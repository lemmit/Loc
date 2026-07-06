// Unit tests for the level-wise mark composer (span-tracking-emission.md,
// M15 phase 7 slice 2) — `renderExprWithMarks` (src/generator/_expr/
// target.ts), exercised through its TS instantiation `renderTsExprWithMarks`.
// Pattern follows `render-expr-kinds.test.ts`: build tiny ExprIR fixtures
// directly and assert on the rendered `{ text, marks }` shape.
//
// These pin the anchoring discipline itself, independent of the system-level
// fixture in test/system/sourcemap.test.ts (which proves the same composer
// wired end to end into a real v3 mapping).

import { describe, expect, it } from "vitest";
import { renderTsExprWithMarks } from "../../../src/generator/typescript/render-expr.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";
import type { OriginRef } from "../../../src/ir/types/origin.js";

const originAt = (start: number, end: number): OriginRef => ({
  kind: "source",
  path: "/a.ddd",
  span: { start, end },
});

const thisProp = (name: string, origin?: OriginRef): ExprIR => ({
  kind: "ref",
  name,
  refKind: "this-prop",
  origin,
});
const refParam = (name: string, origin?: OriginRef): ExprIR => ({
  kind: "ref",
  name,
  refKind: "param",
  origin,
});
const litInt = (v: string): ExprIR => ({ kind: "literal", lit: "int", value: v });

describe("renderExprWithMarks — leaf node", () => {
  it("a bare ref carries exactly its own whole-text mark", () => {
    const origin = originAt(10, 22);
    const { text, marks } = renderTsExprWithMarks(thisProp("customerName", origin));
    expect(text).toBe("this._customerName");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toEqual({ start: 0, end: text.length, origin });
  });

  it("a ref with no origin carries no mark at all", () => {
    const { marks } = renderTsExprWithMarks(thisProp("customerName"));
    expect(marks).toHaveLength(0);
  });
});

describe("renderExprWithMarks — sibling ambiguity skip (`a + a`)", () => {
  it("drops BOTH children's marks when their rendered text is identical (non-unique anchor)", () => {
    const originA = originAt(0, 1);
    const left = thisProp("a", originA);
    const right = thisProp("a", originA);
    const expr: ExprIR = {
      kind: "binary",
      op: "+",
      left,
      right,
      // No origin on the binary node itself — isolates the assertion to
      // the child-anchoring behavior alone.
    };
    const { text, marks } = renderTsExprWithMarks(expr);
    expect(text).toBe("this._a + this._a");
    // Both "this._a" occurrences are ambiguous anchors — an honest skip,
    // not a guess — so NEITHER child's mark survives, and the (origin-less)
    // parent contributes none of its own.
    expect(marks).toHaveLength(0);
  });

  it("still anchors the PARENT's own mark even when children are skipped", () => {
    const originA = originAt(0, 1);
    const parentOrigin = originAt(0, 9);
    const expr: ExprIR = {
      kind: "binary",
      op: "+",
      left: thisProp("a", originA),
      right: thisProp("a", originA),
      origin: parentOrigin,
    };
    const { text, marks } = renderTsExprWithMarks(expr);
    // Children skipped (ambiguous); the node's own whole-text mark is
    // unaffected by that — it's appended unconditionally when `origin` is set.
    expect(marks).toHaveLength(1);
    expect(marks[0]).toEqual({ start: 0, end: text.length, origin: parentOrigin });
  });
});

describe("renderExprWithMarks — nested resolve (`count > 0 && count < max`)", () => {
  it("resolves BOTH `count` refs level-by-level even though the token repeats across the whole expression", () => {
    const originLeft = originAt(0, 5); // the left comparison's `count`
    const originRight = originAt(20, 25); // the right comparison's `count`
    const left: ExprIR = {
      kind: "binary",
      op: ">",
      left: thisProp("count", originLeft),
      right: litInt("0"),
    };
    const right: ExprIR = {
      kind: "binary",
      op: "<",
      left: thisProp("count", originRight),
      right: refParam("max"),
    };
    const top: ExprIR = { kind: "binary", op: "&&", left, right };

    const { text, marks } = renderTsExprWithMarks(top);
    expect(text).toBe("this._count > 0 && this._count < max");
    // Each comparison's own text ("this._count > 0" / "this._count < max")
    // is unique within the outer `&&` text, so both inner `count` marks
    // (already anchored within their own comparison one level down) survive
    // the outer anchor unshifted-in-ambiguity.
    expect(marks).toHaveLength(2);
    const sorted = [...marks].sort((a, b) => a.start - b.start);
    expect(text.slice(sorted[0]!.start, sorted[0]!.end)).toBe("this._count");
    expect(sorted[0]!.origin).toEqual(originLeft);
    expect(text.slice(sorted[1]!.start, sorted[1]!.end)).toBe("this._count");
    expect(sorted[1]!.origin).toEqual(originRight);
    // The second occurrence is strictly after the first (distinct offsets —
    // not both collapsed onto the first `this._count`).
    expect(sorted[1]!.start).toBeGreaterThan(sorted[0]!.start);
  });
});

describe("renderExprWithMarks — join-heavy arm (call args)", () => {
  it("resolves every argument's mark when each argument's rendered text is unique within the call", () => {
    const originA = originAt(0, 1);
    const originB = originAt(2, 3);
    const expr: ExprIR = {
      kind: "call",
      callKind: "free",
      name: "foo",
      args: [refParam("a", originA), refParam("b", originB)],
    };
    const { text, marks } = renderTsExprWithMarks(expr);
    expect(text).toBe("foo(a, b)");
    expect(marks).toHaveLength(2);
    const sorted = [...marks].sort((a, b) => a.start - b.start);
    expect(text.slice(sorted[0]!.start, sorted[0]!.end)).toBe("a");
    expect(sorted[0]!.origin).toEqual(originA);
    expect(text.slice(sorted[1]!.start, sorted[1]!.end)).toBe("b");
    expect(sorted[1]!.origin).toEqual(originB);
  });

  it("skips an argument whose rendered text recurs elsewhere in the call (ambiguous anchor)", () => {
    const originA = originAt(0, 1);
    const expr: ExprIR = {
      kind: "call",
      callKind: "free",
      name: "foo",
      args: [refParam("a", originA), refParam("a", originA)],
    };
    const { text, marks } = renderTsExprWithMarks(expr);
    expect(text).toBe("foo(a, a)");
    // "a" occurs twice in "foo(a, a)" — both anchors ambiguous, honest skip.
    expect(marks).toHaveLength(0);
  });
});
