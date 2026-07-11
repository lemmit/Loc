import { describe, expect, it } from "vitest";
import { translateBreakpoint } from "../../src/dap/breakpoints.js";
import { generateSystems } from "../../src/system/index.js";
import { resolveFrame, type SourceMap } from "../../src/trace/resolve.js";
import { parseValid } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// `translateBreakpoint` — the REVERSE of `src/trace/`'s `resolveFrame`: a
// `.ddd` file+line → generated file:line lookup over a hand-built
// `SourceMap`, exactly like test/trace/annotate.test.ts covers
// `resolveFrame`/`annotateTrace`. The final `it` closes the loop with a
// REAL generated system (mirrors test/system/trace-roundtrip.test.ts).
// ---------------------------------------------------------------------------

const DDD_SOURCE = [
  "system Demo {", // 1
  "  subdomain Sales {", // 2
  "    context Orders {", // 3
  "      aggregate Order {", // 4
  "        customerName: string", // 5
  "        operation confirm() { }", // 6
  "      }", // 7
  "    }", // 8
  "  }", // 9
  "}", // 10
].join("\n");

/** 0-based byte offset of 1-based line `line`'s first character — same
 *  convention test/trace/annotate.test.ts's `AGGREGATE_LINE_START` uses. */
function startOfLine(line: number): number {
  if (line <= 1) return 0;
  return (
    DDD_SOURCE.split("\n")
      .slice(0, line - 1)
      .join("\n").length + 1
  );
}

const CONFIRM_LINE = 6;
const CONFIRM_LINE_TEXT = DDD_SOURCE.split("\n")[CONFIRM_LINE - 1]!;
const CONFIRM_OFFSET_IN_LINE = CONFIRM_LINE_TEXT.indexOf("confirm");
const CONFIRM_SPAN: [number, number] = [
  startOfLine(CONFIRM_LINE) + CONFIRM_OFFSET_IN_LINE,
  startOfLine(CONFIRM_LINE) + CONFIRM_OFFSET_IN_LINE + "confirm".length,
];

// The whole-aggregate span, lines 4 through 7 inclusive (line 4's start to
// line 8's start) — covers CONFIRM_LINE too, for the nested-construct case.
const AGGREGATE_LINE = 4;
const AGGREGATE_SPAN: [number, number] = [startOfLine(AGGREGATE_LINE), startOfLine(8)];

const readSource = () => DDD_SOURCE;

describe("translateBreakpoint", () => {
  it("a region covering the requested .ddd line resolves to its generated file:line", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        "hono_api/domain/order.ts": [
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm",
          },
        ],
      },
    };

    const out = translateBreakpoint(map, "main.ddd", CONFIRM_LINE, readSource);
    expect(out).toEqual([
      {
        file: "hono_api/domain/order.ts",
        line: 55,
        region: map.files["hono_api/domain/order.ts"]![0],
      },
    ]);
  });

  it("nested constructs on one line: a whole-aggregate region and a narrower operation region both covering the line -> both returned, narrowest-origin-span first", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        "hono_api/domain/order.ts": [
          {
            target: [40, 40],
            origin: { kind: "source", path: "main.ddd", span: AGGREGATE_SPAN },
            construct: "Orders.Order",
          },
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm",
          },
        ],
      },
    };

    const out = translateBreakpoint(map, "main.ddd", CONFIRM_LINE, readSource);
    expect(out.map((t) => ({ file: t.file, line: t.line }))).toEqual([
      { file: "hono_api/domain/order.ts", line: 55 }, // narrowest span (confirm) first
      { file: "hono_api/domain/order.ts", line: 40 }, // widest span (whole aggregate) last
    ]);
  });

  it("a line with no covering region returns []", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        "hono_api/domain/order.ts": [
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm",
          },
        ],
      },
    };

    // Line 2 ("subdomain Sales {") is covered by neither region.
    expect(translateBreakpoint(map, "main.ddd", 2, readSource)).toEqual([]);
  });

  it("readSource returning undefined for the path is an honest skip -> []", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        "hono_api/domain/order.ts": [
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm",
          },
        ],
      },
    };

    expect(translateBreakpoint(map, "main.ddd", CONFIRM_LINE, () => undefined)).toEqual([]);
  });

  it("matchPath: a longer-suffix origin path still matches the requested short path", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["/proj/main.ddd"],
      files: {
        "hono_api/domain/order.ts": [
          {
            target: [55, 55],
            origin: { kind: "source", path: "/proj/main.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm",
          },
        ],
      },
    };

    const out = translateBreakpoint(map, "main.ddd", CONFIRM_LINE, readSource);
    expect(out).toEqual([
      {
        file: "hono_api/domain/order.ts",
        line: 55,
        region: map.files["hono_api/domain/order.ts"]![0],
      },
    ]);
  });

  it("de-dups identical {file,line} pairs reached via two regions, keeping the narrowest-span one", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        "hono_api/domain/order.ts": [
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: AGGREGATE_SPAN },
            construct: "Orders.Order (wide)",
          },
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm (narrow)",
          },
        ],
      },
    };

    const out = translateBreakpoint(map, "main.ddd", CONFIRM_LINE, readSource);
    expect(out).toHaveLength(1);
    expect(out[0]!.region.construct).toBe("Orders.Order.confirm (narrow)");
  });

  it("a region whose origin doesn't resolve to a source ref (bare derived, no `from`) is skipped", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        "hono_api/domain/order.ts": [
          { target: [99, 99], origin: { kind: "derived", reason: "auto-findAll" } },
        ],
      },
    };

    expect(translateBreakpoint(map, "main.ddd", CONFIRM_LINE, readSource)).toEqual([]);
  });

  it("no match under any generated file when the path doesn't match at all", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["other.ddd"],
      files: {
        "hono_api/domain/order.ts": [
          {
            target: [55, 55],
            origin: { kind: "source", path: "other.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm",
          },
        ],
      },
    };

    expect(translateBreakpoint(map, "main.ddd", CONFIRM_LINE, readSource)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REAL round trip over a generated system's `.loom/sourcemap.json` — closes
// the loop with the already-shipped reverse direction (`resolveFrame`):
// forward(reverse(line)) must land back on the same `.ddd` line.
// ---------------------------------------------------------------------------

const REAL_SOURCE = `
system SourceMapDemo {
  subdomain Sales {
    context Orders {
      aggregate Order {
        customerName: string
        status: string
        operation confirm() {
          let ok = 1
          status := "confirmed"
        }
      }
      repository Orders for Order { }
    }
  }

  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  api SalesApi from Sales
  ui SalesUi with scaffold(subdomains: [Sales]) { }

  deployable honoApi { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 3000 }
}
`;

const LET_LINE = REAL_SOURCE.split("\n").findIndex((l) => l.includes("let ok = 1")) + 1;

describe("translateBreakpoint — real round trip over a generated system's sourcemap", () => {
  it("forward (translateBreakpoint) then back (resolveFrame) lands on the same .ddd line", async () => {
    const model = await parseValid(REAL_SOURCE);
    const { files } = generateSystems(model, { sourcemap: true });
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as SourceMap;

    // The in-memory parsed document's own URI (`map.sources[0]`, e.g.
    // `/1.ddd`) — not a real on-disk path, but the same one every region's
    // `origin.path` was recorded against, so it's what a real caller (which
    // reads this same map) would pass too.
    const dddPath = map.sources[0]!;
    const targets = translateBreakpoint(map, dddPath, LET_LINE, () => REAL_SOURCE);
    expect(targets.length).toBeGreaterThan(0);

    const honoTarget = targets.find(
      (t) => t.file.startsWith("hono_api/") && t.file.endsWith(".ts"),
    );
    expect(honoTarget, "expected a hono_api/*.ts target for the `let ok = 1` line").toBeDefined();
    const { file, line } = honoTarget!;

    // Back: resolveFrame from that generated file:line resolves to a region
    // whose origin's `.ddd` line is the SAME line we started from.
    const resolution = resolveFrame({ lineIndex: 0, file, line }, map);
    expect(resolution, `resolveFrame found no region for ${file}:${line}`).toBeDefined();
    expect(
      resolution!.source,
      "expected the resolved region to chain to real .ddd source",
    ).toBeDefined();

    const resolvedLineText = REAL_SOURCE.slice(0, resolution!.source!.span.start).split("\n");
    const resolvedLine = resolvedLineText.length;
    expect(resolvedLine).toBe(LET_LINE);

    // Concrete numbers for the report (also asserted, not just logged).
    expect({
      dddLine: LET_LINE,
      genFile: file,
      genLine: line,
      resolvedBackLine: resolvedLine,
    }).toEqual({
      dddLine: LET_LINE,
      genFile: file,
      genLine: line,
      resolvedBackLine: LET_LINE,
    });
  });
});
