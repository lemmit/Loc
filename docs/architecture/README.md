# Loom architecture specs

Cross-cutting design specs that several proposals depend on. Unlike
`docs/proposals/` (one self-contained feature each) these docs pin a
**shared shape** that multiple features consume, so they are written
once here and referenced from every proposal that touches them.

They correspond to Phase 0.4 of
[`../proposals/global-implementation-plan.md`](../proposals/global-implementation-plan.md)
and back the matching `D-*` decisions in
[`../decisions.md`](../decisions.md). Where a doc pins a decision, the
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
