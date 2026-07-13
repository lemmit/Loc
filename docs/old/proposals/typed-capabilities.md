# Typed capabilities — from `implements "string"` to a first-class `capability`

> **[2026-06-20 status audit]** SHIPPED (#1388) — first-class `capability` mixin live (grammar `ddd.langium:~955`, expander `src/macros/expander.ts:~237`, Phase 6 string-form removal in `lower-capabilities.ts`). Only OQ#1 emission-dedup remains (`capability-emission-dedup.md`).

> **Status:** PROPOSED (no implementation yet). Grammar/IR/lowering specified;
> byte-identical-output migration path. Emerged from the multi-tenancy design
> session (see [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md)
> R5, whose `tenantRegistry` is the worked case).
>
> **Supersedes the *mechanism* of** the stringly-typed capability surface in
> [`../capabilities.md`](../../capabilities.md) (`implements "X"`, `filter for "X"`,
> `stamp for "X"`). The selectability/propagation *semantics* survive unchanged;
> only the names become typed.

## Problem — the one un-resolved corner

Loom's thesis is a **fully-resolved IR**: every name carries a `refKind`, every
member access a `receiverType`. Capabilities are the **single exception** — they
are matched on bare strings:

```ddd
implements "tenantRegistry"          // ImplementsDecl, ddd.langium:909 — a STRING
filter for "softDeletable" …         // FilterDecl,     ddd.langium:890
stamp  for "auditable"     …         // StampDecl,      ddd.langium:897
```

A string tag has no declaration and no resolution. Consequences:

- **Typos / drift** — `implements "auditabl"` is a silent no-match, not an error.
- **No existence check** — referencing a capability nobody declares is accepted.
- **No tooling** — no go-to-definition, find-implementors, or autocomplete.
- **Muddy concept** — "capabilities" today *are* macros (`src/macros/stdlib/`),
  so the line between a capability and a macro is unclear.

## Proposed surface — `capability` is a **pure mixin**

A `capability` is a named bundle of **fields + `filter` + `stamp`** — everything
in its body is **provided** to implementors. There are **no ownership keywords**
(`requires` / `provides` / `expects`): declaring something in the body *is* the
capability providing it. Aggregates reference it with a **typed**
`implements` / `with` (resolved like any cross-reference):

```ddd
capability softDeletable {
  isDeleted: bool = false           // a field the capability adds
  filter !this.isDeleted            // behavior the capability adds
}

capability auditable {
  createdAt: datetime, createdBy: User, updatedAt: datetime, updatedBy: User
  stamp onCreate { createdAt := now()  createdBy := currentUser }
  stamp onUpdate { updatedAt := now()  updatedBy := currentUser }
}

capability tenantRegistry {         // the multi-tenancy registry — still a pure mixin
  parent: Self id?                  // the tree edge — PROVIDED (immutable; null = root)
  // dataKey: managed path + path-stamp behavior (computed by Loom)
}

aggregate Order with auditable, softDeletable { subject: string }
aggregate Org   implements tenantRegistry      { name: string }   // gains parent + dataKey
```

`Self` resolves to the implementing aggregate's own type, so `parent: Self id?`
is a self-referential optional ref that becomes `Org id?` on `Org`.

### Why no `requires` / contract members

An earlier draft split the body into `requires` (host must supply) and
`provides` (capability supplies). It was dropped, because **every capability
provides the fields its own behavior uses** — `softDeletable` provides
`isDeleted`, `auditable` provides `createdAt`, `tenantRegistry` provides
`parent`. There is no real case of a capability needing a *fixed-name* field
*from* the host: the rare "operate on a host field" need is **parameterization**
(`searchable(on: name)` — open question), not a contract. With no `requires`
use case, there is no field-**conformance** to verify either (the capability
adds the field, so it exists by construction). So: **pure mixin, no contract,
no conformance.** (`tenantRegistry`'s singular-cardinality and `of …` cross-link
checks remain — but those are tenancy-level validators, not a capability
mechanism.)

### Provision is local and unfoldable — not magic

A capability adds fields, but only via the **local, explicit, unfoldable**
`with` / `implements` on the aggregate (the LSP "unfold macro" action expands it
to literal source). That is the *good* kind of field-adding — visible at the
aggregate — not a distant declaration silently mutating shape. Capability-added
members are **non-overridable** by default (uniform infra is the point — an
overridable tenant filter would be a leak); allow an override only via an
explicit opt-in if a real case ever appears.

`dataKey`-style **managed** values (a derived materialized path, like an index
or `wireShape`) are the one thing Loom *computes*: their *presence* is the
explicit consequence of the capability, their *value* is derived, never authored.

## Lowering — byte-identical to the string form

A capability lowers to the **existing** per-aggregate IR; the typed reference
merely replaces the string match as the join:

- body fields → folded into the aggregate's `fields` (as the field-adding macros
  do today).
- `filter` → each implementor's **`agg.contextFilters`** (predicate list).
- `stamp` → each implementor's **`agg.contextStamps`**.

Both authoring forms — co-located `capability { filter … }` and the legacy
standalone `filter for "X"` — converge on the identical platform-neutral IR.
Backends are unchanged; this is a **byte-identical-output** migration (regenerate
every `examples/*.ddd` across all backends, sha256 before == after — the gate
used for the `ExprTarget`/`WalkerTarget` extractions).

## Backend emission (non-normative note)

A typed capability has a natural per-backend representation a string tag lacks: a
**marker interface** (C# `interface ISoftDeletable`, a TS brand, an Ecto
schema-module convention). That enables idiomatic emission — e.g. an EF `OnModelCreating` loop
over entities implementing the marker, instead of N hand-written `HasQueryFilter`
calls:

```csharp
foreach (var et in modelBuilder.Model.GetEntityTypes())
  if (typeof(ISoftDeletable).IsAssignableFrom(et.ClrType))
    modelBuilder.Entity(et.ClrType).HasQueryFilter(/* combined predicate */);
```

Two EF realities, captured so the IR stays backend-neutral:

1. EF registers query filters **per entity type** — "once" means once in
   *emitted code* (the loop), not one runtime registration.
2. Classic EF allows **one filter per entity** (a second overwrites), so an
   entity implementing several filtering capabilities must **AND-combine** them
   into a single predicate — inherently per-entity. (EF Core 10 multiple named
   filters relaxes this.)

This is a **codegen choice over the same `contextFilters` IR**; the capability
model never dictates it. Drizzle (WHERE splice) and Ecto (a shared
`where`-clause helper) have their own faithful emission. (How shared code is emitted when one capability is
reused across many aggregates is open question #1.)

## What becomes a capability vs stays a macro

The proposal **shrinks the stdlib** and draws the line that is muddy today:

> **Capability** = *decorate* an aggregate with **fields + filter + stamp**
> (declarative, typed, unfoldable).
> **Macro** = *generate structure* — **operations, pages, whole subtrees**
> (imperative, TS-authored).

| Stdlib macro (`src/macros/stdlib/`) | Fate | Why |
|---|---|---|
| `audit` / `auditable` / `auditedByDefault` | → **`capability auditable`** | fields + stamps; the state/behavior split collapses into one decl |
| `softDelete` / `softDeletable` / `softDeleteByDefault` | → **`capability softDeletable`** | a field + `filter` |
| `tenantOwned` (proposed) | → **`capability tenantOwned`** | fields (`tenantId`, `dataKey`) + filter + stamp |
| `tenantRegistry` (proposed) | → **`capability tenantRegistry`** | a provided self-ref `parent` + `dataKey` + path-stamp |
| `crudish` | **stays a macro** | adds **operations**, beyond a capability bundle |
| `scaffold*` | **stays a macro** | generates **structures** (pages, aggregates, modules) |

The `*ByDefault` variants become **context-level application** — `context Sales
with auditable` applies the capability to every aggregate in the context — a thin
language feature, not a bespoke macro each.

## Relationships

- **vs aggregate inheritance** ([`aggregate-inheritance.md`](./aggregate-inheritance.md)):
  inheritance is the *vertical* is-a axis (single, nominal, `abstract`/`extends`).
  Capabilities are the *horizontal* mixin axis (multiple, cross-cutting). A
  capability is **not** a second inheritance system.
- **vs macros**: typed capabilities subsume the *field/filter/stamp* macros;
  macros revert to pure structural/operation generation.
- **vs multi-tenancy**: `tenantRegistry` (provided self-ref `parent` + `dataKey`)
  and `tenantOwned` (provided `tenantId`/`dataKey` + filter + stamp) are the
  worked cases. Tenancy need not *wait* — it can use the string capability form
  initially, then adopt the typed `capability` once this lands.

## Migration & back-compat

- Keep `implements "string"` / `filter for "X"` / `stamp for "X"` working as
  **sugar / a deprecation path** so existing usages don't break; migrate the
  stdlib (`audit`/`softDelete`) to typed `capability` declarations incrementally.
- Each stdlib migration is individually **byte-identical-gated**.

## Scope guardrails (what this is NOT)

Keep it minimal: a **pure-mixin** body (fields + `filter` + `stamp`) + typed
refs. **Not** a contract/`requires` mechanism (no use case — see above), **not**
default-method overridability (footgun), **not** a full trait system (no
generics, no capability-implements-capability, no provided *operations*) until a
concrete case demands each. Operations/structure stay in macros; "operate on a
host field" is parameterization, not a contract.

## Open questions

1. **Emission deduplication when a capability is reused** — **RESOLVED** in
   [`capability-emission-dedup.md`](./capability-emission-dedup.md). Verdict:
   dedup is a **per-backend codegen choice over an unchanged per-aggregate IR**,
   enabled by one additive provenance seam (`capabilityOrigin` on propagated
   filters/stamps). **Filters stay per-entity** (EF's one-filter-per-entity
   forces per-entity AND-combination; predicates are trivial — nothing to
   hoist); the marker interface is emitted for *type identity*, not to install
   filters. **Stamps dedup** via a marker-interface-keyed write-time hook (.NET
   `is I<Cap>` interceptor branch / JPA `@EntityListener`), gated on pinning
   **write-time stamp semantics** (a stamp is materialized at persist, not
   readable in the operation body — already true on .NET, a behavior change for
   Java). Behavior-preserving but **not** byte-identical (runtime-gated, unlike
   the rest of this proposal); sequenced *after* typed capabilities land.
2. **Capability parameters** — `searchable(on: name)` / `tenantOwned(by: …)`. The
   only sanctioned way for a capability to touch a *host* field. Defer until a
   real case appears.
3. **`Self`-type resolution** for self-referential provided fields (`parent:
   Self id?`) — grammar + scope rules.
4. **Context-level application** surface for the `*ByDefault` cases (`context …
   with X`) — grammar + propagation rules.

## Cross-references

- [`../capabilities.md`](../../capabilities.md) — the current (stringly-typed)
  capability reference this evolves.
- [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) R5 — the
  worked cases (`tenantRegistry` / `tenantOwned`).
- [`aggregate-inheritance.md`](./aggregate-inheritance.md) — the orthogonal
  vertical axis.
- `src/macros/stdlib/` — the `audit`/`softDelete`/`crudish` macros this
  reconciles; `ddd.langium:890-910` — the existing `FilterDecl`/`StampDecl`/
  `ImplementsDecl` grammar.
