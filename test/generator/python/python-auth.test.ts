import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — auth gate (plan S16, docs/auth.md).  An
// `auth: required` deployable emits the User dataclass + verifier
// registry + Starlette middleware.  An AUTHZ-ONLY operation (currentUser
// used only in `requires`) keeps a PURE domain method — its 403 gate
// relocates to the FastAPI route/workflow handler (denied with RFC 7807
// 403 before dispatch); only a data-use op keeps the trailing
// `current_user: User` param.  A currentUser-scoped find threads the
// actor into the repository predicate.  Verified live (401 / 403 / 204 /
// row-level `mine` scoping).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/auth.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python auth gate", () => {
  it("emits the auth trio: user dataclass, verifier registry, middleware", async () => {
    const files = await build();
    const user = files.get("api/app/auth/user.py")!;
    expect(user).toContain("@dataclass(frozen=True)");
    expect(user).toContain("class User:");
    expect(user).toContain("    role: str");
    expect(user).toContain("    permissions: list[str]");
    const verifier = files.get("api/app/auth/verifier.py")!;
    expect(verifier).toContain("def register_user_verifier(fn: UserVerifier) -> None:");
    expect(verifier).toContain("async def verify_user_or_throw(request: Request) -> User:");
    expect(verifier).toContain("def assert_user_verifier_registered() -> None:");
    const mw = files.get("api/app/auth/middleware.py")!;
    // Bypass list matches Hono/.NET exactly.
    expect(mw).toContain('BYPASS_PREFIXES = ("/health", "/ready", "/openapi.json", "/swagger")');
    expect(mw).toContain("request.state.current_user = user");
    expect(mw).toContain('return JSONResponse({"error": "unauthorized"}, status_code=401)');
    // Stamps the principal id into the RequestContext carrier after verify;
    // the user block's id key is `id`, so it reads user.id.
    expect(mw).toContain("from app.obs.log import set_actor_id");
    expect(mw).toContain("set_actor_id(str(user.id))");
    // Stamped after the principal is set on request.state, before call_next.
    const setIdx = mw.indexOf("request.state.current_user = user");
    const stampIdx = mw.indexOf("set_actor_id(");
    expect(stampIdx).toBeGreaterThan(setIdx);
  });

  it("wires the middleware after CORS and asserts the verifier at boot", async () => {
    const files = await build();
    const main = files.get("api/app/main.py")!;
    expect(main).toContain("from app.auth.middleware import AuthMiddleware");
    expect(main).toContain("    assert_user_verifier_registered()");
    // Starlette runs later-added middleware first: AuthMiddleware is
    // added BEFORE CORS so CORS stays outermost.
    const authAt = main.indexOf("app.add_middleware(AuthMiddleware)");
    const corsAt = main.indexOf("app.add_middleware(\n    CORSMiddleware");
    expect(authAt).toBeGreaterThan(-1);
    expect(corsAt).toBeGreaterThan(-1);
    expect(authAt).toBeLessThan(corsAt);
  });

  it("authz-only op stays a pure domain method; its 403 gate relocates to the route", async () => {
    const files = await build();
    const domain = files.get("api/app/domain/order.py")!;
    // `cancel` is authz-only (currentUser only in `requires`) — the domain
    // method is pure: no `current_user` param, no `ForbiddenError` raise (and so
    // no `User`/`ForbiddenError` import in the domain module).  The 400
    // precondition stays in the body.
    expect(domain).toContain("def cancel(self) -> None:");
    expect(domain).not.toContain("def cancel(self, current_user: User)");
    expect(domain).not.toContain("from app.auth.user import User");
    expect(domain).not.toContain("ForbiddenError");
    expect(domain).toContain('raise DomainError("Precondition failed: status != ');
    // The gate moves to the route handler: bind the principal, raise 403 BEFORE
    // dispatch (the now-pure method takes no actor), declare 403 in OpenAPI.
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain("current_user: User = request.state.current_user");
    expect(routes).toContain("raise ForbiddenError(");
    expect(routes).toContain("found.cancel()");
    expect(routes).not.toContain("found.cancel(current_user)");
    expect(routes).toContain('403: {"model": ProblemDetails, "description": "Forbidden"}');
    // Gate is raised before the domain dispatch.
    const gateAt = routes.indexOf("raise ForbiddenError(");
    const dispatchAt = routes.indexOf("found.cancel()");
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(dispatchAt);
  });

  it("currentUser-scoped find threads the actor into the repository predicate", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo).toContain("from app.auth.user import User");
    expect(repo).toContain("async def mine(self, current_user: User) -> list[Order]:");
    expect(repo).toContain("OrderRow.customer_id == current_user.customer_id");
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain("await repo.mine(current_user)");
  });

  it("guarded workflow binds the actor; an authz-only op-call relocates its gate and threads no actor", async () => {
    const files = await build();
    const wf = files.get("api/app/http/workflows_routes.py")!;
    expect(wf).toContain("current_user: User = request.state.current_user");
    // `cancel` is authz-only, so its method is pure — the op-call threads no
    // actor, and its 403 gate is rendered at the call site before dispatch.
    expect(wf).toContain("o.cancel()");
    expect(wf).not.toContain("o.cancel(current_user)");
    expect(wf).toContain('403: {"model": ProblemDetails, "description": "Forbidden"}');
    // Both the workflow's own `requires` (handler-layer) and the relocated
    // op-call gate raise 403.
    expect(wf).toContain("raise ForbiddenError(");
  });

  it("domain tests call an authz-only op with NO actor (its method is now pure)", async () => {
    const files = await build();
    const tests = files.get("api/tests/test_order.py")!;
    // `cancel`'s 403 gate relocated to the handler, so the domain method dropped
    // its actor param — the test calls it with no synthetic actor (and the file
    // needs neither the SimpleNamespace nor the User import for it).
    expect(tests).toContain("o.cancel()");
    expect(tests).not.toContain("SimpleNamespace");
    expect(tests).not.toContain("from app.auth.user import User");
  });

  it("anonymous deployables emit no auth module and stay Noop-shaped", async () => {
    const source = FIXTURE.replace(/\n {4}auth: required\n/, "\n");
    expect(source).not.toMatch(/^\s*auth: required\s*$/m);
    const { model, errors } = await parseString(source);
    if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
    const files = generateSystems(model).files;
    expect(files.get("api/app/auth/user.py")).toBeUndefined();
    const main = files.get("api/app/main.py")!;
    expect(main).not.toContain("AuthMiddleware");
    expect(main).not.toContain("assert_user_verifier_registered");
  });
});
