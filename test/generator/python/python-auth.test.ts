import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — auth gate (plan S16, docs/auth.md).  An
// `auth: required` deployable emits the User dataclass + verifier
// registry + Starlette middleware; a `requires`-guarded operation
// gains a trailing `current_user: User` parameter (threaded from
// `request.state.current_user`, denied with RFC 7807 403), a
// currentUser-scoped find threads the actor into the repository
// predicate, and domain tests inject a synthetic full-access actor.
// Verified live (401 / 403 / 204 / row-level `mine` scoping).
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

  it("guarded op gains the trailing actor param and the route threads + declares 403", async () => {
    const files = await build();
    const domain = files.get("api/app/domain/order.py")!;
    expect(domain).toContain("from app.auth.user import User");
    expect(domain).toContain("def cancel(self, current_user: User) -> None:");
    expect(domain).toContain("raise ForbiddenError(");
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain("current_user: User = request.state.current_user");
    expect(routes).toContain("found.cancel(current_user)");
    expect(routes).toContain('403: {"model": ProblemDetails, "description": "Forbidden"}');
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

  it("guarded workflow binds the actor, threads gated op-calls, declares 403", async () => {
    const files = await build();
    const wf = files.get("api/app/http/workflows_routes.py")!;
    expect(wf).toContain("current_user: User = request.state.current_user");
    // The gated op takes the actor as its trailing argument.
    expect(wf).toContain("o.cancel(current_user)");
    expect(wf).toContain('403: {"model": ProblemDetails, "description": "Forbidden"}');
    expect(wf).toContain("raise ForbiddenError(");
  });

  it("domain tests inject the synthetic full-access actor", async () => {
    const files = await build();
    const tests = files.get("api/tests/test_order.py")!;
    expect(tests).toContain("from types import SimpleNamespace");
    expect(tests).toContain("from app.auth.user import User");
    expect(tests).toContain(
      'o.cancel(cast(User, SimpleNamespace(id="00000000-0000-0000-0000-000000000000", role="admin", permissions=["*"])))',
    );
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
