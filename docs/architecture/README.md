# Loom architecture specs

Cross-cutting design specs that several proposals depend on. Unlike
`docs/old/proposals/` (one self-contained feature each) these docs pin a
**shared shape** that multiple features consume, so they are written
once here and referenced from every proposal that touches them.

They were written as the cross-cutting groundwork phase of the
original global implementation plan (the plan at
[`../proposals/global-implementation-plan.md`](../old/proposals/global-implementation-plan.md)
was rewritten 2026-06-10; these specs stand on their own) and back the
matching `D-*` decisions in [`../decisions.md`](../decisions.md). Where a doc pins a decision, the
binding answer lives in `decisions.md`; the spec here elaborates it.

| Spec | Pins | Consumed by |
|---|---|---|
| [`request-context.md`](./request-context.md) | D-CTX-SHAPE | execution-context, multi-tenancy, authorization, sensitivity, i18n, audit, observability |
| [`wire-envelope.md`](./wire-envelope.md) | D-ENVELOPE | payload-transport, exception-less, pagination, every backend's DTO/route emitter |
| [`modifier-propagation.md`](./modifier-propagation.md) | — (convention) | sensitivity, provenance, audit, multi-tenancy, document-axis, masking |
| [`diagnostic-catalog.md`](./diagnostic-catalog.md) | — (convention) | every validator + IR/system check |
| [`cli-surface.md`](./cli-surface.md) | — (convention) | i18n (`ddd i18n`), any future sub-command |
| [`coordinated-rebaseline.md`](./coordinated-rebaseline.md) | — (operational) | M1 / M2 / M3 / Lifecycle-1 / Inheritance fixture rebaselines |

These specs are **design intent**, not all implemented yet. Each notes
its current-vs-target state inline.
