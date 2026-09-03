import { describe, expect, it } from "vitest";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";
import {
  type FindPredicateAdapter,
  firstUnlowerableForAdapter,
  isFindPredicateAdapter,
} from "../../../src/ir/util/find-predicate-capability.js";

// The per-persistence-adapter narrowing of the queryable predicate subset.
// M-T9.17 slice 3 — no test imports this module directly.
//
// This descriptor is a GATE: `ir/validate` asks it whether the selected adapter
// can lower a `find` / `filter` / retrieval predicate, and refuses at generate
// time when it cannot.  Both directions of a wrong answer are silent and
// expensive:
//
//   • a FALSE NEGATIVE (says "lowerable" when the adapter cannot) ships the
//     failure downstream — MikroORM throws "not yet supported" mid-generate,
//     Dapper used to emit a `NotImplementedException` stub that compiles and
//     then 500s at runtime;
//   • a FALSE POSITIVE (says "unlowerable" for a shape the adapter handles)
//     refuses a perfectly good model, and the refusal names a node the author
//     is told to remove.
//
// The tests pin the SHAPE OF THE NARROWING, not the message wording: which
// adapters are at the EF Core baseline, and the one shape MikroORM still
// cannot reach.  Two of the narrowings this table used to carry are gone
// (`currentUser.<field>`, whose real defect was a missing method parameter one
// layer out; and Dapper's whole subset, now the full baseline) — both are
// asserted here as explicitly LOWERABLE, so re-adding a narrowing that was
// diagnosed as belonging elsewhere fails rather than quietly returning.

const thisRecv = { kind: "this" } as unknown as ExprIR;

const boolMember = (member: string): ExprIR =>
  ({
    kind: "member",
    receiver: thisRecv,
    member,
    memberType: { kind: "primitive", name: "bool" },
  }) as unknown as ExprIR;

const strMember = (member: string): ExprIR =>
  ({
    kind: "member",
    receiver: thisRecv,
    member,
    memberType: { kind: "primitive", name: "string" },
  }) as unknown as ExprIR;

const strLit = (value: string): ExprIR => ({ kind: "string", value }) as unknown as ExprIR;

const binary = (op: string, left: ExprIR, right: ExprIR): ExprIR =>
  ({ kind: "binary", op, left, right }) as unknown as ExprIR;

const not = (operand: ExprIR): ExprIR => ({ kind: "unary", op: "!", operand }) as unknown as ExprIR;

const paren = (inner: ExprIR): ExprIR => ({ kind: "paren", inner }) as unknown as ExprIR;

/** `this.<refColl>.contains(x)` — membership over a reference collection.  The
 *  receiver type is what identifies it: an array OF IDS. */
const containsMembership = (): ExprIR =>
  ({
    kind: "method-call",
    member: "contains",
    receiver: strMember("tags"),
    receiverType: { kind: "array", element: { kind: "id", name: "Tag" } },
    args: [strLit("t1")],
  }) as unknown as ExprIR;

/** A `queryable` catalogue intrinsic over a primitive receiver. */
const queryableIntrinsic = (member: string): ExprIR =>
  ({
    kind: "method-call",
    member,
    receiver: strMember("name"),
    receiverType: { kind: "primitive", name: "string" },
    args: [],
  }) as unknown as ExprIR;

const authzFilter = (): ExprIR => ({ kind: "authz-filter", stance: "deny" }) as unknown as ExprIR;

const BASELINE: FindPredicateAdapter[] = ["efcore", "drizzle", "dapper"];
const ALL: FindPredicateAdapter[] = ["efcore", "drizzle", "dapper", "mikroorm"];

describe("isFindPredicateAdapter", () => {
  it("recognises exactly the four relational adapters", () => {
    for (const name of ALL) expect(isFindPredicateAdapter(name)).toBe(true);
  });

  it("rejects a non-relational or unknown persistence selector", () => {
    // Only relational adapters lower a predicate to SQL; a name that reaches
    // the gate without being one must not silently index into the capability
    // table (`CAPABILITIES[name]` would be `undefined` and throw at call time).
    for (const name of ["memory", "ecto", "sqlalchemy", "jpa", "", "Drizzle"]) {
      expect(isFindPredicateAdapter(name), name).toBe(false);
    }
  });
});

describe("the EF Core baseline — efcore, drizzle and dapper narrow NOTHING", () => {
  // Asserted per adapter rather than over a merged fixture: each is a separate
  // entry in the capability table, and one of them silently falling back to a
  // narrowing (or to `undefined`) is exactly the drift this table exists to
  // prevent.
  const everyQueryableShape: [string, ExprIR][] = [
    ["a comparison", binary("==", strMember("status"), strLit("open"))],
    [
      "an && of comparisons",
      binary("&&", binary("==", strMember("a"), strLit("x")), boolMember("active")),
    ],
    ["a bare boolean column", boolMember("active")],
    ["a negated boolean column", not(boolMember("deleted"))],
    ["refColl membership", containsMembership()],
    ["a queryable intrinsic", queryableIntrinsic("trim")],
    ["an authz/tenancy sentinel", authzFilter()],
  ];

  for (const adapter of BASELINE) {
    for (const [label, expr] of everyQueryableShape) {
      it(`${adapter} lowers ${label}`, () => {
        expect(firstUnlowerableForAdapter(expr, adapter)).toBeNull();
      });
    }
  }
});

describe("MikroORM — the one remaining narrowing", () => {
  it("REJECTS `this.<refColl>.contains(x)` membership", () => {
    // The correlated EXISTS subquery the adapter emits nowhere.  This is the
    // single shape that separates MikroORM from the baseline, so it is the one
    // assertion that must not become vacuous.
    const reason = firstUnlowerableForAdapter(containsMembership(), "mikroorm");
    expect(reason).toContain("contains");
  });

  it("rejects membership hidden inside a comparison OPERAND, not just at the root", () => {
    // `walkValue` exists for this: a comparison's operands are values, and the
    // adapter-wide rejected shapes can hide there.  A root-only check would
    // pass the predicate straight through to a generate-time throw.
    const nested = binary("==", containsMembership(), strLit("x"));
    expect(firstUnlowerableForAdapter(nested, "mikroorm")).toContain("contains");
  });

  it("rejects membership nested under an && / ! / parens", () => {
    const buried = not(paren(binary("&&", boolMember("active"), containsMembership())));
    expect(firstUnlowerableForAdapter(buried, "mikroorm")).toContain("contains");
  });

  it("still lowers a bare boolean column", () => {
    expect(firstUnlowerableForAdapter(boolMember("active"), "mikroorm")).toBeNull();
  });

  it("still lowers a comparison, an && and a || of predicates", () => {
    const cmp = binary("==", strMember("status"), strLit("open"));
    expect(firstUnlowerableForAdapter(cmp, "mikroorm")).toBeNull();
    expect(firstUnlowerableForAdapter(binary("&&", cmp, boolMember("a")), "mikroorm")).toBeNull();
    expect(firstUnlowerableForAdapter(binary("||", cmp, boolMember("a")), "mikroorm")).toBeNull();
  });

  it("still lowers a queryable scalar intrinsic standing alone (the raw() fragment)", () => {
    expect(firstUnlowerableForAdapter(queryableIntrinsic("trim"), "mikroorm")).toBeNull();
  });

  it("still lowers the authz/tenancy sentinel", () => {
    // `deny` is the always-false FilterQuery contradiction; the deep/global
    // scope sentinel is a `raw()` prefix test.  Both lower, so the sentinel
    // must never be reported as a narrowing — a false positive here would
    // refuse every tenant-scoped find on the adapter.
    expect(firstUnlowerableForAdapter(authzFilter(), "mikroorm")).toBeNull();
  });

  it("REJECTS an arithmetic operator in a predicate position, naming the operator", () => {
    // `whereToMikroFilter` accepts only top-level comparisons / && / ||; a
    // FilterQuery has no arithmetic position at all.
    const reason = firstUnlowerableForAdapter(binary("+", strMember("a"), strLit("b")), "mikroorm");
    expect(reason).toContain("arithmetic '+'");
  });

  it("reports the FIRST unlowerable node, walking the left branch before the right", () => {
    // The contract is "first node this adapter cannot lower" — the message
    // points the author at one site, so which one it picks is part of the
    // behaviour, not an accident of traversal.
    const reason = firstUnlowerableForAdapter(
      binary("&&", binary("+", strMember("a"), strLit("b")), containsMembership()),
      "mikroorm",
    );
    expect(reason).toContain("arithmetic '+'");
  });

  it("peels parens before judging — `(this.active)` is still a bare boolean column", () => {
    expect(firstUnlowerableForAdapter(paren(boolMember("active")), "mikroorm")).toBeNull();
  });
});

describe("a non-boolean bare member is not a boolean column", () => {
  it("MikroORM rejects a bare STRING column in a predicate position", () => {
    // `isBareBooleanColumn` checks the member TYPE, not merely that the node is
    // a `this.<field>` member: `{ name: true }` is not what a string column in
    // a boolean position means, and emitting it would silently filter on the
    // wrong value.
    expect(firstUnlowerableForAdapter(strMember("name"), "mikroorm")).toContain("member");
  });

  it("but the baseline adapters lower it (they are unconditional)", () => {
    for (const adapter of BASELINE) {
      expect(firstUnlowerableForAdapter(strMember("name"), adapter), adapter).toBeNull();
    }
  });
});
