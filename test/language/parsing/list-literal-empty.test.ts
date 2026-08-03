// The empty list literal, and the lexer hazard behind it.
//
// `'[]'` is a KEYWORD token — the array marker in `string[]` / `Order id[]`.
// Langium builds the lexer from every keyword and matches longest-first, so
// an UNSPACED `[]` lexes as that single token and can never reach `ListLit`'s
// `'[' … ']'` bracket-pair form.  A SPACED `[ ]` lexes as two tokens and does.
//
// The consequence, before the fix: `tags := []` was a hard parse error while
// `tags := [ ]` parsed fine — a whitespace-sensitive difference with no
// grammar-level explanation, whose diagnostic ("Expecting: one of these
// possible Token sequences" listing every expression start, INCLUDING `[`)
// pointed at the parser rather than the lexer.  `ListLit` therefore carries
// both spellings, and this file pins both so a keyword/lexer change cannot
// silently re-break either one.
import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import { parseRawResult } from "../../_helpers/parse.js";

const wrap = (expr: string) => `
system S {
  subdomain M {
    context C {
      aggregate A {
        n: string
        tags: string[]
        operation set() { tags := ${expr} }
      }
    }
  }
}`;

const syntaxErrors = (expr: string) =>
  parseRawResult(wrap(expr)).parserErrors.map((e) => e.message);

describe("list literal — the empty forms", () => {
  it("parses the UNSPACED empty list `[]` (the `[]` keyword token)", () => {
    expect(syntaxErrors("[]")).toEqual([]);
  });

  it("parses the SPACED empty list `[ ]` (a real '[' + ']' pair)", () => {
    expect(syntaxErrors("[ ]")).toEqual([]);
  });

  it("still parses non-empty lists, spaced and unspaced", () => {
    expect(syntaxErrors(`["a"]`)).toEqual([]);
    expect(syntaxErrors(`[ "a" ]`)).toEqual([]);
    expect(syntaxErrors(`["a", "b"]`)).toEqual([]);
    expect(syntaxErrors(`["a", "b",]`)).toEqual([]);
  });

  it("both empty spellings produce the SAME AST — one element-less ListLit", () => {
    const listNodes = (expr: string) =>
      [...AstUtils.streamAllContents(parseRawResult(wrap(expr)).value)].filter(
        (n) => n.$type === "ListLit",
      );

    for (const spelling of ["[]", "[ ]"]) {
      const nodes = listNodes(spelling);
      expect(nodes, spelling).toHaveLength(1);
      // The keyword spelling must not smuggle a phantom element through.
      expect((nodes[0] as { elements?: unknown[] }).elements ?? [], spelling).toHaveLength(0);
    }

    // …and the non-empty form still carries its element, so the two
    // alternatives are not collapsing into one another.
    const nonEmpty = listNodes(`["a"]`);
    expect(nonEmpty).toHaveLength(1);
    expect((nonEmpty[0] as { elements?: unknown[] }).elements ?? []).toHaveLength(1);
  });

  it("`string[]` still lexes as the array marker, not an empty list", () => {
    // The regression this file guards in the other direction: if `[]` were
    // ever demoted from a keyword to '[' + ']', every array TYPE would change
    // shape.  A declared `tags: string[]` must keep parsing.
    expect(syntaxErrors("[]")).toEqual([]);
    expect(parseRawResult(wrap("[]")).parserErrors).toEqual([]);
  });
});
