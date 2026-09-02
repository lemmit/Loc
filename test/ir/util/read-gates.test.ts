import { describe, expect, it } from "vitest";
import type { ExprIR, FindIR, RepositoryIR } from "../../../src/ir/types/loom-ir.js";
import { listReadFind, listReadGate } from "../../../src/ir/util/read-gates.js";

// The aggregate's canonical LIST read and the `requires` gate on it.
// M-T9.17 slice 5 — no test calls either export today.
//
// This module exists because of a shipped authorization hole, and its header
// names it: java, python and elixir each special-case `all` OUT of their
// declared-find loop (the list route has a bespoke shape — paging controls, the
// `<Agg>Paged` envelope, `index`), and each then emitted that bespoke route
// without ever reading the find's `requires`.  The same `.ddd` served the list
// 403-gated on node/.NET and WIDE OPEN on the other three.  The gate parsed,
// validated and lowered correctly the whole time; three emitters simply read
// every other field on the find except that one.
//
// So the two questions worth pinning are exactly the two the emitters get
// wrong: WHICH find backs the list (the author's, when they declared one), and
// whether it carries a gate (only the author's can).

const gateExpr = (src: string): ExprIR =>
  ({ kind: "ref", name: src, refKind: "current-user" }) as unknown as ExprIR;

const find = (name: string, requires?: ExprIR): FindIR =>
  ({ name, params: [], requires }) as unknown as FindIR;

const repo = (finds: FindIR[]): RepositoryIR =>
  ({ name: "Orders", forAggregate: "Order", finds }) as unknown as RepositoryIR;

describe("listReadFind — which find backs GET /<aggs>", () => {
  it("finds the `all` entry", () => {
    const all = find("all");
    expect(listReadFind(repo([all]))).toBe(all);
  });

  it("picks `all` out of a repository carrying other finds", () => {
    const all = find("all");
    expect(listReadFind(repo([find("byStatus"), all, find("recent")]))).toBe(all);
  });

  it("is undefined when no find is named `all`", () => {
    expect(listReadFind(repo([find("byStatus")]))).toBeUndefined();
    expect(listReadFind(repo([]))).toBeUndefined();
  });

  it("tolerates an undefined repository", () => {
    // Every call site uses this unconditionally on an aggregate that may have
    // no repository at all.
    expect(listReadFind(undefined)).toBeUndefined();
  });

  it("matches the name EXACTLY — `allOpen` is not the list read", () => {
    // A prefix or `includes` match would silently route a differently-named
    // find's gate onto the list endpoint, which is the same class of bug in
    // the opposite direction.
    expect(listReadFind(repo([find("allOpen"), find("findAll")]))).toBeUndefined();
  });
});

describe("listReadGate — the gate three backends were not reading", () => {
  it("is undefined for the enrichment-injected `all` (it carries no gate)", () => {
    // The synthesized find has no author source line, which is also why
    // `loom.default-deny-ungated` exempts it.
    expect(listReadGate(repo([find("all")]))).toBeUndefined();
  });

  it("returns the AUTHOR's gate when they declared their own `find all()`", () => {
    // `repository Orders for Order { find all(): Order[] requires currentUser.role == "admin" }`
    // — the shape that was served wide open on java/python/elixir.
    const g = gateExpr("admin-only");
    expect(listReadGate(repo([find("all", g)]))).toBe(g);
  });

  it("does NOT return a gate from some OTHER find", () => {
    // The list route must evaluate the LIST read's gate, not whichever gate
    // happens to be nearby: picking up a neighbour's would 403 the list on a
    // rule the author wrote for a different endpoint.
    expect(listReadGate(repo([find("byStatus", gateExpr("other")), find("all")]))).toBeUndefined();
  });

  it("is undefined when there is no `all` find, and for an undefined repository", () => {
    expect(listReadGate(repo([find("byStatus", gateExpr("g"))]))).toBeUndefined();
    expect(listReadGate(undefined)).toBeUndefined();
  });

  it("is derived from `listReadFind`, so the two never disagree", () => {
    // Both halves read the same find.  A backend that resolved the find one way
    // for the query and another way for the gate is the drift this single
    // derivation exists to prevent.
    const g = gateExpr("admin-only");
    const r = repo([find("byStatus", gateExpr("other")), find("all", g)]);
    expect(listReadGate(r)).toBe(listReadFind(r)?.requires);
  });
});
