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
| [`optional-and-partial-update.md`](./optional-and-partial-update.md) | Optional / partial update | `Optional<T>` to distinguish "field absent" from "field null" |
| [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) | Multi-tenancy | `tenancy by user.tenantId` at system level; `crossTenant` / `platform` aggregate modifiers; auto-stamped `TenantId` column + EF/Drizzle/Ash query filter |
| [`pagination-design-note.md`](./pagination-design-note.md) | Pagination | `Paged<T>` response envelope; offset/limit defaults; `unpaged` opt-out for small reference lists |
| [`mutation-testing.md`](./mutation-testing.md) | Mutation testing | IR-level `ExprIR → ExprIR[]` operators; gated instrumented emit mode preserving byte-identical fixtures; staged runner plan |
| [`authorization.md`](./authorization.md) | Authorization | `DataKey` hierarchical scoping, `policy { data { … } }` reachability, operation/view/workflow gates, field masking |

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
