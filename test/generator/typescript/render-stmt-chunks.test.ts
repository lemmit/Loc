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

  it("returns no marks for a variant-match-shaped statement kind (frontend-only; never reaches this backend in practice)", () => {
    // `variant-match` is the one StmtIR kind `markableExprsOf` never returns
    // exprs for (`renderTsStatement` throws on it before this would ever be
    // called for real) — falls through to `default: []` alongside any future
    // unhandled kind. Exercise `statementExprMarks` directly (bypassing the
    // throwing renderer) to pin the empty-list arm.
    const stmt: StmtIR = {
      kind: "variant-match",
      subject: { kind: "ref", name: "x", refKind: "param" },
      arms: [],
    };
    expect(statementExprMarks(stmt, "    // unreachable")).toHaveLength(0);
  });

  it("marks a precondition's predicate expression", () => {
    const stmt: StmtIR = {
      kind: "precondition",
      expr: { kind: "ref", name: "isActive", refKind: "this-prop", origin },
      source: "isActive",
    };
    const [chunk] = renderTsStatementChunks([stmt]);
    expect(chunk).toBe(
      '    if (!(this._isActive)) throw new DomainError("Precondition failed: isActive");',
    );
    const marks = statementExprMarks(stmt, chunk!);
    expect(marks).toHaveLength(1);
    expect(chunk!.slice(marks[0]!.start, marks[0]!.end)).toBe("this._isActive");
  });

  it("marks a requires predicate expression", () => {
    const stmt: StmtIR = {
      kind: "requires",
      expr: { kind: "ref", name: "isAdmin", refKind: "this-prop", origin },
      source: "isAdmin",
    };
    const [chunk] = renderTsStatementChunks([stmt]);
    const marks = statementExprMarks(stmt, chunk!);
    expect(marks).toHaveLength(1);
    expect(chunk!.slice(marks[0]!.start, marks[0]!.end)).toBe("this._isAdmin");
  });

  it("marks an add/remove's value expression", () => {
    const add: StmtIR = {
      kind: "add",
      target: { segments: ["tags"] },
      value: { kind: "ref", name: "newTag", refKind: "this-prop", origin },
      elementType: { kind: "primitive", name: "string" },
      collection: true,
    };
    const [addChunk] = renderTsStatementChunks([add]);
    const addMarks = statementExprMarks(add, addChunk!);
    expect(addMarks).toHaveLength(1);
    expect(addChunk!.slice(addMarks[0]!.start, addMarks[0]!.end)).toBe("this._newTag");

    const remove: StmtIR = {
      kind: "remove",
      target: { segments: ["tags"] },
      value: { kind: "ref", name: "oldTag", refKind: "this-prop", origin },
      elementType: { kind: "primitive", name: "string" },
      collection: true,
    };
    const [removeChunk] = renderTsStatementChunks([remove]);
    const removeMarks = statementExprMarks(remove, removeChunk!);
    expect(removeMarks).toHaveLength(1);
    expect(removeChunk!.slice(removeMarks[0]!.start, removeMarks[0]!.end)).toBe("this._oldTag");
  });

  it("marks a bare `expression` statement's expr", () => {
    const stmt: StmtIR = {
      kind: "expression",
      expr: { kind: "ref", name: "counter", refKind: "this-prop", origin },
    };
    const [chunk] = renderTsStatementChunks([stmt]);
    const marks = statementExprMarks(stmt, chunk!);
    expect(marks).toHaveLength(1);
    expect(chunk!.slice(marks[0]!.start, marks[0]!.end)).toBe("this._counter");
  });

  it("marks every field value of a multi-field emit independently", () => {
    const origin2: OriginRef = { kind: "source", path: "/a.ddd", span: { start: 20, end: 30 } };
    const stmt: StmtIR = {
      kind: "emit",
      eventName: "Thing",
      fields: [
        { name: "n", value: { kind: "ref", name: "count", refKind: "this-prop", origin } },
        {
          name: "m",
          value: { kind: "ref", name: "otherCount", refKind: "this-prop", origin: origin2 },
        },
      ],
    };
    const [chunk] = renderTsStatementChunks([stmt]);
    const marks = statementExprMarks(stmt, chunk!);
    expect(marks).toHaveLength(2);
    const texts = marks.map((m) => chunk!.slice(m.start, m.end)).sort();
    expect(texts).toEqual(["this._count", "this._otherCount"]);
  });

  it("marks every arg of a multi-arg call independently, but two IDENTICAL args mutually skip while a distinct sibling still resolves", () => {
    const distinctArg: StmtIR = {
      kind: "call",
      target: "function",
      name: "helper",
      args: [
        { kind: "ref", name: "a", refKind: "this-prop", origin },
        { kind: "ref", name: "b", refKind: "this-prop", origin },
      ],
    };
    const [distinctChunk] = renderTsStatementChunks([distinctArg]);
    const distinctMarks = statementExprMarks(distinctArg, distinctChunk!);
    expect(distinctMarks).toHaveLength(2);
    const texts = distinctMarks.map((m) => distinctChunk!.slice(m.start, m.end)).sort();
    expect(texts).toEqual(["this._a", "this._b"]);

    // Two args that render to the IDENTICAL text: `indexOf` can't tell the
    // two occurrences apart for EITHER of them, so both honestly skip, while
    // a third, distinct sibling arg still resolves.
    const identicalArgs: StmtIR = {
      kind: "call",
      target: "function",
      name: "helper",
      args: [
        { kind: "ref", name: "dup", refKind: "this-prop", origin },
        { kind: "ref", name: "dup", refKind: "this-prop", origin },
        { kind: "ref", name: "unique", refKind: "this-prop", origin },
      ],
    };
    const [dupChunk] = renderTsStatementChunks([identicalArgs]);
    const dupMarks = statementExprMarks(identicalArgs, dupChunk!);
    expect(dupMarks).toHaveLength(1);
    expect(dupChunk!.slice(dupMarks[0]!.start, dupMarks[0]!.end)).toBe("this._unique");
  });

  it("a traced precondition anchors into (or honestly skips) the __pre_N_ok binding line", () => {
    const stmt: StmtIR = {
      kind: "precondition",
      expr: { kind: "ref", name: "isActive", refKind: "this-prop", origin },
      source: "isActive",
    };
    const traceCtx = { emitTrace: true, aggregate: "Widget", op: "touch" };
    const [chunk] = renderTsStatementChunks([stmt], false, traceCtx);
    // Multi-line chunk: `const __pre_0_ok = (this._isActive);` on line 1,
    // then a trace-log line repeating the SOURCE text `"isActive"` (not the
    // rendered `this._isActive`), then the conditional throw.
    expect(chunk).toContain("const __pre_0_ok = (this._isActive);");
    const marks = statementExprMarks(stmt, chunk!);
    // `this._isActive` appears exactly once in the whole chunk (the JSON
    // source-text echo is `"isActive"`, not `this._isActive`), so the anchor
    // resolves cleanly into the __pre_0_ok binding.
    expect(marks).toHaveLength(1);
    expect(chunk!.slice(marks[0]!.start, marks[0]!.end)).toBe("this._isActive");
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

  // The chunk-level anchor is the same one-occurrence discipline the
  // composer applies per level — pin its two skip arms directly, since no
  // real renderTsStatementChunks output in the fixture triggers them (a
  // provenance/trace-wrapped chunk repeating the RHS in its snapshot array
  // is the real-world case the ambiguity arm exists for).
  it("returns no marks when the RHS text occurs more than once in the chunk (ambiguous anchor)", () => {
    const origin: OriginRef = { kind: "source", path: "/a.ddd", span: { start: 5, end: 17 } };
    const stmt: StmtIR = {
      kind: "let",
      name: "note",
      expr: { kind: "ref", name: "customerName", refKind: "this-prop", origin },
      type: { kind: "primitive", name: "string" },
    };
    const chunk = '    const note = this._customerName; // __prov: ["this._customerName"]';
    expect(statementExprMarks(stmt, chunk)).toHaveLength(0);
  });

  it("returns no marks when the RHS text does not occur in the chunk at all", () => {
    const origin: OriginRef = { kind: "source", path: "/a.ddd", span: { start: 5, end: 17 } };
    const stmt: StmtIR = {
      kind: "let",
      name: "note",
      expr: { kind: "ref", name: "customerName", refKind: "this-prop", origin },
      type: { kind: "primitive", name: "string" },
    };
    expect(statementExprMarks(stmt, "    const note = somethingElse;")).toHaveLength(0);
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

  it("skips a mark whose start and end fall on different chunk lines (no single col to report)", () => {
    const origin: OriginRef = { kind: "source", path: "/a.ddd", span: { start: 0, end: 5 } };
    const stmts = [{ origin }];
    const chunks = ["    const x = foo(\n        bar);"];
    // A hand-built mark spanning the newline — statementExprMarks never
    // produces one today (only single-line let/assign/return RHS), but
    // statementSubRegions must stay honest if a later slice does.
    const marks = [[{ start: 14, end: 28, origin }]];
    const regions = statementSubRegions(stmts, chunks, "Ctx.Agg.op", marks);
    // Only the coarse per-statement region survives; the multi-line mark is
    // dropped rather than pinned to a wrong single-line column.
    expect(regions).toHaveLength(1);
    expect(regions[0]!.col).toBeUndefined();
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
