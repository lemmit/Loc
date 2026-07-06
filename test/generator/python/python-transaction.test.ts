import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — per-request transaction boundary (read-after-create fix).
//
// The FastAPI `get_session` dependency used to commit in its `yield`-teardown,
// which FastAPI runs AFTER the response is sent.  A client that reads its own
// write immediately (create → GET / dependent-create on a parallel keep-alive
// connection) then raced the commit and saw a 404 / stale FK — the intermittent
// `behavioral-python` flake.  The fix owns the transaction in a pure-ASGI
// `TransactionMiddleware` that commits BEFORE the response starts.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/shell.ddd"),
  "utf8",
);

async function build(source: string) {
  const { model, errors } = await parseString(source);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python per-request transaction boundary", () => {
  it("get_session reads the middleware-owned request session (no post-response commit)", async () => {
    const files = await build(FIXTURE);
    const engine = files.get("api/app/db/engine.py")!;
    // The request-scoped session lives on a ContextVar set by the middleware.
    expect(engine).toContain("request_session: ContextVar[AsyncSession | None] = ContextVar(");
    // On the request path, get_session hands back the middleware's session and
    // does NOT commit in its teardown (the commit-after-response race).
    expect(engine).toContain("existing = request_session.get()");
    expect(engine).toContain("if existing is not None:");
    expect(engine).toContain("        yield existing");
    // Off the request path (seeds/CLI) it still owns + commits a fresh session.
    expect(engine).toContain("    async with session_factory() as session:");
    expect(engine).toContain("        await session.commit()");
  });

  it("emits a pure-ASGI TransactionMiddleware that commits before the response starts", async () => {
    const files = await build(FIXTURE);
    const tx = files.get("api/app/db/transaction.py")!;
    expect(tx).toContain("class TransactionMiddleware:");
    expect(tx).toContain(
      "async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:",
    );
    expect(tx).toContain("token = request_session.set(session)");
    // Commit fires on http.response.start — i.e. BEFORE the first response byte.
    expect(tx).toContain('if message["type"] == "http.response.start" and not finalized:');
    expect(tx).toContain('if message["status"] < 400:');
    expect(tx).toContain("await session.commit()");
    // Error status / exception rolls back; the ContextVar is always reset.
    expect(tx).toContain("await session.rollback()");
    expect(tx).toContain("request_session.reset(token)");
  });

  it("mounts TransactionMiddleware inside CORS/obs so the commit brackets the route", async () => {
    const files = await build(FIXTURE);
    const main = files.get("api/app/main.py")!;
    expect(main).toContain("from app.db.transaction import TransactionMiddleware");
    const txAt = main.indexOf("app.add_middleware(TransactionMiddleware)");
    const corsAt = main.indexOf("app.add_middleware(\n    CORSMiddleware");
    const obsAt = main.indexOf("app.add_middleware(ObservabilityMiddleware)");
    expect(txAt).toBeGreaterThan(-1);
    // Added before CORS/obs => Starlette runs it inner (closer to the route),
    // so it commits before the response bubbles out through them.
    expect(txAt).toBeLessThan(corsAt);
    expect(txAt).toBeLessThan(obsAt);
  });
});
