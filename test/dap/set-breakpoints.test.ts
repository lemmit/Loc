import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DapSetBreakpointsArguments } from "../../src/dap/dap-protocol.js";
import { resolveSetBreakpoints } from "../../src/dap/set-breakpoints.js";
import { generateSystems } from "../../src/system/index.js";
import { resolveFrame, type SourceMap } from "../../src/trace/resolve.js";
import { parseValid } from "../_helpers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// ---------------------------------------------------------------------------
// `resolveSetBreakpoints` — the DAP `setBreakpoints` resolution core built
// on `translateBreakpoint`. Hand-built fixture maps mirroring
// test/dap/breakpoints.test.ts's discipline, plus a real round trip over
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
 *  convention test/dap/breakpoints.test.ts's `startOfLine` uses. */
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
// CONFIRM_LINE too, for the multi-file fan-out case below.
const AGGREGATE_LINE = 4;
const AGGREGATE_SPAN: [number, number] = [startOfLine(AGGREGATE_LINE), startOfLine(8)];

const NO_MATCH_LINE = 2; // "subdomain Sales {" — covered by no region

const readSource = () => DDD_SOURCE;

const GEN_FILE = "hono_api/domain/order.ts";

describe("resolveSetBreakpoints", () => {
  it("verified, line-only: a coarse (column-less) region resolves with no column key set", () => {
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

    const args: DapSetBreakpointsArguments = {
      source: { path: "main.ddd" },
      breakpoints: [{ line: CONFIRM_LINE }],
    };

    const out = resolveSetBreakpoints(args, map, readSource);
    expect(out).toEqual([{ verified: true, line: 55, source: { path: GEN_FILE } }]);
    expect(out[0]).not.toHaveProperty("column");
  });

  it("verified, with column: a targetCol-bearing region surfaces column = targetCol[0]", () => {
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        [GEN_FILE]: [
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm",
            targetCol: [11, 22],
          },
        ],
      },
    };

    const args: DapSetBreakpointsArguments = {
      source: { path: "main.ddd" },
      breakpoints: [{ line: CONFIRM_LINE }],
    };

    const out = resolveSetBreakpoints(args, map, readSource);
    expect(out).toEqual([{ verified: true, line: 55, column: 11, source: { path: GEN_FILE } }]);
  });

  it("unverified on no mapping: keeps the requested .ddd line, names the reason", () => {
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

    const args: DapSetBreakpointsArguments = {
      source: { path: "main.ddd" },
      breakpoints: [{ line: NO_MATCH_LINE }],
    };

    const out = resolveSetBreakpoints(args, map, readSource);
    expect(out).toHaveLength(1);
    expect(out[0]!.verified).toBe(false);
    expect(out[0]!.line).toBe(NO_MATCH_LINE);
    expect(out[0]!.message).toMatch(/No generated location/);
  });

  it("1:1 positional correspondence: 3 requested breakpoints (mix of mapped + unmapped) -> response length 3, same order", () => {
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

    const args: DapSetBreakpointsArguments = {
      source: { path: "main.ddd" },
      breakpoints: [
        { line: NO_MATCH_LINE }, // unmapped
        { line: CONFIRM_LINE }, // mapped
        { line: NO_MATCH_LINE }, // unmapped again
      ],
    };

    const out = resolveSetBreakpoints(args, map, readSource);
    expect(out).toHaveLength(3);
    expect(out[0]!.verified).toBe(false);
    expect(out[0]!.line).toBe(NO_MATCH_LINE);
    expect(out[1]!.verified).toBe(true);
    expect(out[1]!.line).toBe(55);
    expect(out[2]!.verified).toBe(false);
    expect(out[2]!.line).toBe(NO_MATCH_LINE);
  });

  it("multi-file fan-out -> exactly one DapBreakpoint, reporting the NARROWEST target", () => {
    const OTHER_GEN_FILE = "hono_api/domain/order-wide.ts";
    const map: SourceMap = {
      version: 1,
      sources: ["main.ddd"],
      files: {
        // Wide (whole-aggregate) region in one generated file...
        [OTHER_GEN_FILE]: [
          {
            target: [40, 40],
            origin: { kind: "source", path: "main.ddd", span: AGGREGATE_SPAN },
            construct: "Orders.Order (wide)",
          },
        ],
        // ...and a narrower (operation) region in a DIFFERENT generated file,
        // both covering CONFIRM_LINE.
        [GEN_FILE]: [
          {
            target: [55, 55],
            origin: { kind: "source", path: "main.ddd", span: CONFIRM_SPAN },
            construct: "Orders.Order.confirm",
          },
        ],
      },
    };

    const args: DapSetBreakpointsArguments = {
      source: { path: "main.ddd" },
      breakpoints: [{ line: CONFIRM_LINE }],
    };

    const out = resolveSetBreakpoints(args, map, readSource);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ verified: true, line: 55, source: { path: GEN_FILE } });
  });

  it("source.path undefined -> all breakpoints unverified, message names the reason", () => {
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

    const args: DapSetBreakpointsArguments = {
      source: {},
      breakpoints: [{ line: CONFIRM_LINE }, { line: NO_MATCH_LINE }],
    };

    const out = resolveSetBreakpoints(args, map, readSource);
    expect(out).toEqual([
      { verified: false, message: "source has no path" },
      { verified: false, message: "source has no path" },
    ]);
  });

  it("empty/absent breakpoints -> []", () => {
    const map: SourceMap = { version: 1, sources: ["main.ddd"], files: {} };

    expect(resolveSetBreakpoints({ source: { path: "main.ddd" } }, map, readSource)).toEqual([]);
    expect(
      resolveSetBreakpoints({ source: { path: "main.ddd" }, breakpoints: [] }, map, readSource),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REAL round trip over examples/showcase.ddd — mirrors
// test/dap/breakpoints.test.ts's own showcase.ddd round trip. Nothing here
// is hardcoded: the qualifying (line, column) is derived from the emitted
// sourcemap itself, matching the brief's scouted fixture (a `requires
// currentUser.role == "admin"` guard, column-bearing).
// ---------------------------------------------------------------------------

describe("resolveSetBreakpoints — real round trip over examples/showcase.ddd", () => {
  it("resolves a requires-guard .ddd line to a verified, column-bearing generated breakpoint, and round-trips back via resolveFrame", async () => {
    const showcaseSource = fs.readFileSync(path.join(repoRoot, "examples", "showcase.ddd"), "utf8");
    const model = await parseValid(showcaseSource);
    const { files } = generateSystems(model, { sourcemap: true });
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as SourceMap;
    const dddPath = map.sources[0]!;

    // Locate the `requires currentUser.role == "admin"` line the same way
    // breakpoints.test.ts does: find a domain/*.ts line carrying >=1
    // targetCol region, then derive the .ddd line from its origin span.
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

    const anyRegion = map.files[found!.genFile]!.find(
      (r) => r.target[0] === found!.genLine && r.targetCol !== undefined,
    )!;
    if (anyRegion.origin.kind !== "source") throw new Error("expected a source origin");
    const dddLine = showcaseSource.slice(0, anyRegion.origin.span[0]).split("\n").length;

    const args: DapSetBreakpointsArguments = {
      source: { path: dddPath },
      breakpoints: [{ line: dddLine }],
    };

    const out = resolveSetBreakpoints(args, map, (p) =>
      p === dddPath ? showcaseSource : undefined,
    );
    expect(out).toHaveLength(1);
    const bp = out[0]!;
    expect(bp.verified).toBe(true);
    expect(bp.source?.path).toMatch(/domain\/.*\.ts$/);
    expect(bp.column).toBeDefined();

    // Back: resolveFrame from the resolved generated file:line:col resolves
    // to a region whose origin lands on the SAME .ddd line — closing
    // forward-DAP (this resolver) ∘ reverse (the already-shipped
    // resolveFrame).
    const resolution = resolveFrame(
      { lineIndex: 0, file: bp.source!.path!, line: bp.line!, col: bp.column },
      map,
    );
    expect(
      resolution,
      `resolveFrame found no region for ${bp.source!.path}:${bp.line}:${bp.column}`,
    ).toBeDefined();
    expect(
      resolution!.source,
      "expected the resolved region to chain to real .ddd source",
    ).toBeDefined();
    const resolvedLine = showcaseSource.slice(0, resolution!.source!.span.start).split("\n").length;

    // Concrete numbers for the report (also asserted, not just logged).
    expect({
      dddLine,
      genFile: bp.source!.path,
      genLine: bp.line,
      column: bp.column,
      resolvedBackLine: resolvedLine,
    }).toEqual({
      dddLine,
      genFile: bp.source!.path,
      genLine: bp.line,
      column: bp.column,
      resolvedBackLine: dddLine,
    });
  });
});
