// ---------------------------------------------------------------------------
// zod-refine renderability gate (generator-code-review 2026-08-17, C3 + C4).
//
// `zod-refine.ts` renders wire-boundary validators as BROWSER JS.  Its switch
// is deliberately narrower than `classifyForWire` — the cross-backend
// admission gate that also drives .NET FluentValidation, Java, Python and the
// i18n validation catalog, and which therefore admits shapes (every collection
// op, every scalar intrinsic) this renderer has no faithful JS arm for.
//
// Three things are pinned here, and they are the whole point of the item:
//
//   1. Every op the local screen (`refineRenderable`) ADMITS actually renders
//      — no arm claims coverage it doesn't have.
//   2. Every op the screen EXCLUDES throws the explicit `UNRENDERABLE` marker
//      when the renderer is driven directly — so widening `classifyForWire`
//      (or the screen) can never silently arm a broken arm.
//   3. End-to-end, `refineClauseFor` returns null for an excluded op (the rule
//      stays server-side), so the throw is unreachable in a real generation.
//
// Before this, the excluded ops fell through a `default:` arm that emitted
// `(recv).take(2)` — not a JS array method — with no marker at all.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  chainSingleFieldNative,
  REFINE_RENDERABLE_COLLECTION_OPS,
  refineClauseFor,
  refineRenderable,
  renderRefineExpr,
  UNRENDERABLE_MARKER,
} from "../../src/generator/zod-refine.js";
import type { ExprIR, InvariantIR, TypeIR } from "../../src/ir/types/loom-ir.js";
import { classifyForWire } from "../../src/ir/validate/invariant-classify.js";
import { COLLECTION_OP_SIGNATURES } from "../../src/util/collection-ops.js";

const IntT: TypeIR = { kind: "primitive", name: "int" };
const BoolT: TypeIR = { kind: "primitive", name: "bool" };
const IntArrT: TypeIR = { kind: "array", element: IntT };

const litInt = (n: number): ExprIR => ({ kind: "literal", lit: "int", value: String(n) });

/** `lines` — an int-collection request-body field. */
const linesRef: ExprIR = { kind: "ref", name: "lines", refKind: "this-prop", type: IntArrT };

const LAMBDA_OPS = new Set(["sum", "all", "any", "where", "map", "sortBy", "min", "max", "avg"]);

function argsFor(op: string): ExprIR[] {
  if (LAMBDA_OPS.has(op)) {
    return [
      {
        kind: "lambda",
        param: "x",
        body: { kind: "ref", name: "x", refKind: "lambda", type: IntT },
        type: IntT,
      },
    ];
  }
  if (op === "contains") return [litInt(1)];
  if (op === "take" || op === "skip") return [litInt(2)];
  if (op === "join") return [{ kind: "literal", lit: "string", value: "," }];
  return [];
}

/** `lines.<op>(…)` as the lowering pass emits it — a `method-call` carrying
 *  `isCollectionOp`. */
function collectionOpCall(op: string): ExprIR {
  return {
    kind: "method-call",
    receiver: linesRef,
    member: op,
    args: argsFor(op),
    receiverType: IntArrT,
    memberType: IntT,
    isCollectionOp: true,
  };
}

/** The same call wrapped in `!= 0` so the invariant is boolean-shaped. */
function collectionOpInvariant(op: string): InvariantIR {
  return {
    expr: {
      kind: "binary",
      op: "!=",
      left: collectionOpCall(op),
      right: litInt(0),
      leftType: IntT,
      resultType: BoolT,
    },
    source: `lines.${op}(…) != 0`,
  };
}

const CTX = { available: new Set(["lines"]) };
const ALL_OPS = COLLECTION_OP_SIGNATURES.map((o) => o.name);
const MARKER_RE = new RegExp(`^${UNRENDERABLE_MARKER}:`);

describe("zod-refine — the admitted collection ops all render", () => {
  const admitted = ALL_OPS.filter((op) => REFINE_RENDERABLE_COLLECTION_OPS.has(op));

  it("the admitted set is non-empty and contains only catalogue ops", () => {
    expect(admitted.length).toBeGreaterThan(0);
    expect([...REFINE_RENDERABLE_COLLECTION_OPS].filter((o) => !ALL_OPS.includes(o))).toEqual([]);
  });

  for (const op of admitted) {
    it(`${op}: screened in, renders JS, and refineClauseFor emits a refine`, () => {
      const inv = collectionOpInvariant(op);
      expect(refineRenderable(inv.expr), `${op} should be screened in`).toBe(true);
      const body = renderRefineExpr(collectionOpCall(op));
      // The JS spelling is never the Loom spelling for these — a body still
      // carrying `.<op>(` would be the exact drift this gate exists to catch.
      expect(body, `${op} rendered its Loom spelling verbatim`).not.toContain(`.${op}(`);
      const clause = refineClauseFor(inv, CTX);
      expect(clause, `${op} should render a refine`).not.toBeNull();
      expect(clause).toContain(".refine(");
    });
  }
});

describe("zod-refine — the excluded collection ops throw the explicit marker", () => {
  const excluded = ALL_OPS.filter((op) => !REFINE_RENDERABLE_COLLECTION_OPS.has(op));

  it("the excluded set is non-empty (otherwise this suite proves nothing)", () => {
    expect(excluded.length).toBeGreaterThan(0);
  });

  for (const op of excluded) {
    it(`${op}: classifyForWire admits it, the local screen refuses, the renderer throws`, () => {
      const inv = collectionOpInvariant(op);
      // The CROSS-BACKEND gate still admits it — which is exactly why the
      // local screen has to exist.
      expect(classifyForWire(inv, CTX), `${op}: classifyForWire is the wider gate`).toBe(true);
      expect(refineRenderable(inv.expr), `${op} should be screened out`).toBe(false);
      // End-to-end: no broken refine is emitted; the rule stays server-side.
      expect(refineClauseFor(inv, CTX)).toBeNull();
      // Backstop: driving the renderer past the screen is a loud, marked fail.
      expect(() => renderRefineExpr(collectionOpCall(op))).toThrow(MARKER_RE);
    });
  }
});

describe("zod-refine — non-collection method calls follow the same rule", () => {
  const strT: TypeIR = { kind: "primitive", name: "string" };
  const codeRef: ExprIR = { kind: "ref", name: "code", refKind: "this-prop", type: strT };

  const call = (member: string, args: ExprIR[] = []): ExprIR => ({
    kind: "method-call",
    receiver: codeRef,
    member,
    args,
    receiverType: strT,
    memberType: strT,
    isCollectionOp: false,
  });

  it("a known scalar intrinsic renders through the SHARED JS table, not verbatim", () => {
    expect(refineRenderable(call("toUpper"))).toBe(true);
    // `toUpper` is `.toUpperCase()` in JS — pasting the Loom name was a TS2339.
    expect(renderRefineExpr(call("toUpper"))).toBe("data.code.toUpperCase()");
    expect(
      renderRefineExpr(call("contains", [{ kind: "literal", lit: "string", value: "x" }])),
    ).toBe('data.code.includes("x")');
  });

  it("an unknown scalar method is screened out and throws the marker", () => {
    expect(refineRenderable(call("noSuchIntrinsic"))).toBe(false);
    expect(() => renderRefineExpr(call("noSuchIntrinsic"))).toThrow(MARKER_RE);
  });
});

describe("zod-refine — regex hardening is shared (C4)", () => {
  it('matches("") no longer emits `.regex(//)`', () => {
    const chained = chainSingleFieldNative("z.string()", { kind: "regex", pattern: "" });
    expect(chained).not.toContain(".regex(//)");
    expect(chained).toBe('z.string().regex(new RegExp(""))');
  });

  it("a trailing-backslash pattern falls back to the RegExp constructor", () => {
    expect(chainSingleFieldNative("z.string()", { kind: "regex", pattern: "a\\" })).toContain(
      "new RegExp(",
    );
  });

  it("an ordinary pattern still renders as a literal, slashes escaped", () => {
    expect(chainSingleFieldNative("z.string()", { kind: "regex", pattern: "^a/b$" })).toBe(
      "z.string().regex(/^a\\/b$/)",
    );
  });

  it("a matches() call inside a refine body uses the same hardening", () => {
    const strT: TypeIR = { kind: "primitive", name: "string" };
    const e: ExprIR = {
      kind: "method-call",
      receiver: { kind: "ref", name: "code", refKind: "this-prop", type: strT },
      member: "matches",
      args: [{ kind: "literal", lit: "string", value: "" }],
      receiverType: strT,
      memberType: { kind: "primitive", name: "bool" },
      isCollectionOp: false,
    };
    expect(renderRefineExpr(e)).toBe('new RegExp("").test(data.code)');
  });
});
