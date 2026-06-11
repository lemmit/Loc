import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — observability (plan S17, docs/observability.md).
// Every deployable emits `app/obs/` (CatalogFormatter + `log(...)`
// facade + request-bracket middleware): one flat JSON object per line
// on stdout with the catalog envelope (ts / level / event /
// request_id), the lifecycle bracket in the lifespan, health_ok at
// debug, fault warns in the problem handlers, and the dispatcher's
// event_unrouted drop on the same stream.  The runtime contract is
// gated end-to-end by `observability-events-python.test.ts`
// (LOOM_OBS_E2E_PYTHON=1).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/shell.ddd"),
  "utf8",
);
const SAGA = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/saga.ddd"),
  "utf8",
);

async function build(source: string) {
  const { model, errors } = await parseString(source);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python observability", () => {
  it("emits the obs module: CatalogFormatter envelope + log facade + middleware", async () => {
    const files = await build(FIXTURE);
    const log = files.get("api/app/obs/log.py")!;
    expect(log).toContain("class CatalogFormatter(logging.Formatter):");
    expect(log).toContain('"ts": datetime.now(UTC)');
    expect(log).toContain('body["request_id"] = rid');
    expect(log).toContain("def log(level: str, event: str, **fields: object) -> None:");
    const mw = files.get("api/app/obs/middleware.py")!;
    expect(mw).toContain('request.headers.get("x-request-id") or uuid.uuid4().hex');
    expect(mw).toContain('log("info", "request_start", method=request.method');
    expect(mw).toContain("duration_ms=int((time.monotonic() - started) * 1000)");
    expect(mw).toContain('response.headers["x-request-id"] = rid');
  });

  it("lifespan brackets the lifecycle; obs middleware mounts outermost", async () => {
    const files = await build(FIXTURE);
    const main = files.get("api/app/main.py")!;
    expect(main).toContain('log("info", "server_starting", port=_PORT)');
    expect(main).toContain('log("info", "server_listening", port=_PORT)');
    expect(main).toContain('log("info", "server_shutdown", signal="SIGTERM")');
    expect(main).toContain('log("info", "server_drained")');
    expect(main).toContain('log("debug", "health_ok", checks=["app"])');
    // Added after every other middleware so Starlette runs it first.
    const obsAt = main.indexOf("app.add_middleware(ObservabilityMiddleware)");
    const corsAt = main.indexOf("app.add_middleware(\n    CORSMiddleware");
    expect(obsAt).toBeGreaterThan(corsAt);
  });

  it("problem handlers emit the catalog fault warns", async () => {
    const files = await build(FIXTURE);
    const problem = files.get("api/app/http/problem.py")!;
    expect(problem).toContain('log("warn", "domain_error", message=str(err), status=400)');
    expect(problem).toContain('log("warn", "forbidden", message=str(err), status=403)');
    expect(problem).toContain('log("warn", "not_found", message=str(err), status=404)');
    expect(problem).toContain('log("error", "extern_handler_threw", error=str(err), status=500)');
  });

  it("the dispatcher's drop path logs event_unrouted on the catalog stream", async () => {
    const files = await build(SAGA);
    const dispatch = files.get("api/app/dispatch.py")!;
    expect(dispatch).toContain("from app.obs.log import log");
    expect(dispatch).toContain(
      'log("warn", "event_unrouted", workflow="OrderFulfillment", event_type="ShipmentRequested", key=__key)',
    );
  });
});
