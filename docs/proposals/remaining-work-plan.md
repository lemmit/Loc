# Remaining work — a clean snapshot

> **Status:** REFERENCE. **Snapshot date: 2026-06-03.**
>
> A deliberately short, single-source list of **what is not yet done** across
> the Loom proposal corpus. The
> [`global-implementation-plan.md`](./global-implementation-plan.md) owns the
> *topological ordering* and the *rationale* (decisions, coordinated single-PR
> moments, parallelisation); [`README.md`](./README.md) owns the *per-proposal
> status table*. This doc is the **carry-over digest** that sits between them —
> regenerate it from the audit whenever a batch of work lands, so "what's left"
> never requires re-reading the whole corpus.
>
> Anything not listed here is either SHIPPED or out of scope. When an item
> lands, delete its bullet (don't annotate it done — that's what the audit
> tables are for).
>
> Many carry-over items are **cross-backend parity gaps** (a feature on Hono but
> not Phoenix, on .NET but not the rest). For the code-verified, per-backend
> snapshot of those, see [`platform-parity-debt.md`](./platform-parity-debt.md)
> and its source audit
> [`../audits/gated-features-inventory.md`](../audits/gated-features-inventory.md).

## Recently closed (so you skip them)

The last refresh closed these — see `global-implementation-plan.md` "Major
landings" for PR-level detail:

- **Pagination (offset)** — `Paged<T>` + paged finds on all four backends.
- **Reified criteria (retrieval *and* find, all four backends)** —
  `Criterion<T>` / `IsSatisfiedBy` / `ToExpression` / Ardalis
  `Specification<T>` bundle on .NET/EF; parameterised SQL on Dapper;
  module-level predicate fn on Hono (retrieval #952, find #963); `:boolean`
  Ash calculation on Phoenix (retrieval #955, find #964).
- **Event-sourcing appliers** — Hono + **.NET/EF** (Phoenix still open).
- **Agent tooling** — `ddd-mcp` stdio server + full navigational family (read +
  rewrite trios) + the transport-neutral agent loop.
- **Phoenix static analysis** — `@spec` emission + Dialyzer CI + format gates.
- **ir/lower + ir/validate decomposition**; **render-expr** unification; the
  .NET/Phoenix emit-monolith splits.
- **Value-object array persistence** (`Money[]` → child tables, all backends).

## Remaining work by family

### Type-system family

> Ordering & milestones (M1/M2/M3) per `implementation-plan.md`. Grammar pins
> D1–D4 + D14–D15 are RATIFIED (`decisions.md`); the rest take their
> recommended answers per phase.

- **payload-transport-layer** — P1 (`payload`/`error` keyword + sugars),
  P2 (`<Agg>Wire` auto-synthesis), P3 (carrier-bounded generics, ML-postfix),
  P4 (named + anonymous `or` unions + exhaustive `match`), P5 (`validate for X`
  / `authorize for X`). *Only the P3b `Paged<T>` slice has shipped.* **M1 = P3+P4
  together.**
- **exception-less** — A1 (`error` payloads + `none`/`option` + two-regime
  line), A2 (`?` propagation), A3 (api `status` clause + ProblemDetails), A4
  (find-variant re-shape + coordinated fixture re-baseline), A5 (parse/extern as
  `or`), A6 (`validate for X` returns `or`), A7a (carrier stdlib helpers).
  Prereq: payload P3+P4. **M2 = A1+A2+A3; M3 = A4 alone.** Folds in
  `partial-update.md` (A1).
- **criterion** deferred tail — `from <Criterion>(args)`, `when <Criterion>` +
  auto-exposed `can-<op>`, built-in `Repo.findAll(criterion, sort?, page?,
  loads?)`, `private workflow`. Prereq: exception-less + payload.
- **reified-criteria** — retrieval *and* find criteria reified on all four
  backends (done). Remaining: anonymous capability `filter` predicates still
  inline; the principal/tenancy factory + `isSatisfiedBy` duality (see the
  proposal's remaining-work register).
- **retrieval** — `Repo.run(...)` emission shipped on all four backends
  (.NET `Run<Name>Async`, Hono `run<Name>`, Phoenix/Ash read action);
  remaining: the `loads:` load-plan.
- **aggregate-inheritance** — I2 (TPH emission), I3 (TPC emission), I4
  (per-concrete override + TPT-via-`contains` docs). I1 surface/IR/validators
  done; independent track.
- **load-specifications** — folded into P3 (`loads` clause + inferred load
  plans + loadedness typing); v1 is explicit `loads` only.

### Storage & platform config

- **storage-and-platform-config** — per-deployable `persistence:` / `style:` /
  `layout:` selection is **SHIPPED** (D-REALIZATION-AXES 5a–5d: .NET
  `efcore`/`dapper`, hono `drizzle`/`mikroorm`, `cqrs` style, `byLayer`/
  `byFeature` layout; backends read `deployable.persistence` directly, with
  `loom.dapper-unsupported` / `loom.mikroorm-unsupported` capability gates in
  `system-checks.ts`). Remaining: per-context `dataSource` bindings
  (D-STORAGE-SPLIT / D-GRANULARITY), the `STORAGE_CAPABILITIES` matrix, the
  reserved `marten` / `layered` stubs, outbox emission + per-deployable
  overrides; per-aggregate `for:` deferred to v2.
- **platform-realization-axes** — phases 1–5d shipped (per-axis style/layout/
  persistence adapters on .NET + hono, with the cross-axis gating matrix +
  validator codes). Remaining: naming review + grammar sketch for the
  still-homeless config axes (actor runtimes, etc.).
- **document-and-json-hierarchies** — Phoenix shape emission + TS `embedded`
  shape (Marten / EF `.ToJson()` paths landed for .NET; TS `relational` +
  `document` landed).
- **resource-model-and-source-types** + **workflow-resource-consumption** —
  the logical-need / configured-binding / technology-descriptor split (object
  stores, queues, external APIs as first-class) and the workflow call surface
  that consumes them.

### Lifecycle, forms & frontend

- **lifecycle-operations** — Phase 2+ (the `urlStyle:` / `routeSlug` slice per
  `lifecycle-url-style.md`), the full action surface, `crudish` reframe to the
  canonical trio, scaffold alignment. Phase 1 IR done.
- **loom-forms** — F1 (`CreateForm`/`OperationForm`/`DestroyForm` primitives
  bound to typed actions), F2 (API-client wiring), F3 (design-pack polish).
  Prereq: lifecycle Phase 1 (done).
- **frontend-acl** — schema restructure (flat-key + `.transform()` +
  `<Action>FormState ≠ <Action>Payload`), per-action FieldMap instances,
  `option`-field rendering (gated on `partial-update`). Phases 1+2 done.
- **extern-component-escape-hatch** — Tier 2 (`action` behaviour params, Loom's
  first function type) + LiveView. Tier 1 (React, slot) done.
- **extern-function-hook-escape-hatch** — `function … extern` (TS) → Phoenix
  `@spec` → React `hook … extern`. The logic twin; staged after the component
  hatch.

### Workflow, event-sourcing & channels

- **workflow-and-applier** — the **Phoenix** event-sourced backend, snapshots,
  projections / read models, the workflow-as-aggregate / `on(...)` handler
  surface. Sagas deferred to v2.
- **channels** — the realtime wire (SSE/WebSocket + two-hop edge relay +
  policy-derived router) and **Part II** (reads / freshness / invalidation-based
  caching). Slice 1 surface→IR done.

### Provenance & governance

> Audit-driven; deltas only. Tier 0 is the backbone — land it first.

- **execution-context** (Tier 0) — compiler-emitted scope frames.
- **audit-and-logging** — promote `audited` boolean to
  `audited(actions | access | events | off)`; `AuditRecord` shape; before/after
  snapshots; .NET Mediator behaviour; access-audit query pipeline.
- **sensitivity-and-compliance** — Phase 2 full (`authorized(<tag>,…)`
  declassification), Phase 3 (`mask:` DTOs + React), Phase 4 (sink-call
  classification). Phases 1 + 2-lite done.
- **multi-tenancy-design-note** → **authorization** phases 1–4 (DataKey infra →
  `policy { data { } }` reachability → operation/view/workflow gates → backend
  parity; wires `policyDecisionId` into Tier 1 audit). Multi-tenancy ships first
  (DataKey leftmost = TenantId). Authorization phases 5–7 (`exists`, field
  rules, `implies`) are the deferred tail.
- **validation-error-extension** — Phoenix `errors[]` on 422 (Hono + .NET done).
- **provenance** — .NET / Phoenix parity (TS/Hono v1 shipped).
- **encrypted-at-rest** — final deferred tail; gated on the storage capability
  matrix.

### i18n & UX

- **i18n-strings** → **i18n** phases 1–7 (ICU catalogs, content-hash keys,
  named `text { }`, `ddd i18n sync` three-way merge, per-backend adapters).
  D-I18N-KEY pinned.
- **pagination** — `unpaged` opt-out + page-aware React hooks (offset paging
  shipped).

### Tooling & static analysis

- **cross-stack-static-analysis** — enable C# nullable-reference annotations
  (the .NET type-metadata arm) + a .NET analyzer gate + repo-content lint.
  Phoenix arm largely done.
- **agent-tools-and-mcp** — LSP-provider correctness (§4c) + the **playground
  agentic chat UI** (the engine — catalog, MCP server, full nav family, and the
  transport-neutral agent loop — has shipped).

### Database seeding

- **database-seeding** — the ship-once `__loom_seed` marker + compose wiring,
  the imperative (workflow-shaped) body, per-row natural-key upsert. Phase 1 +
  all three emitters + CI gates done.

### Deployment & backend-matrix (largely deferred / research)

`kubernetes-helm`, `terraform-iac-target`, `deployable-networking`,
`multi-target-proxy`, `java-backend`, `elixir-ecto-and-api-only-backends`,
`embedded-frontend-composition`, `bounded-context-model`,
`per-package-output-tree`, `platform-directory-layout`. See each doc and the
README "Deployment & infrastructure" / "Backends & code generation" rows for
sequencing; most are gated on the packaging-split or the realization axes.

## Suggested near-term order

A pragmatic next-N, consistent with the global plan's two-agent split:

1. **Lifecycle Phase 2** (`urlStyle`/`routeSlug`) → **loom-forms F1** — unblocks
   typed-action forms and fixes the create-contract layering bug.
   (Per-deployable storage selection — formerly listed here — **shipped** via
   D-REALIZATION-AXES; the storage tail that remains is logical `dataSource`
   bindings + the `STORAGE_CAPABILITIES` matrix + outbox/overrides, not the
   adapter selection itself.)
3. **Payload P1→P4 (M1)** → **exception-less A1–A3 (M2)** → **A4 (M3)** — the
   type-system spine; everything in the criterion/exception tail rides it.
4. **Aggregate inheritance I2/I3** — independent; parallelisable.
5. **Reified-criteria: capability-`filter` reification + principal factory** —
   retrieval *and* find parity is done on all four backends; extend
   reification to the remaining inline use-sites (the anonymous `filter`
   capability predicates) and the principal/tenancy factory so the
   selectability model is uniform.
6. **execution-context (Tier 0)** — before any governance tier.
