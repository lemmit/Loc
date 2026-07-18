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
    // request_id on every line is the carrier's correlation id (subsumed channel).
    expect(log).toContain('body["request_id"] = cid');
    expect(log).toContain("def log(level: str, event: str, **fields: object) -> None:");
    // Runtime log-level knob — LOG_LEVEL (default info) mapped via _LEVELNO.
    expect(log).toContain("import os");
    expect(log).toContain(
      'logger.setLevel(_LEVELNO.get(os.environ.get("LOG_LEVEL", "info").lower(), logging.INFO))',
    );
    const mw = files.get("api/app/obs/middleware.py")!;
    // Pure-ASGI (NOT BaseHTTPMiddleware): BaseHTTPMiddleware runs the endpoint
    // in a child task and defers the yield-dependency DB commit until after the
    // response is sent — the read-after-create race.  Pure ASGI keeps it inline.
    expect(mw).not.toContain("starlette.middleware.base");
    expect(mw).not.toContain("(BaseHTTPMiddleware)");
    expect(mw).toContain("class ObservabilityMiddleware:");
    expect(mw).toContain(
      "async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:",
    );
    // Correlation resolves x-correlation-id || x-request-id || minted.
    expect(mw).toContain('request.headers.get("x-correlation-id")');
    expect(mw).toContain('or request.headers.get("x-request-id")');
    expect(mw).toContain("or new_id()");
    expect(mw).toContain('log("info", "request_start", method=method, path=path)');
    expect(mw).toContain("duration_ms = int((time.monotonic() - started) * 1000)");
    // Metrics recorded at the same seam as request_end (M-T7.1).
    expect(mw).toContain("from app.obs.metrics import record_http_request");
    expect(mw).toContain("record_http_request(method, _route_template(scope, path)");
    // Correlation echoed via the ASGI response-start headers (MutableHeaders).
    expect(mw).toContain('headers["x-request-id"] = correlation');
    expect(mw).toContain('headers["x-correlation-id"] = correlation');
  });

  it("emits the Prometheus metrics module + /metrics route (M-T7.1)", async () => {
    const files = await build(FIXTURE);
    const metrics = files.get("api/app/obs/metrics.py")!;
    expect(metrics).toBeDefined();
    // Catalog-driven names/labels — the neutral src/generator/_obs/metrics.ts.
    expect(metrics).toContain('"http_requests_total"');
    expect(metrics).toContain('"http_request_duration_seconds"');
    expect(metrics).toContain('["method", "route", "status"]');
    expect(metrics).toContain(
      "def record_http_request(method: str, route: str, status: int, duration_ms: float) -> None:",
    );
    expect(metrics).toContain("def render_metrics() -> tuple[bytes, str]:");
    // The route is mounted in main.py, serving the exposition.
    const main = files.get("api/app/main.py")!;
    expect(main).toContain("from app.obs.metrics import render_metrics");
    expect(main).toContain('@app.get("/metrics")');
    expect(main).toContain("return Response(content=body, media_type=content_type)");
  });

  it("emits the RequestContext carrier (subsumes the request-id contextvar)", async () => {
    const files = await build(FIXTURE);
    const log = files.get("api/app/obs/log.py")!;
    // One ambient channel: a frozen RequestContext in a single ContextVar.
    expect(log).toContain("class RequestContext:");
    expect(log).toContain("    correlation_id: str");
    expect(log).toContain("    scope_id: str");
    expect(log).toContain("    actor_id: str | None = None");
    expect(log).toContain("request_context_var: ContextVar[RequestContext | None] = ContextVar(");
    // Accessors for non-HTTP reads + the post-auth actor-id stamp.
    expect(log).toContain("def correlation_id() -> str | None:");
    expect(log).toContain("def actor_id() -> str | None:");
    expect(log).toContain("def set_actor_id(value: str) -> None:");
    expect(log).toContain("request_context_var.set(replace(ctx, actor_id=value))");
    // The middleware opens the carrier with a root scope id + locale + start.
    const mw = files.get("api/app/obs/middleware.py")!;
    expect(mw).toContain("open_context(");
    expect(mw).toContain("correlation_id=correlation");
    expect(mw).toContain("scope_id=new_id()");
    expect(mw).toContain('locale=request.headers.get("accept-language") or "en"');
  });

  it("emits the per-dispatch child-frame seam (parent_id chaining)", async () => {
    const files = await build(FIXTURE);
    const log = files.get("api/app/obs/log.py")!;
    // The carrier carries the parent_id tier + an accessor for it.
    expect(log).toContain("    parent_id: str | None = None");
    expect(log).toContain("def parent_id() -> str | None:");
    // child_context() opens a child frame: fresh scope_id, parent_id <- the
    // caller's scope_id, restored on exit; a no-op outside any request.
    expect(log).toContain("def child_context() -> Iterator[None]:");
    expect(log).toContain("replace(parent, scope_id=new_id(), parent_id=parent.scope_id)");
    // The in_child_context decorator wraps an async dispatch boundary in it.
    expect(log).toContain(
      "def in_child_context(fn: Callable[_P, Awaitable[_R]]) -> Callable[_P, Awaitable[_R]]:",
    );
    expect(log).toContain("with child_context():");
    // The log formatter stamps parent_id onto every line of the child frame.
    expect(log).toContain("pid = parent_id()");
    expect(log).toContain('body["parent_id"] = pid');
  });

  it("the dispatcher's reactor handlers open a child frame", async () => {
    const files = await build(SAGA);
    const dispatch = files.get("api/app/dispatch.py")!;
    // Every reactor handler carries the decorator directly above its def, so it
    // runs in a child execution-context frame under the dispatching request.
    expect(dispatch).toMatch(/@in_child_context\nasync def _order_fulfillment_/);
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
    // Catch-all fallback: an otherwise-unhandled exception logs internal_error
    // (parity with Hono/.NET/Java/vanilla) and returns a sanitized 500.
    expect(problem).toContain("@app.exception_handler(Exception)");
    expect(problem).toContain('log("error", "internal_error", error=str(err), status=500)');
    expect(problem).toContain(
      'return problem(request, 500, "Internal Server Error", "An unexpected error occurred.")',
    );
  });

  it("the dispatcher's drop path logs event_unrouted on the catalog stream", async () => {
    const files = await build(SAGA);
    const dispatch = files.get("api/app/dispatch.py")!;
    expect(dispatch).toContain("from app.obs.log import in_child_context, log");
    expect(dispatch).toContain(
      'log("warn", "event_unrouted", workflow="OrderFulfillment", event_type="ShipmentRequested", key=__key)',
    );
  });

  // S2 — info narrative (domain-seam-log-parity.md): aggregate_created (create
  // route after persist), operation_invoked (per-op route after load),
  // event_dispatched (repository publish loop).
  it("the create route logs aggregate_created after persist", async () => {
    const files = await build(SAGA);
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain("from app.obs.log import log");
    expect(routes).toContain('log("info", "aggregate_created", aggregate="Order", id=created.id)');
  });

  it("each operation route logs operation_invoked with aggregate/op/id", async () => {
    const files = await build(SAGA);
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain(
      'log("info", "operation_invoked", aggregate="Order", op="place", id=id)',
    );
  });

  it("the repository publish loop logs event_dispatched per pulled event", async () => {
    const files = await build(SAGA);
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo).toContain("from app.obs.log import log");
    expect(repo).toContain(
      'log("info", "event_dispatched", event_type=type(event).__name__, aggregate="Order", id=str(aggregate.id))',
    );
  });
});
