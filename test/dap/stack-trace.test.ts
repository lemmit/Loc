import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DapStackFrame } from "../../src/dap/dap-protocol.js";
import { remapStackFrames } from "../../src/dap/stack-trace.js";
import { generateSystems } from "../../src/system/index.js";
import type { SourceMap } from "../../src/trace/resolve.js";
import { parseValid } from "../_helpers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// ---------------------------------------------------------------------------
// `remapStackFrames` — the DAP `stackTrace` remap core, the REVERSE twin of
// `resolveSetBreakpoints` (test/dap/set-breakpoints.test.ts). Hand-built
// fixture maps mirroring that file's discipline, plus a real round trip over
// examples/showcase.ddd (the brief's scouted column-bearing fixture).
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
 *  convention test/dap/set-breakpoints.test.ts's `startOfLine` uses. */
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

// The whole-aggregate span, lines 4 through 7 inclusive — covers
// CONFIRM_LINE too, for the column-disambiguation case below.
const AGGREGATE_LINE = 4;
const AGGREGATE_SPAN: [number, number] = [startOfLine(AGGREGATE_LINE), startOfLine(8)];

const readSource = (p: string) => (p === "main.ddd" ? DDD_SOURCE : undefined);

const GEN_FILE = "hono_api/domain/order.ts";

describe("remapStackFrames", () => {
  it("resolved, line-only: a coarse (column-less) region rewrites source/line, keeps id/name", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        [GEN_FILE]: [
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm",
          },
        ],
      },
    };

    const frames: DapStackFrame[] = [
      { id: 1, name: "confirm", source: { path: GEN_FILE }, line: 55, column: 1 },
    ];

    const out = remapStackFrames(frames, map, readSource);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: 1,
      name: "confirm",
      source: { path: "main.ddd" },
      line: CONFIRM_LINE,
      column: CONFIRM_OFFSET_IN_LINE + 1,
    });
  });

  it("resolved, column-aware: a targetCol region disambiguates between two spans sharing the same generated line", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        [GEN_FILE]: [
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

    const narrowFrame: DapStackFrame = {
      id: 2,
      name: "confirm",
      source: { path: GEN_FILE },
      line: 55,
      column: 11,
    };
    const wideFrame: DapStackFrame = {
      id: 3,
      name: "confirm",
      source: { path: GEN_FILE },
      line: 55,
      column: 32,
    };

    const [narrowOut, wideOut] = remapStackFrames([narrowFrame, wideFrame], map, readSource);

    // column 11 lands in the NARROW (confirm) targetCol -> resolves to
    // CONFIRM_SPAN's line/column.
    expect(narrowOut).toEqual({
      id: 2,
      name: "confirm",
      source: { path: "main.ddd" },
      line: CONFIRM_LINE,
      column: CONFIRM_OFFSET_IN_LINE + 1,
    });

    // column 32 lands in the WIDE (whole-aggregate) targetCol -> resolves to
    // AGGREGATE_SPAN's line/column (AGGREGATE_LINE, column 1).
    expect(wideOut).toEqual({
      id: 3,
      name: "confirm",
      source: { path: "main.ddd" },
      line: AGGREGATE_LINE,
      column: 1,
    });
  });

  it("unresolved frame (source.path matches no map file) passes through unchanged", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        [GEN_FILE]: [
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm",
          },
        ],
      },
    };

    const frame: DapStackFrame = {
      id: 4,
      name: "<anonymous>",
      source: { path: "<node_internals>/internal/process/task_queues.js" },
      line: 12,
      column: 3,
    };

    const out = remapStackFrames([frame], map, readSource);
    expect(out).toEqual([frame]);
    expect(out[0]).toBe(frame); // byte-identical: same object, not a rebuilt copy
  });

  it("frame with no source passes through unchanged", () => {
    const map: SourceMap = { version: 1, sources: ["main.ddd"], files: {} };
    const frame: DapStackFrame = { id: 5, name: "native", line: 0, column: 0 };

    const out = remapStackFrames([frame], map, readSource);
    expect(out).toEqual([frame]);
  });

  it("1:1 order + length: a mixed stack (resolved + unresolved) rewrites only the resolved frame", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        [GEN_FILE]: [
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm",
          },
        ],
      },
    };

    const internalFrame: DapStackFrame = {
      id: 10,
      name: "<anonymous>",
      source: { path: "<node_internals>/internal/timers.js" },
      line: 5,
      column: 1,
    };
    const resolvedFrame: DapStackFrame = {
      id: 11,
      name: "confirm",
      source: { path: GEN_FILE },
      line: 55,
      column: 1,
    };
    const noSourceFrame: DapStackFrame = { id: 12, name: "native", line: 0, column: 0 };

    const out = remapStackFrames([internalFrame, resolvedFrame, noSourceFrame], map, readSource);

    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(internalFrame);
    expect(out[1]).toEqual({
      id: 11,
      name: "confirm",
      source: { path: "main.ddd" },
      line: CONFIRM_LINE,
      column: CONFIRM_OFFSET_IN_LINE + 1,
    });
    expect(out[2]).toEqual(noSourceFrame);
  });

  it("readSource returning undefined for the resolved path -> passthrough (honest, no guess)", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        [GEN_FILE]: [
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm",
          },
        ],
      },
    };

    const frame: DapStackFrame = {
      id: 6,
      name: "confirm",
      source: { path: GEN_FILE },
      line: 55,
      column: 1,
    };

    const out = remapStackFrames([frame], map, () => undefined);
    expect(out).toEqual([frame]);
  });

  it("empty frames -> []", () => {
    const map: SourceMap = { version: 1, sources: ["main.ddd"], files: {} };
    expect(remapStackFrames([], map, readSource)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REAL round trip over examples/showcase.ddd — mirrors
// test/dap/set-breakpoints.test.ts's own showcase.ddd round trip, but in the
// REVERSE direction: starting from a generated `domain/*.ts` file:line:col
// (the site M23/M24 used forward), remap it back to `.ddd` source. Nothing
// here is hardcoded: the qualifying generated (file, line, column) is
// discovered by scanning the emitted sourcemap itself.
// ---------------------------------------------------------------------------

describe("remapStackFrames — real round trip over examples/showcase.ddd", () => {
  it("a generated domain/*.ts:line:col frame (targetCol-covered) remaps back to the requires-guard .ddd line", async () => {
    const showcaseSource = fs.readFileSync(path.join(repoRoot, "examples", "showcase.ddd"), "utf8");
    const model = await parseValid(showcaseSource);
    const { files } = generateSystems(model, { sourcemap: true });
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as SourceMap;
    const dddPath = map.sources[0]!;

    // Locate a domain/*.ts region carrying a targetCol — the same
    // `requires currentUser.role == "admin"` guard construct M23/M24's
    // round trips used (`hono_api/domain/build.ts:45` at column 11 or 32,
    // per the brief's scouted fixture).
    let found: { genFile: string; genLine: number; column: number } | undefined;
    for (const genFile of Object.keys(map.files)) {
      if (!/domain\/.*\.ts$/.test(genFile)) continue;
      for (const r of map.files[genFile]!) {
        if (r.targetCol === undefined) continue;
        found = { genFile, genLine: r.target[0], column: r.targetCol[0] };
        break;
      }
      if (found) break;
    }
    expect(found, "expected some domain/*.ts region carrying targetCol").toBeDefined();
    const { genFile, genLine, column } = found!;

    // Derive the expected `.ddd` line the same way the forward tests do:
    // from the matched region's own origin span.
    const anyRegion = map.files[genFile]!.find(
      (r) => r.target[0] === genLine && r.targetCol !== undefined && r.targetCol[0] === column,
    )!;
    if (anyRegion.origin.kind !== "source") throw new Error("expected a source origin");
    const expectedDddLine = showcaseSource.slice(0, anyRegion.origin.span[0]).split("\n").length;

    const frame: DapStackFrame = {
      id: 100,
      name: "requires guard",
      source: { path: genFile },
      line: genLine,
      column,
    };

    const [out] = remapStackFrames([frame], map, (p) =>
      p === dddPath ? showcaseSource : undefined,
    );

    // `dddPath` (`map.sources[0]`) is the in-memory parsed document's own
    // URI (e.g. `/1.ddd`, not a real on-disk `showcase.ddd` path — see
    // test/dap/set-breakpoints.test.ts's own round trip for the same
    // convention), but it's the SAME path every region's `origin.path` was
    // recorded against, so it's what a real caller (which reads this same
    // map) would pass too.
    expect(out!.id).toBe(100);
    expect(out!.name).toBe("requires guard");
    expect(out!.source?.path).toBe(dddPath);
    expect(out!.line).toBe(expectedDddLine);

    // Concrete numbers for the report (also asserted, not just logged).
    expect({
      genFile,
      genLine,
      column,
      dddLine: out!.line,
    }).toEqual({
      genFile,
      genLine,
      column,
      dddLine: expectedDddLine,
    });
  });
});
