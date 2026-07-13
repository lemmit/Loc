# Production readiness — feature roadmap

> **[2026-06-20 status audit]** Several items shipped (no longer 'no code yet') — §3.8 Kubernetes/Helm (`src/system/kubernetes.ts`, `src/system/helm.ts`, `--k8s`) and §3.9 health/ready probes + observability. Still open: ops/admin UI, §3.7 i18n, §3.10 backend-to-backend calls.

> **Status:** REFERENCE / roadmap proposal — no code yet.
> **Role:** Names the gap between "Loom generates a runnable stack" and
> "Loom generates a system you can run in production," frames each
> missing capability as its own feature (problem → vision → rationale →
> sketch), and pins a prioritised order. Where a capability already has a
> dedicated proposal, this doc points to it rather than restating it; the
> features without a home below are the ones that still need their own
> proposal.
> **Scope:** all backends (.NET/EF, TS/Hono, Phoenix LiveView on plain Ecto/Phoenix) plus the React
> frontend, consistent with the one-directional pipeline and the
> single platform-neutral IR.

---

## 1. The problem in one paragraph

Loom today lowers a `.ddd` source to a runnable multi-project tree: typed
aggregates, REST + OpenAPI, a generated SPA, migrations, docker-compose,
structured logs. That is a complete *scaffold*. It is not yet a complete
*system*. The surface stops at domain CRUD: every list endpoint returns
the whole table, there is no identity story beyond a typed JWT claim
shape, declared infrastructure (`redis`, `kafka`, `elasticsearch`) parses
but emits nothing, the only deployment artefact is a compose file, and
there is no operational surface beyond `/health`. Each of those is a
concrete, mechanical gap — not a research problem — and each lowers
cleanly across the existing backends. This document collects them, gives
each a rationale and a vision, and orders them.

## 2. Design principles (how these features must land)

Every feature below is constrained by the architecture, not just bolted
on:

1. **Single IR, parity-gated.** A feature lowers from `LoomModel` to
   *every* domain-logic backend, or degrades explicitly. No
   target-specific IR. The conformance harness (`docs/conformance.md`)
   gates wire/OpenAPI parity; new features extend it rather than slip
   under it.
2. **Source over black box.** Prefer expressing a capability as a macro
   that expands to visible DSL (the `scaffold` / `audit` / `softDelete`
   precedent in `src/macros/stdlib/`) over a generator that emits opaque
   framework code. The user should be able to read what they got.
3. **Fail-safe defaults.** Defaults move toward the safe state: bounded
   responses, deny-by-default authorization, isolation-on. A forgotten
   annotation must not ship an unbounded scan or an open endpoint.
4. **Declared-then-emitted, not declared-then-ignored.** Several storage
   kinds already parse (`docs/old/proposals/storage-and-platform-config.md`).
   Turning a parsed keyword into real emission is higher-leverage and
   lower-risk than inventing new surface, so those rank first.

## 3. The features

The features split into four tiers by *blocking-ness*: Tier 0 is "real
apps don't ship without this," descending to Tier 3 "operate and deploy."

### Tier 0 — Table stakes

#### 3.1 Bounded reads — pagination, sort, filter
- **Gap.** `find all()` and every auto-`findAll` return a complete array
  (`src/generator/react/api-builder.ts`, auto-`findAll` in
  `src/ir/enrich/enrichments.ts`). A list endpoint over a real table is a
  latent outage.
- **Vision.** List/find queries are **paged by default** behind a
  `Paged<T>` envelope (`items`, `page`, `pageSize`, `total`, `hasMore`),
  with a named `unpaged` opt-out for small reference lists, a stable
  default order, and server-side clamps. Generated React hooks fold
  `page`/`pageSize`/filter into the query key so pages cache separately.
- **Rationale.** This is the single most load-bearing gap: it changes
  generated apps from "demo" to "survives production data." It also
  unblocks meaningful sortable tables and is a prerequisite *in spirit*
  for cache invalidation (§3.4).
- **Home.** Fully specified — see
  [`pagination-design-note.md`](./pagination-design-note.md). No new
  proposal needed; this entry exists to pin its priority.

#### 3.2 Deny-by-default authorization
- **Gap.** On an `auth: required` deployable an operation with no
  `requires` gate is still reachable (`docs/auth.md`, slice-2 tail). The
  default is open; it should be closed.
- **Vision.** Authorization is default-deny: an exposed mutation on an
  authenticated deployable must carry an explicit gate (or an explicit
  `public` marker), enforced by a validator diagnostic and a runtime
  default. Hierarchical data scoping and field masking layer on top.
- **Rationale.** This is a *security* gap, not a feature gap — the
  cheapest high-value item in the whole roadmap.
- **Home.** Lives inside
  [`authorization.md`](./authorization.md) (policy model) +
  [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md)
  (isolation default). Pinned here as Tier 0.

### Tier 1 — Integration completeness (parsed → emitted)

These three turn already-parsed storage kinds into real output. They
share one backbone: a typed, pluggable **event-delivery seam**. Domain
events already exist in the IR and drain through a dispatcher that is
a no-op by default (`docs/workflow.md`); the work is making that seam
real, then building on it.

#### 3.3 Asynchronous messaging — outbox + broker delivery
- **Gap.** `storage … { type: kafka }` parses; events emit to a no-op
  dispatcher. There is no at-least-once delivery, no outbox, no consumer
  surface.
- **Vision.** A first-class **transactional outbox**: domain/workflow
  events are persisted in the same transaction that mutates state, then
  relayed to a configured broker by a generated relay. The DSL gains a
  way to declare a **subscription** (an event handler in another context
  or deployable) that lowers to a consumer. Broker bindings are
  per-backend adapters (Kafka first; the seam is broker-neutral).
- **Rationale.** Async integration is the backbone of everything
  event-driven — it is the prerequisite for search projections (§3.5),
  cross-context reactions, and any real microservice topology (§3.10).
  Building it well once pays for all of those.
- **Home.** **Needs its own proposal.** Sketch: an `outbox` data-source
  kind + an `on <Event> { … }` subscription declaration + a
  `MessagingAdapter` contract alongside the persistence adapters.

#### 3.4 Caching & invalidation
- **Gap.** `storage cache { type: redis }` parses; nothing reads or
  writes a cache.
- **Vision.** Opt-in read-through caching on repository reads and views,
  with **prefix-keyed invalidation** driven by the same events as the
  outbox: a mutation publishes an event, the cache layer invalidates the
  affected query-key prefix. On the client, the generated React Query
  keys already form the invalidation prefixes.
- **Rationale.** Caching is the read-side counterpart to messaging and
  reuses its event stream; doing it after §3.3 means it is a consumer of
  an existing mechanism rather than a new one. Pairs naturally with
  bounded reads (§3.1).
- **Home.** **Needs its own proposal** (referenced obliquely from
  [`pagination-design-note.md`](./pagination-design-note.md) §"caching
  feature"). Sketch: a `cached(ttl)` modifier on views/finds + a
  `CacheAdapter` contract + event-driven invalidation rules.

#### 3.5 Search — read-model projections
- **Gap.** `elasticsearch` / `meilisearch` storage kinds parse; no index
  is built, no search endpoint exists.
- **Vision.** A declared **read model / projection** maintained by an
  event subscription (§3.3): the projection denormalises one or more
  aggregates into a search-optimised shape, the relay keeps the index in
  sync, and a generated search endpoint queries it. The projection's
  wire shape flows through the same `wireShape`/OpenAPI machinery as
  everything else.
- **Rationale.** Search is the most visible payoff of the event backbone
  and the natural proving ground for projections — but it strictly
  depends on §3.3, so it sequences last in this tier.
- **Home.** **Needs its own proposal.** Sketch: a `projection <Name>
  of <Agg>… into <searchStorage>` declaration + index-mapping derivation
  from `wireShape` + a `find` surface over the index.

### Tier 2 — Identity & experience

#### 3.6 Account management & identity
- **Gap.** Loom generates the *typed* auth surface — JWT claim shape,
  `currentUser`, gates — but no identity: no login/registration/password
  reset/session, no OIDC integration (`docs/auth.md`).
- **Vision.** An **opt-in identity capability**, delivered the Loom way:
  a `with accountManagement` macro that expands to a `User` aggregate,
  the login/register/reset/account pages (as ordinary `page` DSL through
  the active design pack), and the session/token wiring — all as
  *visible* source the user can then edit. A separate, larger track
  integrates external OIDC providers behind the same `currentUser`
  contract.
- **Rationale.** This is the largest single adoption unlock: today every
  user re-implements identity by hand. Shipping it as a macro keeps it
  inspectable and honours principle #2. It builds directly on
  deny-by-default (§3.2).
- **Home.** **Needs its own proposal**, scoped as an extension of
  [`authorization.md`](./authorization.md) (authorization stays the
  policy layer; this adds the identity/account layer beneath it).

#### 3.7 Internationalization
- **Gap.** No i18n in generated output.
- **Vision.** First-class ICU message catalogs, content-hash keys, named
  `text { }` entries, a `ddd i18n sync` three-way merge, and per-backend
  adapters — plus the string-composition rules (template literals, ICU,
  a concatenation ban in user-visible slots) that make catalogs sound.
- **Rationale.** Self-contained, independent of every other feature here,
  and a hard prerequisite for any non-English deployment. It can proceed
  in parallel with the Tier 1 backbone.
- **Home.** Fully specified — see [`i18n.md`](./i18n.md) and its
  companion [`i18n-strings.md`](./i18n-strings.md). Pinned here for
  ordering only.

### Tier 3 — Operate & deploy

#### 3.8 Deployment manifests beyond compose
- **Gap.** The only deployment artefact is `docker-compose.yml`
  (`src/system/`). Anything beyond a single host is hand-rolled.
- **Vision.** A second deployment-target emitter that sits beside the
  compose builder in `src/system/` and consumes the same composed-system
  model: **Kubernetes manifests** (Deployments, Services, config/secret
  wiring, health probes mapped from the existing `/health`/`/ready`
  endpoints) and an optional Helm chart. Compose stays the default; the
  K8s target is selected, not assumed.
- **Rationale.** Natural extension of an existing capability — the system
  composer already knows every service, port, env var, and dependency
  edge; emitting a second target shape is mechanical. Lower priority than
  app-level features because it is deployment engineering, not domain
  capability.
- **Home.** **Needs its own proposal.** Touches `src/system/` and the
  `PlatformSurface.composeService` contract (generalised to
  "describe-service," consumed by N emitters).

#### 3.9 Operational surface
- **Gap.** Runtime visibility is `/health`, `/ready`, and the structured
  log envelope. There is no generated admin/ops UI: no metrics view, no
  runtime log-level control, no user-administration screen.
- **Vision.** A generated **operational pack** — a small set of admin
  pages (through the design-pack layer) backed by the observability
  envelope (`docs/observability.md`): live health/metrics, request/audit
  trail browse, runtime log-level control, and — once §3.6 lands — basic
  user administration. Opt-in per deployable.
- **Rationale.** The data already exists (the observability catalog and
  `audited` records); this is the missing *surface* over it. Sequences
  after identity (§3.6) so the user-admin screen has a `User` aggregate
  to manage.
- **Home.** **Needs its own proposal**, building on
  [`observability.md`](./observability.md) and
  [`audit-and-logging.md`](./audit-and-logging.md).

#### 3.10 Backend-to-backend service calls
- **Gap.** Multi-deployable composition exists, but a deployable cannot
  *call* another in the DSL — cross-service interaction is undescribed
  (explicitly out of scope in
  [`deployable-networking.md`](./deployable-networking.md)).
- **Vision.** Express a typed inter-service call (sync REST and/or async
  via the §3.3 outbox), with peer URLs and peer auth derived from the
  composed topology, and an emitted gateway/edge for path-prefixed
  multi-backend frontends.
- **Rationale.** This is what turns "several deployables behind one
  compose file" into a genuine distributed system. It is last because it
  depends on both the networking groundwork and the event backbone, and
  because most teams reach for it only after the single-system features
  above are solid.
- **Home.** Extends
  [`deployable-networking.md`](./deployable-networking.md) ("Forward
  compatibility": peer URLs/auth) and
  [`multi-target-proxy.md`](./multi-target-proxy.md) (the gateway/edge
  half). **Needs a consolidating proposal** once those two land.

## 4. Prioritised ordering

```
Now        3.2 deny-by-default        (security; cheapest high-value)
           3.1 bounded reads          (table stakes; independent)        ── parallel
Next       3.3 async messaging        (the event-delivery backbone)
             ├─ 3.4 caching           (consumes the event stream)
             └─ 3.5 search            (consumes the event stream)
Parallel   3.7 i18n                   (self-contained; any time)
Then       3.6 account management     (largest adoption unlock; needs 3.2)
Operate    3.8 k8s/helm emit          (extends the system composer)
           3.9 operational surface    (needs 3.6 for user admin)
Last       3.10 inter-service calls   (needs networking + 3.3)
```

The throughline: **two table-stakes items first; then build the
event-delivery backbone once and let caching, search, and inter-service
all consume it; ship identity and i18n where they unblock the most; treat
deployment and the ops surface as the closing operate-and-deploy tier.**

## 5. Relationship to existing proposals

| Feature | Status of the design | Where it lives |
|---|---|---|
| 3.1 Bounded reads | Specified | [`pagination-design-note.md`](./pagination-design-note.md) |
| 3.2 Deny-by-default | Specified | [`authorization.md`](./authorization.md) + [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) |
| 3.3 Async messaging | **Needs proposal** | — (outbox + subscription + `MessagingAdapter`) |
| 3.4 Caching | **Needs proposal** | obliquely in [`pagination-design-note.md`](./pagination-design-note.md) |
| 3.5 Search projections | **Needs proposal** | — (depends on 3.3) |
| 3.6 Account management | **Needs proposal** | extends [`authorization.md`](./authorization.md) |
| 3.7 i18n | Specified | [`i18n.md`](./i18n.md) + [`i18n-strings.md`](./i18n-strings.md) |
| 3.8 K8s/Helm | **Needs proposal** | — (extends `src/system/`) |
| 3.9 Operational surface | **Needs proposal** | builds on [`observability.md`](./observability.md) + [`audit-and-logging.md`](./audit-and-logging.md) |
| 3.10 Inter-service calls | **Needs proposal** | extends [`deployable-networking.md`](./deployable-networking.md) + [`multi-target-proxy.md`](./multi-target-proxy.md) |

## 6. Open questions

1. **Broker neutrality (§3.3).** How broker-neutral should the first cut
   be? A Kafka-only adapter ships faster; a `MessagingAdapter` contract
   with one implementation costs more up front but mirrors the
   persistence-adapter precedent and avoids a rewrite for the second
   broker.
2. **Macro vs generator for identity (§3.6).** Account management as a
   macro keeps it inspectable but couples it to whatever the `User`
   aggregate looks like; a generator is more opaque but more uniform.
   Principle #2 favours the macro — confirm before committing.
3. **OIDC seam (§3.6).** External-provider integration almost certainly
   wants its own proposal rather than riding inside account management;
   where exactly is the split?
4. **K8s target selection (§3.8).** A new deployment-target keyword vs a
   CLI flag (`ddd generate system … --target k8s`). Lean toward the flag
   to keep the language deployment-agnostic.
5. **Where does the ops surface live (§3.9)?** Folded into an existing
   frontend deployable as an `/admin` route set, or its own deployable?
</content>
</invoke>
