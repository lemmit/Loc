import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { translateBreakpoint } from "../../src/dap/breakpoints.js";
import { generateSystems } from "../../src/system/index.js";
import { parseFrames } from "../../src/trace/frames.js";
import { resolveFrame, type SourceMap } from "../../src/trace/resolve.js";
import { parseValid } from "../_helpers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

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

  it("a region carrying targetCol surfaces column as targetCol[0]", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        "hono_api/domain/order.ts": [
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm",
            targetCol: [11, 22],
          },
        ],
      },
    };

    const out = translateBreakpoint(map, "main.ddd", CONFIRM_LINE, readSource);
    expect(out).toHaveLength(1);
    expect(out[0]!.column).toBe(11);
  });

  it("a column-less (coarse) region surfaces column === undefined", () => {
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
    expect(out).toHaveLength(1);
    expect(out[0]!.column).toBeUndefined();
  });

  it("two fine regions on the SAME generated line at DIFFERENT columns both survive, narrowest-origin-span first", () => {
    // Two distinct sub-expressions inside `confirm`'s body, both emitted on
    // generated line 55 but at different columns — e.g. two operands of one
    // rendered statement. `CONFIRM_SPAN` (narrower) and `AGGREGATE_SPAN`
    // (wider) both cover CONFIRM_LINE, so both are candidates; distinct
    // `targetCol` starts mean the widened `{file,line,column}` key must keep
    // both instead of collapsing to one.
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        "hono_api/domain/order.ts": [
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: AGGREGATE_SPAN },
            construct: "Orders.Order (wide)",
            targetCol: [32, 39],
          },
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm (narrow)",
            targetCol: [11, 22],
          },
        ],
      },
    };

    const out = translateBreakpoint(map, "main.ddd", CONFIRM_LINE, readSource);
    expect(out.map((t) => ({ file: t.file, line: t.line, column: t.column }))).toEqual([
      { file: "hono_api/domain/order.ts", line: 55, column: 11 }, // narrowest origin span first
      { file: "hono_api/domain/order.ts", line: 55, column: 32 }, // widest origin span last
    ]);
  });

  it("same-line, column-less duplicate still collapses to one (byte-identical to pre-column behavior)", () => {
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
    expect(out[0]!.column).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Column round trip over `examples/showcase.ddd` — the same forward∘reverse
// proof as above, but over a `.ddd` line whose region carries a real
// `targetCol` (a `requires <cond>` guard — the only TS/Hono construct this
// slice's marks-carrying statement renderer marks with columns). Nothing
// below is hardcoded to a known-good line/file/column: the qualifying
// generated (file, line) — one hosting >=2 DISTINCT `targetCol` starts, the
// de-dup-key-widening proof from real output — is discovered by scanning the
// emitted sourcemap itself (the #1748 no-hardcode pattern), matching
// docs/plans/dap-node-debug.md's scouted showcase.ddd fixture (a `requires
// currentUser.role == "admin"` guard collapsing four fine regions to two
// armable columns).
// ---------------------------------------------------------------------------

describe("translateBreakpoint — column round trip over examples/showcase.ddd", () => {
  it("a requires-guard .ddd line surfaces >=2 distinct columns on one generated line, and forward-with-column round-trips through resolveFrame", async () => {
    const showcaseSource = fs.readFileSync(path.join(repoRoot, "examples", "showcase.ddd"), "utf8");
    const model = await parseValid(showcaseSource);
    const { files } = generateSystems(model, { sourcemap: true });
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as SourceMap;
    const dddPath = map.sources[0]!;

    // Find a (genFile, genLine) pair carrying >=2 distinct `targetCol[0]`
    // starts among a single backend domain file's regions — the collapsing
    // proof the brief scouted (showcase.ddd's `requires currentUser.role ==
    // "admin"` guard, four fine regions -> two distinct columns).
    let found: { genFile: string; genLine: number } | undefined;
    for (const genFile of Object.keys(map.files)) {
      if (!/domain\/.*\.ts$/.test(genFile)) continue;
      const byLine = new Map<number, Set<number>>();
      for (const r of map.files[genFile]!) {
        if (!r.targetCol) continue;
        const set = byLine.get(r.target[0]) ?? new Set<number>();
        set.add(r.targetCol[0]);
        byLine.set(r.target[0], set);
      }
      for (const [line, cols] of byLine) {
        if (cols.size >= 2) {
          found = { genFile, genLine: line };
          break;
        }
      }
      if (found) break;
    }
    expect(
      found,
      "expected some domain/*.ts line with >=2 distinct targetCol starts",
    ).toBeDefined();
    const { genFile, genLine } = found!;

    // Derive the `.ddd` line hosting that construct from one of the
    // qualifying regions' own origin span (any of them lands on the same
    // `.ddd` line — they're all sub-expressions of the same guard).
    const anyRegion = map.files[genFile]!.find(
      (r) => r.target[0] === genLine && r.targetCol !== undefined,
    )!;
    const anyOrigin = anyRegion.origin;
    if (anyOrigin.kind !== "source") throw new Error("expected a source origin");
    const dddLine = showcaseSource.slice(0, anyOrigin.span[0]).split("\n").length;

    // Forward: translateBreakpoint over the real map surfaces >=2
    // column-bearing targets on (genFile, genLine) with distinct columns.
    // (The same line also hosts a coarse, column-less region for the whole
    // `requires` statement — a THIRD, separate survivor under the widened
    // key, since its column suffix ("") differs from either fine column; it
    // is filtered out here because this assertion is specifically about the
    // column-bearing survivors.)
    const targets = translateBreakpoint(map, dddPath, dddLine, () => showcaseSource);
    const onLineWithColumn = targets.filter(
      (t) => t.file === genFile && t.line === genLine && t.column !== undefined,
    );
    expect(onLineWithColumn.length).toBeGreaterThanOrEqual(2);
    const columns = onLineWithColumn.map((t) => t.column);
    expect(new Set(columns).size).toBeGreaterThanOrEqual(2);

    // Back: a synthesized V8 stack-frame string ("at <file>:<line>:<col>")
    // for the narrowest (first-sorted) column-bearing target resolves BACK
    // to the SAME `.ddd` line via parseFrames + resolveFrame — the exact
    // forward-with-column ∘ reverse-with-column loop a real DAP adapter runs.
    const target = onLineWithColumn[0]!;
    const frameLine = `    at fn (${target.file}:${target.line}:${target.column})`;
    const [parsedFrame] = parseFrames(frameLine);
    expect(parsedFrame, `parseFrames found no frame in ${JSON.stringify(frameLine)}`).toBeDefined();
    expect(parsedFrame!.col).toBe(target.column);

    const resolution = resolveFrame(parsedFrame!, map);
    expect(
      resolution,
      `resolveFrame found no region for ${target.file}:${target.line}:${target.column}`,
    ).toBeDefined();
    expect(resolution!.region.targetCol, "expected the column-aware path to win").toBeDefined();
    expect(
      resolution!.source,
      "expected the resolved region to chain to real .ddd source",
    ).toBeDefined();

    const resolvedLine = showcaseSource.slice(0, resolution!.source!.span.start).split("\n").length;

    // Concrete numbers for the report (also asserted, not just logged).
    expect({
      dddLine,
      genFile: target.file,
      genLine: target.line,
      column: target.column,
      distinctColumnsOnLine: new Set(columns).size,
      resolvedBackLine: resolvedLine,
    }).toEqual({
      dddLine,
      genFile: target.file,
      genLine: target.line,
      column: target.column,
      distinctColumnsOnLine: new Set(columns).size,
      resolvedBackLine: dddLine,
    });
  });
});
