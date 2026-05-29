# Loom decisions log

Pinned decisions referenced by the design corpus in
[`docs/proposals/`](./proposals/) and the implementation plans. Each
entry has a stable **D-tag** that proposals cite when their grammar
or semantics depends on the outcome. Tag scope:

- **PINNED** — decided; downstream proposals may rely on it.
- **OPEN** — recommended answer recorded in the proposal/plan, not
  ratified by the maintainer.

When a proposal's body conflicts with a PINNED decision here, the
decision wins; the proposal text needs a rewrite (tracked per entry
under "Affects").

Decision tags are introduced in
[`proposals/global-implementation-plan.md`](./proposals/global-implementation-plan.md)
§0.1 ("Decisions to pin before any grammar edit") and elaborated in
the per-proposal docs.

---

## D-STORAGE-SPLIT — split the overloaded `storage` keyword

**Status:** PINNED.

**Problem.** `storage-and-platform-config.md` §3.1/§3.2 use one
`storage` rule for two unrelated concerns — a physical instance
(`storage pg { type: postgres }`) vs. a logical aggregate-to-physical
binding with rich per-binding config (`storage orderEvents { use: pg,
for: Sales.Order, kind: eventLog, schema: "sales" }`). The two forms
share nothing beyond the word — the physical form carries
`type`/`instance`/`connection`/`outbox`/`follows`; the logical form
carries `schema`/`tablePrefix`/`kind`/`ttl`/`every`/`retain`/etc.
Disambiguation by "presence of `for:`" is an accident, not a design.

**Decision.** Three distinct keywords, one job each:

| Keyword | Role | Carries |
|---|---|---|
| `storage` | Physical infrastructure instance | `type`, `instance`, `connection`, `outbox`, `follows` |
| `dataSource` | Logical (context, kind) → storage binding | `for: <Context>`, `kind: <state\|eventLog\|snapshot\|cache\|replica>`, `use: <storage>`, plus per-`kind` config (`schema`/`ttl`/`every`/`retain`/`keyPrefix`/…) |
| `deployable` | Process/runtime unit | `contexts: [...]`, `dataSources: [...]`, platform config |

Worked example:

```ddd
storage pg     { type: postgres }
storage kafka  { type: kafka }
storage redis  { type: redis }

dataSource ordersState    { for: Orders, kind: state,    use: pg }
dataSource ordersEvents   { for: Orders, kind: eventLog, use: kafka }
dataSource ordersCache    { for: Orders, kind: cache,    use: redis, ttl: 60 }
dataSource ordersSnapshot { for: Orders, kind: snapshot, use: redis,
                            every: 100, retain: 5 }

deployable api {
  contexts:    [Orders]
  dataSources: [ordersState, ordersEvents, ordersCache, ordersSnapshot]
}
```

**Rationale.**

- The two forms are *not* synonyms with shared structure; they are
  separate concepts that happen to live in the same domain. A naming
  rule that makes them parse identically and rely on a sentinel field
  (`for:`) is fragile.
- `dataSource` reads naturally for "a configured source/sink of data
  for one purpose within one context."
- Keeping `storage` for the physical form preserves the most-typed
  surface (every project has physical stores; only some need rich
  per-context data-source config).
- `deployable.dataSources:` is the new clause; it pairs with the
  existing `contexts:` clause.

**Validator rules implied.**

- `dataSource` requires both `for:` (a context) and `kind:`. Missing
  either → parse / validate error.
- For each `(context, kind)` actually needed by aggregates in the
  context, exactly one `dataSource` must exist with matching `for:`
  and `kind:`. State-based aggregate → `kind: state` required;
  ES aggregate → `kind: eventLog` required; `cache`-annotated
  aggregate → `kind: cache` required; etc.
- A deployable's `dataSources:` must include exactly the dataSources
  `for:` the contexts it hosts (one per needed kind) — validator
  rejects under-listing (missing binding for a needed kind) and
  over-listing (a dataSource `for:` a context the deployable does
  not host).
- Per-`kind:` config keys validated against the resolved physical
  store's `type` (e.g., `ttl:` only on Redis kinds).

**Affects (proposal rewrites needed).**

- `storage-and-platform-config.md` — §2.1 invariant 4 (which
  asserted "no storage homogeneity per BC") conflicts with
  D-GRANULARITY below and needs rewriting; §3.2 ("Logical storage")
  becomes the `dataSource` section; §3.9 ("Module bindings — bare
  form") replaced by deployable's `dataSources:` clause; §3.8
  ("Per-deployable `overrides`") deferred under D-ENV-SWAP.
- `bounded-context-model.md` — the deployable-side
  `storage: { Orders: pg, Subscriptions: pg }` shorthand becomes
  `dataSources:` instead; framework choice on `context` is
  unchanged.
- `storage-and-platform-config-plan.md` and
  `storage-and-platform-config-micro-plan.md` — F1 sub-PRs that
  introduce the logical form ship `dataSource` from day one;
  per-aggregate `for:` does not land in v1 (see D-GRANULARITY).

---

## D-GRANULARITY — storage bindings are per-context, not per-aggregate

**Status:** PINNED.

**Problem.** Two proposals disagree:

- `storage-and-platform-config.md` §3.3 + §3.2 commits to **per-aggregate**
  binding (`for: Sales.Order`), and §2.1 invariant 4 explicitly
  declares "BC = semantic boundary only … no storage homogeneity."
- `bounded-context-model.md` reframes the BC as the unit that owns
  framework + storage, with per-aggregate binding deferred to v2 as
  override-only.

**Decision.** **Per-context for v1, all kinds.** A `dataSource`
binds at granularity `(context, kind)`. All aggregates in a context
share the same primary store (state or eventLog), the same derived
stores (cache, snapshot, replica), and the same per-kind config
(snapshot policy, cache TTL, …) for that context.

Per-aggregate binding is **deferred to v2** as an override mechanism
for the rare cross-infra-within-one-context case. The storage
proposal's per-aggregate `for: <Aggregate>` syntax does not land in
v1; if reintroduced later it lands as a deferred override (not the
primary form).

**Rationale.**

- Transactional feasibility (the "which writes can co-commit?"
  chain) is naturally per-context — see `bounded-context-model.md`
  §"Transactional workflow feasibility" link 3.
- Real-world v1 cases overwhelmingly have one primary store per
  context; cross-aggregate-within-one-context infra splits are rare.
- Per-context-per-kind preserves the storage proposal's most
  valuable insight (different kinds *do* live in different physical
  engines — eventLog in Kafka, snapshot in Redis), without
  multiplying the binding surface.
- v2 per-aggregate override remains compatible: it lifts the
  granularity inside one context without changing the rest of the
  model. The storage proposal's grammar work survives there.

**Validator rules implied.**

- `dataSource.for:` references a context, never an aggregate.
  Parser/validator rejects an aggregate-qualified `for:` in v1 with
  a diagnostic that links to this decision.
- "Two aggregates in the same context bind to different physical
  stores" is unrepresentable in v1.
- ES + state-based aggregates may coexist in one context, each
  resolving to the context's `kind: eventLog` or `kind: state`
  dataSource respectively.

**Affects.**

- `storage-and-platform-config.md` — §2.1 invariant 4 ("BC = semantic
  boundary only") rewritten to "BC = transactional-feasibility unit;
  storage homogeneity per BC is the v1 default"; §3.3 ("`for:`
  reference syntax") rewritten to context-only.
- `bounded-context-model.md` — §"Per-aggregate storage" still
  accurately frames v1 + v2; this decision pins it.

---

## D-ENV-SWAP — per-environment storage swap mechanism

**Status:** OPEN (deferred — out of scope for F1).

**Context.** Storage proposal §2.1 invariant 5: *"Storage is
swappable per deployable."* The test deployable swaps Postgres for
in-memory without the domain noticing. Two shapes were considered:

- **Option ①** — alternate dataSources per environment, deployable
  picks: `dataSource ordersStateTest { … use: memTest }` listed in
  `deployable apiTest { dataSources: [ordersStateTest, …] }`.
  Verbose if many context × kind combinations, but needs no new
  grammar.
- **Option ②** — deployable `overrides { storage pg { type:
  inMemory } }` block (existing storage proposal §3.8). Terse;
  preserves one dataSource set across environments.

**Decision (deferred).** Option ① is the implicit fallback for
v1 — it works with no new grammar beyond what D-STORAGE-SPLIT lands.
Option ② is the cleaner long-term shape but not in scope for the
initial F1 grammar; revisit after F1 lands and we have empirical
pressure on the verbosity.

**Affects.** Storage proposal §3.8 (`overrides`) does not land in
the F1 micro-plan PRs; reopens after F1.

---

## D-DOCUMENT-AXIS — document storage as two orthogonal header axes

**Status:** PINNED (core axes, syntax, validation contract); the
numbered **Open sub-questions** below remain OPEN.

**Implementation:** surface + IR landed — `json` primitive (#703),
`persistedAs(eventLog | state)` (#711), `normalised(true | false)`
surface (#713). The document-persistence **emission** (Marten / EF
`.ToJson()` / document table shape) is not yet built; until then
`normalised(false)` is carried in the IR but inert (an `UNWIRED_KNOBS`
warning says so). See `document-and-json-hierarchies.md` §9.

**Problem.** Loom models internal hierarchies but the
relational-vs-document storage choice is implicit and unselectable
(value objects → inline JSONB; entity parts → child tables); there is
no open-shape JSON field; and a document/event-store backend (Marten)
has nowhere to attach. The shipped `persistenceStrategy:` clause also
conflates the event-sourcing *body contract* with *persistence* and
sits anomalously inside the aggregate body. Full analysis in
[`proposals/document-and-json-hierarchies.md`](./proposals/document-and-json-hierarchies.md).

**Decision.** Two orthogonal **per-aggregate header modifiers**, plus a
`json` field type. "Document" is a field type **and** a saving choice —
**not** a new declaration kind.

| Modifier | Axis | Values | Default |
|---|---|---|---|
| `persistedAs(...)` | primary truth kind | `eventLog` \| `state` | `state` |
| `normalised(...)` | saving shape of the materialised read model / snapshot | `true` \| `false` (`false` = one JSON document) | `true` |

- `persistedAs` values align to the D-STORAGE-SPLIT `kind` set, so
  `resolve-datasource.ts`'s `eventSourced→eventLog` /
  `stateBased→state` mapping becomes an **identity**.
- `persistedAs` **renames + relocates** the shipped body
  `persistenceStrategy: stateBased | eventSourced` → header
  `persistedAs(eventLog | state)`. Breaking change; **hard cutover** —
  `persistenceStrategy:` is removed (not accepted in parallel);
  existing `.ddd` sources migrate in one step (codemod offered).
- **All** aggregate-level config lives on the **header** as paren
  modifiers (`ids`, `with`, `extends`, `persistedAs(…)`,
  `normalised(…)`, `inheritanceUsing(…)`; bare `abstract`/`audited`).
  **Nothing configures in the body** — the body holds members only.
- New `json` **primitive field type** — opaque JSONB; a leaf in
  `wireShape` (never expanded/diffed).
- **Rejected:** `document` as an aggregate peer. **Deferred:** a
  dedicated `document` value-type. **Dropped:** a per-containment
  `as document/table` hint.
- ES + document needs **no new `kind`**: a `kind: eventLog` binding +
  a `kind: snapshot` (or `state`) binding carrying `normalised: false`.
  Marten is the reference backend via a `martenPersistenceAdapter` on
  the existing `PersistenceAdapter` seam.

**Validator rules implied.**

- `persistedAs(eventLog)` is the **declaration** of event-sourcing (the
  rename of `persistenceStrategy: eventSourced`); there is no separate
  `eventSourced` body marker.
- The **body-discipline enforcement** — operations change state only by
  emitting events, an `apply` exists per event, no direct `:=` mutation
  — is **owned by the event-sourcing behavioral feature (appliers,
  `workflow-and-applier.md`)** and is *gated on* `persistedAs(eventLog)`.
  It is **not** implemented by the `persistedAs` rename itself, and
  cannot land before `apply` exists in the grammar. So the rename slice
  ships no body-contract validator; that enforcement arrives with the
  applier feature.
- `persistedAs(state)` (default / absent): operations mutate state
  directly; no `apply`.
- `persistedAs` is **explicit**, default `state` (omitted entirely
  for state-based aggregates). **No inference and no suggestion lint.**
- `normalised(false)` requires the context to resolve a
  document-capable store/adapter; it constrains the `snapshot` binding
  under `persistedAs(eventLog)`, the `state` binding under
  `persistedAs(state)`.
- Interaction (D-ES-TPH, generalised): a `persistedAs(eventLog)`
  concrete subtype of a `sharedTable` base is forced to `ownTable`
  regardless of `normalised`.

**Sub-questions.**

1. **`persistedAs` inference** — **RESOLVED: explicit, default `state`,
   no inference, no lint.**
2. **`json` shape-hint** — **RESOLVED: plain `json` for v1**; `json<T>`
   out of scope.
3. **Snapshot cadence for `eventLog` + document** — OPEN; reuse the
   `snapshot` `dataSource`'s `every:` (recommended) vs a header arg.
4. **Per-projection vs per-aggregate `normalised`** — OPEN; one shape
   per aggregate in v1, per-projection deferred (recommended).
5. **Real document DB** — OPEN; Postgres-JSONB only in v1 (Marten's
   bet), `StorageType += mongo` deferred (recommended).

**Affects.**

- `document-and-json-hierarchies.md` — this is its decision record.
- `aggregate-inheritance.md` — its `storage: shared|own` header clause
  is renamed by D-RENAME (below) to the `inheritanceUsing(…)` paren
  header modifier; same header line.
- Shipped grammar — `persistenceStrategy:` (body) **removed** in favour
  of `persistedAs(…)` (header); hard cutover, one-step source migration
  (codemod).
- `resolve-datasource.ts` — mode→kind mapping collapses to identity.

---

## D-BACKEND-PKG — per-version backend packages are canonical

**Status:** PINNED.

**Problem.** Two layout docs disagree about where framework-coupled
backend code lives. `platform-directory-layout.md` recommends
**Option A** — reverse the `src/platform/hono/v4/` hoist back down
into `src/generator/<platform>/frameworks/…`, shrinking `src/platform/`
to thin surface records. Separately, `docs/plans/packaging-split.md`
(P0–P4, partly shipped) drives toward the opposite: each backend
becomes a **separately-installable per-version npm package**
(`@loom/backend-hono-v4`, `@loom/backend-dotnet-v8`, `-v10`, …)
discovered via its `loom` package.json key, so old + new majors coexist
and `@loom/core` never statically bundles a backend.
`src/platform/hono/v4/` is the staging shape for that relocation
(P3-slice-5), currently blocked only on browser-side backend discovery.

**Decision.** The packaging-split end-state is **canonical**. Backends
are per-version packages; `@loom/core` keeps the framework-neutral emit
(`render-expr`/`render-stmt`, DTO/VO/id/event templates) + the
`PlatformSurface` contract + the resolver. The `package → shared`
layering invariant — *shared code under `src/generator/` must never
import from `src/platform/<family>/<vN>/`*, guarded by
`test/platform/backend-packages-layering.test.ts` — is load-bearing.

`platform-directory-layout.md` **Option A is rejected**: it would
re-pin shared core to one framework version (blocking `hono@v5`) and is
forbidden by the live invariant. The *direction* that survives is
per-`<family>/v<N>/` homes that map 1:1 to packages; the existing hono
hoist is correct, not to be reversed.

**Mechanism / sequencing.**

- No speculative scaffolding — no `v5/`, `express/`, `nestjs/`, adapter
  sub-version dirs, or publish wrappers until a real consumer exists.
- The dotnet (then phoenix) core↔backend split — mirroring hono's P2 —
  is sanctioned now that F6d proved the boundary, but is sequenced
  **after** the storage F-series' remaining persistence-dispatch slices
  land (they still edit `src/generator/dotnet` / `phoenix-live-view`).
- Physical relocation into `packages/` (P3-slice-5) stays gated on
  browser-side backend discovery; until then the in-`src` staging dirs
  + thin re-export wrappers are the reachable shape.

**Affects.**

- `platform-directory-layout.md` — the "Recommendation" section and the
  V1 row (recommending Option A) are superseded; the doc carries a
  "Pinned decisions affecting this proposal" banner pointing here.
- `per-package-output-tree.md` — the *output-side* twin of this decision
  (per-layer output packages). Right direction, **deferred** on one-time
  cost + playground-workspace prerequisite, not rejected; expressible as
  a `LayoutAdapter` extension.
- `docs/plans/packaging-split.md` / `backend-packages.md` — promoted
  from "plan" to the pinned target for backend layout.

---

## D-ADAPTER-HOME — persistence/style/layout adapters live on the backend surface

**Status:** PINNED.

**Problem.** The storage F-series introduced a persistence/style/layout
adapter taxonomy with the contracts correctly in core
(`src/generator/_adapters/`), but a **central** registry
`src/platform/adapter-registry.ts` that statically imports every
backend's adapter implementations. That central fan-in (a) becomes a
`core → package` edge — the direction `backend-packages-layering.test.ts`
forbids — the moment a backend relocates into `packages/`, and (b)
already causes a load-time import cycle (`adapter-registry ← cqrs-style
← … ← platform/registry ← platform/dotnet`), which forced F5d/F6d to
bind each orchestrator's **own local sibling adapters** instead of
resolving through it.

**Decision.** Adapter **implementations** belong to the backend, exposed
through its `PlatformSurface` (an additive contract field carrying the
adapter menu + defaults). `@loom/core` owns only the **contracts**
(`src/generator/_adapters/`) + the `resolve*` helpers, which read
menu/defaults off the *discovered* surface. The central
`src/platform/adapter-registry.ts` is **interim** and does **not**
survive the alignment pass.

**Mechanism / status.**

- The *emit* half is already decentralised (F5d/F6d orchestrators
  dispatch through local adapters). Remaining work: source the menu +
  defaults from the surface, then delete the central registry's static
  fan-in.
- Version-divergent adapters (efcore8 vs efcore10, Ash 3 vs 4) ship
  inside the version's backend package — that divergence *is* the
  package's reason to exist. No shared cross-framework adapter layer
  (e.g. a `node`-shared drizzle) until ≥2 real consumers exist
  ("consolidate the present, don't design for the future").

**Affects.**

- `storage-and-platform-config*.md` — the adapter-registry shape they
  describe is interim per this decision.
- Depends on D-BACKEND-PKG (the surface is the discovery unit).

---

## Other D-tags — referenced but not yet pinned here

The following tags are introduced in
`proposals/global-implementation-plan.md` §0.1 and
`proposals/implementation-plan.md`. They are recorded here as OPEN
with pointers to their proposal-recommended answers. Promote to
PINNED here when ratified.

| Tag | Concern | Recommended answer (source) |
|---|---|---|
| D-RENAME | Aggregate-inheritance layout key naming + syntax | **Amended by D-DOCUMENT-AXIS §4:** header paren modifier `inheritanceUsing(sharedTable \| ownTable)` (was `inheritanceStrategy: …`). Values kept **table-baked**, spelled `sharedTable \| ownTable` (refines pinned `shareTable` → `sharedTable`, reads as "shared table"); medium-neutral `shared\|own` rejected. (`aggregate-inheritance.md` + `document-and-json-hierarchies.md` §4a) |
| D-ES-TPH | ES concrete subtype of TPH abstract | Force `inheritanceUsing(ownTable)` for a `persistedAs(eventLog)` concrete of a `sharedTable` base; generalises across `normalised` per D-DOCUMENT-AXIS (`aggregate-inheritance.md`) |
| D1–D4, D14–D15 | Type-system carrier name / discriminator / postfix vs prefix ML syntax | Per `implementation-plan.md` D-table; locked before P3 |
| D-POLICY-STYLE | Authorization grammar shape | `policy { data { … } operations { … } fields { … } }` reachability over function-style (`authorization.md`) |
| D-LIFECYCLE-VERB | Lifecycle URL style default | `urlStyle: literal \| resource` (`lifecycle-operations.md`) |
| D-I18N-KEY | i18n key stability | Option B — positional hash + named render (`i18n.md`) |
| D-CTX-SHAPE | Ambient `RequestContext` field set | Per `execution-context.md`; see proposed `docs/architecture/request-context.md` |
| D-ENVELOPE | Wire envelope rule | entity \| `Paged<T>` \| ProblemDetails \| event-frame (per global plan §0.4) |
