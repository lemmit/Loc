import { describe, expect, it } from "vitest";
import {
  asStructuredPayload,
  formatLogArg,
  LOG_LEVELS,
  type StructuredLogPayload,
} from "../../web/src/util/log-line.js";

// ---------------------------------------------------------------------------
// Structured-payload detection — the playground's runtime worker reads
// console.* calls and routes pino-shaped objects into the LogLine's
// `structured` slot (so the Output panel filters on the SEMANTIC level
// pino embedded in the payload, not the console method pino called).
// These tests guard the predicate: tight enough to skip unrelated
// `console.log({...})` calls, loose enough to admit every catalog line.
// See docs/proposals/observability.md.
// ---------------------------------------------------------------------------

describe("asStructuredPayload — catalog payload detection", () => {
  it("admits a typical catalog line at every level", () => {
    for (const level of ["trace", "debug", "info", "warn", "error"] as const) {
      const payload: StructuredLogPayload = {
        level,
        event: "operation_invoked",
        ts: "2026-05-23T01:23:45.678Z",
        request_id: "abc-123",
        aggregate: "Cart",
        op: "applyTotal",
      };
      const out = asStructuredPayload(payload);
      expect(out, `level ${level}`).toBeDefined();
      expect(out?.level).toBe(level);
      expect(out?.event).toBe("operation_invoked");
      expect(out?.request_id).toBe("abc-123");
    }
  });

  it("rejects payloads missing the catalog envelope", () => {
    // No event → not a catalog line, just a structured object.
    expect(asStructuredPayload({ level: "info", message: "hi" })).toBeUndefined();
    // No level → ditto.
    expect(asStructuredPayload({ event: "operation_invoked", aggregate: "X" })).toBeUndefined();
    // Unknown level label → reject (defensive against drift between
    // pino's level set and our catalog).
    expect(
      asStructuredPayload({ level: "verbose", event: "operation_invoked" }),
    ).toBeUndefined();
    // Wrong type for event → reject.
    expect(asStructuredPayload({ level: "info", event: 42 })).toBeUndefined();
  });

  it("rejects non-objects, null, and primitives", () => {
    expect(asStructuredPayload(null)).toBeUndefined();
    expect(asStructuredPayload(undefined)).toBeUndefined();
    expect(asStructuredPayload("a plain string log")).toBeUndefined();
    expect(asStructuredPayload(42)).toBeUndefined();
    expect(asStructuredPayload(true)).toBeUndefined();
  });

  it("admits an array-valued field without dropping the payload", () => {
    // health_ok carries `checks: ["readiness", "db"]` — making sure the
    // predicate doesn't reject on array-valued event-specific fields.
    const out = asStructuredPayload({
      level: "debug",
      event: "health_ok",
      checks: ["readiness", "db"],
    });
    expect(out?.event).toBe("health_ok");
    expect(out?.checks).toEqual(["readiness", "db"]);
  });
});

describe("LOG_LEVELS", () => {
  it("includes trace — the level pino in browser routes through console.debug", () => {
    // Trace is the semantic stratum that under-reports without the
    // structured-payload detection above.  Listing it here is what makes
    // the Output panel's filter chip work for trace lines.
    expect(LOG_LEVELS).toContain("trace");
    expect(LOG_LEVELS).toContain("debug");
    expect(LOG_LEVELS).toContain("info");
    expect(LOG_LEVELS).toContain("warn");
    expect(LOG_LEVELS).toContain("error");
  });
});

describe("formatLogArg", () => {
  it("round-trips strings, JSON-stringifies objects, keeps Error stacks", () => {
    expect(formatLogArg("hello")).toBe("hello");
    expect(JSON.parse(formatLogArg({ x: 1 }))).toEqual({ x: 1 });
    const err = new Error("boom");
    expect(formatLogArg(err)).toContain("boom");
    // Circular-ref safety — JSON.stringify throws; the fallback is the
    // String() coercion of the object, not a thrown error tearing down
    // the worker.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(typeof formatLogArg(cyclic)).toBe("string");
  });
});
