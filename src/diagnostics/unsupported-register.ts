// ---------------------------------------------------------------------------
// The `*-unsupported` register (M-T9.27).
//
// Every diagnostic code in `src/` carrying an `-unsupported` / `-backend`
// suffix is WORK — either now (`gap`) or later (`scope`).  That invariant is
// the point of this file, and slice 2 is what made it true.
//
//   gap    — a target hasn't implemented it yet.  A TODO.  DRAINS TO ZERO.
//   scope  — a declared v1 limit with a named successor.  Owned by a mission;
//            becomes a `gap` when that mission starts, or is renamed out (as
//            below) if the limit is re-justified as permanent.
//
// HOW IT GOT THIS WAY.  The suffix originally spanned 69 codes and LOOKED like
// one family — "this target can't do this yet" — which is what made them
// ossify: a permanent-shaped artifact (a stable `loom.*` identity, documented
// beside real rules, matched in tests like real rules) standing in for a
// temporary condition.  Classifying all 69 against their emission sites split
// them FOUR ways, and 27 turned out not to be work at all:
//
//   * 13 were semantically impossible or deliberately refused
//     (`projection-groupby-join`: a join is a by-id load AFTER the query, so it
//     cannot compose with `group by`; `policy-write-global`, a documented
//     deliberate never).  Those never drain.
//   * 6 were not gaps in any sense — a closed vocabulary or a misuse error the
//     suffix regex swept in (`auth-ui-on-backend` was a misuse error;
//     `ui-handler-unsupported` a closed statement vocabulary).
//
// Slice 2 RENAMED all 19 out of the suffix — `-invalid` (impossible/refused),
// `-no-effect` (parses, does nothing), `-unknown` (not in a closed vocabulary)
// — so they no longer read as parity debt and no longer land in this register.
// That is why the two kinds below are the only two left: a third of the
// apparent debt was permanent by design, and leaving it here would have stalled
// any drain sprint at 19 rows nothing could close.
//
// The lasting lesson: NO NAMING CONVENTION separates these.  The classification
// is a reviewed field, not something derivable from the code name — which is
// why `kind` is written down per row.
//
// `verified` marks rows whose classification a human has confirmed against the
// emission site.  Rows land `false` and are promoted on review.
//
// GATED BY `test/system/unsupported-register.test.ts`: every suffixed code in
// `src/` must appear here and every row must still be emitted, so a new gap
// cannot be minted silently and a drained one cannot linger.  When a `gap`
// closes, DELETE ITS ROW in the same PR.
// ---------------------------------------------------------------------------

/** How a `*-unsupported` code relates to work — now or later.  See the header.
 *  A code that is NEITHER (impossible, refused, or a plain rule) does not
 *  belong in the suffix at all; rename it, per slice 2. */
export type UnsupportedKind = "gap" | "scope";

export interface UnsupportedEntry {
  /** The `loom.*` diagnostic code. */
  code: string;
  kind: UnsupportedKind;
  /** `file:line` of the first emission site, for the reviewer. */
  site: string;
  /** One line: what the code refuses. */
  what: string;
  /** Owning mission, where one exists.  A `gap` without one is unowned work. */
  mission?: string;
  /** Classification confirmed against the emission site by a human. */
  verified?: boolean;
}

export const UNSUPPORTED_REGISTER: readonly UnsupportedEntry[] = [
  // -------------------------------------------------------------------------
  // gap — real parity TODOs.  This is the sprint backlog.  Drains to zero.
  // -------------------------------------------------------------------------
  {
    code: "loom.audited-backend-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3484",
    what: "per-operation audit-record emission missing on some backends",
    mission: "M-T6.32",
  },
  {
    code: "loom.auth-ui-unsupported-framework",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:547",
    what: "`auth: ui` ships on every frontend; the seam a NEW one gates on",
    mission: "M-T1.20",
  },
  {
    code: "loom.chart-unsupported-target",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:425",
    what: "`Chart` primitive has no renderer on some frontends",
    mission: "M-T1.3",
  },
  {
    code: "loom.context-filter-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1998",
    what: "`filter` capability not applied by some backends",
    mission: "M-T6.32",
  },
  {
    code: "loom.context-test-unsupported",
    kind: "gap",
    site: "src/language/validators/test-placement.ts:104",
    what: "context-level `test` produces no runnable test on some deployables",
    mission: "M-T5.19",
  },
  {
    code: "loom.dapper-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:2274",
    what: "features the .NET Dapper persistence adapter does not emit",
    mission: "M-T6.35",
  },
  {
    code: "loom.datagrid-unsupported-target",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:323",
    what: "`DataGrid` primitive has no renderer on some frontends",
    mission: "M-T1.1",
  },
  {
    code: "loom.event-sourced-workflow-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3302",
    what: "event-sourced workflow storage unimplemented on all backends",
    mission: "M-T6.34",
  },
  {
    code: "loom.event-sourcing-backend-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3263",
    what: "`persistedAs: eventLog` storage emission is Hono-only",
    mission: "M-T6.34",
  },
  {
    code: "loom.feliz-async-effect-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/store-checks.ts:357",
    what: "`match await` async effect unrenderable on the Feliz frontend",
    mission: "M-T1.20",
  },
  {
    code: "loom.field-mask-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3410",
    what: "`mask unless` read redaction missing on some backends",
    mission: "M-T3.2",
  },
  {
    code: "loom.filter-bypass-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:2201",
    what: "`ignoring` capability-filter bypass unimplemented on some backends",
    mission: "M-T6.32",
  },
  {
    code: "loom.find-predicate-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:2729",
    what: "a find predicate the active persistence adapter cannot lower",
    mission: "M-T6.35",
  },
  {
    code: "loom.flutter-primitive-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:562",
    what: "walker primitives with no Flutter renderer",
    mission: "M-T1.20",
  },
  {
    code: "loom.frontend-collection-op-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/ui-checks.ts:459",
    what: "collection ops in a page expression the frontend walker can't render",
    mission: "M-T1.20",
  },
  {
    code: "loom.generic-carrier-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/structural-checks.ts:344",
    what: "generic payload carriers missing on some backends",
    mission: "M-T5.3",
  },
  {
    code: "loom.java-projection-field-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1839",
    what: "projection field shapes the Java emitter does not handle",
    mission: "M-T6.36",
  },
  {
    code: "loom.java-workflow-instance-field-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1822",
    what: "workflow instance field shapes the Java emitter does not handle",
    mission: "M-T6.36",
  },
  {
    code: "loom.mikroorm-unsupported",
    kind: "gap",
    // Re-pointed 2026-08-24: the five feature clauses and the two shape rejects
    // this row used to name are all drained, and `validateMikroOrmSupport` was
    // deleted with them (#2621 / #2623) — the block comment at its old site in
    // `system-checks.ts` records why.  The one surviving raiser is unrelated to
    // any of them: declared migration steps `orm.schema.updateSchema()` can
    // never apply (a rename resolves as DROP + ADD).  Twin of
    // `loom.dapper-unsupported#migrations`, hence the same owning mission.
    site: "src/ir/validate/checks/migration-checks.ts:254",
    what: "declared migration steps the MikroORM adapter's schema sync cannot apply",
    mission: "M-T6.35",
  },
  {
    code: "loom.operation-return-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/structural-checks.ts:626",
    what: "`or`-union operation return types missing on some backends",
    mission: "M-T5.1",
  },
  {
    code: "loom.paged-query-handler-unsupported-backend",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:200",
    what: "`paged` envelope from a queryHandler is node-only",
    mission: "M-T2.6",
  },
  {
    code: "loom.persistence-mode-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1151",
    what: "a persistedAs/shape combination the deployable's adapter can't store",
    mission: "M-T6.35",
  },
  {
    code: "loom.polymorphic-id-ref-unsupported",
    kind: "gap",
    site: "src/language/validators/inheritance.ts:242",
    what: "polymorphic `<Base> id` references unimplemented",
    mission: "M-T5.7",
  },
  {
    code: "loom.projection-groupby-unsupported-backend",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:177",
    what: "`group by` grouped read model missing on some backends",
    mission: "M-T4.2",
  },
  {
    code: "loom.projection-query-time-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:223",
    what: "query-time projection comprehension missing on some backends",
    mission: "M-T4.2",
  },
  {
    code: "loom.projection-source-unsupported-backend",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:286",
    what: "projection sourced from another projection's rows — some backends",
    mission: "M-T4.2",
  },
  {
    code: "loom.projection-whole-table-aggregation-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:148",
    what: "whole-table `select f = agg(…)` missing on some backends",
    mission: "M-T4.2",
  },
  {
    code: "loom.projection-workflow-source-unsupported-backend",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:255",
    what: "projection sourced from a workflow's instance rows — some backends",
    mission: "M-T4.2",
  },
  {
    code: "loom.provenanced-backend-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3343",
    what: "provenance runtime (trace capture + history) missing on some backends",
    mission: "M-T6.32",
  },
  {
    code: "loom.remote-api-op-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:2855",
    what: "in-system typed api call unimplemented on some caller backends",
    mission: "M-T4.8",
  },
  {
    code: "loom.saving-shape-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1282",
    what: "a `shape(...)` the hosting backend cannot persist",
    mission: "M-T6.35",
  },
  {
    code: "loom.store-lifetime-target-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/store-checks.ts:327",
    what: "a persisted store field with no total F# (feliz) or Dart (flutter) codec",
    mission: "M-T1.20",
  },
  {
    code: "loom.tph-backend-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3222",
    what: "sharedTable (TPH) inheritance storage missing on some backends",
    mission: "M-T5.7",
  },
  {
    code: "loom.ui-projection-read-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:407",
    what: "ui→projection read path missing on some frontends",
    mission: "M-T1.3",
  },
  {
    code: "loom.ui-realtime-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:661",
    what: "`on <channel>.<Event>` handlers vs. a backend that serves no SSE wire",
    mission: "M-T1.20",
  },
  {
    code: "loom.union-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/structural-checks.ts:513",
    what: "discriminated unions missing on some backends",
    mission: "M-T5.3",
  },
  {
    code: "loom.vanilla-document-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1528",
    what: "`shape: document` partially emitted on Elixir",
    mission: "M-T6.35",
  },
  {
    code: "loom.when-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/structural-checks.ts:584",
    what: "`when` canCommand gate missing on some backends",
    mission: "M-T5.8",
  },

  // -------------------------------------------------------------------------
  // scope — a declared v1 limit with a named successor.  Mission-owned; not
  // sprint work until its mission starts.
  // -------------------------------------------------------------------------
  {
    code: "loom.criterion-unsupported-target",
    kind: "scope",
    site: "src/language/validators/criterion.ts:86",
    what: "criteria over primitives/VOs/enums reserved for `from <Criterion>(args)`",
    mission: "M-T5.4",
    verified: true,
  },
  {
    code: "loom.e2e-unsupported-statement",
    kind: "scope",
    site: "src/ir/validate/checks/test-checks.ts:174",
    what: "e2e bodies accept a closed statement set (expect/let/expression/…)",
    mission: "M-T5.19",
    verified: true,
  },
  {
    code: "loom.migration-expr-unsupported",
    kind: "scope",
    site: "src/ir/validate/checks/migration-checks.ts:68",
    what: "backfill exprs are a narrow validated ExprIR subset by design",
    mission: "M-T2.3",
    verified: true,
  },
  {
    code: "loom.retrieval-loads-unsupported",
    kind: "scope",
    site: "src/ir/validate/checks/query-checks.ts:278",
    what: "explicit `loads:` deferred — retrievals load the whole aggregate",
    mission: "M-T5.4",
    verified: true,
  },
  {
    code: "loom.tph-own-override-unsupported",
    kind: "scope",
    site: "src/language/validators/inheritance.ts:142",
    what: "per-concrete ownTable override inside a TPH hierarchy",
    mission: "M-T5.7",
    verified: true,
  },
  {
    code: "loom.union-find-shape-unsupported",
    kind: "scope",
    site: "src/ir/validate/checks/structural-checks.ts:483",
    what: "repository finds returning a union — v1 shape only",
    mission: "M-T5.3",
    verified: true,
  },
  {
    code: "loom.handler-load-nullable-unsupported",
    kind: "scope",
    site: "src/ir/validate/checks/api-checks.ts:116",
    what: "command/query handler load of a nullable result — v1 is single non-nullable",
    verified: true,
  },
  {
    code: "loom.workflow-load-array-unsupported",
    kind: "scope",
    site: "src/ir/validate/checks/workflow-checks.ts:591",
    what: "workflow load of an array result — v1 is single non-nullable",
    verified: true,
  },
  {
    code: "loom.workflow-load-nullable-unsupported",
    kind: "scope",
    site: "src/ir/validate/checks/workflow-checks.ts:600",
    what: "workflow load of a nullable result — v1 is single non-nullable",
    verified: true,
  },
];

/** Rows that are actual work.  The sprint backlog; empty is the target state. */
export function openGaps(): readonly UnsupportedEntry[] {
  return UNSUPPORTED_REGISTER.filter((e) => e.kind === "gap");
}
