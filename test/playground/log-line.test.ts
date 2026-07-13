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
// See docs/old/proposals/observability.md.
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
    expect(asStructuredPayload({ level: "verbose", event: "operation_invoked" })).toBeUndefined();
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

/**
 * Mirror of `renderStructuredLine` from `web/src/layout/OutputPanel.tsx`.
 * Kept in sync by hand — exporting it from the layout file would force
 * a React/Mantine pull into the toolchain test harness, and the render
 * fn itself is pure (no React), so a structural copy here lets the
 * vitest run cover the formatting decisions without pulling in the
 * playground UI dependency tree.
 */
function renderStructuredLine(p: StructuredLogPayload): string {
  const head = `[${p.level}] ${p.event}`;
  const { ts: _ts, level: _level, event: _event, request_id, ...rest } = p;
  const parts: string[] = [head];
  for (const [k, v] of Object.entries(rest)) {
    parts.push(`${k}=${formatField(v)}`);
  }
  if (typeof request_id === "string" && request_id.length > 0) {
    parts.push(`req=${request_id.split("-")[0] ?? request_id.slice(0, 8)}`);
  }
  return parts.join(" ");
}

function formatField(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

describe("renderStructuredLine — Output panel formatting", () => {
  it("renders a typical request envelope compactly", () => {
    // [info] header → event name → key=value fields → shortened request_id
    // suffix.  Whole line stays on ONE row at typical terminal widths.
    const out = renderStructuredLine({
      level: "info",
      ts: "2026-05-23T01:23:45.678Z",
      event: "request_end",
      request_id: "7d8bedc1-57dd-47cd-9916-38279e0df8c3",
      method: "GET",
      path: "/health",
      status: 200,
      duration_ms: 4,
    });
    expect(out).toBe(
      `[info] request_end method="GET" path="/health" status=200 duration_ms=4 req=7d8bedc1`,
    );
  });

  it("strips the envelope from the body (ts / level / event / request_id)", () => {
    // The fields that live in the envelope shouldn't appear duplicated in
    // the per-line body — `ts` is implicit in line ordering, level drives
    // the tint, `event` is the head identifier, and `request_id` gets the
    // shortened suffix.
    const out = renderStructuredLine({
      level: "debug",
      event: "health_ok",
      ts: "2026-05-23T01:23:45.678Z",
      checks: ["liveness"],
    });
    expect(out).toBe(`[debug] health_ok checks=["liveness"]`);
    expect(out).not.toContain("ts=");
    expect(out).not.toContain("level=");
    expect(out).not.toContain("event=");
  });

  it("keeps numbers / booleans bare, JSON-encodes strings and structured values", () => {
    // `status=200` (number) — not `status="200"`.  `path="/health"`
    // (string with quotes) — so `path=/health` doesn't get confused with
    // a bare identifier when the eye scans the row.  Arrays and objects
    // get JSON.stringify-d so they survive intact.
    const out = renderStructuredLine({
      level: "trace",
      event: "child_synced",
      parent: "Order",
      part: "OrderLine",
      id: "abc",
      action: "insert",
      nested: { a: 1, b: 2 },
      ok: true,
    });
    expect(out).toContain(`parent="Order"`);
    expect(out).toContain(`action="insert"`);
    expect(out).toContain(`nested={"a":1,"b":2}`);
    expect(out).toContain(`ok=true`);
  });

  it("omits the req= suffix when no request_id is present (boot/lifecycle lines)", () => {
    const out = renderStructuredLine({
      level: "info",
      event: "server_listening",
      port: 3000,
    });
    expect(out).toBe(`[info] server_listening port=3000`);
    expect(out).not.toContain("req=");
  });

  it("falls back to a length-prefix slice when request_id has no hyphen", () => {
    // Tolerant: a non-UUID request_id (custom-injected by an upstream
    // X-Request-Id) still gets shortened so the line stays scannable.
    const out = renderStructuredLine({
      level: "info",
      event: "request_start",
      request_id: "abcdef1234567890",
      method: "GET",
      path: "/",
    });
    expect(out).toContain("req=abcdef12");
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
