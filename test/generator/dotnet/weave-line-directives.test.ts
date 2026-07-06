import { describe, expect, it } from "vitest";
import { offsetToLineCol } from "../../../src/generator/_trace/sourcemap.js";
import { weaveLineDirectives } from "../../../src/generator/dotnet/emit/entity.js";
import type { OriginRef } from "../../../src/ir/types/origin.js";

// ---------------------------------------------------------------------------
// Unit coverage for the weave arms the end-to-end fixture can't reach: every
// statement in a real `.ddd` op body carries an origin, so `#line hidden`
// (a synthesized statement inside an otherwise-mapped body) and the
// all-unmapped `wove: false` skip only get pinned here. Plus edge units for
// the shared 1-based offsetToLineCol.
// ---------------------------------------------------------------------------

const DDD = "line one\nline two\nline three\n";
const PATH = "/proj/main.ddd";
const TEXTS = new Map([[PATH, DDD]]);

const withOrigin = (start: number, end: number): { origin?: OriginRef } => ({
  origin: { kind: "source", path: PATH, span: { start, end } },
});
const noOrigin: { origin?: OriginRef } = {};

describe("weaveLineDirectives", () => {
  it("prepends an enhanced directive per mapped statement and #line hidden per unmapped one", () => {
    const stmts = [withOrigin(0, 8), noOrigin, withOrigin(9, 17)];
    const chunks = ["        var a = 1;", "        Glue();", "        var b = 2;"];
    const { chunks: woven, wove } = weaveLineDirectives(stmts, chunks, TEXTS);
    expect(wove).toBe(true);
    expect(woven).toEqual([
      `#line (1,1)-(1,9) "${PATH}"\n        var a = 1;`,
      "#line hidden\n        Glue();",
      `#line (2,1)-(2,9) "${PATH}"\n        var b = 2;`,
    ]);
  });

  it("leaves an all-unmapped body untouched (never a body of bare #line hidden)", () => {
    const chunks = ["        Glue();", "        MoreGlue();"];
    const { chunks: woven, wove } = weaveLineDirectives([noOrigin, noOrigin], chunks, TEXTS);
    expect(wove).toBe(false);
    expect(woven).toEqual(chunks);
  });

  it("treats a mapped origin whose source text is missing as unmapped", () => {
    const stmts = [
      withOrigin(0, 8),
      { origin: { kind: "source", path: "/other.ddd", span: { start: 0, end: 3 } } } as {
        origin?: OriginRef;
      },
    ];
    const chunks = ["        var a = 1;", "        var b = 2;"];
    const { chunks: woven, wove } = weaveLineDirectives(stmts, chunks, TEXTS);
    expect(wove).toBe(true);
    expect(woven[1]).toBe("#line hidden\n        var b = 2;");
  });

  // --- narrowing arm (M14): `assign`/`return`/`let` prefer the inner
  // expression's own origin over the whole statement's span. ---

  it("narrows an `assign` statement to its `value` expression's origin", () => {
    const stmts = [{ kind: "assign", ...withOrigin(0, 8), value: withOrigin(3, 8) }];
    const chunks = ["        this.A = b;"];
    const { chunks: woven } = weaveLineDirectives(stmts, chunks, TEXTS);
    // (3,8) is inside "line one" — offsets 3..8 map to (1,4)-(1,9).
    expect(woven[0]).toBe(`#line (1,4)-(1,9) "${PATH}"\n        this.A = b;`);
  });

  it("narrows a `return` statement to its `value` expression's origin", () => {
    const stmts = [{ kind: "return", ...withOrigin(0, 8), value: withOrigin(9, 17) }];
    const chunks = ["        return b;"];
    const { chunks: woven } = weaveLineDirectives(stmts, chunks, TEXTS);
    expect(woven[0]).toBe(`#line (2,1)-(2,9) "${PATH}"\n        return b;`);
  });

  it("narrows a `let` statement to its `expr`'s origin", () => {
    const stmts = [{ kind: "let", ...withOrigin(0, 17), expr: withOrigin(9, 17) }];
    const chunks = ["        var tag = b;"];
    const { chunks: woven } = weaveLineDirectives(stmts, chunks, TEXTS);
    expect(woven[0]).toBe(`#line (2,1)-(2,9) "${PATH}"\n        var tag = b;`);
  });

  it("falls back to the statement's own origin when the inner expression has none", () => {
    const stmts = [{ kind: "assign", ...withOrigin(0, 8), value: noOrigin }];
    const chunks = ["        this.A = b;"];
    const { chunks: woven } = weaveLineDirectives(stmts, chunks, TEXTS);
    expect(woven[0]).toBe(`#line (1,1)-(1,9) "${PATH}"\n        this.A = b;`);
  });

  it("leaves a non-narrowed statement kind (e.g. `emit`) on its own statement span", () => {
    const stmts = [{ kind: "emit", ...withOrigin(0, 8) }];
    const chunks = ["        _domainEvents.Add(new Foo());"];
    const { chunks: woven } = weaveLineDirectives(stmts, chunks, TEXTS);
    expect(woven[0]).toBe(`#line (1,1)-(1,9) "${PATH}"\n        _domainEvents.Add(new Foo());`);
  });
});

describe("offsetToLineCol (1-based)", () => {
  it("maps offset 0 to (1,1)", () => {
    expect(offsetToLineCol(DDD, 0)).toEqual({ line: 1, col: 1 });
  });

  it("maps the char right after a newline to the next line's column 1", () => {
    expect(offsetToLineCol(DDD, DDD.indexOf("line two"))).toEqual({ line: 2, col: 1 });
  });

  it("maps a mid-line offset to the right column", () => {
    expect(offsetToLineCol(DDD, DDD.indexOf("two"))).toEqual({ line: 2, col: 6 });
  });

  it("handles offsets at/past the end without throwing, staying on the final line", () => {
    expect(offsetToLineCol(DDD, DDD.length)).toEqual({ line: 4, col: 1 }); // trailing "\n" opens an empty final line
    const past = offsetToLineCol(DDD, DDD.length + 100);
    expect(past.line).toBe(4); // newline scan stops at EOF; the raw column arithmetic is unclamped
  });
});
