import { describe, expect, it } from "vitest";
import { type LogEvent, LogEvents, type LogLevel } from "../../src/generator/_obs/log-events.js";
import { renderHonoBaseLogCall, renderHonoLogCall } from "../../src/generator/_obs/render-hono.js";

// ---------------------------------------------------------------------------
// Neutral log-event catalog — the single source of truth for every log
// line the generated backends emit.  These tests guard the contract:
// stable event names, level discipline, and the domain-injection rule.
// See docs/proposals/observability.md.
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
