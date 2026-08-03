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
  { id: "auth-oidc", title: "OIDC authentication — provider config + requires-guard", doc: "auth", backends: ALL },
  { id: "auth-simple", title: "dev-stub auth — user shape + requires-guard", doc: "auth", backends: ALL },
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
  { id: "stamps", title: "lifecycle stamps (audit timestamps via stamp blocks)", doc: "capabilities", backends: ALL },
  { id: "field-defaults", title: "field `= default` — omittable create input, declared value applied", doc: "language", backends: ALL },
  { id: "extern", title: "extern operations — preconditions gate a user handler", doc: "extern", backends: ALL },
  { id: "extern-handlers", title: "extern commandHandler / queryHandler — bodyless, scaffold-once user impl", backends: ALL },
  { id: "seeding", title: "seed datasets — default / demo / wired-raw", doc: "language", backends: ALL },
  { id: "resources", title: "external resources — objectStore / queue / http api / mailer (smtp) clients", doc: "resources", backends: ALL },
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
    backends: ALL,
  },
  {
    id: "criterion-filter",
    title: "reusable criterion (criterion.md) used as `filter <Criterion>`",
    doc: "criterion",
    backends: ALL,
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
] as const;

/** Lookup by id. */
export function corpusFeature(id: string): CorpusFeature | undefined {
  return CORPUS.find((f) => f.id === id);
}
