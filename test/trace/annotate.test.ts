import { describe, expect, it } from "vitest";
import { annotateTrace, LineIndex } from "../../src/trace/annotate.js";
import type { ParsedFrame } from "../../src/trace/frames.js";
import { resolveFrame, type SourceMap } from "../../src/trace/resolve.js";

// ---------------------------------------------------------------------------
// Hand-built sourcemap covering the three OriginRef kinds a region can
// carry, plus the always-present "no match" case (a frame in a file/line
// the map never mentions). Mirrors the wire shape `renderSourceMap` emits
// (src/system/sourcemap.ts) — see test/system/trace-roundtrip.test.ts for
// the real-generator round trip.
// ---------------------------------------------------------------------------

const DDD_SOURCE = [
  "system Demo {",
  "  subdomain Sales {",
  "    context Orders {",
  "      aggregate Order {",
  "        customerName: string",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

// Byte span of the `aggregate Order {` declaration line (index 3, 0-based).
const AGGREGATE_LINE_START = DDD_SOURCE.split("\n").slice(0, 3).join("\n").length + 1;
const AGGREGATE_SPAN: [number, number] = [
  AGGREGATE_LINE_START,
  AGGREGATE_LINE_START + "      aggregate Order {".length,
];

// Byte span of the `ui SalesUi with scaffold(...)` call site (synthesized —
// content doesn't need to parse, only the byte offsets need to be sane).
const MACRO_CALL_SPAN: [number, number] = [500, 540];

const MAP: SourceMap = {
  version: 1,
  sources: ["main.ddd"],
  files: {
    "hono_api/src/domain/order.ts": [
      {
        target: [1, 20],
        origin: { kind: "source", path: "main.ddd", span: AGGREGATE_SPAN },
        construct: "Sales.Orders.Order",
      },
    ],
    "hono_api/src/ui/pages/CartPage.tsx": [
      {
        target: [12, 61],
        origin: {
          kind: "macro",
          macro: "scaffold",
          call: { kind: "source", path: "main.ddd", span: MACRO_CALL_SPAN },
        },
        construct: "Sales.CartPage",
      },
    ],
    "hono_api/src/domain/repository.ts": [
      {
        target: [80, 96],
        origin: { kind: "derived", reason: "auto-findAll" },
      },
    ],
  },
};

function readMainDdd(path: string): string | undefined {
  return path === "main.ddd" ? DDD_SOURCE : undefined;
}

describe("annotateTrace", () => {
  it("annotates a source-kind region with the construct and .ddd line (when readSource is given)", () => {
    const log = "    at /repo/out/hono_api/src/domain/order.ts:10:3";
    const out = annotateTrace(log, MAP, readMainDdd);
    expect(out).toBe(`${log}  →  Sales.Orders.Order  (main.ddd:4)`);
  });

  it("falls back to a byte span when readSource is omitted", () => {
    const log = "    at /repo/out/hono_api/src/domain/order.ts:10:3";
    const out = annotateTrace(log, MAP);
    expect(out).toBe(
      `${log}  →  Sales.Orders.Order  (main.ddd@bytes ${AGGREGATE_SPAN[0]}..${AGGREGATE_SPAN[1]})`,
    );
  });

  it("falls back to a byte span when readSource returns undefined for that path", () => {
    const log = "    at /repo/out/hono_api/src/domain/order.ts:10:3";
    const out = annotateTrace(log, MAP, () => undefined);
    expect(out).toBe(
      `${log}  →  Sales.Orders.Order  (main.ddd@bytes ${AGGREGATE_SPAN[0]}..${AGGREGATE_SPAN[1]})`,
    );
  });

  it("marks a macro-kind region with [macro <name>] and the call-site location", () => {
    const log = "    at /repo/out/hono_api/src/ui/pages/CartPage.tsx:31:5";
    const out = annotateTrace(log, MAP, readMainDdd);
    const callLine = new LineIndex(DDD_SOURCE).lineOf(MACRO_CALL_SPAN[0]);
    expect(out).toBe(`${log}  →  Sales.CartPage  [macro scaffold]  (main.ddd:${callLine})`);
  });

  it("prefers the narrowest containing region — a statement sub-region beats the whole-file region it nests in", () => {
    // Statement-granular regions (source-map Milestone 3) nest inside the
    // construct's whole-file region; the frame's line sits in both, and the
    // tighter one must win.
    const FIELD_LINE_START = DDD_SOURCE.split("\n").slice(0, 4).join("\n").length + 1;
    const nested: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        "hono_api/src/domain/order.ts": [
          {
            target: [1, 20],
            origin: { kind: "source", path: "main.ddd", span: AGGREGATE_SPAN },
            construct: "Sales.Orders.Order",
          },
          {
            target: [10, 10],
            origin: {
              kind: "source",
              path: "main.ddd",
              span: [FIELD_LINE_START, FIELD_LINE_START + 10],
            },
            construct: "Sales.Orders.Order.confirm",
          },
        ],
      },
    };
    const log = "    at /repo/out/hono_api/src/domain/order.ts:10:3";
    const out = annotateTrace(log, nested, readMainDdd);
    expect(out).toBe(`${log}  →  Sales.Orders.Order.confirm  (main.ddd:5)`);
  });

  it("marks a derived-kind region [synthetic: <reason>] with no location (no `from` chain)", () => {
    const log = "    at /repo/out/hono_api/src/domain/repository.ts:88:3";
    const out = annotateTrace(log, MAP, readMainDdd);
    expect(out).toBe(`${log}  →  [synthetic: auto-findAll]`);
  });

  it("passes an unmatched frame through unchanged (wrong file)", () => {
    const log = "    at /repo/out/hono_api/src/domain/nonexistent.ts:1:1";
    expect(annotateTrace(log, MAP, readMainDdd)).toBe(log);
  });

  it("passes an unmatched frame through unchanged (matched file, line outside every region)", () => {
    const log = "    at /repo/out/hono_api/src/domain/order.ts:999:1";
    expect(annotateTrace(log, MAP, readMainDdd)).toBe(log);
  });

  it("leaves non-frame lines (headers, messages, blank lines) untouched", () => {
    const log = ["Error: boom", "", "    at /repo/out/hono_api/src/domain/order.ts:10:3"].join(
      "\n",
    );
    const out = annotateTrace(log, MAP, readMainDdd);
    const outLines = out.split("\n");
    expect(outLines[0]).toBe("Error: boom");
    expect(outLines[1]).toBe("");
    expect(outLines[2]).toBe(
      `    at /repo/out/hono_api/src/domain/order.ts:10:3  →  Sales.Orders.Order  (main.ddd:4)`,
    );
  });
});

describe("LineIndex", () => {
  it("maps a byte offset to its 1-based line number", () => {
    const idx = new LineIndex("abc\ndef\nghi");
    expect(idx.lineOf(0)).toBe(1); // 'a'
    expect(idx.lineOf(3)).toBe(1); // '\n' itself still counts as line 1
    expect(idx.lineOf(4)).toBe(2); // 'd'
    expect(idx.lineOf(8)).toBe(3); // 'g'
  });

  it("maps a byte offset to its 1-based column", () => {
    const idx = new LineIndex("abc\ndef\nghi");
    expect(idx.colOf(0)).toBe(1); // 'a'
    expect(idx.colOf(2)).toBe(3); // 'c'
    expect(idx.colOf(4)).toBe(1); // 'd' — first char of line 2
    expect(idx.colOf(6)).toBe(3); // 'f'
  });
});

// ---------------------------------------------------------------------------
// Column-aware resolution (M16, phase 7 slice 3) — `resolveFrame` layers a
// column-narrowest match on top of the line-narrowest walk, but ONLY when
// the frame carries a column AND some candidate region carries a matching
// `targetCol`. `COL_MAP` mirrors the real shape span-tracking emission
// produces: a wide whole-construct region (no `targetCol` — never chosen
// by column, no column evidence) with two single-line, `targetCol`-bearing
// sub-regions nested on the statement's own line (`target: [10, 10]`) —
// `INNER` (the RHS's `customerName` reference) nested inside `OUTER` (the
// whole `let note = customerName` statement).
// ---------------------------------------------------------------------------
describe("resolveFrame — column-aware region selection", () => {
  const CONSTRUCT_SPAN = AGGREGATE_SPAN; // whole-construct origin — no column evidence
  const OUTER_SPAN: [number, number] = [200, 240]; // e.g. `let note = customerName`
  const INNER_SPAN: [number, number] = [214, 226]; // e.g. `customerName` alone, nested inside OUTER

  const COL_MAP: SourceMap = {
    version: 1,
    sources: ["main.ddd"],
    files: {
      "hono_api/src/domain/order.ts": [
        {
          target: [1, 20],
          origin: { kind: "source", path: "main.ddd", span: CONSTRUCT_SPAN },
          construct: "Sales.Orders.Order",
        },
        {
          target: [10, 10],
          targetCol: [5, 40],
          origin: { kind: "source", path: "main.ddd", span: OUTER_SPAN },
          construct: "Sales.Orders.Order.rename (let note = customerName)",
        },
        {
          target: [10, 10],
          targetCol: [12, 24],
          origin: { kind: "source", path: "main.ddd", span: INNER_SPAN },
          construct: "Sales.Orders.Order.rename (customerName)",
        },
      ],
    },
  };

  function frame(col: number | undefined): ParsedFrame {
    return { lineIndex: 0, file: "hono_api/src/domain/order.ts", line: 10, col };
  }

  it("(a) a col inside a targetCol region resolves to the fine region's origin and prints path:line:col", () => {
    const res = resolveFrame(frame(15), COL_MAP);
    expect(res?.region.targetCol).toEqual([12, 24]);
    expect(res?.origin).toEqual({
      kind: "source",
      path: "main.ddd",
      span: { start: INNER_SPAN[0], end: INNER_SPAN[1] },
    });

    const log = "    at /repo/out/hono_api/src/domain/order.ts:10:15";
    const out = annotateTrace(log, COL_MAP, readMainDdd);
    const idx = new LineIndex(DDD_SOURCE);
    expect(out).toBe(
      `${log}  →  Sales.Orders.Order.rename (customerName)  (main.ddd:${idx.lineOf(INNER_SPAN[0])}:${idx.colOf(INNER_SPAN[0])})`,
    );
  });

  it("(b) a col outside every targetCol region falls back to the statement region and does not print a col", () => {
    const res = resolveFrame(frame(999), COL_MAP);
    expect(res?.region.targetCol).toBeUndefined();
    expect(res?.origin).toEqual({
      kind: "source",
      path: "main.ddd",
      span: { start: CONSTRUCT_SPAN[0], end: CONSTRUCT_SPAN[1] },
    });

    const log = "    at /repo/out/hono_api/src/domain/order.ts:10:999";
    const out = annotateTrace(log, COL_MAP, readMainDdd);
    const idx = new LineIndex(DDD_SOURCE);
    expect(out).toBe(`${log}  →  Sales.Orders.Order  (main.ddd:${idx.lineOf(CONSTRUCT_SPAN[0])})`);
    expect(out).not.toMatch(/main\.ddd:\d+:\d+/);
  });

  it("(c) a frame without a col on a line with targetCol regions still resolves to the statement region — no-regression pin", () => {
    // Both `targetCol`-bearing regions have a strictly narrower `target`
    // ([10, 10], width 0) than the whole-construct region ([1, 20], width
    // 19). Without the ELSE-branch exclusion, plain line-narrowest walking
    // would wrongly pick one of them by line-width accident — this is
    // exactly the case that keeps every column-less resolution
    // byte-identical to before `targetCol` existed.
    const res = resolveFrame(frame(undefined), COL_MAP);
    expect(res?.region.targetCol).toBeUndefined();
    expect(res?.origin).toEqual({
      kind: "source",
      path: "main.ddd",
      span: { start: CONSTRUCT_SPAN[0], end: CONSTRUCT_SPAN[1] },
    });
  });

  it("(d) two targetCol regions on one line, col inside both (nested) — the narrowest wins", () => {
    // OUTER's targetCol is [5, 40] (width 35), INNER's is [12, 24] (width
    // 12) — col 20 sits inside both; INNER must win regardless of
    // registration order.
    const res = resolveFrame(frame(20), COL_MAP);
    expect(res?.region.targetCol).toEqual([12, 24]);
  });

  it("(e) a col exactly at targetCol[1] (the half-open upper bound) does not match that region", () => {
    // INNER's targetCol is [12, 24) — col 24 is excluded from INNER (must
    // fall through to OUTER's [5, 40), which does contain it).
    const res = resolveFrame(frame(24), COL_MAP);
    expect(res?.region.targetCol).toEqual([5, 40]);
  });

  it("(f) equal-width targetCol regions both containing the col — the earlier region wins", () => {
    // Not derivable from (d): both regions are width 10, so narrowest-wins
    // gives no verdict and only the documented strict-`<` tie-break decides.
    const tieMap: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        "hono_api/src/domain/order.ts": [
          {
            target: [10, 10],
            targetCol: [5, 15],
            origin: { kind: "source", path: "main.ddd", span: OUTER_SPAN },
          },
          {
            target: [10, 10],
            targetCol: [8, 18],
            origin: { kind: "source", path: "main.ddd", span: INNER_SPAN },
          },
        ],
      },
    };
    const res = resolveFrame(frame(12), tieMap); // col 12 is inside both [5,15) and [8,18)
    expect(res?.region.targetCol).toEqual([5, 15]);
  });
});

// ---------------------------------------------------------------------------
// The realistic emitted shape: `statementSubRegions` always layers the fine
// `targetCol` regions ALONGSIDE a coarse, col-less region for the SAME
// statement on the SAME line (src/generator/_trace/sourcemap.ts). COL_MAP
// above deliberately omits that coarse sibling to isolate the selection
// rules; this fixture adds it back so the fallback cases pin the answer a
// real map produces — the STATEMENT region, not the whole-construct one.
// ---------------------------------------------------------------------------
describe("resolveFrame — realistic map with a coarse same-line statement region", () => {
  const CONSTRUCT_SPAN = AGGREGATE_SPAN;
  const STMT_SPAN: [number, number] = [200, 240]; // the whole `let note = customerName`
  const RHS_SPAN: [number, number] = [214, 226]; // `customerName` alone

  const REAL_MAP: SourceMap = {
    version: 1,
    sources: ["main.ddd"],
    files: {
      "hono_api/src/domain/order.ts": [
        {
          target: [1, 20],
          origin: { kind: "source", path: "main.ddd", span: CONSTRUCT_SPAN },
          construct: "Sales.Orders.Order",
        },
        {
          // The coarse per-statement sub-region — col-less, same line.
          target: [10, 10],
          origin: { kind: "source", path: "main.ddd", span: STMT_SPAN },
          construct: "Sales.Orders.Order.rename",
        },
        {
          // The fine expression-level mark layered onto the same line.
          target: [10, 10],
          targetCol: [12, 24],
          origin: { kind: "source", path: "main.ddd", span: RHS_SPAN },
          construct: "Sales.Orders.Order.rename",
        },
      ],
    },
  };

  function frame(col: number | undefined): ParsedFrame {
    return { lineIndex: 0, file: "hono_api/src/domain/order.ts", line: 10, col };
  }

  it("a col inside the fine region still picks it over the coarse same-line sibling", () => {
    const res = resolveFrame(frame(15), REAL_MAP);
    expect(res?.region.targetCol).toEqual([12, 24]);
    expect(res?.origin).toEqual({
      kind: "source",
      path: "main.ddd",
      span: { start: RHS_SPAN[0], end: RHS_SPAN[1] },
    });
  });

  it("a col missing every fine region falls back to the coarse STATEMENT region, not the construct", () => {
    const res = resolveFrame(frame(2), REAL_MAP);
    expect(res?.region.targetCol).toBeUndefined();
    expect(res?.origin).toEqual({
      kind: "source",
      path: "main.ddd",
      span: { start: STMT_SPAN[0], end: STMT_SPAN[1] },
    });
  });

  it("a col-less frame on the marked line resolves to the coarse STATEMENT region — exactly as before targetCol existed", () => {
    const res = resolveFrame(frame(undefined), REAL_MAP);
    expect(res?.region.targetCol).toBeUndefined();
    expect(res?.origin).toEqual({
      kind: "source",
      path: "main.ddd",
      span: { start: STMT_SPAN[0], end: STMT_SPAN[1] },
    });
  });
});
