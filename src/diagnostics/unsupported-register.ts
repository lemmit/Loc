// ---------------------------------------------------------------------------
// The `*-unsupported` register (M-T9.27).
//
// 69 diagnostic codes in `src/` carry an `-unsupported` / `-backend` suffix.
// They LOOK like one family — "this target can't do this yet" — and that
// reading is what makes them ossify: a permanent-shaped artifact (a stable
// `loom.*` identity, documented beside real rules, matched in tests like real
// rules) standing in for a temporary condition.
//
// They are not one family.  Classifying them against their emission sites
// splits them four ways, and only ONE of the four is work:
//
//   gap    — a target hasn't implemented it yet.  A TODO.  DRAINS TO ZERO.
//   scope  — a declared v1 limit with a named successor.  Owned by a mission;
//            becomes a `gap` when that mission starts, or a `never` if the
//            limit is re-justified.
//   never  — semantically impossible or deliberately refused.  Never drains.
//            Should not be spelled `-unsupported` at all (§Rename, M-T9.27).
//   rule   — not a gap in any sense: a closed vocabulary or a misuse error the
//            suffix regex swept in.  A plain language rule wearing the wrong
//            name.
//
// WHY THIS FILE EXISTS.  Under the no-permanent-skips policy every `gap` is a
// commitment, so the gap list is a sprint backlog.  It could not be planned
// before this file: the codes were inline string literals across ~50 files, 53
// of the 69 were mentioned nowhere in `docs/new-plan/`, and the suffix itself
// misclassifies 27 of them.  You cannot drain a list you cannot enumerate, and
// you cannot enumerate this one by grep — which is exactly why `kind` is an
// explicit reviewed field here and not a naming convention.
//
// `verified` marks rows whose classification a human has confirmed against the
// emission site.  Rows land `false` and are promoted on review — an unverified
// `never` is the dangerous cell (it silently excuses work), so those are the
// ones to review first.
//
// GATED BY `test/system/unsupported-register.test.ts`: every suffixed code in
// `src/` must appear here and every row must still be emitted, so a new gap
// cannot be minted silently and a drained one cannot linger.  When a `gap`
// closes, DELETE ITS ROW in the same PR.
// ---------------------------------------------------------------------------

/** How a `*-unsupported` code relates to work.  See the header. */
export type UnsupportedKind = "gap" | "scope" | "never" | "rule";

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
  },
  {
    code: "loom.auth-ui-unsupported-framework",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:446",
    what: "`auth: ui` only on react/vue/svelte/angular; feliz + flutter open",
  },
  {
    code: "loom.chart-unsupported-target",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:363",
    what: "`Chart` primitive has no renderer on some frontends",
    mission: "M-T1.3",
  },
  {
    code: "loom.context-filter-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1998",
    what: "`filter` capability not applied by some backends",
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
  },
  {
    code: "loom.datagrid-unsupported-target",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:323",
    what: "`DataGrid` primitive has no renderer on some frontends",
    mission: "M-T1.1",
  },
  {
    code: "loom.dotnet-stamp-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1684",
    what: "principal stamp without auth / stamp on event-sourced — .NET arm",
  },
  {
    code: "loom.elixir-stamp-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1689",
    what: "principal stamp without auth / stamp on event-sourced — Elixir arm",
  },
  {
    code: "loom.java-stamp-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1683",
    what: "principal stamp without auth / stamp on event-sourced — Java arm",
  },
  {
    code: "loom.node-stamp-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1685",
    what: "principal stamp without auth / stamp on event-sourced — node arm",
  },
  {
    code: "loom.python-stamp-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1686",
    what: "principal stamp without auth / stamp on event-sourced — Python arm",
  },
  {
    code: "loom.event-sourced-workflow-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3302",
    what: "event-sourced workflow storage unimplemented on all backends",
  },
  {
    code: "loom.event-sourcing-backend-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3263",
    what: "`persistedAs: eventLog` storage emission is Hono-only",
  },
  {
    code: "loom.feliz-async-effect-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/store-checks.ts:357",
    what: "`match await` async effect unrenderable on the Feliz frontend",
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
  },
  {
    code: "loom.find-predicate-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:2729",
    what: "a find predicate the active persistence adapter cannot lower",
  },
  {
    code: "loom.flutter-primitive-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:562",
    what: "walker primitives with no Flutter renderer",
  },
  {
    code: "loom.frontend-collection-op-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/ui-checks.ts:459",
    what: "collection ops in a page expression the frontend walker can't render",
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
  },
  {
    code: "loom.java-workflow-instance-field-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1822",
    what: "workflow instance field shapes the Java emitter does not handle",
  },
  {
    code: "loom.mikroorm-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:2456",
    what: "five features whose Hono emitter is gated off under MikroORM",
    mission: "M-T6.23",
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
    site: "src/ir/validate/checks/system-checks.ts:498",
    what: "`on <channel>.<Event>` live-event handlers missing on some targets",
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

  // -------------------------------------------------------------------------
  // never — semantically impossible or deliberately refused.  These do NOT
  // drain, and spelling them `-unsupported` is what makes the debt number lie.
  // M-T9.27 §Rename retires the suffix on these.
  // -------------------------------------------------------------------------
  {
    code: "loom.backfill-target-unsupported",
    kind: "never",
    site: "src/ir/validate/checks/migration-checks.ts:42",
    what: "a document/eventLog aggregate has no SQL column to backfill",
    verified: true,
  },
  {
    code: "loom.policy-write-global-unsupported",
    kind: "never",
    site: "src/ir/validate/checks/tenancy-checks.ts:268",
    what: "root-subtree-wide mutation is a deliberate never (surface-redundancy-cuts §4)",
    verified: true,
  },
  {
    code: "loom.projection-groupby-join-unsupported",
    kind: "never",
    site: "src/ir/validate/checks/projection-checks.ts:449",
    what: "`join` is a post-query by-id load, so it cannot compose with `group by`",
    verified: true,
  },
  {
    code: "loom.projection-groupby-keyed-unsupported",
    kind: "never",
    site: "src/ir/validate/checks/projection-checks.ts:438",
    what: "`keyed by` and `group by` define conflicting row identities",
    verified: true,
  },
  {
    code: "loom.projection-groupby-source-unsupported",
    kind: "never",
    site: "src/ir/validate/checks/projection-checks.ts:421",
    what: "a grouped projection must read an aggregate source",
    verified: true,
  },
  {
    code: "loom.projection-query-and-fold-unsupported",
    kind: "never",
    site: "src/ir/validate/checks/projection-checks.ts:245",
    what: "a query source and `on(e)` event folds are mutually exclusive",
    verified: true,
  },
  {
    code: "loom.projection-source-ignoring-unsupported",
    kind: "never",
    site: "src/ir/validate/checks/projection-checks.ts:209",
    what: "`ignoring` over a projection source has no effect (read-model rows)",
    verified: true,
  },
  {
    code: "loom.projection-source-join-unsupported",
    kind: "never",
    site: "src/ir/validate/checks/projection-checks.ts:198",
    what: "by-id joins resolve aggregates, not projection rows",
    verified: true,
  },
  {
    code: "loom.projection-workflow-source-eventsourced-unsupported",
    kind: "never",
    site: "src/ir/validate/checks/projection-checks.ts:116",
    what: "an event-sourced workflow has no instance table to read",
    verified: true,
  },
  {
    code: "loom.projection-workflow-source-ignoring-unsupported",
    kind: "never",
    site: "src/ir/validate/checks/projection-checks.ts:139",
    what: "`ignoring` over a workflow source has no effect",
    verified: true,
  },
  {
    code: "loom.projection-workflow-source-join-unsupported",
    kind: "never",
    site: "src/ir/validate/checks/projection-checks.ts:128",
    what: "by-id joins resolve aggregates, not workflow instance rows",
    verified: true,
  },
  {
    code: "loom.store-cross-store-on-liveview-unsupported",
    kind: "never",
    site: "src/ir/validate/checks/store-checks.ts:256",
    what: "a LiveView process cannot reach another store's action",
    verified: true,
  },
  {
    code: "loom.store-lifetime-liveview-unsupported",
    kind: "never",
    site: "src/ir/validate/checks/store-checks.ts:236",
    what: "`persist:` lifetimes have no LiveView equivalent (server-held state)",
    verified: true,
  },

  // -------------------------------------------------------------------------
  // rule — not a gap in any sense.  A closed vocabulary or a misuse error the
  // `-unsupported` suffix swept in.  These are the proof that the suffix is not
  // a classifier: no amount of grepping separates them from the `gap` rows.
  // M-T9.27 §Rename moves them out of the suffix.
  // -------------------------------------------------------------------------
  {
    code: "loom.auth-ui-on-backend",
    kind: "rule",
    site: "src/language/validators/deployable.ts:215",
    what: "`auth: ui` on a backend deployable — misuse; backends use `auth: required`",
    verified: true,
  },
  {
    code: "loom.channelsource-unsupported-transport",
    kind: "rule",
    site: "src/language/validators/channel.ts:69",
    what: "the bound storage type is not a channel transport — type compatibility",
    verified: true,
  },
  {
    code: "loom.interp-format-unsupported",
    kind: "rule",
    site: "src/language/validators/template.ts:71",
    what: "ICU format outside the closed set (plural/selectordinal/select)",
    verified: true,
  },
  {
    code: "loom.seed-raw-unsupported-column",
    kind: "rule",
    site: "src/language/validators/seed.ts:74",
    what: "raw seed rows take scalar/enum/id columns only — use the domain path",
    verified: true,
  },
  {
    code: "loom.store-url-field-unsupported",
    kind: "rule",
    site: "src/ir/validate/checks/store-checks.ts:93",
    what: "`persist: url` fields must be scalar",
    verified: true,
  },
  {
    code: "loom.ui-handler-unsupported",
    kind: "rule",
    site: "src/language/validators/ui.ts:400",
    what: "handler bodies take `toast(…)` / `refetch(…)` only — closed vocabulary",
    verified: true,
  },
];

/** Rows that are actual work.  The sprint backlog; empty is the target state. */
export function openGaps(): readonly UnsupportedEntry[] {
  return UNSUPPORTED_REGISTER.filter((e) => e.kind === "gap");
}
