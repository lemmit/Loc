// ---------------------------------------------------------------------------
// The `*-unsupported` register (M-T9.27).
//
// Every diagnostic code in `src/` carrying an `-unsupported` / `-backend`
// suffix is WORK — either now (`gap`) or later (`scope`).  That invariant is
// the point of this file.
//
//   gap    — a target hasn't implemented it yet.  A TODO.  DRAINS TO ZERO.
//   scope  — a declared v1 limit with a named successor.  Owned by a mission;
//            becomes a `gap` when that mission starts, or is renamed out (as
//            below) if the limit is re-justified as permanent.
//
// WHAT DOES NOT BELONG HERE.  The suffix reads like one family — "this target
// can't do this yet" — which is exactly how a permanent-shaped artifact (a
// stable `loom.*` identity, documented beside real rules, matched in tests like
// real rules) comes to stand in for a temporary condition.  A code that is NOT
// work does not carry the suffix and does not get a row:
//
//   * semantically impossible or deliberately refused — `-invalid`
//     (`projection-groupby-join`: a join is a by-id load AFTER the query, so it
//     cannot compose with `group by`; `policy-write-global`, a documented
//     deliberate never);
//   * parses and does nothing — `-no-effect`;
//   * not in a closed vocabulary, or a plain misuse error — `-unknown`
//     (`auth-ui-on-backend` is a misuse error; `ui-handler-unsupported` a closed
//     statement vocabulary).
//
// Leaving those here would stall any drain sprint on rows nothing can close.
//
// The lasting lesson: NO NAMING CONVENTION separates these.  The classification
// is a reviewed field, not something derivable from the code name — which is
// why `kind` is written down per row.
//
// `verified` marks rows whose classification a human has confirmed against the
// emission site.  Rows land `false` and are promoted on review.
//
// LATENT ROWS — why a `gap` can be a gate nothing can trip.  Many gates' Sets
// (EVENT_SOURCING_BACKENDS, PROJECTION_*_SUPPORTED, SUPPORTED_UNION_BACKENDS,
// FIELD_MASK_BACKENDS, CHART_FRAMEWORKS, PROJECTION_READ_FRAMEWORKS, …) name
// every shipping target, so the gate fires for nothing that exists.  Those
// gates are deliberately KEPT — they are the seam the NEXT backend/frontend
// gates on until it ports, the pattern CHART_FRAMEWORKS documents at
// system-checks.ts.  Their rows stay too, because the code IS still emitted in
// `src/` and that invariant demands a row; such a row's `what` says "ships on
// all five; latent seam for a NEW target" rather than reading as a TODO.
//
// So the `gap` count is NOT a backlog depth: a latent row drains only when the
// gate itself is deleted (a decision about the seam), while a live row drains
// when a target ports.  Read each row's `what` to tell which you are looking at
// — "latent seam" / "dormant" / "unreachable backstop" mark the former.  The
// classification stayed `gap` on purpose: nothing here is a declared v1 limit
// with a successor mission (that is `scope`), and inventing a third kind would
// change what the pin counts without changing what is true.
//
// GATED BY `test/system/unsupported-register.test.ts`: every suffixed code in
// `src/` must appear here and every row must still be emitted, so a new gap
// cannot be minted silently and a drained one cannot linger.  When a `gap`
// closes, DELETE ITS ROW in the same PR.
// ---------------------------------------------------------------------------

/** How a `*-unsupported` code relates to work — now or later.  See the header.
 *  A code that is NEITHER (impossible, refused, or a plain rule) does not
 *  belong in the suffix at all — rename it, per the header. */
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
    site: "src/ir/validate/checks/system-checks.ts:3912",
    what:
      "audit-record emission (`operation … audited`, `audited create|destroy`) ships on all five " +
      "backends (AUDIT_OP_BACKENDS / AUDIT_LIFECYCLE_BACKENDS) — fires only when NO backend " +
      "deployable hosts the context",
    mission: "M-T6.32",
  },
  {
    code: "loom.audited-returning-operation-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3798",
    what: "`audited`/`provenanced` × a RETURNING operation falls into node's void-204 handler",
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
    site: "src/ir/validate/checks/system-checks.ts:441",
    what:
      "`Chart` renders on every shipping frontend (CHART_FRAMEWORKS names all seven) — latent " +
      "seam a NEW framework gates on until it ports",
    mission: "M-T1.3",
  },
  {
    code: "loom.context-filter-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:2385",
    what:
      "a `currentUser`-referencing `filter` capability on a deployable with no `auth: required` " +
      "+ system `user {}` — there is no principal to scope by.  The backend×shape half is gone: " +
      "every family now wires capability filters (elixir document evaluates them in-app)",
    mission: "M-T6.32",
  },
  {
    code: "loom.context-test-unsupported",
    kind: "gap",
    site: "src/language/validators/test-placement.ts:104",
    what:
      "context-level `test` whose target context no INTEGRATION_BACKENDS deployable hosts — all " +
      "five backends render context integration tests, so only a frontend-only host warns",
    mission: "M-T5.19",
  },
  {
    code: "loom.dapper-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:2629",
    what:
      "the .NET Dapper residue after full EF parity: an AGGREGATING query-time projection over a " +
      "document/event-sourced source, a hierarchical (deep/global) tenancy scope filter, and the " +
      "two self-provisioning limits — declared migration steps and Postgres schema placement " +
      "(migration-checks.ts, `validateMigrationAdapterSupport` / " +
      "`validateSelfProvisioningSchemaSupport`)",
    mission: "M-T6.35",
  },
  {
    code: "loom.datagrid-unsupported-target",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:353",
    what:
      "`DataGrid` (a TanStack row model) outside DATA_GRID_FRAMEWORKS — phoenixLiveView is the " +
      "open leg; flutter is a settled never (native build, no JS runtime — D-DATAGRID-TARGETS)",
    mission: "M-T1.1",
  },
  {
    code: "loom.event-sourced-workflow-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3724",
    what:
      "`workflow … eventSourced` runtime ships on all five backends " +
      "(EVENT_SOURCING_WORKFLOW_BACKENDS) — latent seam for a NEW backend",
    mission: "M-T6.34",
  },
  {
    code: "loom.event-sourcing-backend-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3690",
    what:
      "`persistedAs: eventLog` storage ships on all five backends (EVENT_SOURCING_BACKENDS) — " +
      "fires only when no backend deployable hosts the context",
    mission: "M-T6.34",
  },
  {
    code: "loom.feliz-async-effect-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/store-checks.ts:451",
    what:
      "`match await` on Feliz in a COMPONENT host, or whose awaited subject is not an aggregate " +
      "INSTANCE op — a page-hosted instance-op effect renders (MVU trigger/result pair)",
    mission: "M-T1.20",
  },
  {
    code: "loom.field-mask-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3822",
    what:
      "`mask unless` read redaction ships on all five backends (FIELD_MASK_BACKENDS) — fires " +
      "only when no backend deployable hosts the context",
    mission: "M-T3.2",
  },
  {
    code: "loom.filter-bypass-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:2555",
    what:
      "`ignoring` is honored by every backend family (FILTER_BYPASS_FAMILIES) — latent: it can " +
      "only fire for a backend deployable with no DB read path, which carries no `ignoring`",
    mission: "M-T6.32",
  },
  {
    code: "loom.find-predicate-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3127",
    what:
      "a find / retrieval / query-time-projection / capability-filter predicate outside the " +
      "opt-in `persistence: dapper|mikroorm` SQL subset (EF Core + Drizzle lower it in full)",
    mission: "M-T6.35",
  },
  {
    code: "loom.flutter-async-effect-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/store-checks.ts:502",
    what: "`match await` in a COMPONENT action silently drops the whole widget on Flutter",
    mission: "M-T1.20",
  },
  {
    code: "loom.flutter-primitive-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:754",
    what:
      "every page primitive now renders on Flutter — FLUTTER_UNRENDERED_PRIMITIVES " +
      "(src/util/flutter-deferred-primitives.ts) is EMPTY, so the gate is a dormant re-arm net",
    mission: "M-T1.20",
  },
  {
    code: "loom.frontend-collection-op-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/ui-checks.ts:616",
    what:
      "every stdlib collection op except `map` over a collection receiver in a walker-rendered " +
      "page/component/store expression — target-agnostic; `map` is gated on feliz too",
    mission: "M-T1.20",
  },
  {
    code: "loom.generic-carrier-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/structural-checks.ts:338",
    what:
      "`paged`/`envelope` generic carriers ship on all five backends " +
      "(SUPPORTED_PAGED_BACKENDS) — latent seam for a NEW backend",
    mission: "M-T5.3",
  },
  {
    code: "loom.java-reserved-identifier-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:2560",
    what:
      "a `.ddd` field / param / operation named after a JAVA reserved word (`case`, `do`, " +
      '`new`, …). The SQL half is quoted (`@Column(name = "`case`")`); the host-identifier ' +
      "half emits `String case;` / `public String case() {`, which javac rejects. Refused " +
      "rather than escaped because Java has no verbatim identifier and a rename would move " +
      "the JSON property on java alone — drained by emitting a mangled field plus an explicit " +
      "`@JsonProperty` at every wire site",
    mission: "M-T6.36",
    verified: true,
  },
  {
    code: "loom.mikroorm-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:2873",
    what:
      "on MikroORM: a primitive/enum SCALAR-ARRAY root field under relational/embedded " +
      "(#scalar-array — drizzle stores it natively), an abstract inheritance base owning " +
      "`contains`, and the two self-provisioning limits — declared migration steps and Postgres " +
      "schema placement (migration-checks.ts).  All five ONCE-gated " +
      "non-persistence features (query-time projections, SSE, outbox, timers, brokers) closed",
    mission: "M-T6.23",
  },
  {
    code: "loom.operation-return-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/structural-checks.ts:623",
    what:
      "`or`-union operation returns ship on all five backends (SUPPORTED_RETURN_BACKENDS) — " +
      "latent seam for a NEW backend",
    mission: "M-T5.1",
  },
  {
    code: "loom.paged-query-handler-unsupported-backend",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:213",
    what:
      "a `paged` queryHandler return ships on all five backends (PAGED_QH_SUPPORTED) — latent " +
      "seam for a NEW backend",
    mission: "M-T2.6",
  },
  {
    code: "loom.persistence-mode-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1460",
    what:
      "NOT a backend gap: a hosted aggregate whose deployable binds no matching `dataSource` " +
      "(`kind: state` for stateBased, `kind: eventLog` for eventSourced) — a missing binding",
    mission: "M-T6.35",
  },
  {
    code: "loom.polymorphic-id-ref-unsupported",
    kind: "gap",
    site: "src/language/validators/inheritance.ts:230",
    what:
      "a `<Base> id` reference to a TPC (`ownTable`) abstract base — no single table to key the " +
      "FK against; an all-shared TPH base IS allowed (mixed strategy has its own code)",
    mission: "M-T5.7",
  },
  {
    code: "loom.projection-groupby-unsupported-backend",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:186",
    what:
      "`group by` grouped read models ship on all five backends (PROJECTION_GROUPBY_SUPPORTED) " +
      "— latent seam for a NEW backend",
    mission: "M-T4.2",
  },
  {
    code: "loom.projection-query-time-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:240",
    what:
      "query-time projections ship on all five backends (PROJECTION_QT_SUPPORTED) — latent seam " +
      "for a NEW backend",
    mission: "M-T4.2",
  },
  {
    code: "loom.projection-source-unsupported-backend",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:312",
    what:
      "a projection sourced from another projection's rows ships on all five backends " +
      "(PROJECTION_PROJ_SOURCE_SUPPORTED) — latent seam for a NEW backend",
    mission: "M-T4.2",
  },
  {
    code: "loom.projection-whole-table-aggregation-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:151",
    what:
      "whole-table `select f = agg(…)` SQL push-down ships on all five backends " +
      "(PROJECTION_AGG_SUPPORTED) — latent seam for a NEW backend",
    mission: "M-T4.2",
  },
  {
    code: "loom.projection-workflow-source-unsupported-backend",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:276",
    what:
      "a projection sourced from a workflow's instance rows ships on all five backends " +
      "(PROJECTION_WF_SOURCE_SUPPORTED) — latent seam for a NEW backend",
    mission: "M-T4.2",
  },
  {
    code: "loom.provenanced-backend-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3756",
    what:
      "the provenance runtime (lineage column + history flush) ships on all five backends " +
      "(PROVENANCE_BACKENDS) — fires only when no backend deployable hosts the context",
    mission: "M-T6.32",
  },
  {
    code: "loom.remote-api-op-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3268",
    what:
      "every backend emits the typed in-system api client — REMOTE_API_OP_UNSUPPORTED is an " +
      "EMPTY set, kept as the honest-gap net for a sixth backend added before its client",
    mission: "M-T4.8",
  },
  {
    code: "loom.saving-shape-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1594",
    what:
      "every backend emits all three shapes (PLATFORM_SAVING_SHAPES, plus the elixir `document` " +
      "widening in the check) — latent seam for a NEW backend family missing one",
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
    code: "loom.toast-message-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/ui-checks.ts:2193",
    what:
      "an `on <chan>.<Event> { toast(<expr>) }` message outside the v1 subset all three realtime " +
      "renderers implement (literal / the event binding / single-level member off it / paren / " +
      "binary).  Not latent and not per-target: the three `switch`es are arm-for-arm identical " +
      "(`_frontend/realtime.ts`, `feliz/realtime.ts`, `elixir/realtime-liveview.ts`) and each " +
      "THREW on anything else, so the gate replaces a codegen abort.  Drains when the renderers " +
      "grow the general expression path (they would then share the walker's expression emitter " +
      "rather than three hand-written subsets)",
    mission: "M-T1.10",
  },
  {
    code: "loom.tph-backend-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3648",
    what:
      "sharedTable (TPH) storage ships on all five backends (TPH_CAPABLE) — fires only when no " +
      "backend deployable hosts the context",
    mission: "M-T5.7",
  },
  {
    code: "loom.tph-filter-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:3651",
    what:
      "a TPH SUBTYPE's capability `filter` reading a column the hierarchy ROOT does not declare, " +
      "on the .NET EF adapter only — Dapper splices the same predicate into raw SQL, where a " +
      "subtype column is just a column, so it is NOT gated.  EF Core registers every query " +
      "filter in an inheritance hierarchy on the " +
      "root entity type, and a root-hosted filter cannot reach a subtype-only column (verified " +
      'against EF Core 10.0.10: a CLR downcast raises "No coercion operator is defined between ' +
      "types 'Truck' and 'Car'\" and EF.Property raises \"the specified property does not exist " +
      'on the entity type" as soon as the query source is a SIBLING subtype).  Filters reading ' +
      "ROOT columns — the common `tenantOwned`-on-the-base case — are emitted, discriminator-" +
      "guarded, and are NOT gated.  Replaces a silent drop (`tph ? [] :`, F2-CB-C2).  Drains if " +
      "the .NET read path moves capability filters off HasQueryFilter onto the per-read LINQ " +
      "`.Where(...)`, which is per-DbSet and therefore subtype-typed",
    mission: "M-T5.7",
  },
  {
    code: "loom.ui-projection-read-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:507",
    what:
      "a KEYED or FOLDED projection read from a page/component — not ui-consumable on ANY target " +
      "(ui-checks.ts:1538).  The per-framework half is fully ported: PROJECTION_READ_FRAMEWORKS " +
      "names all seven frontends, so that arm is latent",
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
    site: "src/ir/validate/checks/structural-checks.ts:511",
    what:
      "discriminated-union tagged wire ships on all five backends (SUPPORTED_UNION_BACKENDS) — " +
      "latent seam for a NEW backend",
    mission: "M-T5.3",
  },
  {
    code: "loom.vanilla-document-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/system-checks.ts:1903",
    what:
      "elixir `shape: document`, the residue after CRUD + scalar finds/ops landed: a PROVENANCED " +
      "op, or a body/find predicate reading a derived field, a dereferenced cross-aggregate " +
      "entity, a value-object/private/service/resource call, or a REFERENCE collection (`X id[]`)",
    mission: "M-T6.35",
  },
  {
    code: "loom.when-unsupported",
    kind: "gap",
    site: "src/ir/validate/checks/structural-checks.ts:581",
    what:
      "the `when` canCommand gate ships on all five backends (SUPPORTED_WHEN_BACKENDS) — latent " +
      "seam for a NEW backend, as the check's own docstring says",
    mission: "M-T5.8",
  },

  // -------------------------------------------------------------------------
  // scope — a declared v1 limit with a named successor.  Mission-owned; not
  // sprint work until its mission starts.
  // -------------------------------------------------------------------------
  {
    code: "loom.criterion-unsupported-target",
    kind: "scope",
    site: "src/language/validators/criterion.ts:87",
    what: "criteria over primitives/VOs/enums reserved for `from <Criterion>(args)`",
    mission: "M-T5.4",
    verified: true,
  },
  {
    code: "loom.e2e-unsupported-statement",
    kind: "scope",
    site: "src/ir/validate/checks/test-checks.ts:176",
    what: "e2e bodies accept a closed statement set (expect/let/expression/…)",
    mission: "M-T5.19",
    verified: true,
  },
  {
    code: "loom.migration-expr-unsupported",
    kind: "scope",
    site: "src/ir/validate/checks/migration-checks.ts:74",
    what: "backfill exprs are a narrow validated ExprIR subset by design",
    mission: "M-T2.3",
    verified: true,
  },
  {
    code: "loom.retrieval-loads-unsupported",
    kind: "scope",
    site: "src/ir/validate/checks/query-checks.ts:290",
    what: "explicit `loads:` deferred — retrievals load the whole aggregate",
    mission: "M-T5.4",
    verified: true,
  },
  {
    code: "loom.tph-own-override-unsupported",
    kind: "scope",
    site: "src/language/validators/inheritance.ts:134",
    what: "per-concrete ownTable override inside a TPH hierarchy",
    mission: "M-T5.7",
    verified: true,
  },
  {
    code: "loom.union-find-shape-unsupported",
    kind: "scope",
    site: "src/ir/validate/checks/structural-checks.ts:479",
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
    site: "src/ir/validate/checks/workflow-checks.ts:643",
    what: "workflow load of an array result — v1 is single non-nullable",
    verified: true,
  },
  {
    // Same SHAPE bound as the two rows above, on the third body kind: the
    // `reading` tier recognises a repository read only when it is the WHOLE
    // expression (`matchRepoRead` requires `suffixes.length === 1`).  A read in
    // MEMBER-RECEIVER position (`Accounts.byHolder(h).balance`) therefore never
    // becomes a `repo-read`: the service is typed `pure`, no read port is
    // threaded, and every backend emits the bare repository name.  Widening the
    // detector (and re-applying the remaining suffixes in
    // `lower-domain-service.ts`) retires this row.
    code: "loom.domain-service-read-unsupported",
    kind: "scope",
    site: "src/ir/validate/checks/domain-service-checks.ts:233",
    what: "a repository read used as a MEMBER RECEIVER in a domainService body — v1 binds it first",
    verified: true,
  },
  {
    code: "loom.workflow-load-nullable-unsupported",
    kind: "scope",
    site: "src/ir/validate/checks/workflow-checks.ts:656",
    what: "workflow load of a nullable result — v1 is single non-nullable",
    verified: true,
  },
  {
    code: "loom.seed-event-sourced-unsupported",
    kind: "gap",
    site: "src/language/validators/seed.ts:101",
    // Live, not latent: no backend HAS an event-append seed path.  It drains
    // when one exists on all five (elixir appends the creation event; java/.NET
    // build the call from the declared `create` params, not `forCreateInput`).
    what: "a `seed` row on an event-sourced aggregate — no backend can append its creation event",
    mission: "M-T6.52",
    verified: true,
  },
];

/** Rows that are actual work.  The sprint backlog; empty is the target state. */
export function openGaps(): readonly UnsupportedEntry[] {
  return UNSUPPORTED_REGISTER.filter((e) => e.kind === "gap");
}
