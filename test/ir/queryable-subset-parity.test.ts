import { describe, expect, it } from "vitest";
import { lowerToDrizzle } from "../../src/generator/typescript/repository-find-builder.js";
import type { EnrichedBoundedContextIR, ExprIR, TypeIR } from "../../src/ir/types/loom-ir.js";
import { firstColumnVsColumn } from "../../src/ir/validate/checks/shared.js";
import { firstNonQueryableNode } from "../../src/ir/validate/validate.js";

// ---------------------------------------------------------------------------
// Queryable-subset parity invariant.
//
// "What may appear in a `find`/`view`/`retrieval`/`filter` WHERE clause"
// is defined in TWO places that must agree:
//
//   1. `firstNonQueryableNode` (src/ir/validate/validate.ts) — the GATE.
//      Returns null ⟺ the expression is queryable.
//   2. `lowerToDrizzle` (src/generator/typescript/repository-find-builder.ts)
//      — the Hono LOWERER.  Returns non-null ⟺ it produced SQL.
//
// The contract `buildFindWhereClause` relies on is:  the validator
// rejects anything non-queryable, so by the time the lowerer runs,
// lowering always succeeds — a `lowerToDrizzle` returning null on a
// validator-admitted expression is an "internal: please file a bug"
// throw at generate time.
//
// These two grew independently and DRIFTED: the validator used to admit
// a bare `this-vo-prop` ref that the lowerer can't lower (a bare VO
// sub-property ref carries no parent-field name, so it can't form the
// flattened `<vo>_<sub>` column).  That arm is unreachable today, so it
// was latent, not live — but unenforced.  This test pins the invariant:
//
//   for every sample, validator-queryable ⟹ Drizzle-lowerable.
//
// (.NET / Phoenix need no analogue: they feed the validated filter to
// their *universal* expression renderer rather than re-walking the
// subset, so there is no second definition to drift.)
// ---------------------------------------------------------------------------

const STR: TypeIR = { kind: "primitive", name: "string" };
const BOOL: TypeIR = { kind: "primitive", name: "bool" };
const VO: TypeIR = { kind: "valueobject", name: "Address" };
const IDARR: TypeIR = {
  kind: "array",
  element: { kind: "id", targetName: "Tag", valueType: "guid" },
};

const thisExpr: ExprIR = { kind: "this" };
const strLit: ExprIR = { kind: "literal", lit: "string", value: "x" };

/** `this.<col> == "x"` for a given column member name. */
const cmpThisCol = (col: string): ExprIR => ({
  kind: "binary",
  op: "==",
  left: { kind: "member", receiver: thisExpr, member: col, receiverType: STR, memberType: STR },
  right: strLit,
});

/** `this.<vo>.<sub> == "x"` — the queryable VO member form. */
const cmpVoMember: ExprIR = {
  kind: "binary",
  op: "==",
  left: {
    kind: "member",
    receiver: {
      kind: "member",
      receiver: thisExpr,
      member: "addr",
      receiverType: VO,
      memberType: VO,
    },
    member: "city",
    receiverType: VO,
    memberType: STR,
  },
  right: strLit,
};

/** `this.<col> == <ref>` for a param/let/lambda/enum-value ref. */
const cmpThisRef = (refKind: "param" | "let" | "lambda" | "enum-value"): ExprIR => ({
  kind: "binary",
  op: "==",
  left: { kind: "member", receiver: thisExpr, member: "name", receiverType: STR, memberType: STR },
  right:
    refKind === "enum-value"
      ? { kind: "ref", name: "Draft", refKind, enumName: "Status", type: STR }
      : { kind: "ref", name: "v", refKind, type: STR },
});

// Minimal ctx — lowerToDrizzle only reads ctx.aggregates, and only for
// the `refColl.contains` arm (absent from these samples).
const ctx = { aggregates: [] } as unknown as EnrichedBoundedContextIR;

const QUERYABLE: { name: string; e: ExprIR }[] = [
  { name: "this.col == literal", e: cmpThisCol("name") },
  {
    name: "this.isActive (bare bool col)",
    e: {
      kind: "member",
      receiver: thisExpr,
      member: "isActive",
      receiverType: BOOL,
      memberType: BOOL,
    },
  },
  {
    name: "!this.isDeleted",
    e: {
      kind: "unary",
      op: "!",
      operand: {
        kind: "member",
        receiver: thisExpr,
        member: "isDeleted",
        receiverType: BOOL,
        memberType: BOOL,
      },
    },
  },
  {
    name: "this.a == x && this.b == x",
    e: { kind: "binary", op: "&&", left: cmpThisCol("a"), right: cmpThisCol("b") },
  },
  { name: "this.vo.sub == literal (VO member form)", e: cmpVoMember },
  { name: "this.col == param", e: cmpThisRef("param") },
  { name: "this.col == let", e: cmpThisRef("let") },
  { name: "this.col == lambda", e: cmpThisRef("lambda") },
  { name: "this.col == enum-value", e: cmpThisRef("enum-value") },
  {
    name: "this.col.trim() == literal (queryable scalar intrinsic on the column side)",
    e: {
      kind: "binary",
      op: "==",
      left: {
        kind: "method-call",
        receiver: {
          kind: "member",
          receiver: thisExpr,
          member: "name",
          receiverType: STR,
          memberType: STR,
        },
        member: "trim",
        args: [],
        receiverType: STR,
        isCollectionOp: false,
      },
      right: strLit,
    },
  },
  {
    name: "this.col == param.trim() (queryable scalar intrinsic on the value side)",
    e: {
      kind: "binary",
      op: "==",
      left: {
        kind: "member",
        receiver: thisExpr,
        member: "name",
        receiverType: STR,
        memberType: STR,
      },
      right: {
        kind: "method-call",
        receiver: { kind: "ref", name: "q", refKind: "param", type: STR },
        member: "trim",
        args: [],
        receiverType: STR,
        isCollectionOp: false,
      },
    },
  },
  {
    name: "this.col.toUpper() == literal (second queryable intrinsic, data-only row)",
    e: {
      kind: "binary",
      op: "==",
      left: {
        kind: "method-call",
        receiver: {
          kind: "member",
          receiver: thisExpr,
          member: "name",
          receiverType: STR,
          memberType: STR,
        },
        member: "toUpper",
        args: [],
        receiverType: STR,
        isCollectionOp: false,
      },
      right: strLit,
    },
  },
  {
    name: "this.col.round(2) == param (multi-arg numeric intrinsic, A3)",
    e: {
      kind: "binary",
      op: "==",
      left: {
        kind: "method-call",
        receiver: {
          kind: "member",
          receiver: thisExpr,
          member: "amount",
          receiverType: { kind: "primitive", name: "decimal" },
          memberType: { kind: "primitive", name: "decimal" },
        },
        member: "round",
        args: [{ kind: "literal", lit: "int", value: "2" }],
        receiverType: { kind: "primitive", name: "decimal" },
        isCollectionOp: false,
      },
      right: {
        kind: "ref",
        name: "a",
        refKind: "param",
        type: { kind: "primitive", name: "decimal" },
      },
    },
  },
  {
    name: "this.a.min(this.b) == param (column in the ARG position — LEAST(a,b) is legitimate SQL)",
    e: {
      kind: "binary",
      op: "==",
      left: {
        kind: "method-call",
        receiver: {
          kind: "member",
          receiver: thisExpr,
          member: "amount",
          receiverType: { kind: "primitive", name: "decimal" },
          memberType: { kind: "primitive", name: "decimal" },
        },
        member: "min",
        args: [
          {
            kind: "member",
            receiver: thisExpr,
            member: "cap",
            receiverType: { kind: "primitive", name: "decimal" },
            memberType: { kind: "primitive", name: "decimal" },
          },
        ],
        receiverType: { kind: "primitive", name: "decimal" },
        isCollectionOp: false,
      },
      right: {
        kind: "ref",
        name: "a",
        refKind: "param",
        type: { kind: "primitive", name: "decimal" },
      },
    },
  },
  {
    name: "this.col == param.min(this.cap) (VALUE-side intrinsic with a column ARG → SQL fallback)",
    e: {
      kind: "binary",
      op: "==",
      left: {
        kind: "member",
        receiver: thisExpr,
        member: "amount",
        receiverType: { kind: "primitive", name: "decimal" },
        memberType: { kind: "primitive", name: "decimal" },
      },
      right: {
        kind: "method-call",
        receiver: {
          kind: "ref",
          name: "a",
          refKind: "param",
          type: { kind: "primitive", name: "decimal" },
        },
        member: "min",
        args: [
          {
            kind: "member",
            receiver: thisExpr,
            member: "cap",
            receiverType: { kind: "primitive", name: "decimal" },
            memberType: { kind: "primitive", name: "decimal" },
          },
        ],
        receiverType: { kind: "primitive", name: "decimal" },
        isCollectionOp: false,
      },
    },
  },
  {
    name: "currentUser.field comparison",
    e: {
      kind: "binary",
      op: "==",
      left: {
        kind: "member",
        receiver: thisExpr,
        member: "owner",
        receiverType: STR,
        memberType: STR,
      },
      right: {
        kind: "member",
        receiver: { kind: "ref", name: "currentUser", refKind: "current-user", type: STR },
        member: "id",
        receiverType: STR,
        memberType: STR,
      },
    },
  },
];

describe("queryable-subset parity — validator admits ⊆ Drizzle lowers", () => {
  for (const { name, e } of QUERYABLE) {
    it(`validator admits AND Drizzle lowers: ${name}`, () => {
      // Sanity: the sample is actually queryable per the gate.
      expect(firstNonQueryableNode(e), `expected queryable: ${name}`).toBeNull();
      // The invariant: anything the gate admits, the lowerer lowers.
      expect(
        lowerToDrizzle(e, "things", ctx),
        `Drizzle could not lower a validator-admitted shape: ${name}`,
      ).not.toBeNull();
    });
  }

  it("rejects the un-lowerable bare this-vo-prop ref in BOTH places (no drift)", () => {
    // A bare VO sub-property ref: only its sub-name, no parent VO field —
    // cannot form a `<vo>_<sub>` column.  Must be rejected by the gate
    // (so it never reaches the lowerer) AND unlowerable by Drizzle.
    const bareVoProp: ExprIR = {
      kind: "binary",
      op: "==",
      left: { kind: "ref", name: "city", refKind: "this-vo-prop", type: STR },
      right: strLit,
    };
    expect(firstNonQueryableNode(bareVoProp)).not.toBeNull();
    expect(lowerToDrizzle(bareVoProp, "things", ctx)).toBeNull();
  });

  it("a non-queryable intrinsic in where-position is rejected BY NAME", () => {
    // `substring` is catalogued queryable:false — the gate must reject it
    // with the intrinsic-specific label (actionable diagnostic), and the
    // Drizzle lowerer must agree (no drift).
    const subInWhere: ExprIR = {
      kind: "binary",
      op: "==",
      left: {
        kind: "method-call",
        receiver: {
          kind: "member",
          receiver: thisExpr,
          member: "name",
          receiverType: STR,
          memberType: STR,
        },
        member: "substring",
        args: [{ kind: "literal", lit: "int", value: "0" }],
        receiverType: STR,
        isCollectionOp: false,
      },
      right: strLit,
    };
    expect(firstNonQueryableNode(subInWhere)).toBe("non-queryable intrinsic '.substring'");
    expect(lowerToDrizzle(subInWhere, "things", ctx)).toBeNull();
  });

  it("trim(col) vs col still trips the column-vs-column gate", () => {
    // A queryable intrinsic over a column stays column-side: comparing it
    // against another column must be flagged (Drizzle's eq() needs one
    // column and one value), not admitted into an internal lowering throw.
    const trimColVsCol: ExprIR = {
      kind: "binary",
      op: "==",
      left: {
        kind: "method-call",
        receiver: {
          kind: "member",
          receiver: thisExpr,
          member: "a",
          receiverType: STR,
          memberType: STR,
        },
        member: "trim",
        args: [],
        receiverType: STR,
        isCollectionOp: false,
      },
      right: {
        kind: "member",
        receiver: thisExpr,
        member: "b",
        receiverType: STR,
        memberType: STR,
      },
    };
    expect(firstColumnVsColumn(trimColVsCol)).toContain("'this.a'.trim()");
  });

  it("contains over a ref-collection is queryable (the one admitted collection op)", () => {
    const contains: ExprIR = {
      kind: "method-call",
      receiver: {
        kind: "member",
        receiver: thisExpr,
        member: "tags",
        receiverType: IDARR,
        memberType: IDARR,
      },
      member: "contains",
      args: [
        {
          kind: "ref",
          name: "t",
          refKind: "param",
          type: { kind: "id", targetName: "Tag", valueType: "guid" },
        },
      ],
      receiverType: IDARR,
      isCollectionOp: true,
    };
    // Validator admits it (the EXISTS-subquery shape); lowering needs a
    // real association on ctx, so we only assert the gate here — the
    // end-to-end lowering is covered by the generator suite.
    expect(firstNonQueryableNode(contains)).toBeNull();
  });
});
