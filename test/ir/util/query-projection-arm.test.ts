import { describe, expect, it } from "vitest";
import type {
  BoundedContextIR,
  EnrichedAggregateIR,
  ExprIR,
  ProjectionIR,
} from "../../../src/ir/types/loom-ir.js";
import {
  columnlessProjectionSource,
  documentAggregationSource,
  queryProjectionArm,
  readsAggregateTableDirectly,
  unappliedCapabilityFilters,
} from "../../../src/ir/util/query-projection-arm.js";

// WHICH shape a query-time projection reads through, and whether the source it
// reads has the COLUMNS that shape's SQL would name.  M-T9.17 slice 3 — no test
// imports this module directly.
//
// Both halves of the pipeline depend on this classifier and may not import each
// other: `ir/validate` raises `loom.projection-columnless-source` from it, and
// each backend's projection emitter picks its arm from it.  If the two ever
// disagreed the result is the silent miscompile the gate exists to prevent —
// EF's `o.Total` a CS1061, drizzle's `schema.orders.total` a TS2339, and for an
// event-sourced source no table to name at all.  So each arm, and each of the
// column gate's per-source-kind reasons, is asserted alone.
//
// One caveat found by mutation and left visible rather than papered over: the
// grouped-over-singleton precedence is guarded in TWO places that mask each
// other, so no single mutation can make that assertion fail (see the note on
// the test itself).  Every other assertion here fails to a single mutation.

const primitive = (name: string) => ({ kind: "primitive", name }) as never;

const member = (m: string): ExprIR =>
  ({
    kind: "member",
    receiver: { kind: "this" },
    member: m,
    memberType: primitive("decimal"),
  }) as unknown as ExprIR;

/** An aggregating select (`select total = sum(o.total)`). */
const aggSelect = (field: string, arg?: ExprIR) => ({
  field,
  type: primitive("int"),
  expr: member(field),
  aggregate: { fn: arg ? "sum" : "count", arg: arg ?? undefined },
});

/** A per-row select (`select status = o.status`). */
const rowSelect = (field: string) => ({
  field,
  type: primitive("string"),
  expr: member(field),
});

const proj = (query: Record<string, unknown>): ProjectionIR =>
  ({ name: "P", query, wireShape: [] }) as unknown as ProjectionIR;

const agg = (over: Partial<EnrichedAggregateIR> = {}): EnrichedAggregateIR =>
  ({
    name: "Order",
    persistedAs: "state",
    savingShape: "relational",
    ...over,
  }) as unknown as EnrichedAggregateIR;

const ctxWith = (...aggregates: EnrichedAggregateIR[]): BoundedContextIR =>
  ({ name: "C", aggregates }) as unknown as BoundedContextIR;

describe("queryProjectionArm — the five arms, in the order every emitter branches", () => {
  it("`group by` wins: GROUPED even when every select aggregates", () => {
    // A grouped projection is one row per key, not one row overall.  That
    // precedence is guarded TWICE — `grouped` is checked first here, AND
    // `wholeTableAggregates` independently refuses any projection carrying
    // `groupBy`.  Verified by mutation: removing either defence alone changes
    // nothing (each masks the other), and removing BOTH flips this assertion to
    // "singleton".  So this test does reach the behaviour; it just cannot
    // attribute it to one of the two guards, and neither can a reader — which is
    // why it is written against the OUTCOME rather than against either guard.
    const p = proj({
      source: "Order",
      sourceKind: "aggregate",
      groupBy: [member("status")],
      selects: [aggSelect("n")],
    });
    expect(queryProjectionArm(p)).toBe("grouped");
  });

  it("all-aggregate selects with NO group by: SINGLETON", () => {
    expect(queryProjectionArm(proj({ source: "Order", selects: [aggSelect("n")] }))).toBe(
      "singleton",
    );
  });

  it("a MIX of aggregate and per-row selects is not a singleton", () => {
    // All-or-nothing: the mix without `group by` is rejected upstream by
    // `loom.projection-groupby-missing`, and calling it a singleton here would
    // take the aggregation path with an unresolved per-row select in it.
    const p = proj({ source: "Order", selects: [aggSelect("n"), rowSelect("status")] });
    expect(queryProjectionArm(p)).toBe("repository");
  });

  it("`from <Workflow>` reads the saga-state store — WORKFLOW", () => {
    expect(queryProjectionArm(proj({ source: "Signup", sourceKind: "workflow" }))).toBe("workflow");
  });

  it("`from <OtherProjection>` reads a folded read model — PROJECTION", () => {
    expect(queryProjectionArm(proj({ source: "Totals", sourceKind: "projection" }))).toBe(
      "projection",
    );
  });

  it("`from <Aggregate>` falls through to REPOSITORY", () => {
    expect(queryProjectionArm(proj({ source: "Order", sourceKind: "aggregate" }))).toBe(
      "repository",
    );
  });

  it("an aggregating projection over a WORKFLOW source is still an aggregation arm", () => {
    // The aggregation checks run before the source-kind checks, so a
    // `sourceKind: workflow` carrying only aggregate selects is a singleton —
    // the arm order is not merely cosmetic.
    const p = proj({ source: "Signup", sourceKind: "workflow", selects: [aggSelect("n")] });
    expect(queryProjectionArm(p)).toBe("singleton");
  });

  it("a projection with no query at all is a REPOSITORY read", () => {
    expect(queryProjectionArm({ name: "P" } as unknown as ProjectionIR)).toBe("repository");
  });
});

describe("readsAggregateTableDirectly — which arms name columns", () => {
  it("is true for exactly the two aggregation arms", () => {
    expect(readsAggregateTableDirectly("grouped")).toBe(true);
    expect(readsAggregateTableDirectly("singleton")).toBe(true);
  });

  it("is false for the three arms that read through a hydrating store", () => {
    // Repository / saga-state / read-model reads go through a store the backend
    // itself emitted, so the source's fields never have to BE columns — which
    // is exactly why the column gate below must not fire on them.
    for (const arm of ["repository", "workflow", "projection"] as const) {
      expect(readsAggregateTableDirectly(arm), arm).toBe(false);
    }
  });
});

describe("columnlessProjectionSource — the universal (not per-adapter) column gate", () => {
  const singletonOver = (source: string, selects = [aggSelect("n")]) =>
    proj({ source, sourceKind: "aggregate", selects });

  it("passes a relational source", () => {
    expect(
      columnlessProjectionSource(singletonOver("Order"), ctxWith(agg()), undefined),
    ).toBeNull();
  });

  it("refuses an EVENT-SOURCED source — there is no state table to aggregate", () => {
    const reason = columnlessProjectionSource(
      singletonOver("Order"),
      ctxWith(agg({ persistedAs: "eventLog" })),
      undefined,
    );
    expect(reason).toContain("event-sourced");
  });

  it("refuses a TPC abstract base — no table of its own", () => {
    const reason = columnlessProjectionSource(
      singletonOver("Order"),
      ctxWith(
        agg({ isAbstract: true, inheritanceUsing: "ownTable" } as Partial<EnrichedAggregateIR>),
      ),
      undefined,
    );
    expect(reason).toContain("TPC");
  });

  it("does NOT refuse an abstract base under TPH — that one HAS a shared table", () => {
    // The `isAbstract && inheritanceUsing === "ownTable"` conjunction asserted
    // on its own half: a TPH base maps to a single discriminated table whose
    // columns a SQL aggregate can name.
    expect(
      columnlessProjectionSource(
        singletonOver("Order"),
        ctxWith(
          agg({
            isAbstract: true,
            inheritanceUsing: "singleTable",
          } as Partial<EnrichedAggregateIR>),
        ),
        undefined,
      ),
    ).toBeNull();
  });

  it("refuses a DOCUMENT source when the SQL would name a declared field", () => {
    const reason = columnlessProjectionSource(
      singletonOver("Order", [aggSelect("total", member("total"))]),
      ctxWith(agg({ savingShape: "document" } as Partial<EnrichedAggregateIR>)),
      undefined,
    );
    expect(reason).toContain("shape: document");
    expect(reason).toContain("'total'");
  });

  it("ALLOWS `count()` over a document source — `id` is the one real column", () => {
    // The row-count tile `scaffoldDashboard` emits.  A document table is the
    // `(id, data, version)` triple, so a bare count survives the gate and must
    // keep doing so; refusing it would break every scaffolded dashboard.
    expect(
      columnlessProjectionSource(
        singletonOver("Order", [aggSelect("n")]),
        ctxWith(agg({ savingShape: "document" } as Partial<EnrichedAggregateIR>)),
        undefined,
      ),
    ).toBeNull();
  });

  it("ALLOWS a document source whose only named member is `id`", () => {
    expect(
      columnlessProjectionSource(
        singletonOver("Order", [aggSelect("n", member("id"))]),
        ctxWith(agg({ savingShape: "document" } as Partial<EnrichedAggregateIR>)),
        undefined,
      ),
    ).toBeNull();
  });

  it("sees a column named in the `where` predicate, not only in a select", () => {
    // `directTableColumnRefs` collects the filter, the group-by keys AND the
    // selects; a select-only scan would pass a predicate the SQL still has to
    // render as a column.
    const p = proj({
      source: "Order",
      sourceKind: "aggregate",
      selects: [aggSelect("n")],
      filter: member("status"),
    });
    const reason = columnlessProjectionSource(
      p,
      ctxWith(agg({ savingShape: "document" } as Partial<EnrichedAggregateIR>)),
      undefined,
    );
    expect(reason).toContain("'status'");
  });

  it("sees a column named in a `group by` key", () => {
    const p = proj({
      source: "Order",
      sourceKind: "aggregate",
      groupBy: [member("region")],
      selects: [aggSelect("n")],
    });
    const reason = columnlessProjectionSource(
      p,
      ctxWith(agg({ savingShape: "document" } as Partial<EnrichedAggregateIR>)),
      undefined,
    );
    expect(reason).toContain("'region'");
  });

  it("never fires on a REPOSITORY-arm projection, whatever the source shape", () => {
    // The arm guard, asserted against the worst source: an event-sourced
    // aggregate read through its own repository hydrates rows perfectly well.
    const p = proj({ source: "Order", sourceKind: "aggregate" });
    expect(
      columnlessProjectionSource(p, ctxWith(agg({ persistedAs: "eventLog" })), undefined),
    ).toBeNull();
  });

  it("is silent when the named source is not an aggregate in this context", () => {
    // A workflow / projection source, or a dangling name: not this gate's
    // diagnostic to raise.
    expect(columnlessProjectionSource(singletonOver("Nope"), ctxWith(agg()), undefined)).toBeNull();
  });
});

describe("documentAggregationSource — the one place the arm+shape question is answered", () => {
  it("returns the aggregate for a direct-table read over a document source", () => {
    const a = agg({ savingShape: "document" } as Partial<EnrichedAggregateIR>);
    const p = proj({ source: "Order", sourceKind: "aggregate", selects: [aggSelect("n")] });
    expect(documentAggregationSource(p, ctxWith(a), undefined)).toBe(a);
  });

  it("is undefined for a document source read through its REPOSITORY", () => {
    const a = agg({ savingShape: "document" } as Partial<EnrichedAggregateIR>);
    const p = proj({ source: "Order", sourceKind: "aggregate" });
    expect(documentAggregationSource(p, ctxWith(a), undefined)).toBeUndefined();
  });

  it("is undefined for a direct-table read over a RELATIONAL source", () => {
    const p = proj({ source: "Order", sourceKind: "aggregate", selects: [aggSelect("n")] });
    expect(documentAggregationSource(p, ctxWith(agg()), undefined)).toBeUndefined();
  });

  it("is undefined when the source names no aggregate in this context", () => {
    const p = proj({ source: "Nope", sourceKind: "aggregate", selects: [aggSelect("n")] });
    expect(documentAggregationSource(p, ctxWith(agg()), undefined)).toBeUndefined();
  });

  it("agrees with `columnlessProjectionSource` about which arm is in play", () => {
    // Both gates key off `readsAggregateTableDirectly(queryProjectionArm(...))`.
    // A repository-arm projection must be invisible to both, or one of them
    // reports a defect the other says does not exist.
    const a = agg({ savingShape: "document" } as Partial<EnrichedAggregateIR>);
    const repoArm = proj({ source: "Order", sourceKind: "aggregate" });
    expect(documentAggregationSource(repoArm, ctxWith(a), undefined)).toBeUndefined();
    expect(columnlessProjectionSource(repoArm, ctxWith(a), undefined)).toBeNull();
  });
});

describe("unappliedCapabilityFilters — what a document aggregation would still have to apply", () => {
  const filtered = (over: Partial<EnrichedAggregateIR> = {}) =>
    agg({
      contextFilters: [{} as never, {} as never],
      contextFilterOrigins: ["Tenancy", "SoftDelete"],
      ...over,
    } as Partial<EnrichedAggregateIR>);

  it("is empty for an aggregate with no filtering capability at all", () => {
    expect(unappliedCapabilityFilters(proj({}), agg())).toEqual([]);
  });

  it("labels every unbypassed capability, in declaration order", () => {
    expect(unappliedCapabilityFilters(proj({}), filtered())).toEqual(["'Tenancy'", "'SoftDelete'"]);
  });

  it("`ignoring *` (bypassAll) waives everything — the not-gated answer", () => {
    expect(unappliedCapabilityFilters(proj({ bypassAll: true }), filtered())).toEqual([]);
  });

  it("`ignoring <Cap>` drops exactly the named capability", () => {
    expect(unappliedCapabilityFilters(proj({ bypassCaps: ["Tenancy"] }), filtered())).toEqual([
      "'SoftDelete'",
    ]);
  });

  it("an ANONYMOUS filter can never be bypassed — it is labelled, not dropped", () => {
    // A bare context-level `filter` (or a derived tenancy scope) has no origin,
    // so `ignoring <Cap>` cannot name it.  It still has to be applied, and the
    // author still has to be told which read is unsafe — dropping it here would
    // silently pass an aggregation that counts every tenant's rows.
    const anon = agg({
      contextFilters: [{} as never],
      contextFilterOrigins: [],
    } as Partial<EnrichedAggregateIR>);
    expect(unappliedCapabilityFilters(proj({ bypassAll: false }), anon)).toEqual([
      "a 'filter' on 'Order'",
    ]);
  });

  it("`ignoring *` waives an anonymous filter too", () => {
    const anon = agg({
      contextFilters: [{} as never],
      contextFilterOrigins: [],
    } as Partial<EnrichedAggregateIR>);
    expect(unappliedCapabilityFilters(proj({ bypassAll: true }), anon)).toEqual([]);
  });

  it("deduplicates two predicates from the SAME capability into one label", () => {
    const twice = agg({
      contextFilters: [{} as never, {} as never],
      contextFilterOrigins: ["Tenancy", "Tenancy"],
    } as Partial<EnrichedAggregateIR>);
    expect(unappliedCapabilityFilters(proj({}), twice)).toEqual(["'Tenancy'"]);
  });

  it("pairs each predicate with the origin at its OWN index", () => {
    // `origins[i]`, not "is this capability bypassed anywhere": a bypass of the
    // first capability must not waive the second predicate.
    const p = proj({ bypassCaps: ["SoftDelete"] });
    expect(unappliedCapabilityFilters(p, filtered())).toEqual(["'Tenancy'"]);
  });
});
