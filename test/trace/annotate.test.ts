import { describe, expect, it } from "vitest";
import { annotateTrace, LineIndex } from "../../src/trace/annotate.js";
import type { SourceMap } from "../../src/trace/resolve.js";

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
});
