# Modifier propagation

> Convention spec — no single `D-*` tag, but every governance proposal
> relies on it. Status: `sensitive`/`provenanced`/`audited`/`persistedAs`/
> `shape` exist; their propagation rules are partly implemented and
> codified here so later phases extend one model instead of inventing
> per-feature rules.

## The question every modifier must answer

A modifier written on an aggregate, a field, or a value object has to
say **how far it reaches**. Does `sensitive(pii)` on a field travel into
the DTO? Into a containment that embeds the field? Into a derived value
computed from it? Into a log line? Each of Loom's cross-cutting
modifiers answers the same four questions, and they should answer them
**consistently** — otherwise a value that is `sensitive` in the
aggregate leaks through a wire shape that forgot to carry the tag.

The four propagation axes:

1. **Containment** — does it flow from a part/VO into its container (and
   vice-versa)?
2. **Wire** — does it survive into `wireShape` / the DTO?
3. **Derivation** — does a `derived`/computed value inherit it from its
   inputs?
4. **Sink** — does it constrain where the value may go (log, error,
   response, persistence)?

## The matrix

| Modifier | Containment | Wire | Derivation | Sink |
|---|---|---|---|---|
| `sensitive(<tag>)` | container of a sensitive part is **tainted** for that field; the field stays tagged | tag rides into the DTO; phase-3 `mask:` may redact at the wire | **inherited** — a `derived` reading a sensitive input is sensitive (sensitivity propagates through expressions; phase-1 shipped) | **constrained** — phase-4 rejects sensitive values in log/error/trace/metric sink calls unless `authorized(<tag>,…)` declassifies |
| `provenanced` | per-field; not inherited by container | the lineage is a **sibling artefact** (snapshot/trace), not inlined in `wireShape` | a `derived provenanced` records its inputs' lineage | emitted to the provenance store, never to a generic log |
| `audited(<mode>)` | aggregate-level only; parts do not carry it | **no** — audit records are a side channel, not wire fields | n/a | writes an `AuditRecord` on the audited actions (load→mutate→save→audit) |
| tenant-scope (`crossTenant` / `platform`) | aggregate-level; a contained part shares the root's tenancy | the auto-stamped `TenantId` column is **not** a wire field (callers never pass it, D-tenancy) | n/a | every query for a scoped aggregate gets `WHERE TenantId = ctx.tenantId`; writes stamp it from `RequestContext` |
| `mask:` (sensitivity phase 3) | follows the masked field | **transforms** the wire value (redact/partial) per `RequestContext.currentUser` | masks the rendered form, not the stored value | DTO + React render layer |
| `authorized(<tag>, …)` | expression-scoped declassification | n/a | narrows a sensitive value back to plain **within the authorized scope only** | the escape hatch for the sink constraint above |
| `persistedAs(eventLog\|state)` | aggregate-level header (D-DOCUMENT-AXIS) | n/a — affects persistence, not wire | n/a | selects event-log vs state datasource; gates the applier body contract |
| `shape(relational\|embedded\|document)` | aggregate-level header | n/a | n/a | selects the saving shape — relational tables, embedded-children JSONB, or one opaque JSONB document |

## Binding rules

- **Tags travel toward the sink, not away from it.** A sensitive field
  taints everything *downstream* (DTOs, derived values, container access
  paths) but does not retroactively tag unrelated siblings. This is the
  standard taint-propagation direction and matches the shipped phase-1
  sensitivity pass.

- **Wire decisions are made on `wireShape`, once.** Whether a modifier
  reaches the wire is decided when `wireShape` is built in enrichment
  (phase ⑥), so every backend's DTO emitter sees the same answer.
  Backends never re-decide propagation.

- **Containment inherits structural modifiers, not behavioural ones.** A
  contained part shares the root's **tenancy** and **`shape(…)`
  saving shape** (they are storage-structural). It does **not** inherit
  the root's `audited` mode (audit is an action-level concern keyed to
  the aggregate's lifecycle operations).

- **`RequestContext` is the propagation runtime.** Every sink/mask/tenant
  decision that needs "who is asking" reads it from `RequestContext`
  (see [`request-context.md`](./request-context.md)) — there is no
  per-modifier ambient accessor.

## Why centralise this

Without one matrix, each feature picks its own answer to the four axes
and they collide: a value masked at the wire but logged in the clear, a
tenant column that leaks into a DTO, a derived total that drops its
inputs' sensitivity. Pinning the axes here means a new modifier is
specified by **filling one row**, and the enrichment pass that builds
`wireShape` is the single place the wire column is honoured.
