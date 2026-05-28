# Loom proposals — index

This directory is the live design corpus for Loom. Each doc is a
single self-contained proposal (problem → proposed surface → grammar
additions → lowering semantics → open questions). Some are shipped,
some are partial, most are still on paper.

**Authoritative ordering lives in
[`global-implementation-plan.md`](./global-implementation-plan.md)** —
it audits the codebase against `origin/main`, resolves
cross-proposal collisions, and pins a topological order across the
whole corpus. The phase summary in this README is a précis; the
plan doc is the source of truth.

This README is hand-maintained and was previously stale. If you
spot drift between a proposal's actual status and the table here,
update both the entry and `global-implementation-plan.md`.

## Status legend

| Tag | Meaning |
|---|---|
| **SHIPPED** | Lives on `origin/main`. Deltas only from here. |
| **PARTIAL** | Some phases shipped; remaining phases tracked in the doc. |
| **PROPOSED** | No code yet. Grammar/IR/semantics specified. |
| **SUPERSEDED** | Replaced or reframed by a newer proposal. Read for background only. |
| **DEFERRED** | Design recorded, implementation not scheduled. |
| **REFERENCE** | Cross-cutting plan or overview, not itself a feature. |

Status reflects `origin/main` as of the last refresh of
`global-implementation-plan.md`'s audit table.

## Every proposal in this directory

### Reference & planning

| Doc | Status | Role |
|---|---|---|
| [`global-implementation-plan.md`](./global-implementation-plan.md) | REFERENCE | Topological ordering across the whole corpus; audits against `origin/main`; pins decisions; lists coordinated single-PR moments (M1/M2/M3, etc.). Start here for "what's next". |
| [`implementation-plan.md`](./implementation-plan.md) | REFERENCE | Stacked delivery plan for the type-system family (aggregate-inheritance + payload-transport + exception-less + criterion). Phase-by-phase, dependency-explicit. Consumed by Phase 2 of the global plan. |
| [`type-system-overview.md`](./type-system-overview.md) | REFERENCE | 10-minute orientation across the type-system family. Read first if you're picking up any of P/A/Crit. |
| [`storage-and-platform-config-plan.md`](./storage-and-platform-config-plan.md) | REFERENCE | 14-phase, 17–19 PR build order for the storage proposal. Consumed by Phase 1A. |
| [`storage-and-platform-config-micro-plan.md`](./storage-and-platform-config-micro-plan.md) | REFERENCE | Foundation-first sub-plan (skeleton-only delivery, ~22 days serialised, F1 broken into 6 small PRs). Consumed by Phase 1A. |

### Structural & layout

| Doc | Status | Aspect |
|---|---|---|
| [`bounded-context-model.md`](./bounded-context-model.md) | PROPOSED | **Reframes the structural model.** Promotes the bounded context to the central organising unit; adds a subdomain layer; clarifies BC vs module vs deployable. **Supersedes the per-aggregate-storage granularity of the three `storage-and-platform-config*.md` docs** (the grammar work mostly survives — the *granularity* is what changes; persistence binds at BC level, not per-aggregate). |
| [`src-ir-phase-reveal.md`](./src-ir-phase-reveal.md) | SHIPPED | Restructured `src/ir/` into `types/` / `lower/` / `enrich/` / `validate/`; moved `migrations-builder.ts` to `src/system/`. |
| [`test-layout-and-macro-consolidation.md`](./test-layout-and-macro-consolidation.md) | SHIPPED | Test tree mirrors `src/` phases; macros consolidated under `src/macros/`. |

### Storage & platform config

| Doc | Status | Core addition |
|---|---|---|
| [`storage-and-platform-config.md`](./storage-and-platform-config.md) | PARTIAL | Top-level `storage <name> { type }` and deployable role-keyed slots shipped. Remaining: per-aggregate `persistenceStrategy:`, logical bindings (keyword TBD — see D-STORAGE-SPLIT), per-deployable `style:` / `layout:` / `persistence:`, `STORAGE_CAPABILITIES` matrix, adapter contracts. **Granularity decision pending bounded-context-model.md** (BC-level vs per-aggregate). |

### Type-system family — state, transport, exception-less, criterion

> **Start here**: [`type-system-overview.md`](./type-system-overview.md).
> The proposals total ~3000 lines; the overview is 10 minutes.

| Doc | Status | Core addition |
|---|---|---|
| [`aggregate-inheritance.md`](./aggregate-inheritance.md) | PROPOSED | Abstract aggregates with single inheritance; storage strategies `shareTable`/`ownTable` (renamed per D-RENAME). Nominal, no generics. Independent track. |
| [`payload-transport-layer.md`](./payload-transport-layer.md) | PROPOSED | `payload` umbrella over events/commands/queries/responses/errors. Carrier-bounded generics with ML-postfix syntax (`customer page`). Named (`payload Foo = A \| B`) and anonymous `or` unions. Auto-synthesised aggregate wire payloads. Foundation for the whole family. |
| [`exception-less.md`](./exception-less.md) | PROPOSED | `error` payloads (HTTP-blind in the domain). `option` ML-postfix sugar. `?` propagation operator. `Repo.getById` re-shape to `T or NotFound`. Per-api `status` mapping + stdlib defaults driving auto-generated RFC 7807 ProblemDetails. Two-regime split (aggregate-throws vs boundary-returns-carrier). No `Result<T, E>` wrappers. |
| [`criterion.md`](./criterion.md) | PROPOSED | `criterion <Name>(args) of T = <bool expr>` (Spring-Data / Evans style). Bound to params via `from <Criterion>(args)`, to operation guards via `when <Criterion>` (auto-exposed `can-<op>` endpoint). Plus built-in `Repo.findAll(criterion, sort?, page?, loads?)` ("repository with 40 methods" → composition). Plus `private workflow` modifier + workflow-calls-workflow body extension. Resolves D23. |
| [`partial-update.md`](./partial-update.md) | PROPOSED | `command` + `T option` fields for PATCH semantics. Supersedes the v0 `Optional<T>` proposal. **Folded into A1** of the implementation plan. |
| [`load-specifications.md`](./load-specifications.md) | PROPOSED | `loads` clause + compiler-inferred load plans + shape (loadedness) typing. **Folded into P3** of the implementation plan. |

### Aggregate lifecycle + forms

Tightly coupled pair: aggregate action surface and the form-generation
layer that consumes it.

| Doc | Status | Core addition |
|---|---|---|
| [`lifecycle-operations.md`](./lifecycle-operations.md) | PROPOSED | Three keywords on aggregates (`create [name]`, `operation name`, `destroy [name]`) with kind-tagged typed actions; framework-owned persistence; body operating on pre-bound `this`. Drops PATCH (POST for body-carrying actions, DELETE only for canonical destroy). API-layer `urlStyle: literal \| resource`. Reframes `crudish` to emit the canonical lifecycle trio. Rejects: lifecycle-on-service, per-operation route alias, generic action kind, `delete` keyword. |
| [`loom-forms.md`](./loom-forms.md) | PROPOSED | `CreateForm` / `OperationForm` / `DestroyForm` walker primitives binding strictly to typed actions defined by `lifecycle-operations.md`. The action's param list IS the form's field list — no field-walking fallback. Submission dispatches via the generated API client. Fixes the layering bug where form walker + API generators independently synthesise the create contract. |

**Read order:** lifecycle-operations first (foundation); forms second.

### Workflow

| Doc | Status | Core addition |
|---|---|---|
| [`workflow-and-applier.md`](./workflow-and-applier.md) | PROPOSED | Reframes today's `workflow Name(params) [transactional]`. Introduces appliers (`apply(...)`) for event-sourced aggregates and workflows. Three concepts split out of today's overloaded `workflow`: single-tx command handler, multi-tx command-triggered process, event-triggered process. Sagas (compensation contract) deferred to a v2 amendment. |

### Provenance & governance family

> The umbrella term is **value provenance** — "explain where a
> computed value came from", aligned with W3C PROV. Classic
> requirements-tracing was considered and set aside in favour of
> this.

| Doc | Status | Core addition |
|---|---|---|
| [`provenance.md`](./provenance.md) | SHIPPED (TS/Hono v1) | `derived … provenanced` + compiler-inferred lineage + snapshot/trace split. .NET/Phoenix parity is Phase 5 deferred tail. |
| [`execution-context.md`](./execution-context.md) | PROPOSED | Compiler-emitted scope frames (`correlationId`/`scopeId`/`parentId`/…) shared by provenance, audit, and logging. Tier 0 of Phase 3 — backbone for everything that follows. |
| [`audit-and-logging.md`](./audit-and-logging.md) | PARTIAL | `audited` boolean shipped; Hono emits load→mutate→save→audit. Remaining: promote to `audited(actions \| access \| events \| off)`, `AuditRecord` shape, before/after snapshots, .NET Mediator behaviour, access-audit query pipeline. |
| [`observability.md`](./observability.md) | SHIPPED | Structured logging via IR-neutral event catalog. Catalog + 3 backends + `LOOM_OBS_E2E_*` gates green on main. Complementary to `audited` — observability is the structured-log channel, `audited` is the transactional append-only one. |
| [`sensitivity-and-compliance.md`](./sensitivity-and-compliance.md) | PARTIAL | `sensitive(<tag>)` as a type-system property; sensitivity propagates through expressions. Phases 1 + 2-lite shipped. Remaining: Phase 2 full (`authorized(<tag>, …)` declassification), Phase 3 (`mask:` DTOs + React), Phase 4 (sink-call classification — log/error/trace/metric reject sensitive values). |
| [`encrypted-at-rest.md`](./encrypted-at-rest.md) | DEFERRED | Reserved sibling of `sensitive` — governs *persistence*, not *flow*. Final phase of Phase 5; gated on storage capability matrix. |
| [`policies-supplementary-note.md`](./policies-supplementary-note.md) | SUPERSEDED | Background only. Superseded by `authorization.md`. |

### Authorization & tenancy

| Doc | Status | Core addition |
|---|---|---|
| [`authorization.md`](./authorization.md) | PROPOSED | `DataKey` hierarchical scoping; `policy { data { … } operations { … } fields { … } }` reachability, operation/view/workflow gates, field masking. Pinned per D-POLICY-STYLE over the function-style alternative. Phases 1–4 in Phase 3.2; phases 5–7 (`exists`, field rules, `implies`) in Phase 5. |
| [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) | PROPOSED | `tenancy by user.tenantId` at system level; `crossTenant` / `platform` aggregate modifiers; auto-stamped `TenantId` column + EF/Drizzle/Ash query filter. Ships before authorization phase 1 (DataKey leftmost = TenantId). |

### UX / output

| Doc | Status | Core addition |
|---|---|---|
| [`pagination-design-note.md`](./pagination-design-note.md) | PROPOSED | `Paged<T>` response envelope; offset/limit defaults; `unpaged` opt-out for small reference lists. Phase 4.2. |
| [`i18n-strings.md`](./i18n-strings.md) | PROPOSED | String composition: template literals, ICU, concatenation ban in user-visible slots. Closes `i18n.md` open question #4. Companion — must read with `i18n.md`. |
| [`i18n.md`](./i18n.md) | PROPOSED | First-class i18n: ICU catalogs, content-hash keys, named `text { }` entries, `ddd i18n sync` three-way merge, per-backend adapters. 7-phase build, ~4 weeks. Phase 4.1. |

### Quality / tooling

| Doc | Status | Core addition |
|---|---|---|
| [`mutation-testing.md`](./mutation-testing.md) | PROPOSED (OUT OF SCOPE) | IR-level `ExprIR → ExprIR[]` operators; gated instrumented emit mode preserving byte-identical fixtures; staged runner plan. Excluded from the global plan per maintainer. |

## Phase summary (precis of global plan)

```
Phase 0 — Convenience & architectural groundwork (decisions + docs)
  0.1 Decisions to pin (D-RENAME, D-STORAGE-SPLIT, D-POLICY-STYLE,
      D-LIFECYCLE-VERB, D-I18N-KEY, D-CTX-SHAPE, D-ENVELOPE,
      type-system D1–D4 + D14–D15)
  0.2 Mechanical reorgs — DONE (src-ir-phase-reveal,
      test-layout-and-macro-consolidation)
  0.3 Seam extractions — partially done; remaining seams listed
  0.4 Cross-cutting design specs at docs/architecture/*.md
      (request-context, wire-envelope, modifier-propagation,
      diagnostic-catalog, cli-surface, coordinated-rebaseline)
  0.5 (deferred)
  0.6 Decision log + PR-type taxonomy

Phase 1 — Three parallel foundation tracks
  1A Storage & platform-config foundation (depends on D-STORAGE-SPLIT
     and bounded-context-model.md granularity decision)
  1B Lifecycle-operations + loom-forms
  1C Aggregate inheritance (Track I)

Phase 2 — Type-system family (per implementation-plan.md)
  2.1 Payload-transport (P1–P5)        — M1 = P3+P4 together
  2.2 Exception-less (A1–A7a)          — M2 = A1+A2+A3, M3 = A4 alone
  2.3 Criterion (Crit1–5)
  2.4 partial-update folded into A1; load-specifications into P3

Phase 3 — Provenance & governance
  3.0 execution-context (Tier 0 backbone)
  3.1 Tier 1 — audit promotion + sensitivity phases 2/3/4
  3.2 Tier 2 — multi-tenancy → authorization phases 1–4
              (wires policyDecisionId into Tier 1 audit records)

Phase 4 — i18n + pagination
  4.1 i18n-strings → i18n phases 1–7
  4.2 pagination-design-note

Phase 5 — Deferred tail
  Authorization phases 5–7
  Provenance v1 across .NET / Phoenix
  Audit module-wide config
  encrypted-at-rest
```

### Coordinated single-PR moments

| Tag | What | Phase |
|---|---|---|
| D-RENAME | `inheritanceStrategy: shareTable \| ownTable` rename | 0.1 |
| D-STORAGE-SPLIT | Split overloaded `storage` keyword | 0.1 |
| D-POLICY-STYLE | `policy {}` over function-style | 0.1 |
| D-LIFECYCLE-VERB | `urlStyle:` default | 0.1 |
| D-I18N-KEY | Option B placeholder lowering | 0.1 |
| F1-PR-5 | `STORAGE_CAPABILITIES` + adapter stubs | 1A |
| F3 | Adapter contract publication | 1A |
| Lifecycle-1 | Grammar + `OperationIR.kind` | 1B |
| M1 | P3 + P4 ship together | 2.1 |
| M2 | A1 + A2 + A3 ship together | 2.2 |
| M3 | A4 alone with fixture rebaseline | 2.2 |
| Tier-0 | execution-context before audit/auth tiers | 3.0 |
| Auth-gate | multi-tenancy before authorization phase 1 | 3.2 |

### Parallelisation

Two-agent split per the global plan:

- **Agent A** — Phase 0 seams → Phase 1A (storage) → Phase 2 → Phase 3.2 (auth)
- **Agent B** — Phase 0 reorgs → Phase 1B (lifecycle + forms) and/or 1C (inheritance) → Phase 3.0 → Phase 3.1 → Phase 4

After the storage adapter contract (F3) publishes, additional
implementers can absorb storage post-foundation streams A–O in
parallel.

## Cross-proposal coordination notes

- **bounded-context-model.md vs storage proposals.** The
  bounded-context proposal changes the *granularity* at which
  persistence binds (BC-level, not per-aggregate). The storage
  proposal's grammar work mostly survives the reframe, but the
  per-aggregate `persistenceStrategy:` placement may move up to the
  BC. Resolve the granularity decision before landing Storage F1.

- **aggregate-inheritance.md ↔ storage.** Original
  `storage: shared | own` for inheritance table layout collides
  lexically with the storage proposal's `storage` keyword. Pinned
  rename: `inheritanceStrategy: shareTable | ownTable`, inside the
  `aggregate { … }` block (D-RENAME). ES concrete subtype of a TPH
  abstract is forced to `inheritanceStrategy: ownTable`.

- **Storage foundation positioning.** The storage micro-plan's
  foundation phases are positioned to land **before** the type-system
  family's exception-less A4 phase. The
  `PersistenceAdapter.emitRepository(...)` contract is stable under
  A4 — landing the seam first reduces A4's per-backend monolithic
  edits to per-adapter file edits.

- **Authorization vs multi-tenancy.** They overlap on the
  `crossTenant` keyword and tenancy primitives; reconciliation is
  tracked in §0 of `authorization.md`. `policies-supplementary-note.md`
  is retained as background but superseded by `authorization.md`.

- **Sensitivity / audit / load-spec ↔ authorization.** Sensitivity
  tags drive a policy-presence lint; audit records reference a
  policy decision id; the load-spec layer and any data-policy
  filtering both wrap `Repo.load`.

- **lifecycle-operations ↔ workflow-and-applier.** Both touch the
  action surface. Lifecycle-operations covers aggregate-local typed
  actions; workflow-and-applier reframes context-level orchestration
  and adds appliers. Read the lifecycle doc first; the workflow doc
  builds on its `OperationIR.kind` tagging.
