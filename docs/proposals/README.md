# Loom proposals — provenance, audit, and shape-typing aspects

These documents distil a set of long design conversations into clean,
one-document-per-aspect language proposals for Loom. They are **design
proposals**, not shipped features — nothing here is in `ddd.langium`
yet. Each doc states the problem, the proposed Loom surface (rendered
in Loom's own declarative grammar style, not the GraphQL/F#-flavoured
`@annotation` sketches the source conversations used), the concrete
grammar additions, lowering semantics, and open questions.

## Why "provenance" is the umbrella term

Two source threads — one titled *traceability*, one titled
*provenance* — independently converged on the same core idea and the
same vocabulary: explain **where a computed value came from**. This
aligns with W3C PROV (Entities / Activities / Agents). "Traceability"
in the classic sense (requirements ↔ code ↔ tests) was explicitly
considered and set aside in favour of **value provenance**. So the
aspects below are framed as a provenance/governance family, not a
requirements-tracing one.

## The aspects

| Doc | Aspect | Core addition |
|---|---|---|
| [`provenance.md`](./provenance.md) | Value provenance | `derived … provenanced` + compiler-inferred lineage + snapshot/trace split |
| [`execution-context.md`](./execution-context.md) | Call-context backbone | Compiler-emitted scope frames (`correlationId`/`scopeId`/`parentId`/…) shared by provenance, audit, and logging |
| [`audit-and-logging.md`](./audit-and-logging.md) | Audit & logging markers | `audited` / `logged` modifiers, append-only audit records, aggregate→command/view propagation |
| [`sensitivity-and-compliance.md`](./sensitivity-and-compliance.md) | Sensitivity tagging | `sensitive(<tag>)` as a type-system property; sensitivity propagates through expressions; `authorized(...)` declassification; sinks (log/error/trace/metric) reject sensitive values |
| [`encrypted-at-rest.md`](./encrypted-at-rest.md) | Column-level encryption | Reserved sibling of `sensitive` — governs *persistence*, not flow; deferred (see doc) |
| [`load-specifications.md`](./load-specifications.md) | Aggregate load specs | `loads` clause + compiler-inferred load plans + shape (loadedness) typing |
| [`partial-update.md`](./partial-update.md) | Partial-update pattern | `command` + `T option` fields for PATCH semantics; supersedes the v0 `Optional<T>` proposal |
| [`payload-transport-layer.md`](./payload-transport-layer.md) | Structural transport layer | `payload` keyword + five sugar keywords (`event`/`command`/`query`/`response`/`error`); carrier-bounded generics with ML-postfix syntax (`customer page`); both named unions (`payload Foo = A \| B`) and anonymous `or` unions (`A or B`); auto-synthesised aggregate wire payloads |
| [`exception-less.md`](./exception-less.md) | Exception-less flow | `error` payloads (HTTP-blind in the domain); `option` ML-postfix sugar for `T or none`; `?` propagation operator dispatching on `error`-marked variants; `Repo.getById` re-shape to `T or NotFound`; preconditions throw at both layers (different status codes); api-surface `status <Error> <Code>` mapping + stdlib defaults driving auto-generated RFC 7807 ProblemDetails translation; aggregate-vs-workflow-vs-api layer-aware failure model; no `Result<T, E>` / `Ok` / `Err` wrappers |
| [`criterion.md`](./criterion.md) | Cross-aggregate domain rules + list queries | `criterion <Name>(args) of T = <bool expr>` (Spring-Data / Evans style pure predicate); bound to parameters via `from <Criterion>(args)`, to operation guards via `when <Criterion>` (canCommand pattern with auto-exposed `can-<op>` endpoint). Plus built-in `Repo.findAll(criterion, sort?, page?, loads?)` for generic list queries (solves "repository with 40 methods"). Plus `private workflow` modifier + workflow-calls-workflow body extension. Resolves D23. |
| [`implementation-plan.md`](./implementation-plan.md) | Implementation plan | Stacked delivery plan covering all type-system proposals (state layer + transport layer + exception-less + criterion). Phases, dependencies, coordinated migration moments, decisions to pin per phase, risk management |
| [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) | Multi-tenancy | `tenancy by user.tenantId` at system level; `crossTenant` / `platform` aggregate modifiers; auto-stamped `TenantId` column + EF/Drizzle/Ash query filter |
| [`pagination-design-note.md`](./pagination-design-note.md) | Pagination | `Paged<T>` response envelope; offset/limit defaults; `unpaged` opt-out for small reference lists |
| [`mutation-testing.md`](./mutation-testing.md) | Mutation testing | IR-level `ExprIR → ExprIR[]` operators; gated instrumented emit mode preserving byte-identical fixtures; staged runner plan |
| [`authorization.md`](./authorization.md) | Authorization | `DataKey` hierarchical scoping, `policy { data { … } }` reachability, operation/view/workflow gates, field masking |
| [`lifecycle-operations.md`](./lifecycle-operations.md) | Aggregate lifecycle operations | Three keywords on aggregates (`create [name]`, `operation name`, `destroy [name]`) with kind-tagged typed actions, framework-owned persistence, body operating on pre-bound `this`. Drops PATCH; POST for body-carrying actions, DELETE only for canonical destroy. API-layer `urlStyle: literal \| resource` setting controls noun pluralisation. Reframes `crudish` to emit the canonical lifecycle trio. Rejects: lifecycle-on-service (Naked Objects), per-operation route alias, generic action kind, `delete` keyword. |
| [`loom-forms.md`](./loom-forms.md) | Declarative forms | `CreateForm` / `OperationForm` / `DestroyForm` walker primitives binding to typed actions defined by [`lifecycle-operations.md`](./lifecycle-operations.md). Strict binding (no field-walking fallback); param list IS the field list; submission dispatches via the generated API client. Fixes the layering bug where form walker + API generators independently synthesise the create contract. |

## Type-system family — state, transport, exception-less

> **Start here**:
> [`type-system-overview.md`](./type-system-overview.md) — 10-minute
> orientation across the whole family. Read first; the full proposals
> total ~3000 lines.

Six proposals + an implementation plan reshape Loom's type system:

- **State layer** —
  [`aggregate-inheritance.md`](./aggregate-inheritance.md). Abstract
  aggregates with single inheritance and storage strategies
  (`shared` / `own`). Nominal, no generics. Sister to the transport
  layer.
- **Transport layer** —
  [`payload-transport-layer.md`](./payload-transport-layer.md).
  `payload` umbrella over events/commands/queries/responses/errors;
  carrier-bounded generics (ML-postfix `T option`, `T page`);
  discriminated unions in both named (`payload Foo = A | B`) and
  anonymous-inline (`A or B`) forms.
- **Exception-less flow** —
  [`exception-less.md`](./exception-less.md). Uses the transport
  layer's primitives. `error` payloads (HTTP-blind in the domain);
  anonymous `or` unions replace the `Result<T, E>` wrapper; `?`
  propagates `error` variants. RFC 7807 ProblemDetails translation
  at the api edge. Two-regime split (aggregate-invariant throws vs
  boundary-returns-carrier) enforced by the validator.
- **Cross-aggregate domain rules + list queries** —
  [`criterion.md`](./criterion.md). `criterion` declarations
  (parameterised predicates over T, Spring-Data / Evans style)
  bound to parameters via `from <Criterion>(args)`, to operation
  guards via `when <Criterion>`. Built-in `Repo.findAll(criterion,
  sort?, page?, loads?)` solves the "repository with 40 methods"
  problem via composition. Plus `private workflow` modifier +
  workflow-calls-workflow body extension for reusable internal
  orchestration.
- **Delivery plan** —
  [`implementation-plan.md`](./implementation-plan.md). Stacks all
  of the above into one work stream with phases, coordinated
  migration moments, and risk gates.

Implementing agents: read the docs in order — aggregate-inheritance
(independent), payload-transport-layer (foundation), exception-less
(consumer), criterion (resolves D23), implementation-plan
(delivery). The transport-layer doc pins the load-bearing rules
(carrier bound, aggregate-as-carrier projection, variant-name-tagged
union identity, `error` sugar keyword, anonymous-`or` unions) that
the downstream proposals depend on.

## High-level plan — parallelisation and pickup order

The implementation plan organises the work into four tracks. **One
track is fully independent; the others have ordered dependencies.**
Multiple agents can pick up parallel tracks; the dependency graph
governs serial points.

```
                     ┌──────────────────────────────┐
                     │  Track I — Aggregate inh.    │
                     │  ~7 weeks; fully independent │  ← AGENT B can take this
                     │  Lands when ready            │     in parallel with everything
                     │  Phases I1, I2, I3, I4       │
                     └──────────────────────────────┘

  ┌──────────────────┐    ┌──────────────────────┐    ┌─────────────────────┐
  │ Track P          │ →  │ Track A              │ →  │ Track Crit          │
  │ Payload transport│    │ Exception-less       │    │ Criterion + Repo.*  │
  │ ~10 weeks         │    │ ~11.5 weeks           │    │ ~6 weeks            │
  │ Phases P1-P5     │    │ Phases A1-A7a         │    │ Phases Crit1-5      │
  └──────────────────┘    └──────────────────────┘    └─────────────────────┘
       AGENT A starts here →   blocks on P3+P4 →           blocks on A6 →
```

### What an agent can take independently

| Track | Depends on | Can start when | Approx. weeks |
|---|---|---|---|
| **I — Aggregate inheritance** | nothing | day 1 | ~7 |
| **P1, P2 — Payload keyword + auto-synth wire shapes** | nothing | day 1 | ~2.5 |
| **P3 — Carrier-bounded generics + ML-postfix syntax** | P1, P2 | week 3 | ~3 |
| **P4 — Tagged unions + anonymous `or`** | P3 | week 6 | ~3 |
| **P5 — `validate for X` / `authorize for X`** | P1 | week 3 | ~2 |
| **A1 — `error` keyword + `option` + stdlib + two-regime rule** | P3, P4 | week 9 | ~2 |
| **A2 — `?` propagation operator** | A1 | week 11 | ~2 |
| **A3 — API-edge ProblemDetails translation** | A1 | week 11 | ~2 |
| **A4 — Find-variant re-shape** (single coordinated PR) | A1, A3 | week 13 | ~1 + 2-3 days fixture re-baseline |
| **A5 — Parse + external API as `or`** | A1, A2 | after A2 | ~1.5 |
| **A6 — `validate for X` returns `or`** | A1, A2, P5 | after both | ~1.5 |
| **A7a — Carrier stdlib helpers** | A1 | parallel with A2-A6 | ~2 |
| **Crit1-4 — Criteria + `from`/`when` + `Repo.find`/`findAll`** | A1, A2, A6 | after A6 | ~5 |
| **Crit5 — Workflow-calls-workflow + `private workflow`** | A1 | parallel with anything | ~1 |

### Coordinated migration moments (must land as single PRs)

| Moment | What | Why single PR |
|---|---|---|
| **M1** | P3 + P4 together | Anonymous `or` unions are the first real consumer of generics; shipping P3 without P4 leaves the type system half-built |
| **M2** | A1 + A2 + A3 together | Authors need all three to express, compose, and translate typed errors — any subset is unusable in practice |
| **M3** | A4 alone (with fixture re-baseline) | Every example .ddd, every backend repo emitter, every route emitter changes — coordinated commit prevents drift |

### Suggested two-agent split

If two implementers are available:

- **Agent A** owns the **type-system foundation** (P1–P5 → A1–A7a → Crit1–5). Sequential, ~28.5 weeks of focused work.
- **Agent B** owns **Track I** (aggregate inheritance, ~7 weeks). Independent.

Agent B finishes early; can then absorb later phases of Track A (e.g., A5–A6 in parallel with A4's coordinated PR).

### Suggested single-agent order

If one implementer carries the whole thing:

1. **Foundation** (~6 weeks): P1, P2, P3, P4 (M1 coordinated).
2. **Minimum coherent ship** (~6 weeks): A1, A2, A3 (M2 coordinated).
3. **The big migration** (~1.5 weeks): A4 alone (M3 coordinated).
4. **Long tail** (~5 weeks): A5, A6, P5, A7a — order as convenient.
5. **Criterion + repos** (~6 weeks): Crit1-5.
6. **Aggregate inheritance** (~7 weeks, parallel-able): I1-I4 — can be interleaved at any point.

Total: ~33 weeks focused work / ~20-24 calendar weeks for one implementer; faster with two.

### Decisions to confirm per phase

Each phase has decisions in the [`implementation-plan.md`](./implementation-plan.md)
D-table (D1–D37 with recommended answers). **The agent should
confirm D1–D4 + D14–D15 with the maintainer before grammar-shape
phases land**; the rest can take the recommended answer. The plan
flags which decisions block which phase.

### Test gates per phase

Per CLAUDE.md, Loom has tiered test suites. The implementation
plan §"Test / CI gates per phase" lists which `LOOM_*_BUILD=1`
gates and which e2e suites each phase must pass before merge.

## Infrastructure / composition proposals

Proposals outside the provenance/governance and type-system families
that still belong with the design corpus:

| Doc | Aspect | Core addition |
|---|---|---|
| [`storage-and-platform-config.md`](./storage-and-platform-config.md) | Storage + generator config | One `storage` keyword in two forms (physical instance vs. per-aggregate logical binding); per-aggregate `persistenceStrategy: stateBased \| eventSourced`; per-deployable `style:` / `layout:` / `persistence:` config; per-deployable storage overrides; storage capability matrix; pluggable persistence / style / layout adapters per platform |
| [`storage-and-platform-config-plan.md`](./storage-and-platform-config-plan.md) | Implementation plan | 14-phase build order, ~17–19 PRs total, ~65 implementer-days; Phase 1 broken into 6 feature-by-feature PRs |
| [`storage-and-platform-config-micro-plan.md`](./storage-and-platform-config-micro-plan.md) | Foundation-first sub-plan | Skeleton-only delivery: ship grammar + IR + validator + downstream consumer alignment + adapter seams in ~22 days serialized (~12 with parallelism); all new features stubbed with `AdapterNotImplementedError`. F1 is delivered as 6 small per-feature PRs. Includes §"Sequencing relative to PR #549" pinning the position before the type-system family's A4 phase |

### Coordination with the type-system family

The storage proposal's §12 records one recommendation to the [`aggregate-inheritance.md`](./aggregate-inheritance.md) author: rename the inheritance-table-layout key `storage: shared | own` to `inheritanceStrategy: shareTable | ownTable` (moved inside the `aggregate { ... }` block). The two aspects (persistence model vs. inheritance table layout) are genuinely orthogonal; only the word `storage` is overloaded between the storage proposal's top-level keyword and the inheritance proposal's aggregate-property key. The corner case of an event-sourced concrete subtype of a TPH-inheritance hierarchy is documented with a recommended resolution (force `inheritanceStrategy: ownTable` for ES subtypes).

The storage proposal's foundation phases are positioned to land **before** the type-system family's exception-less A4 phase, in parallel with the aggregate-inheritance I-track. The storage proposal's `PersistenceAdapter.emitRepository(...)` contract is stable under A4 — landing the seam first reduces A4's per-backend monolithic edits to per-adapter file edits.

## Aggregate lifecycle + forms family

A two-doc, tightly coupled pair covering the aggregate's action surface and the form-generation layer that consumes it:

| Doc | Aspect | Core addition |
|---|---|---|
| [`lifecycle-operations.md`](./lifecycle-operations.md) | Aggregate lifecycle operations | Three keywords on aggregates (`create [name]`, `operation name`, `destroy [name]`) with kind-tagged typed actions; framework-owned persistence; body operating on pre-bound `this`. Drops PATCH (POST for body-carrying actions, DELETE only for canonical destroy). API-layer `urlStyle: literal \| resource` controls noun pluralisation. Reframes `crudish` to emit the canonical lifecycle trio. Surveys prior art (Naked Objects / Causeway, Ash, DDD orthodoxy) and rejects: lifecycle-on-service, per-operation route alias, generic action kind, `delete` keyword. |
| [`loom-forms.md`](./loom-forms.md) | Declarative forms | `CreateForm` / `OperationForm` / `DestroyForm` walker primitives binding strictly to typed actions defined by [`lifecycle-operations.md`](./lifecycle-operations.md). The action's param list IS the form's field list — no field-walking fallback. Submission dispatches via the generated API client. Fixes the layering bug where form walker + per-backend API generators independently synthesise the create contract by walking `aggregate.fields`. |

**Read order:** `lifecycle-operations.md` first (foundation); `loom-forms.md` second (depends on lifecycle-operations Phase 1 + Phase 3 for typed-action IR and API-client method shapes respectively).

**Delivery sequencing:** lifecycle-operations is a 5-phase build (~13 days serialised, ~7 with parallelism — backends can split); forms is a 3-phase build (~5 days serialised, ~3 with parallelism) that overlaps once lifecycle-operations Phase 1 lands. The Phase 0 stash on the branch that produced these proposals (`phase-0-crudish-create — pending design decision`) is superseded and should be dropped before crudish is reimplemented under the new model.

## Relationship to the policies work

Loom's authorization model is owned by
[`authorization.md`](./authorization.md), which consolidates the
earlier research — including the `DataKey`/`dataPolicy`/operation-gate
split and the alternate function-style policy DSL — into a single
design (a `policy {}` context member with a `data {}` reachability
section, parameterized operation/view/workflow gates, and field
masking, layered on top of `DataKey` for hierarchical scoping). It
overlaps with [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md)
on the `crossTenant` keyword and tenancy primitives; reconciliation
between the two is tracked in §0 of `authorization.md`. Several
aspects here touch the authorization layer at the seams: sensitivity
tags drive a policy-presence lint, audit records reference a policy
decision id, and the load-spec layer and any data-policy filtering
both wrap `Repo.load`. The earlier reconciliation note
[`policies-supplementary-note.md`](./policies-supplementary-note.md)
is retained as background; it is superseded by `authorization.md`.
