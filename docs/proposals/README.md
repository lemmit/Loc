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
| [`specification.md`](./specification.md) | Cross-aggregate domain rules | `specification <Name>(args) of T { query:/check:/enumerate: }` declarations; bound to parameters via `from <Spec>(args)`. One declaration drives input validation + UI options + OpenAPI constraints (Specification Pattern from DDD). Plus `private workflow` modifier (reusing existing `private` from `private operation` / `private invariant`) for reusable internal orchestration; workflow-calls-workflow body extension. Resolves D23. |
| [`implementation-plan.md`](./implementation-plan.md) | Implementation plan | Stacked delivery plan covering all type-system proposals (state layer + transport layer + exception-less + specifications). Phases, dependencies, coordinated migration moments, decisions to pin per phase, risk management |

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
- **Cross-aggregate domain rules** —
  [`specification.md`](./specification.md). `specification` declarations
  (parameterised predicates / sets over T) bound to parameters via
  `from <Spec>(args)`. One declaration drives input validation +
  UI options + OpenAPI constraints (Specification Pattern from DDD).
  Plus `private workflow` modifier + workflow-calls-workflow body
  extension for reusable internal orchestration.
- **Delivery plan** —
  [`implementation-plan.md`](./implementation-plan.md). Stacks all
  of the above into one work stream with phases, coordinated
  migration moments, and risk gates.

Implementing agents: read the docs in order — aggregate-inheritance
(independent), payload-transport-layer (foundation), exception-less
(consumer), specification (resolves D23), implementation-plan
(delivery). The transport-layer doc pins the load-bearing rules
(carrier bound, aggregate-as-carrier projection, variant-name-tagged
union identity, `error` sugar keyword, anonymous-`or` unions) that
the downstream proposals depend on.

## Relationship to the policies work

A separate effort owns Loom's authorization model (`DataKey`,
`dataPolicy`, `operationPolicy`, relation-based sharing). Several
aspects here touch that model at the seams — sensitivity tags drive a
policy-presence lint, audit records reference a policy decision id, the
load-spec layer and any data-policy filtering both wrap `Repo.load`,
and one source conversation contained an *entire alternate policy DSL*
(typed `policy` boolean functions, `@requires`, field `read`/`write`
gates). All of that is collected — with explicit reconciliation notes —
in [`policies-supplementary-note.md`](./policies-supplementary-note.md)
so the two visions stay complementary rather than colliding.
