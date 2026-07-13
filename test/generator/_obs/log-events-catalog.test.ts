import { describe, expect, it } from "vitest";
import { type LogEvent, LogEvents, type LogLevel } from "../../../src/generator/_obs/log-events.js";
import {
  renderDotnetLogCall,
  renderDotnetLogCallWithException,
} from "../../../src/generator/_obs/render-dotnet.js";
import {
  renderHonoBaseLogCall,
  renderHonoLogCall,
} from "../../../src/generator/_obs/render-hono.js";
import { renderPhoenixLogCall } from "../../../src/generator/_obs/render-phoenix.js";

// ---------------------------------------------------------------------------
// Neutral log-event catalog — the single source of truth for every log
// line the generated backends emit.  These tests guard the contract:
// stable event names, level discipline, and the domain-injection rule.
// See docs/old/proposals/observability.md.
// ---------------------------------------------------------------------------

const VALID_LEVELS: ReadonlySet<LogLevel> = new Set(["trace", "debug", "info", "warn", "error"]);
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["ts", "level", "event", "request_id"]);

const entries: ReadonlyArray<readonly [string, LogEvent]> = Object.entries(
  LogEvents,
) as ReadonlyArray<readonly [string, LogEvent]>;

describe("log-event catalog — integrity", () => {
  it("every entry has a non-empty `event` and a valid level", () => {
    for (const [key, e] of entries) {
      expect(e.event, `${key}.event`).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(VALID_LEVELS.has(e.level), `${key}.level (${e.level})`).toBe(true);
    }
  });

  it("every `event` name is unique across the catalog", () => {
    const counts = new Map<string, number>();
    for (const [, e] of entries) counts.set(e.event, (counts.get(e.event) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
    expect(dupes).toEqual([]);
  });

  it("structured field names are non-empty, snake_case, and disjoint from the envelope", () => {
    for (const [key, e] of entries) {
      for (const f of e.fields) {
        expect(f, `${key} field`).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(ENVELOPE_KEYS.has(f), `${key} field '${f}' collides with envelope`).toBe(false);
      }
    }
  });

  it("`domain: true` entries are exclusively trace-level (purity rule)", () => {
    // The compile-time `--trace` switch is the only path that may inject
    // statements into domain methods, so any entry flagged `domain: true`
    // MUST be a trace entry — and conversely, the catalog must not carry
    // a stray non-trace entry with `domain: true` that would silently
    // pollute the default artefact.
    for (const [key, e] of entries) {
      if (e.domain) {
        expect(e.level, `${key} has domain:true but level=${e.level}`).toBe("trace");
      }
    }
  });
});

describe("log-event catalog — Hono renderer", () => {
  it("per-request renderer bridges to the bound child logger via an untyped cast", () => {
    // The sub-router's OpenAPIHono can't carry custom Variables typing
    // (zod-openapi's Env rejects it), so c.get("log") is reached via the
    // same untyped-cast pattern the shipped trace_id read uses — typed
    // through an inline `import("../obs/log").RequestLogger` so the
    // emitted method call still resolves strict-tsc.
    const line = renderHonoLogCall("operationInvoked", 'aggregate: "Cart", op: "applyTotal", id');
    expect(line).toBe(
      `(c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").info({ event: "operation_invoked", aggregate: "Cart", op: "applyTotal", id });`,
    );
  });

  it("base-logger renderer uses the process logger (no request scope)", () => {
    // Boot/lifecycle seams live outside a request — no child logger to
    // resolve through `c`, so they hit `baseLogger` directly.
    const line = renderHonoBaseLogCall("serverListening", "port");
    expect(line).toBe(`baseLogger.info({ event: "server_listening", port });`);
  });

  it("level routes to the matching pino method per catalog entry", () => {
    // The renderer must NOT hardcode `.info` — every level in the
    // taxonomy must reach its matching pino method.  This guards against
    // the obvious "always log info" bug.
    expect(renderHonoLogCall("domainError", "")).toMatch(/\.get\("log"\)\.warn\(/);
    expect(renderHonoLogCall("internalError", "")).toMatch(/\.get\("log"\)\.error\(/);
    expect(renderHonoLogCall("repositorySave", "")).toMatch(/\.get\("log"\)\.debug\(/);
    expect(renderHonoLogCall("invariantEvaluated", "")).toMatch(/\.get\("log"\)\.trace\(/);
  });

  it("emits a bare `{ event }` literal when the call site has no extra fields", () => {
    // `server_drained` has zero structured fields beyond the envelope; the
    // renderer must not leave a dangling comma or empty object literal.
    const line = renderHonoBaseLogCall("serverDrained");
    expect(line).toBe(`baseLogger.info({ event: "server_drained" });`);
  });
});

describe("log-event catalog — .NET renderer", () => {
  it("renders an ILogger.Log<Level> call with snake_case keys and Pascal placeholders", () => {
    // Two-field call site (no exception): `{Event}` head, `key={Pascal}`
    // for each field passed.  Args positional in catalog order, the
    // event-name string literal coming first to bind the head.
    const line = renderDotnetLogCall("operationInvoked", [
      { name: "aggregate", valueExpr: `"Cart"` },
      { name: "op", valueExpr: `"applyTotal"` },
      { name: "id", valueExpr: "id" },
    ]);
    expect(line).toBe(
      `_log.LogInformation("{Event} aggregate={Aggregate} op={Op} id={Id}", "operation_invoked", "Cart", "applyTotal", id);`,
    );
  });

  it("routes the catalog level to the matching ILogger method", () => {
    // Same guard as the Hono renderer: every level lands on its own
    // ILogger method, not a hardcoded one.
    expect(renderDotnetLogCall("domainError")).toMatch(/^_log\.LogWarning\(/);
    expect(renderDotnetLogCall("internalError")).toMatch(/^_log\.LogError\(/);
    expect(renderDotnetLogCall("repositorySave")).toMatch(/^_log\.LogDebug\(/);
    expect(renderDotnetLogCall("invariantEvaluated")).toMatch(/^_log\.LogTrace\(/);
    expect(renderDotnetLogCall("aggregateCreated")).toMatch(/^_log\.LogInformation\(/);
  });

  it("the exception overload puts Exception first, then template, then structured args", () => {
    // ILogger.Log<Level>(Exception, string template, params object[] args)
    // — the order matters; reversing it puts the stack trace in the
    // wrong slot and breaks Serilog's structured capture.
    const line = renderDotnetLogCallWithException("externHandlerThrew", "xh", [
      { name: "aggregate", valueExpr: `"Order"` },
      { name: "op", valueExpr: `"confirm"` },
      { name: "error", valueExpr: "xh.Message" },
    ]);
    expect(line).toBe(
      `_log.LogError(xh, "{Event} aggregate={Aggregate} op={Op} error={Error}", "extern_handler_threw", "Order", "confirm", xh.Message);`,
    );
  });

  it("handles snake_case → PascalCase for compound field names like request_id / event_type", () => {
    // The catalog uses snake_case keys for cross-backend portability;
    // .NET conventions are PascalCase placeholders.  Compound keys
    // (`request_id` → `RequestId`, `event_type` → `EventType`) must
    // join the words correctly, not just upper-case the first letter.
    const line = renderDotnetLogCall("eventDispatched", [
      { name: "event_type", valueExpr: `evt.GetType().Name` },
      { name: "aggregate", valueExpr: `"Order"` },
      { name: "id", valueExpr: "agg.Id" },
    ]);
    expect(line).toMatch(/event_type=\{EventType\}/);
    expect(line).toMatch(/aggregate=\{Aggregate\}/);
  });

  it("emits a bare `{Event}` template when the call site has no extra fields", () => {
    // `server_drained` — no per-event fields; the .NET line stays a
    // valid ILogger call with just the event-name binding.
    const line = renderDotnetLogCall("serverDrained");
    expect(line).toBe(`_log.LogInformation("{Event}", "server_drained");`);
  });
});

describe("log-event catalog — Phoenix renderer", () => {
  it("renders a typical info event with snake_case metadata keys", () => {
    // Message = event name (grep-target); metadata carries the structured
    // fields PLUS a re-stamped `event:` so cross-backend pipelines pivot
    // on one key regardless of source.
    const line = renderPhoenixLogCall("aggregateCreated", [
      { name: "aggregate", valueExpr: `"Order"` },
      { name: "id", valueExpr: "record.id" },
    ]);
    expect(line).toBe(
      `Logger.info("aggregate_created", event: "aggregate_created", aggregate: "Order", id: record.id)`,
    );
  });

  it("maps catalog levels to Elixir Logger method names (warn → warning, trace → debug)", () => {
    // Elixir's Logger has no `trace`; both `trace` and `debug` from the
    // catalog land on Logger.debug.  The event-name keeps them
    // distinguishable.  And Elixir spells the level `warning`, not `warn`.
    expect(renderPhoenixLogCall("domainError")).toMatch(/^Logger\.warning\(/);
    expect(renderPhoenixLogCall("internalError")).toMatch(/^Logger\.error\(/);
    expect(renderPhoenixLogCall("repositorySave")).toMatch(/^Logger\.debug\(/);
    // trace-level entry: still Logger.debug — distinguished by event name.
    expect(renderPhoenixLogCall("invariantEvaluated")).toMatch(/^Logger\.debug\(/);
    expect(renderPhoenixLogCall("invariantEvaluated")).toContain(`event: "invariant_evaluated"`);
    expect(renderPhoenixLogCall("aggregateCreated")).toMatch(/^Logger\.info\(/);
  });

  it("emits the bare `event:` metadata when the call site has no extra fields", () => {
    // `server_drained` carries nothing beyond the catalog envelope —
    // metadata is just the re-stamped event key, no dangling comma.
    const line = renderPhoenixLogCall("serverDrained");
    expect(line).toBe(`Logger.info("server_drained", event: "server_drained")`);
  });
});
