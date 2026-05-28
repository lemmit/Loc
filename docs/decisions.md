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

## Other D-tags — referenced but not yet pinned here

The following tags are introduced in
`proposals/global-implementation-plan.md` §0.1 and
`proposals/implementation-plan.md`. They are recorded here as OPEN
with pointers to their proposal-recommended answers. Promote to
PINNED here when ratified.

| Tag | Concern | Recommended answer (source) |
|---|---|---|
| D-RENAME | Aggregate-inheritance table-layout key naming | `inheritanceStrategy: shareTable \| ownTable` inside `aggregate { … }` (`aggregate-inheritance.md` + storage proposal §12) |
| D-ES-TPH | ES concrete subtype of TPH abstract | Force `inheritanceStrategy: ownTable` (`aggregate-inheritance.md`) |
| D1–D4, D14–D15 | Type-system carrier name / discriminator / postfix vs prefix ML syntax | Per `implementation-plan.md` D-table; locked before P3 |
| D-POLICY-STYLE | Authorization grammar shape | `policy { data { … } operations { … } fields { … } }` reachability over function-style (`authorization.md`) |
| D-LIFECYCLE-VERB | Lifecycle URL style default | `urlStyle: literal \| resource` (`lifecycle-operations.md`) |
| D-I18N-KEY | i18n key stability | Option B — positional hash + named render (`i18n.md`) |
| D-CTX-SHAPE | Ambient `RequestContext` field set | Per `execution-context.md`; see proposed `docs/architecture/request-context.md` |
| D-ENVELOPE | Wire envelope rule | entity \| `Paged<T>` \| ProblemDetails \| event-frame (per global plan §0.4) |
