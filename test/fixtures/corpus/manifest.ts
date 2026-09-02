// Shared fixture corpus — the declared feature × backend coverage matrix.
//
// One canonical `.ddd` per feature (platform-agnostic, `platform: __PLATFORM__`)
// lives beside this file; `backends` lists every backend the feature is
// declared to generate on.  `test/conformance/corpus-coverage.test.ts` enforces
// the matrix: every declared cell must generate cleanly in-memory (no docker),
// and a feature with no manifest row fails the completeness check.
//
// This is the machine-readable form of the matrix in
// `docs/old/plans/global-test-coverage-plan.md`.  Adding a feature = drop a
// `<feature>.ddd` here + one row below.  Widening a backend's support = add the
// key to that row (the gate proves it generates).  See the plan for the
// behavioural / compile tiers layered on top of this generation gate.

import { type Backend, BACKENDS } from "./backends.js";

/** All backends — the common case for platform-agnostic domain features. */
const ALL: readonly Backend[] = BACKENDS;

/** Every backend filters a `shape: document` aggregate IN-APP over the
 *  rehydrated instance (the jsonb blob is not per-field queryable), so the
 *  document × authorization crossing now runs on ALL five — this alias is kept
 *  as the NAME of that property, and as the place its history is recorded.
 *
 *  3 -> 4: `dotnet` joined.  It was excluded for a compile gap + a silent
 *  unfiltered read, and BOTH are closed — `src/generator/dotnet/emit/repository.ts`
 *  now hoists the AND-ed capability predicate into `_CapabilityVisible(...)` and
 *  applies it on all three document read paths (`GetByIdAsync`,
 *  `FindManyByIdsAsync`, every emitted find), and emits the
 *  `GetByIdForWriteAsync` write-scope member whose absence was the CS0535.
 *
 *  4 -> 5: `elixir` joined.  It was the LAST unwired (family, shape) cell in
 *  `supportsNonRelationalFilter`'s whole inventory — an honest, coded rejection
 *  (`loom.context-filter-unsupported`), not a silent gap, but a rejection all
 *  the same.  `renderDocRepository` now AND-s the capability predicate into
 *  every document read (`list`, `find_by_id`, `find_by_id_for_write`, and each
 *  custom find), evaluated over the rehydrated `%<Agg>.Data{}` embed with the
 *  `deep` sentinel rendered by `renderDeepScopeInApp`. */
const IN_APP_DOCUMENT_FILTER: readonly Backend[] = ALL;

/** The backends that can AGGREGATE a `shape: document` table in SQL.
 *
 *  A document aggregate is `(id, data, version)`, so the only aggregation it
 *  can express is the row count — and four backends emit exactly that: drizzle
 *  / mikroorm `count()` over the row table, SQLAlchemy `func.count()` over
 *  `<Agg>Row`, Ecto `count(record.id)` over the document schema, and both .NET
 *  adapters over `DbSet<<Agg>Document>` / the raw table.
 *
 *  `java` is absent, and this is the NAME of that exclusion.  Its aggregation
 *  runs JPQL through the `EntityManager` (`select count(e) from Article e`),
 *  and a document aggregate has no JPA `@Entity` anywhere in the emitted
 *  project — it round-trips one jsonb column through a `JdbcTemplate`
 *  repository — so Hibernate fails the query with "could not resolve root
 *  entity" at request time.  Refused honestly by
 *  `loom.projection-whole-table-aggregation-unsupported#document`; the key returns
 *  here the day that emitter learns to read a document table (a native
 *  `select count(*) from <schema>.<table>`). */
const DOCUMENT_TABLE_AGGREGATION: readonly Backend[] = ALL.filter((b) => b !== "java");

export interface CorpusFeature {
  /** Matches `<id>.ddd` in this directory. */
  readonly id: string;
  /** One-line description of the language feature exercised. */
  readonly title: string;
  /** Reference doc under `docs/` (without extension), or undefined. */
  readonly doc?: string;
  /** Backends declared to generate this feature cleanly (enforced by the gate). */
  readonly backends: readonly Backend[];
  /** Notes on any backend exclusions. */
  readonly note?: string;
  /**
   * Emitted project dirs the compile tiers build — one per `deployable` in the
   * `.ddd`.  Defaults to the single `d` (`CORPUS_DEPLOYABLE`) every ordinary
   * fixture declares, so only a MULTI-service fixture needs this key.
   *
   * It is declared here rather than discovered from the file map because the
   * compile harnesses must know what to build BEFORE they generate — and
   * because a fixture that quietly renames its deployable would otherwise turn
   * a compile gate into a no-op.  `corpus-coverage.test.ts` cross-checks this
   * list against the dirs actually emitted, so the two cannot drift.
   */
  readonly deployables?: readonly string[];
}

export const CORPUS: readonly CorpusFeature[] = [
  { id: "core-domain", title: "enum/VO/event/containment/derived/invariant/operation/find", doc: "language", backends: ALL },
  { id: "state-gate", title: "`when` canCommand state gate + GET can-query companion", doc: "criterion", backends: ALL },
  { id: "operation-returns", title: "exception-less `T or Error` operation returns", doc: "payloads", backends: ALL },
  { id: "union-find-absence", title: "union-returning finds (`Order or NotFound`, `Order option`)", doc: "payloads", backends: ALL },
  { id: "paged", title: "pagination — `find ... paged` Paged<T> envelope", doc: "payloads", backends: ALL },
  { id: "single-containment", title: "single (non-collection) containment — hidden `_parent`", doc: "language", backends: ALL },
  { id: "value-collections", title: "value-object array (`Money[]`) stored inline", doc: "language", backends: ALL },
  { id: "document", title: "`shape: document` — whole aggregate in one jsonb column", doc: "language", backends: ALL },
  {
    id: "document-collection-read",
    title:
      "collection READS over a `shape: document` aggregate's own lists — `lines.sum(λ)` / `.count` / `.any(λ)` over the containment, `.contains` over a scalar array",
    doc: "language",
    backends: ALL,
    note: "Split from `document` because the ELIXIR half was validate-gated long after the emission became correct: Route A had already made the containment a real `embeds_many` and the scalar array an `{:array, _}` field, so the shared collection-op renderers worked verbatim, but `loom.vanilla-document-unsupported` still refused EVERY collection method.  A REFERENCE collection (`X id[]`) is deliberately absent — that one still needs the join table a jsonb blob has no equivalent for, and stays an honest error.",
  },
  { id: "embedded", title: "`shape: embedded` — containments fold into jsonb columns", doc: "language", backends: ALL },
  { id: "embedded-optional", title: "shape: embedded — optional single containment (nullable jsonb)", doc: "language", backends: ALL },
  { id: "inheritance", title: "aggregate inheritance — TPH (sharedTable) + TPC (ownTable)", doc: "inheritance", backends: ALL },
  { id: "tph", title: "TPH-only (sharedTable) hierarchy — Vehicle/Car/Truck canonical fixture", doc: "inheritance", backends: ALL },
  { id: "event-sourcing", title: "`persistedAs: eventLog` — append-only stream + appliers", doc: "workflow", backends: ALL },
  { id: "eventsourced-workflow", title: "event-sourced saga folding its own emitted events", doc: "workflow", backends: ALL },
  { id: "saga", title: "in-process dispatch / saga with persisted correlation", doc: "workflow", backends: ALL },
  { id: "projection", title: "folded projection — read model folded from aggregate events (keyed row + on() folds)", backends: ALL },
  { id: "projection-aggregation", title: "whole-table aggregation — singleton query-time projection (count/sum/avg/min/max pushed to SQL)", doc: "language", backends: ALL },
  { id: "projection-groupby", title: "group by — grouped query-time projection (one row per group, key selects + per-group aggregates, GROUP BY/ORDER BY pushed to SQL)", doc: "language", backends: ALL },
  {
    id: "projection-agg-filters",
    title:
      "aggregation × capability filters — tenantOwned + softDeletable source, whole-table and grouped aggregations scoped by the SAME predicates the row read applies (plus an `ignoring` witness)",
    doc: "tenancy",
    backends: ALL,
    note: "minted by audit A1: the aggregation shapes read the source table DIRECTLY, so four backends applied only the projection's own `where` — a cross-tenant COUNT/SUM leak no fixture crossed",
  },
  {
    id: "projection-document-aggregation",
    title:
      "whole-table aggregation over a `shape: document` source — the row count (`count(*)` over the `(id, data, version)` triple), beside the per-row arm over the same source",
    doc: "language",
    backends: DOCUMENT_TABLE_AGGREGATION,
    note: "minted by audit A1: `loom.projection-columnless-source` deliberately allows `count()` over a document source, and NOTHING pinned that the allowed cell still emits — while java's cell was broken outright.  The filtered crossing is refused universally (`loom.projection-document-source-capability-filtered`); both negatives live in `test/ir/projection-document-aggregation.test.ts`.",
  },
  {
    id: "projection-join",
    title:
      "projection join — the by-id follow (`join <Agg> as <alias> on <idRef>`), carrying the referenced row's fields onto each projection row",
    doc: "language",
    backends: ALL,
    note: "minted by the clause census: `ProjectionJoin` was at ZERO authored uses while four backend emitters, the lowering pass and two validator files all read `proj.joins`",
  },
  { id: "auth-oidc", title: "OIDC authentication — provider config + requires-guard", doc: "auth", backends: ALL },
  { id: "auth-simple", title: "dev-stub auth — user shape + requires-guard", doc: "auth", backends: ALL },
  { id: "read-gates", title: "read-side requires gates — gated list read + folded and query-time projections", doc: "auth", backends: ALL },
  { id: "outbox", title: "durable channel / transactional outbox + relay", doc: "workflow", backends: ALL },
  {
    id: "channels-broker",
    title: "broker-bound channel — channelSource binds `queue/work` to rabbitmq, real driver code emitted",
    doc: "channels",
    backends: ALL,
  },
  { id: "tenancy-filter", title: "principal-referencing (tenancy) capability filter", doc: "capabilities", backends: ALL },
  { id: "tenancy-owned", title: "first-class tenancy — `tenancy by` + tenantOwned + crossTenant", doc: "tenancy", backends: ALL },
  { id: "tenancy-hierarchy", title: "tenancy hierarchy — `implements tenantRegistry` + `policy` deep/global/local read ladder", doc: "tenancy", backends: ALL },
  { id: "tenancy-claim-name", title: "tenancy claim not named `tenantId` — the declared claim binds the tenantOwned stamp/filter", doc: "tenancy", backends: ALL },
  { id: "policy-deny", title: "`policy { deny [write] on <Agg> }` — the deny-wins carve-out on both the read-filter and write-scope seams", doc: "auth", backends: ALL },
  { id: "policy-document", title: "`policy { allow deep / deny }` on a `shape: document` aggregate — the authz ladder applied IN-APP, where it cannot be a column predicate", doc: "auth", backends: IN_APP_DOCUMENT_FILTER },
  { id: "stamps", title: "lifecycle stamps (audit timestamps via stamp blocks)", doc: "capabilities", backends: ALL },
  { id: "field-defaults", title: "field `= default` — omittable create input, declared value applied", doc: "language", backends: ALL },
  {
    id: "reserved-words",
    title:
      "field names that are POSTGRES RESERVED WORDS (`order` / `group` / `limit`) — every SQL writer has to quote its identifiers",
    doc: "language",
    backends: ALL,
    note: "Minted by M-T6.42.  The class was unexercised: no fixture named a reserved word, so the Dapper adapter's bare identifiers (DDL *and* DML) were invisible to every gate — the C# compiles because the SQL is a string literal, and `schema-load` covered only the MIGRATION chain, which that adapter does not use.  Covers four clause positions a partial fix would miss: CREATE TABLE, the SELECT/INSERT column lists, a `find` WHERE, a retrieval ORDER BY, and CREATE INDEX.  Deliberately NOT a host-language-keyword test (`is` / `default` / `class` break the generated DTO, a different class no backend claims).  JAVA WAS EXCLUDED HERE UNTIL M-T6.43 — a gap, not a rejection: it generated and COMPILED, then 500d on the first insert, because the JPA entity emitted `@Column(name = \"order\")` bare and Hibernate derived `insert into ... (order, group, limit, ...)` from it.  Found by running this fixture's behavioural leg on a real booted Spring Boot + Postgres while landing M-T6.42.  Fixed by backtick-quoting the mapping annotations (Hibernate's portable quoting) off the SHARED word list in `src/generator/sql-reserved.ts`, and this row widening back to ALL is that mission's ratchet.",
  },
  {
    id: "vo-field-default",
    title:
      "VALUE-OBJECT-typed field default — the wire boundary renders a non-scalar default differently from a scalar one",
    doc: "language",
    backends: ALL,
    note: "compile-tier by necessity: hono COMPILES the defect by structural typing, so only the strict backends (python mypy --strict, .NET) can see it",
  },
  { id: "extern", title: "extern operations — preconditions gate a user handler", doc: "extern", backends: ALL },
  { id: "extern-handlers", title: "extern commandHandler / queryHandler — bodyless, scaffold-once user impl", backends: ALL },
  {
    id: "handler-resource-ops",
    title:
      "resource-op inside a commandHandler / queryHandler body — the second legal site for outbound I/O",
    doc: "resources",
    backends: ALL,
    note: "Four of five emitters could not render this LEGAL site: node / python emitted the helper call with no import (TS2304 / F821), .NET and java THREW 'reached the renderer without a resource class mapping' at generate time; only elixir was correct (it fully-qualifies the module). The handler loads via a declared FIND rather than `byId`, so the fixture isolates the resource-op leg from the unrelated `Agg id` path-param coercion.",
  },
  {
    id: "handler-triad",
    title:
      "handler-body shapes the emitters mishandled — an aggregate-less handler, a declared `byId` find called with an already-typed `Agg id`, and a dereferenced (non-optional) find",
    doc: "language",
    backends: ALL,
    note: "The three defects #2652 measured and left unfixed. .NET DROPPED the aggregate-less handler and its route entirely (`if (!primaryAgg(h)) continue`); java renamed a declared `byId` find to `getById` and re-wrapped its already-typed argument (`getById(new OrderId(orderId))`, javac `incompatible types`). The third — an OPTIONAL find bound in a handler body, dereferenced unguarded (TS18047 / CS8602) — is now refused at phase ⑦ (`loom.handler-load-nullable-unsupported`), so this fixture carries the non-optional spelling and the refusal is pinned separately.",
  },
  { id: "seeding", title: "seed datasets — default / demo / wired-raw", doc: "language", backends: ALL },
  {
    id: "seed-values",
    title: "seed data read back — the seeder's rows through a collection read, and the opt-in dataset gate",
    doc: "language",
    backends: ALL,
    note: "Split from `seeding` so the two halves can have different BEHAVIOURAL reach: this one reads a collection (the only route class that can see seed rows, and therefore the only one whose body differs on a leg that starts empty), so it was held off the elixir behavioural leg — which emitted no seeder at all (B19) — via BEHAVIOURAL_SKIP, while `seeding` kept its CRUD/FK/404 round-trip armed on all five. M-T6.37 landed the Ecto seeder and that skip is deleted, so this case now runs on all five legs too; the split stays because it is what kept the five-backend coverage armed while one leg was odd.",
  },
  { id: "resources", title: "external resources — objectStore / queue / http api / mailer (smtp) clients", doc: "resources", backends: ALL },
  {
    id: "file-download",
    title:
      "a `File` field over an objectStore — the root `POST /files` + `GET /files/{key}` pair, and the absent-object 404",
    doc: "resources",
    backends: ALL,
    note: "Split from `resources` (which binds an objectStore but declares no `File` field, so no backend emits the /files routes for it): the download route had NO golden on any backend, which is how its absent-object 404 stayed a fourth envelope shape on all five at once (M-T6.39). The 404 itself is not expressible in the `test e2e` DSL, so it rides the behavioral tier's absent-file probe in wire-differential.mjs.",
  },
  {
    id: "api-call",
    title: "typed in-system api call — `resource { kind: api, use: <Api> }` a sibling deployable serves",
    doc: "resources",
    backends: ALL,
    note: "Two deployables: the caller's client is DERIVED from the callee's served operation set, so a single-deployable fixture cannot exercise it.",
    // The emitted DIR names, which are snake_cased from the deployable names
    // (`ordersSvc` → `orders_svc`) — the coverage gate cross-checks these
    // against what actually lands on disk.
    deployables: ["orders_svc", "shipping_svc"],
  },
  { id: "provenance", title: "provenanced stored fields — per-write-site rule snapshots", doc: "provenance", backends: ALL },
  {
    id: "audited",
    title: "command audit — aggregate-wide `audited` + per-command `audited`, transactional audit_records rows",
    doc: "audit",
    backends: ALL,
  },
  {
    id: "audit-history",
    title: "entity history — the derived `GET /<agg>/{id}/history` read over audit_records",
    doc: "audit",
    // ALL FIVE now serve the endpoint (M-T3.9 read path complete).  Each
    // backend's behavioral leg diffs its booted responses against the wire
    // golden minted from node — A≡golden ∧ B≡golden ⇒ A≡B, so this row being
    // ALL is a proven cross-backend equality, not five self-assertions.
    backends: ALL,
  },
  {
    id: "field-mask",
    title:
      "field read-redaction — `mask unless` crossed with `audited` (two masked fields + a masked contained part, projected twice in one scope)",
    doc: "auth",
    backends: ALL,
    note: "the CROSSING is the point: an audited op renders the masked projection twice into one method body, which is where a fixed principal-variable name collides (.NET CS0128)",
  },
  {
    id: "lifecycle-guard",
    title:
      "lifecycle authorization gate — `requires` in the canonical `create` (principal-only, pre-construction) and `destroy` (principal + `this`, post-load)",
    doc: "auth",
    backends: ALL,
    note: "the two halves render in DIFFERENT places — a create guard has no `this` yet, a destroy guard reads the row the caller already loaded; `Crate` carries the OTHER two shapes (an ungated create as the control, and a principal-ONLY destroy guard that leaves the loaded row unread)",
  },
  {
    id: "criterion-filter",
    title: "reusable criterion (criterion.md) used as `filter <Criterion>`",
    doc: "criterion",
    backends: ALL,
  },
  {
    id: "prefix-filter",
    title: "`startsWith` prefix-match filter operator — inline find + criterion filter",
    doc: "stdlib",
    backends: ALL,
    note: "the first bool-returning QUERYABLE intrinsic: it stands alone in predicate position, where a scalar intrinsic only ever appears as a comparison operand",
  },
  {
    id: "domain-services",
    title: "domainService — cross-aggregate pure/reading/mutating ops orchestrated by workflows",
    doc: "domain-services",
    backends: ALL,
  },
  {
    id: "scaffold-macros",
    title: "stdlib macros — crudish (create/update/destroy) + softDeletable capability + softDelete ops",
    doc: "scaffold-macros",
    backends: ALL,
  },
  {
    id: "collection-op-shapes",
    title:
      "collection-op / operator shapes no other fixture witnesses — arithmetic-λ `sum`, `distinct` over money, argless `any()`, DESCENDING `sortBy`, unary `-` on money, `-=` over an `int[]`",
    doc: "stdlib",
    backends: ALL,
    note: "minted by the 2026-08-17 generator code review (A5/A10–A14): every one of these rendered wrong on at least one backend — java's descending sortBy did not COMPILE, node/elixir/python's money fold was broken by a missing `binary` arm in `bodyTypeOf`, elixir's argless `any()` was always false — and none appeared anywhere in the corpus, examples or journey/, so no compile gate could see them.  Writing it also surfaced an UNFILED .NET sibling of A13 (scalar-array mutation routed through a `_codes` backing field that does not exist → CS0103), fixed in the same change.  No `test e2e` block: this is a compile-tier witness, and adding one would mint recorded wire cases whose goldens cannot be captured from the fixture PR",
  },
  {
    id: "numeric-operands",
    title:
      "RIGHT-HAND money/decimal operands — `int * money` (commutative product), `int + decimal`, `int < decimal`, `int == decimal`, plus a decimal-on-the-right repository filter",
    doc: "stdlib",
    backends: ALL,
    note: "minted by the 2026-08-23 numeric-types audit (F7 / M-T6.44): the validator admits every one of these, but the TS and Elixir binary renderers gated money/decimal dispatch on `leftType` ALONE — node emitted native `*` on a decimal.js Decimal (TS2363, uncompilable), elixir emitted native arithmetic on a %Decimal{} (runtime ArithmeticError) and native `<` (Erlang TERM ordering: number < map is ALWAYS true, silently).  No corpus fixture had a right-hand money/decimal operand, so no compile gate could reach the arms.  The `test` block is the runtime value proof on every backend's unit tier; no `test e2e` — the derived decimal values sit inside the un-ruled F11/M-T5.22 cross-backend arithmetic divergence, so a wire golden here would pre-empt that owner ruling (literals are binary-exact so the unit assertions agree everywhere regardless)",
  },
  {
    id: "validation-messages",
    title:
      "authored `message \"…\"` on invariant / field check / precondition / VO invariant + the per-backend message CATALOG the wire `code` resolves against",
    doc: "language",
    backends: ALL,
    note: "the FIRST corpus fixture with a `message` clause at all — before it, every backend's messaged-rule carrier AND the M-T1.11 catalog emission were uncompiled by the corpus tier (retro §78: a conditional emission needs a fixture that satisfies its condition)",
  },
] as const;

/** Lookup by id. */
export function corpusFeature(id: string): CorpusFeature | undefined {
  return CORPUS.find((f) => f.id === id);
}
