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
  statementExprMarks,
  statementSubRegions,
} from "../../../src/generator/typescript/render-stmt.js";
import type { ExprIR, PathIR, StmtIR } from "../../../src/ir/types/loom-ir.js";
import type { OriginRef } from "../../../src/ir/types/origin.js";

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

// Span-tracking emission (span-tracking-emission.md, M15 phase 7 slice 2):
// `statementExprMarks` locates a `let`/`assign`/`return` RHS's rendered text
// inside its own already-rendered chunk; `statementSubRegions`'s optional
// 4th param then turns each mark into a column-bearing sub-region layered
// alongside the plain per-statement one.
describe("statementExprMarks", () => {
  const origin: OriginRef = { kind: "source", path: "/a.ddd", span: { start: 5, end: 17 } };

  it("marks a `let`'s RHS ref at its real position inside the rendered chunk", () => {
    const stmt: StmtIR = {
      kind: "let",
      name: "note",
      expr: { kind: "ref", name: "customerName", refKind: "this-prop", origin },
      type: { kind: "primitive", name: "string" },
    };
    const [chunk] = renderTsStatementChunks([stmt]);
    expect(chunk).toBe("    const note = this._customerName;");
    const marks = statementExprMarks(stmt, chunk!);
    expect(marks).toHaveLength(1);
    const [mark] = marks;
    expect(chunk!.slice(mark!.start, mark!.end)).toBe("this._customerName");
    expect(mark!.origin).toEqual(origin);
  });

  it("marks an `assign`'s value and a `return`'s value the same way", () => {
    // Target and value deliberately name DIFFERENT fields — `count := total`
    // rather than a self-referential `count := count`, whose target text
    // would collide with the RHS text and honestly (and correctly) skip
    // per the anchor-ambiguity rule (see the sibling-ambiguity unit tests
    // in render-expr-marks.test.ts).
    const assign: StmtIR = {
      kind: "assign",
      target: { segments: ["count"] },
      value: { kind: "ref", name: "total", refKind: "this-prop", origin },
      targetType: { kind: "primitive", name: "int" },
    };
    const [assignChunk] = renderTsStatementChunks([assign]);
    const assignMarks = statementExprMarks(assign, assignChunk!);
    expect(assignMarks).toHaveLength(1);
    expect(assignChunk!.slice(assignMarks[0]!.start, assignMarks[0]!.end)).toBe("this._total");

    const ret: StmtIR = {
      kind: "return",
      value: { kind: "ref", name: "count", refKind: "this-prop", origin },
    };
    const [retChunk] = renderTsStatementChunks([ret]);
    const retMarks = statementExprMarks(ret, retChunk!);
    expect(retMarks).toHaveLength(1);
    expect(retChunk!.slice(retMarks[0]!.start, retMarks[0]!.end)).toBe("this._count");
  });

  it("returns no marks for statement kinds outside the let/assign/return narrowing", () => {
    const stmt: StmtIR = {
      kind: "emit",
      eventName: "Thing",
      fields: [{ name: "n", value: { kind: "ref", name: "count", refKind: "this-prop", origin } }],
    };
    const [chunk] = renderTsStatementChunks([stmt]);
    expect(statementExprMarks(stmt, chunk!)).toHaveLength(0);
  });

  it("returns no marks when the RHS carries no origin", () => {
    const stmt: StmtIR = {
      kind: "let",
      name: "note",
      expr: { kind: "ref", name: "customerName", refKind: "this-prop" },
      type: { kind: "primitive", name: "string" },
    };
    const [chunk] = renderTsStatementChunks([stmt]);
    expect(statementExprMarks(stmt, chunk!)).toHaveLength(0);
  });
});

describe("statementSubRegions — exprMarks parameter", () => {
  it("layers a column-bearing sub-region alongside the coarse per-statement region", () => {
    const origin: OriginRef = { kind: "source", path: "/a.ddd", span: { start: 5, end: 17 } };
    const stmts: StmtIR[] = [
      {
        kind: "let",
        name: "note",
        expr: { kind: "ref", name: "customerName", refKind: "this-prop", origin },
        type: { kind: "primitive", name: "string" },
        origin,
      },
    ];
    const chunks = renderTsStatementChunks(stmts);
    const exprMarks = stmts.map((s, i) => statementExprMarks(s, chunks[i]!));
    const regions = statementSubRegions(stmts, chunks, "Ctx.Agg.op", exprMarks);

    // The coarse per-statement region (from `stmts[0].origin`) plus the
    // fine expression-level one (from the `customerName` ref's origin) —
    // both on the SAME (single) generated line.
    expect(regions).toHaveLength(2);
    const coarse = regions.find((r) => r.col === undefined);
    const fine = regions.find((r) => r.col !== undefined);
    expect(coarse).toBeDefined();
    expect(fine).toBeDefined();
    expect(fine!.rel).toEqual(coarse!.rel);
    expect(fine!.col![0]).toBeLessThan(fine!.col![1]);
    const chunk = chunks[0]!;
    // The column range slices to exactly the marked text inside the chunk
    // (1-based, half-open — `endCol - 1` is the last included character).
    expect(chunk.slice(fine!.col![0] - 1, fine!.col![1] - 1)).toBe("this._customerName");
  });

  it("omits exprMarks entirely when the 4th param is not passed (backward-compatible)", () => {
    const origin: OriginRef = { kind: "source", path: "/a.ddd", span: { start: 0, end: 5 } };
    const stmts: StmtIR[] = [
      {
        kind: "let",
        name: "x",
        expr: { kind: "literal", lit: "int", value: "1" },
        type: { kind: "primitive", name: "int" },
        origin,
      },
    ];
    const chunks = renderTsStatementChunks(stmts);
    const regions = statementSubRegions(stmts, chunks, "Ctx.Agg.op");
    expect(regions).toHaveLength(1);
    expect(regions[0]!.col).toBeUndefined();
  });
});
