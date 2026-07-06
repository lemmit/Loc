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

Decision tags were introduced by the original
[`proposals/global-implementation-plan.md`](./proposals/global-implementation-plan.md)
("Decisions to pin before any grammar edit"; that plan was rewritten
2026-06-10 — this log is now the sole home of the tags) and are
elaborated in the per-proposal docs.

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

> **Superseded (2026): the Ash foundation was removed.** `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error and `vanilla` is the default and only valid value. The Ash-vs-vanilla reasoning below is historical.

**Status:** PINNED — **amended by D-ELIXIR-PLATFORM** (the canonical platform
name renamed `phoenix` → `elixir`). The *decomposition* conclusions of this
decision (one platform for the language ecosystem; UI framework axis on `ui`;
default domain Ash; no `family@version`; no `apiOnly`) all stand; only the
spelling of the canonical platform name changes. (Reconciles two proposals
that, taken individually, collide. Subsumes the **D-PHOENIX-ECTO** ask from
`elixir-ecto-and-api-only-backends.md`.)

**Amendment (aliases retired).** Both the `phoenix` / `phoenixLiveView`
*platform* aliases (D-ELIXIR-PLATFORM amendment) and the `liveview` *framework*
alias introduced by this decision have since been **removed**. `framework:
phoenixLiveView` is the only framework spelling — the bare `liveview` keyword is
gone from the grammar `Framework` rule, and the `canonicalFramework` desugar
(both the lowering-side and validator-side copies) is deleted. `platform:
elixir` + `framework: phoenixLiveView` are the only spellings.

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

> **Superseded (2026): the Ash foundation was removed.** `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error and `vanilla` is the default and only valid value. The Ash-vs-vanilla reasoning below is historical.
>
> **Superseded (2026): the `foundation:` axis was removed entirely.** With Ash gone it had collapsed to a single value (`vanilla`) on every backend, so it gated nothing — the grammar clause, the `DeployableIR.foundation` field, the R4 (foundation-owns-layers) and R6 (foundation-compat) validator rules, and the `foundation-default-flipping` warning are all deleted. The realization block now carries **five** axes: `application`, `persistence`, `directoryLayout`, `transport`, `runtime`. All `foundation:`-keyword reasoning below (the amendment, the ownership rules, the rung table) is historical.

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
| `foundation:` | opinionated domain/app framework, or none | `vanilla` · `abp` (phoenix/elixir: `vanilla` only — `ash` removed; node: `vanilla` · `nestjs`) | `vanilla` (phoenix/elixir: `vanilla`) |
| `application:` | application-layer orchestration topology | `flat` · `serviceLayer` · `cqrs` | `cqrs` |
| `persistence:` | data-access library only | `efcore` · `dapper` · `marten` | `efcore` |
| `directoryLayout:` | source-tree organization | `byLayer` · `byFeature` | `byLayer` |
| `transport:` | HTTP surface | `controllers` · `minimalApi` | `controllers` (the attribute-routed `[ApiController]` surface the backend has always emitted; the labels were historically inverted and swapped 2026-06-10 — `minimalApi` is the reserved/unbuilt alternative) |
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

## D-VANILLA-PHOENIX-FOUNDATION — `foundation: vanilla` is added to the Elixir foundation menu

> **Superseded (2026): the Ash foundation was removed.** `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error and `vanilla` is the default and only valid value. The Ash-vs-vanilla reasoning below is historical.

**Status:** PINNED — **amended by D-ELIXIR-PLATFORM** (the foundation menu lives
on `platform: elixir` after the rename; "Phoenix menu" wording below refers to
the same surface). The decision's substance — `foundation: vanilla` as a
first-class second adapter on the Elixir backend, `foundation: ash` remaining
the default, the validator R5 gate — is unchanged. (Concretises one menu slot of
**D-REALIZATION-AXES**; spec in `proposals/vanilla-phoenix-foundation.md`.)

**Problem.** D-REALIZATION-AXES pinned the `foundation:` axis with `phoenix: ash ·
vanilla` as the menu, but the validator (`src/language/validators/data/platform-rules.ts:184`)
currently returns the single-element `["ash"]` and the lowerer
(`src/ir/lower/lower-platform.ts:46`) defaults to `ash` — `vanilla` is a planned
value with no emitter behind it. Two operationally distinct strains on
`foundation: ash` motivate building the second emitter:

1. **Exception-less alignment.** A4 of `proposals/exception-less.md` deletes
   route-layer try/catch towers on every backend in favour of variant dispatch
   on typed `or`-union returns. The current Phoenix emitter has the tower as a
   design feature (`Plug.ErrorHandler` translates `Ash.Error.Invalid` → 422,
   `Ash.Error.Forbidden` → 403, `Ash.Error.Query.NotFound` → 404).  Vanilla
   Ecto's `{:ok, _} | {:error, changeset}` is the natural typed-error carrier;
   the tower collapses into per-variant `with`-block dispatch (the same shape
   TS/.NET adopt post-A4).
2. **Pure event sourcing.** The cross-backend pure-ES contract (no state
   table, per-aggregate `<agg>_events` stream, fold-on-load, emit-and-apply
   command bodies) is live on Hono/Drizzle, Hono/MikroORM, .NET/EF, and
   .NET/Dapper. Under `foundation: ash` there is no clean fit — AshEvents is
   hybrid (state table, single centralised event log, action-wrapping);
   AshCommanded is closer but heavy; a custom `Ash.DataLayer` over event
   streams is months of work (re-implements AshCommanded's internals).

Both strains are **Ash-foundation limitations, not Phoenix-platform
limitations** — Phoenix itself (Plug + Endpoint + Router + LiveView) is
domain-layer-agnostic; what doesn't fit is `Ash.Resource`'s changeset-shaped
action model + `Ash.DataLayer`'s queryable-store callback contract.

**Decision.** `foundation: vanilla` is added to the Phoenix menu as a
first-class second adapter. Emits plain `Phoenix.Endpoint` + `Phoenix.Router` +
LiveView over plain `Ecto.Schema` / `Ecto.Changeset` / `Ecto.Repo` — no
`Ash.Resource`, no `AshPostgres`, no `AshPhoenix.Form`. The existing
`foundation: ash` path is unchanged and remains first-class; neither is
deprecated.

**Affects.** `src/language/validators/data/platform-rules.ts:184` (lift the
single-element menu); `src/ir/lower/lower-platform.ts:46` (keep `ash` default —
see D-VANILLA-DEFAULT); a new `src/generator/phoenix-live-view/vanilla/`
subtree (sibling emitters: `schema-emit`, `changeset-emit`, `policy-emit`,
`context-emit`, `repository-emit`, `vanilla/api-emit`,
`vanilla/problem-details-emit`); a new `ecto-postgres-persistence` adapter; the
strict-parity conformance gate. **Depends on D-REALIZATION-AXES**;
**enables D-VANILLA-ES-HOME**.

---

## D-VANILLA-ES-HOME — pure event sourcing on Elixir lands only under `foundation: vanilla`

> **Superseded (2026): the Ash foundation was removed.** `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error and `vanilla` is the default and only valid value. The Ash-vs-vanilla reasoning below is historical.

**Status:** PINNED — **amended by D-ELIXIR-PLATFORM** (the gap lives on
`platform: elixir` after the rename; the Ash-foundation-vs-Phoenix-platform
distinction in this decision's body is unchanged — the constraint is the
Ash *foundation*, on the Elixir *platform*). (Resolves the
`EVENT_SOURCING_BACKENDS` Elixir gap left open in
`proposals/workflow-and-applier.md`; **depends on
D-VANILLA-PHOENIX-FOUNDATION**.)

**Problem.** `validateEventSourcedStorage` (`src/ir/validate/checks/system-checks.ts`)
rejects `persistedAs(eventLog)` aggregates on Phoenix today;
`ash-postgres-persistence.ts:60` advertises `supportedStrategies: ["state"]`
only. Once vanilla exists, the gate can lift on a foundation-sensitive basis —
but the question of *whether to also pursue Ash-foundation ES* (via AshEvents
adoption, AshCommanded adoption, or a custom `Ash.DataLayer`) is independent
and material.

**Decision.** Pure event sourcing on Phoenix lands **only** under `foundation:
vanilla`. `foundation: ash` + `persistedAs(eventLog)` stays a hard error after
vanilla ships, with a structured diagnostic naming the Ash foundation as the
constraint and pointing the user at `foundation: vanilla` or a non-Phoenix
backend. The following alternatives are **explicitly not pursued**:

- **AshEvents adoption.** Its hybrid model (state table + centralised event
  log + action-wrapping + manual whole-resource replay) diverges from Loom's
  pure per-aggregate-stream / fold-on-load contract. Reconciling would force
  either a divergent Phoenix semantics or a fight-the-grain projection.
- **AshCommanded adoption.** Closest match semantically (Commanded aggregates
  + apply/2 + per-aggregate streams) but ships heavy infrastructure
  (Commanded + EventStore Postgres) for a single foundation, when the vanilla
  path achieves the same contract zero-dep.
- **Custom `Ash.DataLayer` over event streams.** Re-implements AshCommanded
  internals; ~months of work; half-bridges leak (`AshPhoenix.Form`,
  `AshGraphql`, `AshJsonApi`, relationships all assume the data layer answers
  queries about current state).

Rationale: the cross-backend pure-ES contract is live on four paths already
(Hono/Drizzle, Hono/MikroORM, .NET/EF, .NET/Dapper); vanilla joins them as a
fifth port of a proven shape (~2–4 days of work). The Ash paths each carry
multi-week-to-month costs to land *partial* fits. Routing ES through vanilla
costs nothing additional once vanilla exists.

**Affects.** `src/ir/validate/checks/system-checks.ts`
(`EVENT_SOURCING_BACKENDS` un-gate gains a foundation predicate — `phoenix` +
`foundation: vanilla` only); `test/ir/eventsourced-storage-support.test.ts`
(extend the matrix); the structured diagnostic from
`proposals/vanilla-phoenix-foundation.md` P0; `MigrationsIR` consumers (the
shared `<agg>_events` shape extends to the Ecto migrations renderer in P4).
**Depends on D-VANILLA-PHOENIX-FOUNDATION**.

---

## D-PHOENIX-FOUNDATION-ROUTING — Phoenix feature parity is reached by routing to `vanilla`, not by investing in Ash

> **Superseded (2026): the Ash foundation was removed.** `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error and `vanilla` is the default and only valid value. The Ash-vs-vanilla reasoning below is historical.

**Status:** PINNED — ratified 2026-06 (backend feature-parity plan, W4).
Generalises **D-VANILLA-ES-HOME** from event sourcing to *every* feature with
no idiomatic Ash fit; **depends on D-VANILLA-PHOENIX-FOUNDATION**.

**Problem.** Several features (event-sourced storage, event-sourced workflows,
provenanced fields, full `shape(document)` ops, `emit`/`add`/`remove`-bodied
`or`-union-returning ops) emit cleanly on `foundation: vanilla` but have **no
idiomatic Ash fit**. The recurring question is whether to close the
Phoenix-side gap by routing those contexts to `vanilla` (treating the `ash`
gates as the deliberate final answer) **or** by investing in an Ash-idiomatic
emission (AshEvents/AshCommanded for ES, an Ash `:map` document, an Ash
provenance extension, a custom `Ash.DataLayer`).

**Decision.** **Route, don't invest.** "Full parity" on Phoenix is reached by
`foundation: vanilla` for these features; `foundation: ash` keeps each one a
**fail-fast validator error** that names the constraint and points at
`foundation: vanilla` (never a silent downgrade). The Ash-side build-out is
**explicitly out of scope** — the cost is multi-week-to-month for *partial*
fits (see the "explicitly not pursued" list in D-VANILLA-ES-HOME), against a
zero-additional-cost vanilla port of a proven cross-backend shape. This is the
canonical case that "parity" means *emitted **or** fail-fast-gated*, not "every
backend emits every feature" (`plans/backend-parity-plan.md`).

**Already in place (no new compiler work).** Every routed feature already
emits on vanilla and gates on ash today: ES storage/workflows
(`EVENT_SOURCING_BACKENDS` + foundation predicate), provenance
(`PROVENANCE_BACKENDS` + `validateProvenancedStorage`), document-CRUD
(`loom.vanilla-document-unsupported`), returning-op bodies
(`loom.operation-return-unsupported`). Each is compiled against real
Elixir/Ecto by `elixir-vanilla-build.yml`. W4 is therefore a **documentation +
ratification** workstream, not an emission one.

**Affects.** `docs/platforms.md` (the *Phoenix foundations* routing table);
`docs/generators.md` (the five-backend matrix's `elixir·ash` / `elixir·vanilla`
columns); the `loom.*` gate diagnostics already cited above (unchanged — this
decision ratifies their finality).

---

## D-NO-MIXED-FOUNDATION — one foundation per deployable; per-aggregate override not added

> **Superseded (2026): the Ash foundation was removed.** `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error and `vanilla` is the default and only valid value. The Ash-vs-vanilla reasoning below is historical.

**Status:** PINNED — **amended by D-ELIXIR-PLATFORM** (substance unchanged;
`platform: phoenix` references in the body now read `platform: elixir`
post-rename). (Structural consequence of **D-REALIZATION-AXES** + the
deployable model; recorded explicitly to forestall the per-aggregate override
extension request.)

**Problem.** A natural-sounding feature request is "let me keep Ash resources
for state-based aggregates and use vanilla emit for the ES aggregate in the
*same* deployable." The motivation is real (some domains genuinely mix
state-based-CRUD aggregates with one or two ES aggregates), but the
implementation cost compounds at every call site: workflow bodies branch on
per-aggregate strategy, forms split between `AshPhoenix.Form` and stock
`to_form(changeset)`, authorization splits between Ash policies and plain
guard functions, telemetry emission splits between Ash trace events and
hand-emitted equivalents.

**Decision.** A single deployable carries one `foundation` value. Per-aggregate
`foundation` override is **not** added.

**Crucially: this is a structural consequence, not an additional policy.**
Under D-REALIZATION-AXES, `foundation:` is a **per-deployable axis** on the
deployable's `platform:` config block (each deployable declares one platform
with one foundation). The per-deployable scope of the axis *already* makes
mixed foundation within a deployable inexpressible in the grammar — this
decision merely confirms the architecture won't grow a per-aggregate escape
hatch, with the rationale that the plumbing cost (above) outweighs the
mixed-foundation use case.

Users who need both Ash-resource and pure-ES aggregates have two principled
paths:

1. **Split bounded contexts across deployables.** State-based contexts deploy
   under `foundation: ash`; ES contexts deploy under `foundation: vanilla`.
   Each deployable is internally coherent; cross-deployable consumption uses
   the api surface as on any cross-deployable boundary.
2. **Pick `foundation: vanilla` for the whole deployable.** State-based
   aggregates emit as plain Ecto schemas (no loss vs Ash for simple CRUD);
   ES aggregates emit as fold+repository. Single mental model.

**Affects.** `proposals/vanilla-phoenix-foundation.md` (the "Mixed-mode within a
context" section is the conversational origin of this decision). No grammar
change required (the constraint is already structural); no validator rule
needed beyond today's per-deployable `foundation:` typing.

---

## D-VANILLA-DEFAULT — vanilla becomes Elixir default after stabilisation, not on first ship

> **Superseded (2026): the Ash foundation was removed.** `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error and `vanilla` is the default and only valid value. The Ash-vs-vanilla reasoning below is historical.

**Status:** PINNED — **amended by D-ELIXIR-PLATFORM** (the default-flip target
is `platform: elixir` after the rename; sequencing and rationale unchanged).
(Sequences the default-flip of **D-VANILLA-PHOENIX-FOUNDATION**; deferred to a
later release than vanilla's initial ship.)

**Problem.** Today's Phoenix default is `foundation: ash`
(`lower-platform.ts:46`). Once vanilla ships and exception-less A4 is in
place, vanilla is objectively the lower-friction default — no
`Plug.ErrorHandler` rescue tower, direct typed-error mapping, broader contract
coverage (ES + state). But flipping the default in the *same* release that
introduces vanilla risks two things: (a) silent emit-shape change for every
bare-`platform: phoenix` deployable that hasn't been re-validated against
vanilla; (b) regression discovery happening in production before vanilla has
seen real usage.

**Decision.** Vanilla ships **opt-in only initially**. The default stays
`foundation: ash` for at least one minor release after vanilla lands. The flip
is gated on two operational signals:

1. Vanilla has run **at least one minor-release cycle with green CI** —
   `phoenix-vanilla-build.yml` (`mix compile --warnings-as-errors`) and the
   strict-parity matrix entry pass cleanly without ongoing-fix churn.
2. **No obs-e2e regressions** observed on `phoenix-obs-e2e.yml` (vanilla
   variant) for the same cycle.

When both signals are clear, flip in two steps:

1. **Warn-then-flip release.** Emit a `loom.foundation-default-flipping`
   warning on every bare `platform: phoenix` (no explicit `foundation:`)
   for one release cycle, telling the user to set explicit `ash` if they
   want to stay on the current behaviour.
2. **Flip release.** Change `lower-platform.ts:46`'s default from `ash` to
   `vanilla`. Users who didn't act on the warning get vanilla emit; the
   one-line escape hatch (`foundation: ash`) remains supported and
   first-class.

Rationale: zero-surprise migration; opt-in window gives real users time to
validate vanilla before it becomes the default emission; the warning cycle
makes the change visible without breaking anyone's build.

**Affects.** `src/ir/lower/lower-platform.ts:46` (default flip, gated on
release sequencing); `src/language/validators/data/platform-rules.ts`
(`loom.foundation-default-flipping` warning during the warn cycle); release
notes for the two flip-related releases. **Depends on
D-VANILLA-PHOENIX-FOUNDATION**.

---

## D-NODE-PLATFORM — `node` is the JS-runtime platform; `hono` is a `transport:` value

**Status:** PINNED — **amended by D-ELIXIR-PLATFORM** (this decision's body
asserts *"`dotnet`/`phoenix` name the language-ecosystem"* — a rationalisation,
since `phoenix` is a web framework, not a language-ecosystem; the actual
ecosystem is **Elixir**. D-ELIXIR-PLATFORM completes the rename pattern by
making `elixir` the canonical language-ecosystem platform and `phoenix` a
back-compat alias. The framing in the original problem statement should now
be read as *"`dotnet`/`elixir` name the language-ecosystem"*.) (Mirrors
**D-PHOENIX-SURFACE**'s rename pattern; depends on **D-REALIZATION-AXES** for
the `transport:` axis. Rollout in `proposals/realization-axes-rollout.md`
Phase 3.)

**Amendment (alias retired).** The `hono` → `node` back-compat alias described
below has since been **removed** — `node` is now the only spelling. The
`hono` keyword is gone from the grammar `Platform` rule, `LEGACY_PLATFORM_ALIASES`
(`src/platform/metadata.ts`) and `canonicalPlatform` (`src/ir/lower/lower-platform.ts`)
no longer map it, and `platform: hono` / `platform: "hono@v4"` now fail validation
as unknown platforms. All in-tree sources, fixtures and docs were migrated to
`platform: node`. The Hono web framework keeps its name only as the `transport:`
value on `platform: node` (and as the `src/platform/hono/` / `@loom/backend-hono-v4`
package directory). The historical body below is preserved as the original
rationale for the rename.

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

## D-ELIXIR-PLATFORM — `elixir` is the canonical language-ecosystem platform; `phoenix` is a back-compat alias

**Status:** PINNED. (Mirrors **D-NODE-PLATFORM**'s rename pattern; amends
**D-PHOENIX-SURFACE**'s platform-name choice; depends on **D-REALIZATION-AXES**
for the `transport:` axis. Spec in `proposals/elixir-platform-rename.md`.)

**Amendment (alias retired).** The `phoenix` / `phoenixLiveView` → `elixir`
back-compat platform aliases described below have since been **removed** —
`elixir` is now the only spelling, exactly mirroring the retired `hono` →
`node` alias (D-NODE-PLATFORM). The `phoenix` and `phoenixLiveView` keywords
are gone from the grammar `Platform` rule, `LEGACY_PLATFORM_ALIASES`
(`src/platform/metadata.ts`) and `canonicalPlatform`
(`src/ir/lower/lower-platform.ts`) no longer map them, and `platform: phoenix`
/ `platform: "phoenixLiveView"` now fail validation as unknown platforms. All
in-tree sources, fixtures and tests were migrated to `platform: elixir`. The
Phoenix web framework keeps its name only as the `transport: phoenix` value
(D-PHOENIX-TRANSPORT) and the `phoenixLiveView` **framework** value (with its
`liveview` alias, D-PHOENIX-SURFACE — *not* retired); the `ashPhoenix` design
pack and the generated-project code likewise keep the framework name. The
historical body below is preserved as the original rationale for the rename.

**Problem.** D-NODE-PLATFORM (the later decision) renamed `platform: hono` →
`platform: node` on the principle that *platform names the language-ecosystem,
transport names the web framework*. Its own text justifies itself by asserting
*"`dotnet`/`phoenix` name the language-ecosystem"* (decisions.md:1072) — a
rationalisation, since `phoenix` is a web framework, not a language-ecosystem.
The actual ecosystem is **Elixir**.

The result was visible repetition: `platform: phoenix, transport: phoenixRouter`
reads as "Phoenix Phoenix" — two restatements of the same framework. And the
generator scaffolding around the platform name (`src/generator/phoenix-live-view/`
the directory, `src/platform/phoenix-live-view.ts` the module, `phoenix-build.yml`
the CI workflow) carried the legacy `phoenixLiveView`-era spelling that
D-PHOENIX-SURFACE retired at the *platform name* level but never followed
through at the *scaffolding* level.

**Decision.**

- **`elixir` is the canonical language-ecosystem platform**. The platform
  surface that emits the fullstack Elixir/Ash + Phoenix LiveView project
  registers under `elixir` in `src/platform/registry.ts`.
- **`phoenix` and `phoenixLiveView` are back-compat aliases** that desugar to
  `elixir` at the lowering boundary (`canonicalPlatform` /
  `LEGACY_PLATFORM_ALIASES`), preserving any `@version` pin
  (`phoenix@v1` → `elixir@v1`; `phoenixLiveView@v1` → `elixir@v1`). Every
  existing `.ddd` source continues to parse, validate, lower, and emit
  byte-identical output. Identical mechanism to `hono` → `node`
  (D-NODE-PLATFORM).
- **`language` is a derived surface property** (`elixir` for `elixir`,
  `typescript` for `node`/`react`, `csharp` for `dotnet`), consumed by the
  Phase-F shared-contracts grouping — *not* a platform-name prefix. Matches
  D-NODE-PLATFORM's framing now that `phoenix` is no longer the platform.

**Affects.** `src/platform/registry.ts` (register under `elixir`; add `phoenix`
and `phoenixLiveView` to `LEGACY_PLATFORM_ALIASES`); the `Platform` IR union
(`"phoenix"` → `"elixir"`); grammar `Platform` rule (add `elixir` keyword);
`src/ir/lower/lower-platform.ts` (`canonicalPlatform` adds the `phoenix`
arm); every `family === "phoenix"` check across the toolchain (renamed to
`"elixir"`); CLI `--platform` (canonical `elixir`, `phoenix` accepted as
alias); the seven affected decisions get an amend-by-this-one note.
**Mirrors D-NODE-PLATFORM**; **amends D-PHOENIX-SURFACE**.

---

## D-PHOENIX-TRANSPORT — Phoenix is the `transport:` value on `platform: elixir`; `phoenixRouter` is a back-compat alias

**Status:** PINNED. (Depends on **D-ELIXIR-PLATFORM** and **D-REALIZATION-AXES**;
spec in `proposals/elixir-platform-rename.md`.)

**Amendment (alias retired).** The `phoenixRouter` → `phoenix` back-compat
transport alias described below has since been **removed** — `phoenix` is the
only `transport:` value now. The `canonicalTransport` desugar helper (which was
already dead code — nothing called it) is gone, and `transport: phoenixRouter`
no longer resolves to any adapter (it fails the realization-axes menu check
like any unknown transport). Mirrors the retired platform aliases
(`hono`/`phoenix`/`fastapi`) and the `liveview` framework alias.

**Problem.** The transport value `phoenixRouter` carried a redundant `Router`
suffix that named no real distinction (Phoenix has one router; there's no
"Phoenix-but-not-the-router" alternative). Under `foundation: ash` the
transport axis is owned (`FOUNDATION_OWNED_AXES.ash = ["application",
"transport"]`), so users never even wrote it. It existed only as a default
value in the IR — repeating the framework name with no information added.

**Decision.**

- **`phoenix` is the canonical `transport:` value** on `platform: elixir`
  (D-ELIXIR-PLATFORM). Names the Phoenix web framework, parallel to how
  `transport: hono` names the Hono web framework on `platform: node`.
- **`phoenixRouter` is a back-compat alias** that desugars to `phoenix` at
  the lowering boundary (`canonicalTransport` in
  `src/ir/lower/lower-platform.ts`). Every existing source with explicit
  `transport: phoenixRouter` keeps working unchanged.
- **Future Elixir web frameworks** (a Plug-only minimal API, hypothetical
  alternatives) slot into `transport:` as siblings; the menu grows from
  size-1 to size-N without a platform-level change.

**Affects.** `src/ir/lower/lower-platform.ts` (new `canonicalTransport` +
`greenfieldMenu` returns `"phoenix"` for `elixir`); `src/language/validators/data/platform-rules.ts`
(transport menu update); test expectations across the lowering / axes test
files; `proposals/elixir-platform-rename.md`. **Depends on
D-ELIXIR-PLATFORM**.

---

## D-PHOENIX-DIR — generator directory + platform module + CI workflow renames

**Status:** PINNED. (Mechanical completion of the D-ELIXIR-PLATFORM rename;
spec in `proposals/elixir-platform-rename.md`.)

**Problem.** When D-PHOENIX-SURFACE renamed `platform: phoenixLiveView` →
`platform: phoenix`, the legacy directory `src/generator/phoenix-live-view/`,
the platform module `src/platform/phoenix-live-view.ts`, and the CI workflows
`phoenix-*.yml` were not renamed alongside. After D-ELIXIR-PLATFORM the
debt compounds: the LiveView part of the name is no longer accurate (the
emitter outputs the whole Phoenix project — API controllers, OpenAPI,
shell scaffolding — most of which has nothing to do with LiveView), and
the `phoenix` part needs to align with the new `elixir` platform name.

**Decision.** Three coordinated renames, no back-compat alias at the
directory / module / workflow level (callers reach these through the
registered platform surface and the CI matrix, not directly):

| Today | After |
|---|---|
| `src/generator/phoenix-live-view/` | `src/generator/elixir/` |
| `src/platform/phoenix-live-view.ts` | `src/platform/elixir.ts` |
| `generatePhoenixLiveViewProject` | `generateElixirProject` |
| `GeneratePhoenixLiveViewArgs` | `GenerateElixirArgs` |
| `phoenixPlatform` (registry alias) | `elixirPlatform` |
| `.github/workflows/phoenix-build.yml` | `.github/workflows/elixir-ash-build.yml` |
| `.github/workflows/phoenix-dialyzer.yml` | `.github/workflows/elixir-ash-dialyzer.yml` |
| `.github/workflows/phoenix-obs-e2e.yml` | `.github/workflows/elixir-ash-obs-e2e.yml` |

The CI rename uses the `elixir-ash-` prefix (foundation in the name) so a
future `elixir-vanilla-build.yml` pairs cleanly when P2 of
`vanilla-phoenix-foundation.md` ships.

**Affects.** ~80 import paths across `src/` and `test/` (mechanical `sed`,
TypeScript imports resolve through the rename); workflow display names
updated alongside (`Phoenix LiveView build verification` → `Elixir / Ash
build verification`, etc.). The `ashPhoenix` design pack name is **not**
renamed in this pass — its foundation-aware rework belongs to P2 of
`vanilla-phoenix-foundation.md`. **Depends on D-ELIXIR-PLATFORM**.

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

---

## D-AUTH-OIDC — turnkey auth delegates to OIDC; Loom does not build an auth runtime

**Status:** PINNED.

**Problem.** `quickstart-and-day-one-batteries.md` §4 ("turnkey auth") sketched
a self-built auth runtime: an `auth { providers: [email, google, github] }`
block that makes Loom generate an `AuthUser` aggregate with **hashed
passwords**, signup/login/verify-email endpoints, OAuth clients, session
issuance, and login/signup UI — across Hono, .NET, **and** Phoenix, × four
design packs. That is a large, security-critical, perpetually-maintained
surface for a code generator to own.

**Decision.** Turnkey auth **delegates to an OIDC identity provider**.
**Keycloak** is the self-hostable default; Auth0 / Cognito / Zitadel / Ory /
Entra ID are the same thing to Loom — an `issuer` URL. "Don't roll your own
auth": Loom **validates tokens and maps claims into the existing typed
`user {}` shape**; the IdP owns credential storage, password reset, MFA,
lockout, and the hosted login/signup pages. Loom generates **no `AuthUser`
aggregate, no password column, no OAuth client code** — only an OIDC verifier
(the batteries-included fill-in for the already-shipped
`IUserVerifier` / `registerUserVerifier` seam), the `/auth/login|callback|logout`
redirect handshake, session issuance, and a route guard.

**Rationale.**

- "Don't roll your own auth" is the strongest security guidance in the field;
  passwords/MFA/reset/lockout are deep and ruinous to get wrong.
- OIDC is the universal protocol — every IdP plugs in uniformly behind one
  `issuer`. Loom's per-backend work shrinks to "validate a token" (mature libs
  everywhere: `jose`, `Microsoft.Identity`, `oidcc`/`Ueberauth`) + a redirect.
- It **completes** what `auth.md` already ships (typed `user {}`,
  `currentUser`, `requires`, `auth: required` middleware, the verifier hook)
  rather than adding a new runtime. OIDC is just the batteries-included
  verifier.
- The multi-backend × multi-pack cost of a hand-built password/session/login-UI
  runtime is a maintenance + security liability where any divergence is a
  vulnerability.

**Zero-config quick-start.** The one cost of self-hosted OIDC — standing up an
IdP — is closed by **bundling a dev IdP**: the generated `docker-compose.yml`
adds a Keycloak service with a pre-provisioned realm + a **seeded demo user**
(seeding feature, `database-seeding.md` §5.4), so `docker compose up` logs in
out of the box; production repoints `issuer:` at a real IdP. The on-ramp owns
zero auth logic.

**Consequences.** The `auth {}` surface is reframed from
`providers: [email, google, github]` to `auth { oidc { issuer, clientId, … } }`
+ a `claims:` map. A self-contained email/password mode, if ever wanted, is a
**secondary, library-backed** option — never hand-rolled across backends, and
not the headline. Default-deny enforcement (`enforcement: denyByDefault`) is
unaffected.

**Affects.** `quickstart-and-day-one-batteries.md` §1 (battery list), §3.1
(`saas` template), §4 (entire turnkey-auth section), §7 (build order);
`auth.md` (the verifier-hook seam is OIDC's mount point — no rewrite, just the
completion it always anticipated).

---

## D-AI-EMPHASIS — Loom leads as a platform (mass-market land + regulated expand), IR-embedding deferred

**Status:** PINNED.

**Problem.** [`ai-generation-platform.md`](./proposals/ai-generation-platform.md)
§4.4/§7 leaves the platform-vs-IR emphasis open. Three coherent paths
were on the table:

- **A — IR-first.** Ship `@loom/core` as the deterministic, multi-stack,
  auditable engine that *other* AI builders embed (B2B2C). Lowest risk,
  plays to the compiler strength, dodges consumer-AI UX — but has no
  direct customer, leans on integrators with weak incentive to adopt a
  DDD compiler that constrains their breadth, and cannot monetise the
  niche that actually values the differentiation.
- **B — Mass-market platform.** Loom's own end-to-end AI generation
  platform competing for the broad "describe an app" market.
- **C — Vertical platform.** The same platform aimed at the regulated /
  domain-heavy / engineering-led niche (fintech, healthtech, govtech),
  where determinism + ownership + multi-stack + governance are
  non-negotiable and the consumer-grade incumbents cannot follow.

**Decision: B + C.** Loom leads as a **first-party platform across both
motions** — a land-and-expand:

- **B is the funnel.** A free/low tier for the broad market is the
  distribution and brand engine. It is winnable *not* on UX polish alone
  but on the genuine differentiators: model-as-memory (no context rot as
  the app grows), determinism (maintainable/upgradable output), multi-stack,
  and code ownership. The pitch is "AI apps that don't collapse at scale and
  that you own," not "a prettier Bolt."
- **C is the revenue.** The regulated/engineering niche is where pricing
  power lives — governance/conformance/provenance reporting, private
  backends, hosted `verify`, SLA'd determinism. B lands these users; C
  expands them.
- **A is deferred, not dropped.** IR-embedding (`@loom/core` as an engine
  other builders license) is a later **channel/partnership** play, reachable
  *from* a proven platform; the reverse climb (embedded engine → owns the
  customer) is much harder.

**Rationale.**

- The emphasis question is **GTM and narrative, not architecture.** Platform
  and IR run the *same* validate→repair→verify loop over the same model
  patches ([`ai-authoring-loop.md`](./proposals/ai-authoring-loop.md)); the
  wedge demo advances all paths. So committing to B+C costs nothing
  technically and keeps A open.
- Owning the customer (B+C) is the only path that monetises Loom's defensible
  whitespace directly; A buries the differentiation three layers down someone
  else's stack.
- B funds C: the mass-market top-of-funnel supplies the distribution that a
  pure-niche motion lacks, while C supplies the margin a pure-mass motion
  lacks.

**Consequences / honest caveats.** B+C is the **highest-prize and
highest-cost** path, and it leans hardest on Loom's weakest muscle — consumer
AI UX and the capital/team to compete on it. It is justified only if (a) the
on-ramp can be made cheap (grammar-constrained `.ddd` authoring + the
context-pack, `ai-authoring-loop.md` §5) so the engine carries the UX, and
(b) the build sequences the **wedge demo first** (prove the loop end-to-end in
the browser playground) before any mass-market growth spend. If funding/team
for B does not materialise, fall back to **C-only** (vertical-first) rather
than A — keep the direct customer.

**Affects.** `ai-generation-platform.md` §4.4 (reframe the "two strategies,
sequence them" block from IR-first to B+C platform-first with A deferred) and
§7 (resolve the platform-vs-IR open question, citing this tag).

---

## D-API-TOOLKIT — one transport-neutral toolkit core, thin adapters per surface

**Status:** PINNED.

**Problem.** Loom's structured operations (`validate`, `generate`, `patch`,
plus `outline` and the diagnostics/fixHint serializers) were being grown inside
`src/cli/` (`json-report.ts`, `runParseJson`), which is Node-bound. But the
**same operations** are needed by at least four surfaces — the CLI, an MCP
server (agents), the LSP (Monaco/VS Code), and the in-browser playground — and
re-implementing them per surface is exactly the drift the structured contract
exists to prevent. The patch/diagnostic format is also ours
([`ai-diagnostics-contract.md`](./proposals/ai-diagnostics-contract.md)), not an
editor/agent standard, so it needs *one* authoritative implementation plus thin
adapters at the boundaries.

**Decision.** A single **transport-neutral toolkit at `src/api/`** is the
shared core; every surface is a thin adapter over it.

| Layer | Home | Role |
|---|---|---|
| **Toolkit core** | `src/api/` | `validate(source)→ValidateReport`, `generate(source)→GenerateReport`, `applyPatches(source,patches)→PatchResult`; pure, in-memory, **browser-safe** (parses on `EmptyFileSystem`, no `langium/node`). `src/api/report.ts` holds the diagnostic/outline serializers. |
| **CLI** | `src/cli/` | argv + stdout/exit only; calls the toolkit. |
| **MCP server** | (future) | tool handlers calling the toolkit — the recognized way agents call tools. |
| **LSP adapters** | `src/language/lsp/` | `ModelPatch → WorkspaceEdit/TextEdit`, `fixHint → CodeAction`, `JsonDiagnostic → Diagnostic`. |
| **Web playground** | `web/` | imports the toolkit directly (`../src/api`). |

**Consequences.**
- The CLI shrank to thin wrappers (`runParseJson`/`runGenerateJson` are a few
  lines each); the fat report-building moved out of `src/cli/`.
- `applyPatches` switched `NodeFileSystem` → `EmptyFileSystem`, restoring the
  "`src/language/` is browser-safe" invariant (CLAUDE.md).
- The **node-addressed `ModelPatch` stays the loop-native format** (it survives
  re-printing and joins to diagnostics/outline); LSP/MCP are adapters at the
  edge, so the system is "recognizable by everything" without compromising the
  core.
- A new operation (e.g. `rename`, `verify`) is added **once** in the toolkit and
  every surface inherits it.
- `src/api/` sits above `language`/`ir`/`generator`/`system` (an
  orchestration/entrypoint layer, like `cli`); it is not scanned by the
  pipeline-layering invariant and creates no back-edge.

**Affects.** `ai-diagnostics-contract.md` (`--json` scope note now points at the
toolkit, not the CLI); `ai-authoring-loop.md` §3 (the tool surface is the
toolkit + an MCP transport); future MCP-server and LSP-adapter slices build on
this seam.

---

## D-AGENT-TOOLS — one tool catalog over the toolkit; MCP and in-browser are transports

**Status:** PINNED.

**Problem.** Loom's operations need to be **agent-callable tools**. Two surfaces
want them: external agent hosts (Claude Desktop, IDE agents, CI) via **MCP**, and
the in-browser **playground** agentic chat. An MCP stdio server runs as a Node
subprocess and cannot run in a browser; hand-coding the tool schemas separately
for each surface would let them drift — the same mistake
[D-API-TOOLKIT](#d-api-toolkit--one-transport-neutral-toolkit-core-thin-adapters-per-surface)
fixed one layer down.

**Decision.** A single **transport-neutral tool catalog at `src/tools/`** over
the `src/api/` toolkit is the source of truth; every transport is a thin adapter.

| Layer | Home | Role |
|---|---|---|
| **Tool catalog** | `src/tools/` | `{ name, description, inputSchema (JSON Schema), handler(args)→toolkit }` per tool. Browser-safe (imports only `src/api/` + contract types; **no MCP dependency**). |
| **MCP stdio server** | `packages/ddd-mcp/` | Node entrypoint registering the catalog; for external hosts (`npx ddd-mcp`). |
| **Playground chat** | `web/` | imports the same catalog; dispatches the LLM's `tool_use` calls **directly** to `handler(args)` in-browser. (Optional in-memory MCP for byte-identical parity.) |

**Tools are pure and stateless.** Each tool is a function of its inputs (model
`source` in → report/new-source out); **no server-side model state, no
filesystem side effect.** The host owns the working model and threads it through.
This makes the server safe by default (read-only/functional — no consent
prompts), keeps the browser transport trivial, and inherits the toolkit's
determinism + browser-safety. File emission stays in the CLI, never in a tool.

**Two verb families, one catalog.** (a) **Generative** (the v1 authoring loop,
pure functions of `source`): `loom_validate` `{source}→ValidateReport`,
`loom_apply_patch` `{source,patches}→PatchResult`, `loom_generate`
`{source}→GenerateReport`, `loom_outline` `{source}→Outline`. (b)
**Navigational** (query/refactor over the LSP providers, by-name dotted-symbol
addressing): `loom_find_symbol` / `loom_references` / `loom_hover` /
`loom_rename` / `loom_quickfix` / `loom_unfold_macro` — **edits returned as an
LSP `WorkspaceEdit`, never applied to disk** (consistent with pure tools).
Folded from the superseded `language-services-and-agent-tools` proposal; the
navigational verbs gate on fixing the LSP providers' real bugs (operation
rename) first. `loom_verify` / `loom_read_model` / `loom_list_primitives` follow
as their toolkit ops land. New diagnostic→fix mappings are
`src/language/fix-hints.ts` providers (one `ModelPatch` → both the LSP
code-action and `loom_quickfix`), not duplicated bespoke verbs.

**Consequences / answers the question that prompted this.**
- The **stdio MCP server is not runnable in the playground browser** — and isn't
  needed there; the playground dispatches tool calls to the in-process catalog.
- Adding playground agentic chat becomes a **UI + LLM-wiring** task reusing the
  catalog — no second tool implementation. The only browser-new concern is LLM
  key/endpoint handling.
- A future **Streamable-HTTP** transport (hosted Loom MCP endpoint) is another
  thin adapter over the same catalog.

**Rejected.** A stateful "session holds the model" MCP server (adds mutable
server state, complicates the browser path, buys nothing a host string can't);
write-capable tools in v1 (kept side-effect-free; `generate-to-disk`, if ever
wanted, is a separate consent-gated tool).

**Affects.** `ai-authoring-loop.md` §3 (the tool surface is the catalog + MCP /
in-browser transports) and §7 item 6; the new `agent-tools-and-mcp.md` is the
detailed spec; the future playground-chat slice builds on this seam.

## D-PHOENIX-FOUNDATION-STRATEGY — vanilla is the home for everything that fights Ash; Ash stays for the CRUD sweet spot, feature-frozen at the boundary, not deprecated

> **Superseded (2026): the Ash foundation was removed.** `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error and `vanilla` is the default and only valid value. The Ash-vs-vanilla reasoning below is historical.

**Status:** PINNED. (Go-forward stance over **D-VANILLA-PHOENIX-FOUNDATION** /
**D-VANILLA-ES-HOME** / **D-VANILLA-DEFAULT**, prompted by a third Ash-fit
deferral.  No new mechanism — a prioritisation + feature-direction policy.)

**Problem.** The friction between Ash's model and Loom's contracts is not a
one-off; it recurs, and each occurrence is paid as a per-feature Phoenix
deferral or an off-Ash workaround:

1. **Pure event sourcing** — no clean fit on `foundation: ash`; deferred to
   vanilla (D-VANILLA-ES-HOME; `proposals/workflow-and-applier.md`).
2. **Workflow saga / correlation state** — kept a plain `Ecto.Schema`
   deliberately *off the Ash action surface*, because the dispatcher mutates
   it imperatively (load-or-allocate / route-or-drop), not via changeset
   actions (`proposals/channels.md`; `dispatch-emit.ts`).
3. **Workflow-instance `view` sources** — shipped on Hono/.NET/React, **deferred
   on Phoenix** for the same reason: the saga is Ecto-not-Ash, so a workflow
   view can't reuse the aggregate `Ash.Query.filter` path, and promoting the
   saga to an Ash resource would drag the imperative write path onto changeset
   actions (`proposals/workflow-instance-views.md`).
4. **Exception-less variant returns** — Phoenix is the odd backend out; the
   `Plug.ErrorHandler` rescue tower that translates `Ash.Error.*` is a
   *designed-in* feature on Ash that fights the cross-backend typed-`or`-union
   dispatch (`proposals/exception-less.md`; D-VANILLA-PHOENIX-FOUNDATION §1).

The common cause is structural and consistent: **`Ash.Resource`'s
changeset-shaped action model + `Ash.DataLayer`'s current-state queryable
contract do not fit Loom's imperative / non-CRUD / event-sourced / typed-error
paths.** Ash remains a *good* fit for what it was built for — declarative CRUD
aggregates, AshPostgres migrations, admin-shaped LiveView forms. The boundary is
the issue, not the framework.

**Decision.**

1. **Feature-direction policy.** New Phoenix domain capabilities that hit the
   Ash action-model boundary — event sourcing, workflow-instance views,
   exception-less returns, future saga / projection / outbox work — target
   **`foundation: vanilla`** as their Phoenix home. `foundation: ash` is
   **feature-frozen at that boundary**: it is fully supported for the CRUD/admin
   sweet spot and gets cheap parity where it falls out naturally, but we do
   **not** grow bespoke Ash workarounds (custom data layers, AshEvents/AshCommanded
   bridges, action-wrapping) to force ill-fitting patterns onto it. This makes
   explicit the de-facto pattern already in the tree (1–4 above).
2. **Vanilla is the next foundation investment.** Building the vanilla emit
   subtree (P2 of `proposals/vanilla-phoenix-foundation.md`) is now the gating
   dependency for *multiple* deferred features, so its cost is paid once instead
   of re-paid as recurring deferrals. Prioritise it ahead of further per-feature
   Phoenix-on-Ash special-casing.
3. **Ash is NOT deprecated now.** Deprecating `foundation: ash` is premature:
   vanilla is unbuilt and unproven, Ash's declarative DX is a real asset for the
   CRUD case, and D-VANILLA-DEFAULT already sequences vanilla-as-default behind a
   stabilisation cycle. The "neither is deprecated" stance of
   D-VANILLA-PHOENIX-FOUNDATION holds.
4. **Sunset is a *later, conditional* decision.** Whether `foundation: ash` is
   eventually deprecated is deferred and **revisited only after** vanilla (a)
   ships, (b) passes the strict cross-backend parity gate, and (c) clears the
   same stabilisation signals D-VANILLA-DEFAULT defines (a green
   `phoenix-vanilla-build.yml` minor-release cycle + no obs-e2e regressions). At
   that review, weigh the cost of maintaining two Phoenix emitters against Ash's
   residual value for the CRUD sweet spot. Do not pre-commit either way here.

**Affects.** No code change. Sequencing/roadmap: elevates
`proposals/vanilla-phoenix-foundation.md` P2 to the next Phoenix work item;
sets the policy the workflow-instance-views Phoenix follow-up and any future
Ash-boundary feature are evaluated against. **Depends on
D-VANILLA-PHOENIX-FOUNDATION**; **informs D-VANILLA-DEFAULT** (its
stabilisation signals double as the sunset-review trigger).

---

## D-SVELTE-FRONTEND — Svelte reuses the shared markup walker; SvelteKit static SPA; runes-native data/forms

**Decision.**  The Svelte frontend (`platform: svelte`) is NOT a fork of the
React generator.  Pages flow through the SAME shared markup walker
(`src/generator/_walker/walker-core.ts`) with a `svelteTarget`
(`WalkerTarget` impl) and svelte-format design packs (`shadcnSvelte`,
`flowbite`) supplying the framework surface.  Three sub-decisions:

1. **App shape: SvelteKit static SPA** (`@sveltejs/adapter-static`,
   `ssr = false`, fallback `index.html`), served with `vite preview` exactly
   like the React SPA.  File-based routing maps the page metamodel's routes
   (`/orders/:id` → `src/routes/(app)/orders/[id]/+page.svelte`); route
   groups `(app)` / `(bare)` carry the layout selectors.  Chosen over a
   Vite + community-router SPA because SvelteKit is the ecosystem's
   maintained routing answer — dependency risk kills generated-code
   products faster than structural asymmetry.
2. **Data layer: `@tanstack/svelte-query` v6** — runes-native
   `createQuery(() => opts)` returns a reactive object with the
   React-Query property surface (`.data` / `.isPending` / `.mutate`), so
   the generated api factories keep the TSX hook NAMES
   (`useAllCustomers`, `useCreateCustomer`, …) and the walker's api seam
   is name-compatible across both frontends.  The zod schema half of
   every api module is emitted byte-identically from the shared
   `src/generator/_frontend/zod-schemas.ts`.
3. **Forms: hand-rolled runes + zod** (`$lib/forms.svelte.ts` —
   `createForm` with `values` / `errors` / `submit` / `applyServerErrors`),
   no third-party form dependency.  Field templates bind
   `form.values.<path>`; RFC 7807 422s decode onto the same per-field
   error map react gets from apply-server-errors.  Operation-form modals
   render as page-scope `{#snippet <op>OpModal(form)}` blocks (one
   component per .svelte file — module scope lands in the template).

**Walker contract.**  The Svelte port added five `WalkerTarget` seams:
the four markup seams (`renderComment`, `renderConditionalChild`,
`renderStyleAttr`, `escapeText`) plus `renderChildrenSlot` and
`formRuntimeImports`.  Svelte 5 shares JSX's `{expr}` interpolation,
`<Comp x={y}/>` invocation and `data-testid={expr}` syntax — those stay
hardcoded in the shared walker; the seams cover exactly where the two
markups diverge.

**Hosting.**  `svelte` joined `STATIC_BUNDLE_FRAMEWORKS`: dotnet
fullstack hosts embed SvelteKit SPAs under `ClientApp/` (the Dockerfile
copies the adapter-static `build/` into wwwroot).  Phoenix is the
deliberate exception — it serves embedded SPAs under the `/app` path
prefix, which a SvelteKit bundle needs `paths.base` threading for; its
surface excludes `svelte` until that lands.  The in-browser playground
preview is likewise deferred (Svelte compiler in the VFS bundler).

See `docs/plans/svelte-frontend-plan.md` for the slice history.
## D-VUE-FRONTEND — reuse the shared walker, Vite+vue-router SPA, hand-rolled forms

`platform: vue` (Phase B of the platform-expansion roadmap;
`docs/plans/vue-frontend-plan.md`) ships as the third frontend with
three locked choices:

1. **Reuse, not fork.**  Vue pages render through the SHARED markup
   walker (`src/generator/_walker/`) with `vueTarget` supplying the
   leaf seams.  Where Vue genuinely diverges from the JSX family the
   CONTRACT grew (renderInterpolation / renderAttrBinding /
   renderMatchChild) rather than the walker forking — every extension
   byte-identical for TSX/HEEx.  The api/views/workflows module
   builders moved to `src/generator/_frontend/` and are shared
   verbatim (TanStack Query's call surface is identical across
   react-query and vue-query; one import-specifier knob).
2. **Plain Vite SPA + vue-router** — `createWebHistory`, explicit
   route table in `src/router.ts`, `<script setup lang="ts">` SFC
   pages, the same two-stage vite-build/vite-preview docker runtime
   as React.  No Nuxt.
3. **Hand-rolled `reactive()`+zod forms** (`src/lib/form.ts` —
   `useLoomForm`): draft values, zod parse on submit, per-field error
   map, ProblemDetails-style server-error application.  No
   third-party form dependency — one validation story across packs.

Packs: `vuetify@v3` (npm-package model, the default) and
`shadcnVue@v1` (source-copy: reka-ui + Tailwind 4 + a components-ui
barrel; pack-declared `imports` tables flow into page scripts).  Vue
packs own the `op-dialog` operation-modal wrapper.  `vue` is a
STATIC_BUNDLE_FRAMEWORK — dotnet/java/phoenix hosts embed a
`framework: vue` ui exactly like a React one.

---

## D-NO-PAGE-ARCHETYPES

**Status:** PINNED.

**Problem.** The page DSL shipped three "archetype" builder-call names —
`List { of: T }`, `Detail { of: T, by: id }`, `MasterDetail { of: T, scope?,
detail? }` — documented (`page-metamodel.md` §4/§9) as the canonical page
bodies and used in examples. They were **inert**: `admissibleInSource: true`
in the walker registry but with **no `tsx`/`heex` renderer and no expander
arm**, so a body of `List { of: Order }` parsed, validated, then dead-ended to
a `// not supported by the React walker yet` comment (and they sat in
`NON_PAGE_BODY_LAYOUT_PRIMITIVES`, excluded as page bodies outright). Meanwhile
the scaffold sentinels `scaffoldList`/`scaffoldDetails` — also
`admissibleInSource` — *are* generative (a phase-⑤c expander arm rewrites them
into the full Breadcrumbs · Toolbar · QueryView · Table tree) and are
themselves hand-writable and embeddable anywhere (the expander recurses into
nested bodies). So the archetypes were duplicate names for the working scaffold
sentinels, minus the wiring.

**Decision.** **Remove `List` / `Detail` / `MasterDetail`** from the language.
The list/detail surface is the `scaffold` macro (whole-page generation) plus
the `scaffoldList` / `scaffoldDetails` body sentinels (hand-writable, for
embedding a list/detail in a custom page). No capability is lost — the
embeddable case the archetypes were imagined for is already served by writing
`scaffoldList { of: T }` in a custom page body. `MasterDetail`'s richer
split-pane shape (`scope:` + `detail:` lambda) was never implemented; it is
not reintroduced (compose `scaffoldList` + a `state {}` selection + a detail
component if needed).

**Removed from:** `src/generator/_walker/registry.ts`,
`src/language/walker-stdlib.ts`, `NON_PAGE_BODY_LAYOUT_PRIMITIVES`
(`walker-core.ts`), the web visual-builder model (`web/src/builder/page/`),
and their tests; examples switched to `scaffoldList`/`scaffoldDetails`.

**Supersedes** the `proposals/unfoldable-page-scaffolding.md` direction (which
explored *implementing* the archetypes as emitted components) for the
archetype question specifically. The residual idea in that proposal — that the
phase-⑤c scaffold expansion is opaque "magic" that could instead emit
unfoldable, named components — remains an OPEN, separate consideration for the
`scaffoldList`/`scaffoldDetails` sentinels themselves; it is not blocked by
this removal.

**Superseded (2026-06-19).** The `scaffold*` page-body sentinels
(`scaffoldList` / `scaffoldDetails` / `scaffoldNewForm` / `scaffoldOperations`
/ `scaffoldWorkflowForm` / `scaffoldViewList` / `scaffoldInstanceList` /
`scaffoldInstanceDetails`) — together with their phase-⑤c expander
(`src/ir/lower/walker-primitive-expander.ts`) — have now been **removed
entirely**: they were "scaffolds that aren't scaffolds" — opaque,
permanently-in-source indirections with no `unfold`. The only scaffold surface
is the `with scaffold(...)` **page macro**, which emits full unfoldable AST
trees (`src/macros/stdlib/scaffold/_body-builders.ts`). The sentinels are no
longer `admissibleInSource` — a hand-written `body: scaffoldList { of: X }`
now fails validation with "Unknown builder type". Embedding a list/detail in a
custom page therefore means writing the body explicitly (the example
`web/src/examples/extern-showcase.ddd` shows the inlined list tree).

**Update (2026-06-20).** The three **singleton index-page sentinels** (`Home` /
`WorkflowsIndex` / `ViewsIndex`) — the last holdouts — are gone too. They are
now ordinary scaffold macros (`scaffoldHome` / `scaffoldWorkflowsIndex` /
`scaffoldViewsIndex` in `_body-builders.ts`) emitting full bodies from the
gathered inventory; the `expandInlineScaffoldPrimitives` expander, the ⑤c pass,
the `Home`/`WorkflowsIndex`/`ViewsIndex` registry primitives, and the page
`origin`/`source` fields are all removed. `walker-primitive-expander.ts` is now
just `buildExpandContext`. A page's kind is derived on demand from its
role-scoped name + area via `classifyPage` (`src/ir/util/page-kind.ts`).

---

## D-TENANCY-SCOPE — the per-aggregate tenancy axis is two values

**Status:** PINNED.

**Problem.** Earlier drafts of `multi-tenancy-design-note.md` had a three-value
scope axis — `tenantOwned` / `crossTenant` / `platform` — where `platform` meant
"admin-only cross-tenant data" (audit trails, projections), distinct from open
reference data.

**Decision.** The per-aggregate tenancy axis has **two** values: tenant-owned
(the `tenantOwned` capability) and `crossTenant` (unscoped). There is **no
`platform` scope.** *Who may read* is an authorization concern, not a tenancy
scope, so admin-only cross-tenant data is `crossTenant` + an authorization
default-deny policy. Once depth moved to per-role authz access levels
(D-TENANCY-HIERARCHY) and the registry to a capability (D-TENANCY-REGISTRY),
`platform` had no scope meaning left. Safety note: `crossTenant` is fail-open at
the tenancy layer; sensitive cross-tenant data relies on the authz default-deny
gate.

**Affects.** `multi-tenancy-design-note.md` R2 (canonical); `authorization.md`
§0/§2 (no longer lists `platform`).

---

## D-TENANCY-REGISTRY — registry named in `tenancy by … of X` + a `tenantRegistry` capability

**Status:** PINNED.

**Problem.** The tenant registry (the `Organization`/`Tenant` aggregate) can't be
plain tenant-scoped (it is created before its own tenant context exists, and is
self-keyed with no `TenantId` column) nor `crossTenant` (that would leak every
org). An early draft made it a `platform` aggregate mode.

**Decision.** The registry is a **system-level fact** named in `tenancy by
user.tenantId of Organization`. It carries an explicit, unfoldable **`implements
"tenantRegistry"` capability** that **provides** an immutable self-referential
`parent: Self id?` + a managed `dataKey` path + the path-stamp — fields come from
the local capability, never injected by the distant `tenancy by` line
(verify-don't-inject). Loom **verifies** cardinality (exactly one
`tenantRegistry`) + the `of …` cross-link + that the claim field exists — **not**
field-conformance (the capability provides the fields by construction).
**Reparent is out of scope** (immutable `parent` ⇒ permanent paths; rare org
moves are an offline migration).

**Affects.** `multi-tenancy-design-note.md` R1/R5; `typed-capabilities.md` (the
`tenantRegistry` worked case).

---

## D-TENANCY-DEFAULT — no silent default; an explicit-stance lint

**Status:** PINNED (lint **severity** OPEN — recommended `error`).

**Problem.** A fail-closed *silent* default ("unmarked ⇒ `tenantOwned`") would
have Loom implicitly attach the `tenantOwned` capability, injecting
`tenantId`/`dataKey` — the distant-injection magic the capability model forbids.

**Decision.** **No silent default.** An unmarked aggregate under a `tenancy by`
system is **unscoped**; a **lint** flags it and suggests the explicit marker
(`with tenantOwned` or `crossTenant`). Fields only ever come from an explicit,
unfoldable capability. The lint's **severity is the fail-open/fail-closed knob**:
**error** (recommended — the common case is tenant data, so the unmarked fallback
is the dangerous one) gives fail-closed without magic; **warning** is fail-open.
Severity is the one OPEN sub-decision.

**Affects.** `multi-tenancy-design-note.md` R3 (supersedes original decision #2's
silent-default *mechanism*; the fail-closed *goal* survives via the lint).

---

## D-TENANCY-HIERARCHY — always hierarchy-ready; depth is a per-role authz access level

**Status:** PINNED.

**Problem.** Hierarchical (parent/child org) visibility could be a
flat-vs-hierarchical *mode*, a per-aggregate `subtenantScoped` flavor, or a
per-role access level. An entity-flavor can't express "Manager sees `Project`
deep but `Invoice` local."

**Decision.** **Always hierarchy-ready — no mode switch.** "Flat" is the
degenerate case (every org a root, every read `local`). `tenantId` + a
denormalised `dataKey` (the owning org's materialized path) are stamped on every
`tenantOwned` aggregate **from the token** at create (immutable `parent` ⇒
permanent paths ⇒ `orgPath` can ride the token), so enabling `deep` later is
**migration-free**. **Depth is a per-role authorization access level**, not an
aggregate marker — `authorization.md`'s directional `Self`/`Descendants`/`All`
(Dynamics' `local`/`deep`/`global` is the same ladder, a mnemonic). `deep` is a
**direct indexed prefix scan** on the row's `dataKey` (no join). Grounded in
Dynamics (Business Unit + Basic/Local/Deep/Global) and Salesforce (Role
Hierarchy). **Assumption to verify:** token-carried `orgPath` is a *derived
session value*, not an IdP claim (D-AUTH-OIDC), so the pure-claim-copy stamp is
contingent on session enrichment, else a per-request cached registry lookup.

**Affects.** `multi-tenancy-design-note.md` R5; `authorization.md` §2 (`DataKey`
= the hierarchical extension; directional predicates = the access levels).

---

## D-TYPED-CAPABILITIES — capabilities are first-class pure-mixin declarations

**Status:** PINNED (proposal pending scheduling).

**Problem.** Loom's capability surface (`implements "X"` / `filter for "X"` /
`stamp for "X"`) is the one stringly-typed corner — no resolution, no contract,
and a muddy capability-vs-macro line (capabilities are *implemented as* macros
today).

**Decision.** Promote capabilities to a first-class **`capability { fields +
filter + stamp }`** declaration with **typed references** (`implements X` /
`with X`). It is a **pure mixin** — everything in the body is *provided*; **no**
`requires`/`provides`/`expects` keywords and **no** field-conformance (every
capability provides what its own behavior uses; the rare "operate on a host
field" case is *parameterization*, not a contract). Provision is local +
unfoldable (not magic); provided members are non-overridable by default. Lowers
to the existing per-aggregate `contextFilters`/`contextStamps` IR ⇒
**byte-identical migration**. Subsumes the `audit`/`softDelete` field+filter+stamp
macros; `crudish`/`scaffold*` stay macros (operations/structure). Open: emission
deduplication when a capability is reused (`typed-capabilities.md` OQ#1).

**Affects.** `typed-capabilities.md` (canonical); `../capabilities.md` (evolves
its mechanism); `multi-tenancy-design-note.md` (`tenantOwned`/`tenantRegistry`
are capabilities).

---

## D-INDEX-INFRA — manual performance indexes live on the storage binding, not the aggregate

**Status:** PINNED.

**Problem.** Domain uniqueness is a `unique (...)` invariant on the aggregate, but
a plain **performance** index (speed up a frequent filter) has no domain meaning —
putting it on the aggregate conflates infrastructure with the model.

**Decision.** A performance index is declared on the `resource` binding via
`index: [Entity.col, Entity.(a, b)]` (grammar `IndexSpec`). It is **pure
infrastructure** and always **non-unique** (uniqueness stays the domain
invariant). The target entity is named **explicitly** (`Project.name`), never
inferred from which table owns the column — the binding knows the context's shape,
and the entity may be an aggregate *or* a contained part. Lowers to `manualIndexes`
in the IR and lands as `CREATE INDEX` in the derived migration.

**Affects.** `uniqueness-and-indexes.md` §3.2 (canonical); `../resources.md`
(surface); `../migrations.md`.

---

## D-INDEX-SUGGEST — index suggestions are an advisory lint, not an auto-emitted index

**Status:** PINNED.

**Problem.** Loom can see which columns get filtered frequently (find predicates,
FK-shaped reads), so it *could* auto-create covering indexes. But silently
emitting indexes hides a cost (write amplification, storage) the author never
chose, and an index is an ops decision.

**Decision.** Loom does **not** auto-emit performance indexes. It emits an
**advisory warning** — `loom.index-suggestion` (`validateIndexSuggestions`,
`src/ir/validate/checks/index-suggestion-checks.ts`) — pointing at a
frequently-filtered column with no covering index, and the author opts in via the
manual `index:` hatch (D-INDEX-INFRA). Advisory, never an error; never changes
emitted schema on its own.

**Affects.** `uniqueness-and-indexes.md` §11 (canonical); `../resources.md`.
