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

**Implementation: SHIPPED.** `json` primitive (#703);
`persistedAs(eventLog | state)` (#711); the saving-shape axis —
originally drafted as the boolean `normalised(true | false)` (#713),
**reworked to the 3-valued `shape(relational | embedded | document)`**
(#724) once it was clear the axis is a spectrum, not a boolean — with
emission across the backends: **`embedded`** on all of dotnet/hono/
phoenixLiveView (EF owned `.ToJson()` / Drizzle jsonb / Ash embedded
resources, #724/#735/#750), **`document`** on dotnet/hono (STJ /
jsonb blob, #724), and a **`supportedShapes` capability validator**
(#738) that errors on a `shape(…)` the target backend can't emit. No
new Marten backend. Remaining (deferred): Ash `document` (non-idiomatic
single-`:map`, allowed-but-warned) and `eventLog` + snapshot
rehydration (gated behind the appliers feature). See
`document-and-json-hierarchies.md` §9.

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
| `shape(...)` | saving shape of the materialised read model / snapshot | `relational` \| `embedded` \| `document` | `relational` |

(`shape(...)` superseded the original boolean `normalised(true\|false)`
in #724 — `shape(relational)` == old `shape(relational)`, `shape(document)`
== old `shape(document)`, with `embedded` added as the queryable middle.)

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
  `shape(…)`, `inheritanceUsing(…)`; bare `abstract`/`audited`).
  **Nothing configures in the body** — the body holds members only.
- New `json` **primitive field type** — opaque JSONB; a leaf in
  `wireShape` (never expanded/diffed).
- **Rejected:** `document` as an aggregate peer. **Deferred:** a
  dedicated `document` value-type. **Dropped:** a per-containment
  `as document/table` hint.
- ES + document needs **no new `kind`**: a `kind: eventLog` binding +
  a `kind: snapshot` (or `state`) binding carrying `shape: document`.
- **No dedicated Marten backend.** "Store as a document" is *the
  aggregate read model in one JSONB column*, which every backend's ORM
  already supports — so the `document` shape is a **mode added to the
  existing adapters** (EF Core `.ToJson()`, Drizzle `jsonb`, Ash
  embedded/`:map`), advertised via a new **`supportedShapes`** companion
  to `supportedStrategies` on the existing `PersistenceAdapter` seam. A
  separate `martenPersistenceAdapter` was considered and rejected: its
  document half *is* EF `.ToJson()`, and its event-store half (stream +
  document-snapshot rehydration) needs appliers
  (`workflow-and-applier.md`) regardless of backend. So Slice D's
  achievable target is **`persistedAs(state)` + `shape(document)`**;
  the `eventLog` + document case is deferred behind appliers.

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
- `shape(document)` requires the context to resolve a
  document-capable store/adapter; it constrains the `snapshot` binding
  under `persistedAs(eventLog)`, the `state` binding under
  `persistedAs(state)`.
- Interaction (D-ES-TPH, generalised): a `persistedAs(eventLog)`
  concrete subtype of a `sharedTable` base is forced to `ownTable`
  regardless of `shape`.

**Sub-questions.**

1. **`persistedAs` inference** — **RESOLVED: explicit, default `state`,
   no inference, no lint.**
2. **`json` shape-hint** — **RESOLVED: plain `json` for v1**; `json<T>`
   out of scope.
3. **Snapshot cadence for `eventLog` + document** — **RESOLVED: reuse
   the `snapshot` `dataSource`'s `every:` knob** (already in
   D-STORAGE-SPLIT). Cadence is binding/infra config; no aggregate-header
   arg.
4. **Per-projection vs per-aggregate `shape`** — **RESOLVED:
   per-projection.** The shape is settable per read-model: the
   per-binding `dataSource shape:` knob (on the `state` / `snapshot`
   / `replica` binding) governs that projection's shape; the
   aggregate-header `shape(…)` is the default. This stays within
   D-GRANULARITY (per `(context, kind)` binding, not per-aggregate). Richer
   *named* projections (multiple read models of one ES aggregate, each a
   different shape) depend on future read-model modelling and are out of
   v1 scope.
5. **Real document DB** — **RESOLVED: Postgres-JSONB only in v1**
   (Marten's own bet); `shape(document)` resolves to JSONB / Marten
   docs on Postgres. `StorageType += mongo` deferred.

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

## D-RENAME — aggregate-inheritance layout modifier

**Status:** PINNED.

**Decision.** Inheritance table layout is a **header paren modifier**
`inheritanceUsing(sharedTable | ownTable)` (was the body clause
`inheritanceStrategy: shareTable | ownTable`). Amended by
D-DOCUMENT-AXIS §4 — all aggregate config moves to the header as paren
modifiers; nothing in the body. Values stay **table-baked**, spelled
`sharedTable | ownTable` (refines the earlier `shareTable`, reads as
"shared table"); the medium-neutral `shared | own` spelling is
rejected (the choice is specifically about table layout, and naming it
so keeps it honest when document/JSON saving enters via `shape`).

**Validator rules implied.**

- `inheritanceUsing(…)` is only valid on an aggregate that participates
  in inheritance (`abstract` base or `extends` subtype).
- `sharedTable` = TPH (single table + discriminator column);
  `ownTable` = TPC/TPT (table per concrete). The exact TPC-vs-TPT
  choice is a backend detail, not surfaced in the modifier.

**Affects.** `aggregate-inheritance.md` (its `storage: shared|own`
clause is this modifier); `document-and-json-hierarchies.md` §4a (same
header line). Interacts with D-ES-TPH below.

---

## D-ES-TPH — event-sourced concrete subtype of a TPH abstract

**Status:** PINNED.

**Decision.** A `persistedAs(eventLog)` concrete subtype of a
`sharedTable` (TPH) abstract base is **forced to
`inheritanceUsing(ownTable)`** — an event-sourced stream cannot share a
state table with its siblings. Generalises across `shape` per
D-DOCUMENT-AXIS: a `shape(document)` (document) concrete of a
`sharedTable` base is likewise forced to `ownTable`. The validator
raises an error (not a silent coercion) so the author writes the
forced modifier explicitly.

**Affects.** `aggregate-inheritance.md`; the persistence adapter's
table-layout resolution.

---

## D1–D4, D14–D15 — type-system grammar names + ML syntax

**Status:** PINNED (the six grammar-shaping tags). The remaining
type-system decisions D5–D37 keep their **recommended** answers in
[`proposals/implementation-plan.md`](./proposals/implementation-plan.md)
and may be taken per-phase without separate ratification (per that
doc's workflow note); only D1–D4 + D14–D15 are pinned here because they
fix the grammar surface before P3.

| Tag | Question | **Pinned answer** |
|---|---|---|
| D1 | Carrier bound name | **`carrier`** (over `value`/`data`) |
| D2 | Union discriminator field name | **`kind`** (over `type`/`_type`) |
| D3 | Union identity | **Variant-name-tagged** (not structural) |
| D4 | Aggregate-in-carrier semantics | **Handle-in-process, wire-at-boundary** |
| D14 | Parameterised-payload use-site syntax | **Postfix ML** (`customer page`); consistent with `Customer id`; **no angle brackets anywhere** |
| D15 | Anonymous `or` precedence vs postfix constructors | **Postfix binds tighter than `or`** (`string or int option` parses as `string or (int option)`; parens for the other reading) |

**Rationale.** D14's postfix ML choice is the load-bearing one — it
keeps `customer page`, `customer id`, `customer option` all reading as
"a page/id/option *of* customer", with zero generics syntax (`<>`) in
the language. D1/D2 pick the least-surprising names; D3/D4 were already
pinned in the implementation plan and are restated here for one
authoritative location.

**Affects.** `payload-transport-layer.md` (P3/P4 grammar);
`exception-less.md` (D15 governs `or` precedence); `ddd.langium`
`TypeRef` + payload rules.

---

## D-POLICY-STYLE — authorization grammar shape

**Status:** PINNED.

**Decision.** Authorization is expressed in dedicated **`policy { }`
blocks** with three sub-sections — `data { reachable when … }`
(row-set reachability filter, paramless), `operations { <op> when … }`
(point gates, params from the operation), and `fields { mask … }`
(field masking) — **over** the function-style policy DSL alternative.
Reuses `function`, `currentUser`, and `permissions {}` as building
blocks inside the block.

**Rationale.** The block form keeps authorization as visibly-separate
*infrastructure* (one place to read "what governs this aggregate"),
makes the reachability-vs-gate distinction structural (different
sub-sections, different binding scopes), and reads as declarative
configuration rather than scattered guard functions. `currentUser`
member accesses (`.permissions`, `.dataKey`, `.id`) resolve against the
shape pinned in
[`architecture/request-context.md`](./architecture/request-context.md).

**Affects.** `authorization.md` (its central grammar);
`policies-supplementary-note.md` stays superseded background;
`ddd.langium` gains the `policy` rule (Phase 3.2).

---

## D-LIFECYCLE-VERB — lifecycle URL style default

**Status:** PINNED.

**Decision.** The api surface carries `urlStyle: literal | resource`,
**default `literal`**. `literal` uses the operation/create/destroy name
verbatim as the URL slug (`operation cancel()` → `POST
/orders/:id/cancel`); `resource` pluralises it via `src/util/naming.ts`
(`operation cancellation()` → `POST /orders/:id/cancellations`). Loom
rejects the Restful Objects two-tree URL idiom outright (`POST
/services/Customers/actions/createNewCustomer/invoke`) in favour of
conventional REST that hand-written clients already understand.

**Affects.** `lifecycle-operations.md`; the per-backend route emitters
(slug derivation reads `urlStyle`).

---

## D-I18N-KEY — i18n key stability

**Status:** PINNED.

**Decision.** **Option B as default, Option C as escape hatch.**

- **Inline user-visible literals** are keyed by a content hash —
  `page.<page>.<role>.<sha-6>` (6-char base64 of `sha512(source)`).
  Placeholders are **normalised to positional for hashing** (`"Order
  {0}"`) but **rendered named** at use (`{orderNumber}`). Effect: a
  placeholder *rename* leaves the hash stable; `ddd i18n sync` rewrites
  the placeholder name in the catalog without re-keying (Option B).
- **Named `text { }` entries** get true stable keys
  (`text.<Namespace>.<name>`) with author-chosen placeholder names —
  the escape hatch (Option C) for strings that must survive *content*
  edits, not just renames.

Option A (live with churn) is rejected; positional-only hashing without
named render is rejected (leaks DSL/source structure to the client).
The unnamed-placeholder fallback warns (`loom.unnamed-placeholder`).

**Affects.** `i18n.md`, `i18n-strings.md`; the `ddd i18n sync`
three-way merge; the generated catalog key shape.

---

## D-CTX-SHAPE — the ambient `RequestContext` field set

**Status:** PINNED. Full shape in
[`architecture/request-context.md`](./architecture/request-context.md).

**Decision.** One ambient `RequestContext` value, read by every
governance feature. Two tiers: **request-stable** (`correlationId`,
`currentUser`, `locale`, `startedAt`) set once at the boundary;
**frame-local** (`scopeId`, `parentId`) re-derived per execution-context
scope frame. `currentUser` (`id`, `tenantId`, `permissions`, `dataKey`)
**is** the `currentUser` magic identifier from `authorization.md` and
the source of `user.tenantId` for multi-tenancy. No feature opens its
own parallel ambient channel (`ICurrentUserAccessor`, `getLocale()`, a
logging MDC, …) — they all read slices of this one value.

**Affects.** `execution-context.md` (defines the frame tier),
`multi-tenancy-design-note.md` (`tenantId`), `authorization.md`
(`currentUser`/`dataKey`), `sensitivity-and-compliance.md`
(declassification clearance), `i18n.md` (`locale`),
`audit-and-logging.md` (actor + correlation), `observability.md`
(correlation). PlatformSurface lifecycle hooks receive its accessor.

---

## D-ENVELOPE — the wire envelope rule

**Status:** PINNED. Full rules in
[`architecture/wire-envelope.md`](./architecture/wire-envelope.md).

**Decision.** Every HTTP response is exactly one of four shapes — **bare
value** (single entity/payload/primitive), **`Paged<T>`** (lists),
**ProblemDetails** (RFC 7807, all errors), **event-frame** (`{ kind,
occurredAt, correlationId, data }`). The HTTP **status code is the
success/error discriminator**; the success path is **never** wrapped in
a `{ kind: "ok", value }` envelope (D16) — the payload `kind`
discriminator (D2/D3) lives inside tagged-union bodies, not at the
envelope level. A uniform `{ ok, value | error }` envelope is rejected
(forces every client to unwrap; duplicates the status line).

**Affects.** `payload-transport-layer.md`, `exception-less.md` (D16,
D17, D18), `pagination-design-note.md` (`Paged<T>`/`unpaged`),
`workflow-and-applier.md` (event-frame); every backend's DTO/route
emitter; the `conformance-parity.yml` OpenAPI gate.

---

## D-URLSTYLE — lifecycle URL style on the api body + per-action routeSlug

**Status:** PINNED. Full design in
[`proposals/lifecycle-url-style.md`](./proposals/lifecycle-url-style.md);
amends `lifecycle-operations.md` Phase 2, whose grammar sketch assumed a
fictional per-aggregate `api … for <Aggregate> { urlStyle }` form.

**Problem.** `lifecycle-operations.md` Phase 2 specifies `urlStyle` on a
per-aggregate api with a body. The real grammar is
`api <Name> from <Subdomain>` — per-subdomain, body-less. The proposal's
text can't parse against the shipped grammar, so Phase 2 is designed
against the real model here.

**Decision.**

1. **`urlStyle` lives on the `api`, as an optional body** —
   `api SalesApi from Sales { urlStyle: literal | resource }`, default
   `literal` (D-LIFECYCLE-VERB). On the *api* (the shared contract), not
   the deployable (URL shape isn't per-process) nor a system default
   (too coarse; a system-default-with-override is a deferred v2 nicety).
   Grammar uses a direct optional property, not a members list, until a
   second api-body clause actually lands. `urlStyle`/`resource` are
   soft-admitted in `LooseName`/`NameRefIdent` (the `dataSource`/`money`
   precedent).
2. **`routeSlug` is a per-action `OperationIR` field, derived in
   enrichment** — not the proposal's separate `agg.lifecycle` shape (the
   Phase-1 `creates`/`destroys` arrays already partition by kind).
   Derivation: `canonical → undefined` (bare collection / canonical-id
   URL); `urlStyle: literal → name`; `urlStyle: resource → plural(name)`.
   The HTTP verb + path skeleton stays Phase-3 emitter logic keyed on
   `kind` + `canonical` + `routeSlug`.
3. **The surfacing api is resolved by subdomain.** Aggregate → one
   context → one subdomain → the api `from` it. Enrichment threads the
   subdomain's style into `enrichAggregate`. Top-level contexts (no api)
   default to `literal`. If two apis surface one subdomain with differing
   `urlStyle`, the **first declared wins** and the validator warns
   (`loom.subdomain-conflicting-urlstyle`).

**Consequences (not separate decisions).**

- **No generated-output change in Phase 2** — no backend reads
  `routeSlug` yet (emitters still build slugs inline as `snake(name)`),
  so fixtures stay byte-identical. The re-baseline lands in **Phase 3**,
  when emitters consume `routeSlug` and `resource`-style URLs change
  (a coordinated `rebaseline-Lifecycle` moment).
- **The verb-name warning** (`loom.url-style-naming-warn`,
  `cancel → /cancels`) is **deferred** — reliable verb detection needs a
  lexicon; low value vs false-positive cost.

**Affects.** `lifecycle-operations.md` Phase 2 + integration-seams
sections (superseded by `lifecycle-url-style.md`); `ApiIR.urlStyle`,
`OperationIR.routeSlug`; the enrichment pass; depends on D-LIFECYCLE-VERB.

---

## D-PHOENIX-SURFACE — the decomposed Phoenix platform surface

**Status:** PINNED. (Reconciles two proposals that, taken individually,
collide. Subsumes the **D-PHOENIX-ECTO** ask from
`elixir-ecto-and-api-only-backends.md`.)

**Problem.** Two proposals each free a *different* axis off the single
`phoenixLiveView` keyword, and their individually-recommended fixes
**conflict**:

- `elixir-ecto-and-api-only-backends.md` frees the **domain** axis (Ash vs
  Ecto) and its **Option B** recommends carrying that axis *in the platform
  name* — `phoenixLiveView` = Ash, a new `phoenix` = Ecto.
- `embedded-frontend-composition.md` frees the **hosted-UI-framework** axis
  (LiveView vs embedded React) and recommends **retiring `phoenixLiveView`**
  entirely — one `phoenix` platform, with `liveview` demoted to a
  `framework:` value on `ui`.

Composed, they collide: Option B uses the *name* to encode the domain axis,
while the framework note frees a *different* axis off that same name and
deletes it. You cannot do both. `phoenixLiveView` froze **two** axes plus the
host into one token; the fix must free **both** axes the same way — neither
should be re-frozen into a platform name.

**Decision.** **One** backend platform, **`phoenix`**, with both frozen axes
expressed as orthogonal config — *not* as platform names:

| Concern | Where it lives | Values |
|---|---|---|
| **Host runtime / web framework** | `platform: phoenix` | the Phoenix/BEAM runtime (`needsDb: true`, `apiBasePath: "/api"`, serves `priv/static`) |
| **Domain / persistence framework** | the existing **D-ADAPTER-HOME `style:`/`persistence:` adapter** menu off the backend's `PlatformSurface` — **not** a new keyword | `ash` \| `ecto` |
| **Hosted UI framework** | `ui { framework: … }` + `deployable { hosts: }` | `liveview` (Phoenix-only) \| `react`/… (any static host) |

This makes `phoenix.hostableFrameworks = {liveview} ∪ {react, …}` — the
richest of any platform — a *derived* consequence of Phoenix being the only
platform that is both a render runtime **and** a static-asset host, not a
special case. It is **a refinement of D-PHOENIX-ECTO Option B**: keep Option
B's "no `family@version`, no `apiOnly` platform" conclusions, but reject its
"domain axis = platform name" mechanism (which the framework note shows
double-books the name).

**The domain axis is universal, not Phoenix-special.** *Every* backend freezes
a domain/persistence framework — `hono`→Drizzle, `dotnet`→EF+Mediator,
`phoenix`→Ash|Ecto (`docs/generators.md:27`). Ash-vs-Ecto is the *same axis* as
Drizzle-vs-Prisma or EF-vs-Dapper; Phoenix only *looks* special because it is the
first backend whose menu has **size > 1**, so it is the first where the modifier
is ever written. Therefore:

- **No `domain:` keyword, and nothing Phoenix-only.** The axis is the
  already-PINNED **D-ADAPTER-HOME** `style:`/`persistence:` adapter surface:
  each backend exposes its menu + default off its `PlatformSurface`; `phoenix`'s
  menu is `{ash, ecto}` (default `ash`), `hono`'s is `{drizzle}`, `dotnet`'s is
  `{ef}`. A size-1 menu means the author never writes the modifier — which is
  why `platform: hono` looks "domain-free" today. Adding Ecto is *populating
  Phoenix's menu*, not minting a platform mechanism.
- **No second `framework:` on the backend.** `framework` is now the **UI** axis
  (`ui { framework: react | liveview }`); reusing it backend-side would collide.
  A backend's web framework simply **is** its `platform:` (`hono`/`dotnet`/
  `phoenix`). So a backend has exactly two axes, both already named:
  `platform:` (runtime/web framework) and `style:`/`persistence:` (domain
  framework) — and the Ecto note's own Option A already spells Ash/Ecto in
  exactly that surface (`persistence: { ectoPostgres }`, `style: { ecto }`).

Option A (adapter swap) is therefore not a *later* factoring for this axis — it
**is** the axis. This decision pins the domain axis onto the D-ADAPTER-HOME
surface now (the menu/default fields); only the Ash-emit *extraction behind the
adapter contract* remains as the implementation tail the Ecto note phases.

**Consequences.**

- `phoenixLiveView` is retired as a platform token; a desugar shim maps it to
  `platform: phoenix` + the `ash` adapter (default) + the referenced `ui`
  gaining `framework: liveview` (mirrors the `platform: react` → vite-host shim).
- **API-only** stays resolved by **D-API-ONLY** (absence of a `ui`/`hosts:`
  mount) — unchanged; it is neither a name nor a flag.
- **Phoenix-embeds-React** (bundle → `priv/static`, same-origin `/api`)
  becomes expressible for free — the `wwwroot` twin of dotnet.
- The four Phoenix shapes {Ash,Ecto} × {LiveView, embedded-React} +
  {API-only} are spanned by two orthogonal axes (one of them a pre-existing
  adapter menu), not 5+ platform names.

**Open within this decision.**

1. ~~**Adapter-surface spelling** — `style:` vs `persistence:` vs both for the
   Ash/Ecto choice.~~ **RESOLVED by D-REALIZATION-AXES:** neither — the
   domain-framework axis gets a dedicated `foundation:` keyword (default
   `vanilla`), and `persistence:` narrows to the data-access library only.
2. **Default domain** when unspecified on `platform: phoenix` — **`ash`**
   (matches today's `phoenixLiveView` behaviour after desugar). PINNED — now
   expressed as `foundation: ash` (the default) per D-REALIZATION-AXES.

**Affects.** `embedded-frontend-composition.md` §6 (its "retire
`phoenixLiveView`" is this decision's framework half); `elixir-ecto-and-api-only-backends.md`
§4 + §6 (supersedes its D-PHOENIX-ECTO Option-B "sibling platform name" with
"one `phoenix` platform + the domain axis on the D-ADAPTER-HOME surface"); the
`Platform` grammar enum + `Framework` enum; `src/platform/registry.ts`;
`checkDeployable`; **depends on D-ADAPTER-HOME** (the domain axis *is* that
surface's menu/default).

**Amended by D-REALIZATION-AXES.** Its *mechanism* for the domain axis — "rides
the `style:`/`persistence:` surface, no new keyword" — is superseded: the axis
gets the dedicated keyword `foundation:` so the data layer stays pickable under a
framework (`foundation: ash` + `persistence: ashSqlite`). Every *other*
conclusion of this decision stands (one `phoenix` platform, no `family@version`,
no `apiOnly`, `framework:` is UI-only, default domain = Ash).

---

## D-REALIZATION-AXES — the deployable platform-config axes (and the `foundation:` amendment)

**Status:** PINNED. (Amends **D-PHOENIX-SURFACE**'s domain-axis mechanism;
depends on **D-ADAPTER-HOME** and **D-STORAGE-SPLIT**. Full matrix, gating rules,
and examples in `proposals/platform-realization-axes.md`.)

**Problem.** `platform: dotnet` bundles EF Core + MediatR-CQRS + minimal API with
no exposed knobs (`storage-and-platform-config.md:58`). The decomposition into
`platform: <name> { … }` config needs (a) a fixed, reviewed *vocabulary* of
axes, and (b) a resolution of D-PHOENIX-SURFACE open-item 1 (where the Ash/Ecto
domain-framework axis lives). The storage doc's `style:`/`layout:` names are
weak/colliding, and folding the domain framework into `persistence:` destroys the
ability to pick the data layer *underneath* a framework.

**Decision.** A backend deployable's realization is **six orthogonal, optional,
validator-gated axes**, each named for the layer it realizes. Each is a
menu+default exposed off the backend's `PlatformSurface` (D-ADAPTER-HOME); a bare
`platform: <name>` equals the full default block (byte-identical to today).

| Axis | Realizes | Values (dotnet shown; menu is per-platform) | Default |
|---|---|---|---|
| `foundation:` | opinionated domain/app framework, or none | `vanilla` · `abp` (phoenix: `ash` · `vanilla`; node: `vanilla` · `nestjs`) | `vanilla` (phoenix: `ash`) |
| `application:` | application-layer orchestration topology | `flat` · `serviceLayer` · `cqrs` | `cqrs` |
| `persistence:` | data-access library only | `efcore` · `dapper` · `marten` | `efcore` |
| `directoryLayout:` | source-tree organization | `byLayer` · `byFeature` | `byLayer` |
| `transport:` | HTTP surface | `minimalApi` · `controllers` | `minimalApi` |
| `runtime:` | aggregate execution / concurrency model | `transactional` · `orleans` · `akka` (phoenix: `transactional` · `genserver`) | `transactional` |

**Rulings folded in:**

- **`foundation:` is its own keyword** — *this is the amendment to
  D-PHOENIX-SURFACE.* The Ash/Ecto (and EF/ABP, Drizzle/NestJS) domain-framework
  axis is **not** a `persistence:`/`style:` value; it is `foundation:` (default
  `vanilla`). This keeps the data layer pickable under a framework
  (`foundation: ash` + `persistence: ashSqlite`; `foundation: abp` +
  `persistence: dapper`). It preserves D-PHOENIX-SURFACE's correct **no
  `domain:` keyword** instinct — `foundation:` names the framework hosting the
  domain, not the domain (which is the `.ddd` source).
- **`persistence:` narrows** to the data-access library only (no domain
  framework). Prefer it over "dal" (dated acronym).
- **`style:` → `application:`** (layer-named; not `layering:`, which collides
  with its own value and miscasts CQRS). Values are a topology spectrum
  `flat` → `serviceLayer` → `cqrs`. `flat` (not `transactionScript` — that is an
  orthogonal logic-organization pattern spanning all three values; Loom is
  domain-model by construction so that axis is pinned and unexposed).
- **`layout:` → `directoryLayout:`** (explicit; disambiguates from the
  page-level `layout:` wrapper — a real collision).
- **`runtime:` default is `transactional`** (names the DB-transaction
  consistency model; the contrast to actor-mailbox serialization), not the
  earlier coinage `pooled`.
- **Foundation owns layers.** Each `foundation:` value declares which of
  `{application, transport, persistence-flavor}` it owns; setting an owned knob
  is an error. `vanilla` owns nothing.
- **Actor runtimes need a durable store, not necessarily a journal** — event
  sourcing is idiomatic for persistent actors, not required (Akka.NET + EF via a
  `DbContextFactory` is a valid, non-standard state-stored mode). `flat` × actor
  runtime is a *warning*, not an error.

All axes are **optional**; lowering normalizes each omitted knob to its platform
default, so the IR carries concrete values and `ddd snapshot` round-trips the
normalized form (mirrors `design:` via `BUILTIN_PACK_LATEST`).

**Affects.** `proposals/platform-realization-axes.md` (the full spec);
`proposals/storage-and-platform-config.md` (its `style:`/`layout:` names and the
"`platform: dotnet` defaults" row are renamed per this decision);
`proposals/elixir-ecto-and-api-only-backends.md` (its Phase-2 "`style:` vs
`persistence:` field" question is answered: `foundation:`); the `Platform` /
deployable grammar; `DeployableIR`; `checkDeployable`; each backend's
`PlatformSurface` (menu+default fields). **Amends D-PHOENIX-SURFACE** open-item 1;
**depends on D-ADAPTER-HOME**.

---

## D-NODE-PLATFORM — `node` is the JS-runtime platform; `hono` is a `transport:` value

**Status:** PINNED. (Mirrors **D-PHOENIX-SURFACE**'s rename pattern; depends on
**D-REALIZATION-AXES** for the `transport:` axis. Rollout in
`proposals/realization-axes-rollout.md` Phase 3.)

**Problem.** `platform: hono` conflates the **JS runtime** (Node) with the **web
framework** (Hono) in one token — the same conflation just resolved for
`phoenixLiveView`. `dotnet` / `phoenix` name the language-ecosystem; `hono` names
only *one of several* interchangeable TS web frameworks (Hono / Express /
Fastify / Elysia). The codebase already splits these: language codegen lives in
`src/generator/typescript/`, while `src/platform/hono/` is the Hono web-framework
backend.

**Decision.**

- **`node` is the canonical JS-runtime platform** (language TypeScript, *derived*
  — not a name prefix; cf. `dotnet` is not `csharp-dotnet`). Legacy
  `platform: hono` is admitted as a **back-compat alias** that desugars to
  `platform: node { transport: hono }` (same mechanism as `phoenixLiveView` →
  `phoenix`).
- **The web framework is the `transport:` axis** (D-REALIZATION-AXES). `node`'s
  menu: `hono`\* · `express` · `fastify` · `elysia`; default `hono`. (`dotnet`
  transport stays `minimalApi`\*·`controllers`; `phoenix` `phoenixRouter`\*.)
- **NestJS is a `foundation:` value** (rung-3): it owns application + transport
  and runs on an underlying http adapter, so `foundation: nestjs` locks
  `transport:` via R4 — identical shape to `foundation: abp` on dotnet.
- **`language` is a derived surface property** (`typescript` for `node`/`react`,
  `csharp` for `dotnet`, `elixir` for `phoenix`), consumed by the Phase-F
  shared-contracts grouping — *not* a platform-name prefix.
- **Future JS runtimes** (`bun` / `deno` / `edge`) are **sibling `platform:`
  values** (distinct stdlib/deploy), all TypeScript — not a `typescript-X`
  prefix and not a new sub-axis.

**Affects.** `src/platform/registry.ts` (add `node`, alias `hono`→`node`); the
`Platform` IR union + grammar `Platform` rule (add `node`, keep `hono` as
back-compat keyword); the `transport:` menu (`hono` becomes its default value);
`src/platform/hono/` (reframed as node's Hono transport); the derived `language`
property on `PlatformSurface`. **Depends on D-REALIZATION-AXES**; mirrors
**D-PHOENIX-SURFACE**.

---

## D-SEED-PATH — seed rows go through the domain `create`

**Status:** PINNED.

**Problem.** `database-seeding.md` must pick how a declarative seed row
reaches the database. Target frameworks split: EF `HasData` and Drizzle
`insert` go *straight to tables*; Ash goes *through actions* (enforcing
changesets). Loom needs one default.

**Decision.** Seed rows lower through the aggregate's **canonical
`create`** by default — the same path a real request takes — so
invariants and create-time logic run, and a seed that violates an
invariant is caught at boot rather than producing a corrupt row. A
`seed raw { … }` modifier opts a block into table-level inserts for
bulk fixtures where the domain pass is deliberately bypassed (or too
slow); `raw` carries a `loom.seed-raw-unchecked` warning when a value
would fail an invariant.

**Rationale.**

- The domain `create` already encodes the invariants; bypassing it to
  insert rows is the same mistake as letting an API skip validation.
- Ash's native seed idiom is `Ash.create!`; routing through `create`
  makes the Loom surface map cleanly onto the most-opinionated backend
  rather than the least.
- `raw` keeps the escape hatch explicit and visible, not the default.

**Consequences.** `SeedIR.path: "domain" | "raw"`; the declarative
record shape is the aggregate's **`create`-parameter shape** (no `id`
field — the framework mints ids). Object graphs built by *operations*
(not create params) are the imperative-body's job, not the declarative
form's.

**Affects.** `database-seeding.md` §2 (D-SEED-PATH), §3.2, §6 (per-
backend emitters), §8 (`loom.seed-raw-unchecked`).

---

## D-SEED-IDEMPOTENCY — v1 is ship-once via a dataset marker

**Status:** PINNED.

**Problem.** Re-running a seed must not duplicate rows. Two mechanisms
were on the table: (a) an applied-**marker** table; (b) per-row
**upsert** by a declared natural key.

**Decision.** v1 is **ship-once via an applied-marker**: a `__loom_seed`
table holds one row per applied `(module, dataset)`; the seeder skips
the whole set on boot if the marker is present. This matches the Rails
`db:seed` / Ecto `seeds.exs` contract, needs no natural key on the
rows, and covers the quick-start demo entirely. Editing an
already-applied seed has no effect until the marker is cleared
(`ddd seed --reset <dataset>`); seeding is forward-only, mirroring the
migrations stance.

Per-row **upsert by a declared natural key** (`key Aggregate.field`),
for *reference* data corrected in place over time, is **deferred** — it
adds a second idempotency mechanism, a grammar clause, a validation
rule, and a per-backend upsert branch, and earns its keep only once a
model actually has evolving lookup data. The grammar reserves the slot
(`seed <dataset> key Aggregate.field`) so it lands additively later.

**Rationale.**

- The driving use case (first-boot demo content) is served by the
  marker alone; the marker is the smaller, simpler mechanism.
- Marker-by-content-hash was rejected: re-applying forward-only
  `create`s on a changed set just collides on existing rows — the very
  thing upsert would fix — so hashing buys nothing without also buying
  upsert. Keying the marker by *dataset name* sidesteps it.

**Consequences.** No `key`/`contentHash` in `SeedIR` for v1; the marker
table is emitted as a synthetic `createTable` step by the owning
module's migration pass. `LOOM_SEED` gates which datasets run.

**Affects.** `database-seeding.md` §2 (D-SEED-IDEMPOTENCY), §7, §10
(deferred upsert), build-order §11 phase 6.

---

## D-SEED-XREF — seed cross-references are explicit ids (no `@handle`)

**Status:** PINNED.

**Problem.** Declarative seed data sometimes needs to relate rows (an
`Order` referencing a `Customer`). How does a referencing row name the
referenced row's id?

**Decision.** **Explicit ids on the `raw` path** — the declarative-fixture
model of Django fixtures, EF Core `HasData`, and raw SQL. A `raw` row is a
literal record (explicit `id` + literal FK columns) inserted directly,
bypassing the domain `create`; the author writes the same literal id in the
referenced row and the referencing FK, and orders parents before children.
No bespoke handle/reference construct, no topological reorder.

A symbolic-reference form (`Customer @acme { … }` / `Order { customerId:
@acme }`, lowering to a `SeedRef` ExprIR + topo-sort) was prototyped and
**dropped**: no concrete stack has it (imperative seeders use host-language
local variables; declarative ones use explicit ids), it duplicates what the
imperative body's `let` bindings already give for free, and it spread a new
`ExprIR` variant + topo-sort + three validators across the toolchain for a
convenience neither camp felt the need to invent.

**Consequences.** The default **domain** path mints ids and therefore has no
cross-references (a minted id isn't knowable to reference) — flat demo /
reference data only. Cross-referenced / relational seed data uses **`raw`**.
`SeedRowIR` carries no `handle`; there is no `seed-ref` ExprIR; `SeedIR.rows`
stay in source order.

**Affects.** `database-seeding.md` §3.1/§3.2 (cross-ref design), §5 (IR), §8
(validation), §11 (build order — `raw` path is the cross-ref home).
