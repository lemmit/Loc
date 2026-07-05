// Statement-granular rendering (source-map Milestone 3, Part 2 item 6):
// `renderTsStatementChunks` must produce EXACTLY the per-statement strings
// that `renderTsStatements` joins with "\n" today — `renderTsStatements` is
// now literally `renderTsStatementChunks(...).join("\n")`, so this pins the
// join-equivalence across every StmtIR kind the TS backend renders
// (`variant-match` excluded: it's frontend-only and `renderTsStatement`
// throws on it before ever reaching the TS backend).

import { describe, expect, it } from "vitest";
import {
  renderTsStatementChunks,
  renderTsStatements,
  statementSubRegions,
} from "../../../src/generator/typescript/render-stmt.js";
import type { ExprIR, PathIR, StmtIR } from "../../../src/ir/types/loom-ir.js";

const litInt = (v: string): ExprIR => ({ kind: "literal", lit: "int", value: v });
const thisProp = (name: string): ExprIR => ({ kind: "ref", name, refKind: "this-prop" });
const path = (...segments: string[]): PathIR => ({ segments });

const ALL_KIND_STMTS: StmtIR[] = [
  { kind: "precondition", expr: litInt("1"), source: "1" },
  { kind: "requires", expr: litInt("1"), source: "1" },
  { kind: "let", name: "x", expr: litInt("1"), type: { kind: "primitive", name: "int" } },
  {
    kind: "assign",
    target: path("count"),
    value: litInt("2"),
    targetType: { kind: "primitive", name: "int" },
  },
  {
    kind: "add",
    target: path("tags"),
    value: litInt("3"),
    elementType: { kind: "primitive", name: "int" },
    collection: true,
  },
  {
    kind: "remove",
    target: path("tags"),
    value: litInt("3"),
    elementType: { kind: "primitive", name: "int" },
    collection: true,
  },
  { kind: "emit", eventName: "Thing", fields: [{ name: "n", value: litInt("4") }] },
  { kind: "call", target: "function", name: "helper", args: [] },
  { kind: "expression", expr: thisProp("counter") },
  { kind: "return", value: litInt("5") },
];

describe("renderTsStatementChunks — join-equivalence with renderTsStatements", () => {
  it("chunks.join('\\n') reproduces renderTsStatements byte-for-byte, over every StmtIR kind", () => {
    const chunks = renderTsStatementChunks(ALL_KIND_STMTS);
    expect(chunks).toHaveLength(ALL_KIND_STMTS.length);
    expect(chunks.join("\n")).toBe(renderTsStatements(ALL_KIND_STMTS));
  });

  it("holds with provenance + trace context threaded through too", () => {
    const traceCtx = { emitTrace: true, aggregate: "Widget", op: "touch" };
    const chunks = renderTsStatementChunks(ALL_KIND_STMTS, true, traceCtx);
    expect(chunks.join("\n")).toBe(renderTsStatements(ALL_KIND_STMTS, true, traceCtx));
  });
});

describe("statementSubRegions", () => {
  it("assigns one relative line span per statement, advancing by each chunk's own line count", () => {
    const stmts: StmtIR[] = [
      {
        kind: "let",
        name: "x",
        expr: litInt("1"),
        type: { kind: "primitive", name: "int" },
        origin: { kind: "source", path: "/a.ddd", span: { start: 0, end: 5 } },
      },
      {
        kind: "return",
        value: litInt("2"),
        // No origin — a synthesized statement; must be omitted, not guessed.
      },
      {
        kind: "emit",
        eventName: "Thing",
        fields: [],
        origin: { kind: "source", path: "/a.ddd", span: { start: 10, end: 20 } },
      },
    ];
    const chunks = renderTsStatementChunks(stmts);
    const regions = statementSubRegions(stmts, chunks, "Ctx.Agg.op");

    // The undefined-origin `return` statement contributes no region.
    expect(regions).toHaveLength(2);
    expect(regions[0]!.origin).toEqual(stmts[0]!.origin);
    expect(regions[0]!.construct).toBe("Ctx.Agg.op");
    expect(regions[0]!.rel[0]).toBe(1);
    // The second recorded region (the `emit`, chunk index 2) starts strictly
    // after the first statement's own chunk — proving the cursor advanced
    // past the skipped (no-origin) `return` chunk in between.
    expect(regions[1]!.rel[0]).toBeGreaterThan(regions[0]!.rel[1]);
    expect(regions[1]!.origin).toEqual(stmts[2]!.origin);
  });
});
