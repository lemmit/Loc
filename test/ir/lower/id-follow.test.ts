import { describe, expect, it } from "vitest";
import {
  idFollowPath,
  joinRefPath,
  mapVarForPath,
  orderAuxiliaries,
} from "../../../src/ir/lower/id-follow.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";

// Cross-aggregate bulk-load / join planning.  These four decide which
// auxiliary maps a read loads and what each is CALLED in the emitted source,
// so an off-by-one in a path or a collision in a mint produces either a
// missing preload (an N+1, or a null deref) or two auxiliaries sharing a
// variable.  M-T9.17 slice 2 — no direct test.
//
// `idFollowPath` and `joinRefPath` are near-twins with deliberately different
// contracts, and the difference is the interesting part: the first is
// INFERRED from an id-typed expression and returns `undefined` when the shape
// does not fit; the second is the DECLARED `join … on` counterpart and returns
// `[]` instead, because its caller falls back to the join alias. A test that
// asserted the same thing of both would hide a swap.

const ref = (name: string, id = true): ExprIR =>
  ({
    kind: "ref",
    name,
    type: id ? { kind: "id", targetName: "X" } : { kind: "string" },
  }) as ExprIR;

const member = (receiver: ExprIR, m: string, receiverIsId = true): ExprIR =>
  ({
    kind: "member",
    receiver,
    member: m,
    receiverType: receiverIsId ? { kind: "id", targetName: "X" } : { kind: "entity", name: "X" },
  }) as ExprIR;

describe("mapVarForPath — the auxiliary's emitted variable name", () => {
  it("single hop is `<agg>ById`", () => {
    expect(mapVarForPath(["customerId"], "Customer")).toBe("customerById");
  });

  it("lower-cases only the FIRST character of the aggregate", () => {
    // `LineItem` → `lineItemById`, not `lineitemById`.
    expect(mapVarForPath(["x"], "LineItem")).toBe("lineItemById");
  });

  it("multi-hop names itself after the path PREFIX, dropping the last hop", () => {
    expect(mapVarForPath(["customerId", "regionId"], "Region")).toBe("regionByCustomerId");
  });

  it("joins every prefix segment on a three-hop path", () => {
    expect(mapVarForPath(["a", "b", "c"], "Region")).toBe("regionByAB");
  });

  it("treats an EMPTY path like a single hop", () => {
    // `path.length <= 1` — the guard covers 0 as well as 1, so an empty path
    // mints the by-id name rather than `regionBy`.
    expect(mapVarForPath([], "Region")).toBe("regionById");
  });

  it("distinguishes two different prefixes for the same aggregate", () => {
    // The collision case the mint exists to avoid: same target, two paths.
    expect(mapVarForPath(["customerId", "regionId"], "Region")).not.toBe(
      mapVarForPath(["supplierId", "regionId"], "Region"),
    );
  });
});

describe("idFollowPath — INFERRED from an id-typed expression", () => {
  it("returns the name for an id-typed ref", () => {
    expect(idFollowPath(ref("customerId"))).toEqual(["customerId"]);
  });

  it("returns undefined for a ref that is NOT id-typed", () => {
    expect(idFollowPath(ref("name", false))).toBeUndefined();
  });

  it("walks a chain of id-typed member accesses", () => {
    expect(idFollowPath(member(ref("customerId"), "regionId"))).toEqual(["customerId", "regionId"]);
  });

  it("returns undefined when the receiver is not id-typed", () => {
    // The guard that stops a plain entity member access being planned as a
    // follow — the receiver's type is what makes the hop loadable.
    expect(idFollowPath(member(ref("customerId"), "regionId", false))).toBeUndefined();
  });

  it("returns undefined when an INNER hop does not fit", () => {
    // Failure must propagate out of the recursion, not be swallowed into a
    // partial path — a partial path would mint an auxiliary that loads the
    // wrong thing.
    expect(idFollowPath(member(member(ref("n", false), "a"), "b"))).toBeUndefined();
  });

  it("returns undefined for shapes that are not refs or members at all", () => {
    expect(
      idFollowPath({ kind: "call", name: "f", args: [] } as unknown as ExprIR),
    ).toBeUndefined();
  });
});

describe("joinRefPath — DECLARED from a `join … on` clause", () => {
  it("returns the name for a bare ref", () => {
    expect(joinRefPath(ref("customerId"))).toEqual(["customerId"]);
  });

  it("drops a `this` receiver — a source field is a one-segment path", () => {
    const thisRef = { kind: "this" } as unknown as ExprIR;
    expect(joinRefPath(member(thisRef, "customerId"))).toEqual(["customerId"]);
  });

  it("keeps an ALIAS receiver as the leading segment", () => {
    expect(joinRefPath(member(ref("c"), "regionId"))).toEqual(["c", "regionId"]);
  });

  it("unwraps parentheses", () => {
    const paren = { kind: "paren", inner: ref("customerId") } as unknown as ExprIR;
    expect(joinRefPath(paren)).toEqual(["customerId"]);
  });

  it("returns EMPTY (not undefined) for an unrecognised shape", () => {
    // The contract difference from `idFollowPath`: the caller falls back to the
    // join alias on `[]`, so returning undefined here would be a crash.
    expect(joinRefPath({ kind: "call", name: "f", args: [] } as unknown as ExprIR)).toEqual([]);
  });

  it("does NOT require id typing, unlike idFollowPath", () => {
    // A declared join names its column; the inference-side type guard does not
    // apply.  Asserted explicitly so the two are not "simplified" into one.
    expect(joinRefPath(ref("plain", false))).toEqual(["plain"]);
    expect(idFollowPath(ref("plain", false))).toBeUndefined();
  });
});

describe("orderAuxiliaries", () => {
  it("orders shortest path first, so a hop's prerequisite loads before it", () => {
    const auxes = new Map([
      ["b", { path: ["customerId", "regionId"], aggName: "Region" }],
      ["a", { path: ["customerId"], aggName: "Customer" }],
    ]);
    expect(orderAuxiliaries(auxes).map((a) => a.path.length)).toEqual([1, 2]);
  });

  it("mints each auxiliary's mapVar", () => {
    const auxes = new Map([
      ["a", { path: ["customerId"], aggName: "Customer" }],
      ["b", { path: ["customerId", "regionId"], aggName: "Region" }],
    ]);
    expect(orderAuxiliaries(auxes).map((a) => a.mapVar)).toEqual([
      "customerById",
      "regionByCustomerId",
    ]);
  });

  it("preserves every entry and carries path + aggName through", () => {
    const auxes = new Map([
      ["a", { path: ["x"], aggName: "A" }],
      ["b", { path: ["y"], aggName: "B" }],
      ["c", { path: ["z"], aggName: "C" }],
    ]);
    const out = orderAuxiliaries(auxes);
    expect(out).toHaveLength(3);
    expect(out.map((a) => a.aggName).sort()).toEqual(["A", "B", "C"]);
  });

  it("returns an empty list for no auxiliaries", () => {
    expect(orderAuxiliaries(new Map())).toEqual([]);
  });
});
