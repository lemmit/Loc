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
| [`domain-service.md`](./domain-service.md) | Domain services and validators | `validator <name>(...): or <Error>` (pure cross-aggregate domain rule check; subtype of service) + `service <name>(...): or <Result>` (full domain service; may mutate via aggregate ops). `pre <validator>(args)` clause on aggregate operations declaratively lifts the check into the synthesised application layer. Resolves D23. |
| [`implementation-plan.md`](./implementation-plan.md) | Implementation plan | Stacked delivery plan covering all type-system proposals (state layer + transport layer + exception-less + domain-service). Phases, dependencies, coordinated migration moments, decisions to pin per phase, risk management |

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
  layer's primitives. `error` payloads with their own status codes;
  anonymous `or` unions replace the `Result<T, E>` wrapper; `?`
  propagates `error` variants. Two-regime split enforced by the
  validator.
- **Delivery plan** —
  [`implementation-plan.md`](./implementation-plan.md). Stacks the
  three above into one work stream with phases, coordinated
  migration moments, and risk gates.

Implementing agents: read the docs in order — aggregate-inheritance
(independent), payload-transport-layer (foundation),
exception-less (consumer), implementation-plan (delivery). The
three share a load-bearing rule set (carrier bound,
aggregate-as-carrier projection, variant-name-tagged union identity,
`error` sugar keyword, anonymous-`or` unions) which is pinned in
the transport-layer doc precisely because exception-less depends on
it.

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
