# Typed capabilities — from `implements "string"` to a first-class `capability`

> **Status:** PROPOSED (no implementation yet). Grammar/IR/lowering/validation
> specified; byte-identical-output migration path. Emerged from the
> multi-tenancy design session (see [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md)
> R5, which needs the conformance check this proposal generalises).
>
> **Supersedes the *mechanism* of** the stringly-typed capability surface
> documented in [`../capabilities.md`](../capabilities.md) (`implements "X"`,
> `filter for "X"`, `stamp for "X"`). The selectability/propagation *semantics*
> survive unchanged; only the names become typed.

## Problem — the one un-resolved corner

Loom's thesis is a **fully-resolved IR**: every name carries a `refKind`, every
member access a `receiverType`, every call a `callKind`. Backends never
re-resolve. Capabilities are the **single exception** — they are matched on bare
strings:

```ddd
implements "tenantRegistry"          // ImplementsDecl, ddd.langium:909 — a STRING
filter for "softDeletable" …         // FilterDecl,     ddd.langium:890
stamp  for "auditable"     …         // StampDecl,      ddd.langium:897
```

A string tag has no declaration, no contract, no resolution. Consequences:

- **Typos / drift** — `implements "auditabl"` is a silent no-match, not an error.
- **No existence check** — referencing a capability nobody declares is accepted.
- **No field contract** — nothing can say "to be a `tenantRegistry` you must have
  a self-referential `parent`." (Multi-tenancy R5 needs exactly this.)
- **No tooling** — no go-to-definition, find-implementors, or autocomplete.
- **Muddy concept** — "capabilities" today *are* macros (`src/macros/stdlib/`),
  so the line between a capability and a macro is unclear.

## Proposed surface — `capability` declaration

A named, typed declaration bundling up to three things; aggregates reference it
with a **typed** `implements`/`with` (resolved like any cross-reference):

```ddd
capability <Name> {
  requires <field>: <Type>        // CONTRACT — implementors must already have this
  provides <field>: <Type> = …    // MIXIN    — fields the capability adds (managed)
  filter <bool-expr>              // BEHAVIOR — query scope (optional)
  stamp <event> { <assigns> }     // BEHAVIOR — write stamp (optional)
}
```

Three flavours fall out of which parts are present:

| Flavour | Parts | Example |
|---|---|---|
| **Contract** | `requires` only | `tenantRegistry { requires parent: Self id? }` |
| **Mixin** | `provides` (+ `filter`/`stamp`) | `auditable`, `softDeletable`, `tenantOwned` |
| **Both** | `requires` + `provides` + behavior | rare; allowed |

Worked cases:

```ddd
capability auditable {
  provides createdAt: datetime, createdBy: User, updatedAt: datetime, updatedBy: User
  stamp onCreate { createdAt := now()  createdBy := currentUser }
  stamp onUpdate { updatedAt := now()  updatedBy := currentUser }
}

capability softDeletable {
  provides isDeleted: bool = false
  filter !this.isDeleted
}

capability tenantRegistry {          // contract-only — the registry must be self-referential
  requires parent: Self id?
}

aggregate Order  with auditable, softDeletable { subject: string }
aggregate Org    implements tenantRegistry      { parent: Org id? }   // verified, not injected
```

`Self` resolves to the implementing aggregate's own type (so `requires parent:
Self id?` means "a self-referential optional ref").

## Semantics

### Resolution & conformance (the new bit)

- `implements <Name>` / `with <Name>` is a **typed reference** resolved by the
  scope provider to a `capability` declaration. Unknown name → error
  (`loom.capability-unknown`).
- **`requires` is verified, not injected.** The author writes the field; Loom
  checks the implementor has a field of the required name and a compatible type
  (`loom.capability-missing-required` / `-type-mismatch`). This is the
  "verify, don't inject" principle from the multi-tenancy session — a
  declaration checks shape, it does not silently mutate it.
- **`provides` is injected** — but *only* via the **local, explicit,
  unfoldable** `with`/`implements` on the aggregate (the LSP "unfold macro"
  action expands it to literal source). That is the *good* kind of field-adding
  (visible, local), not distant magic. Duplicate-name collisions between a
  `provides` field and an author field → error.

### Lowering — byte-identical to the string form

A capability lowers to the **existing** per-aggregate IR; the typed reference
merely replaces the string match as the join key:

- `provides` fields → folded into the aggregate's `fields` (exactly as the
  field-adding macros do today).
- `filter` → each implementor's **`agg.contextFilters`** (predicate list).
- `stamp` → each implementor's **`agg.contextStamps`**.

So both authoring forms — co-located `capability { filter … }` and the legacy
standalone `filter for "X"` — converge on the identical platform-neutral IR.
Backends are unchanged; this is a **byte-identical-output** migration (regenerate
every `examples/*.ddd` across all backends, sha256 before == after — the gate
used for the `ExprTarget`/`WalkerTarget` extractions).

### Backend emission (non-normative note)

A typed capability has a natural per-backend representation a string tag lacks:
a **marker interface** (C# `interface ISoftDeletable`, a TS brand, an Ash
extension). That enables idiomatic emission — e.g. an EF `OnModelCreating` loop
over entities implementing the marker, rather than N hand-written
`HasQueryFilter` calls:

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
   into a single predicate — that combination is inherently per-entity. (EF Core
   10 multiple named filters relaxes this.)

This is a **codegen choice over the same `contextFilters` IR** (per-aggregate
predicate list); the capability model never dictates it. Drizzle (WHERE splice)
and Ash (`base_filter`) have their own faithful emission.

## What becomes a capability vs stays a macro

The proposal **shrinks the stdlib** and draws the line that is muddy today:

> **Capability** = *decorate* an aggregate with **fields + filter + stamp**
> (declarative, typed, unfoldable).
> **Macro** = *generate structure* — **operations, pages, whole subtrees**
> (imperative, TS-authored).

| Stdlib macro (`src/macros/stdlib/`) | Fate | Why |
|---|---|---|
| `audit` / `auditable` / `auditedByDefault` | → **`capability auditable`** | fields + stamps; the state/behavior split collapses into one decl |
| `softDelete` / `softDeletable` / `softDeleteByDefault` | → **`capability softDeletable`** | `provides isDeleted` + `filter` |
| `tenantOwned` (proposed) | → **`capability tenantOwned`** | `provides tenantId, dataKey` + filter + stamp |
| `tenantRegistry` (proposed) | → **`capability tenantRegistry`** | contract-only (`requires parent`) |
| `crudish` | **stays a macro** | adds **operations**, beyond a capability bundle |
| `scaffold*` | **stays a macro** | generates **structures** (pages, aggregates, modules) |

The `*ByDefault` variants become **context-level application** — `context Sales
with auditable` applies the capability to every aggregate in the context — a thin
language feature, not a bespoke macro each.

## Relationships

- **vs aggregate inheritance** ([`aggregate-inheritance.md`](./aggregate-inheritance.md)):
  inheritance is the *vertical* is-a axis (single, nominal, `abstract`/`extends`).
  Capabilities are the *horizontal* mixin axis (multiple, cross-cutting). Keep
  them distinct — a capability is **not** a second inheritance system.
- **vs macros**: typed capabilities subsume the *field/filter/stamp* macros;
  macros revert to pure structural/operation generation. The capability stops
  being "implemented as a macro."
- **vs multi-tenancy**: `tenantRegistry`'s `requires parent` and `tenantOwned`'s
  `provides`/filter/stamp are the motivating clients (one contract, one full
  mixin). Tenancy need not *wait* — R5's conformance check can ship as a small
  tenancy-specific validator first, then generalise into this proposal.

## Migration & back-compat

- Keep `implements "string"` / `filter for "X"` / `stamp for "X"` working as
  **sugar / a deprecation path** so the existing usages don't break; migrate the
  stdlib (`audit`/`softDelete`) to typed `capability` declarations incrementally.
- Each stdlib migration is individually **byte-identical-gated**.

## Scope guardrails (what this is NOT)

Keep it minimal: `requires` + `provides` + `filter`/`stamp` + typed refs +
conformance. **Not** a full trait system — no generics, no default methods, no
capability-implements-capability, no provided *operations* — until a concrete
use case demands each. Operations/structure stay in macros.

## Open questions

1. **Emission deduplication when a capability is reused** *(next design step,
   flagged in session).* When a capability is implemented by many aggregates,
   its `provides` fields / `filter` / `stamp` logic risk being **duplicated**
   N times in generated code. Options: a shared base mapping, the
   marker-interface `OnModelCreating` loop (above), a shared stamper keyed on
   the interface, or per-aggregate copies (status quo). Trade DRY-emission
   against per-entity combination constraints (EF one-filter rule) and
   cross-backend uniformity. **To be designed next.**
2. `Self`-type resolution in `requires` (self-referential contracts) — grammar +
   scope rules.
3. Capability *parameters* (e.g. `softDeletable(by: User)`) — defer unless needed.
4. Whether `provides` defaults/visibility (`internal`, `= false`) need their own
   surface or reuse the field grammar verbatim (lean: reuse).
5. Context-level application surface for the `*ByDefault` cases (`context … with
   X`) — grammar + propagation rules.

## Cross-references

- [`../capabilities.md`](../capabilities.md) — the current (stringly-typed)
  capability reference this evolves.
- [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) R5 — the
  motivating conformance case (`tenantRegistry` / `tenantOwned`).
- [`aggregate-inheritance.md`](./aggregate-inheritance.md) — the orthogonal
  vertical axis.
- `src/macros/stdlib/` — the `audit`/`softDelete`/`crudish` macros this
  reconciles; `ddd.langium:890-910` — the existing `FilterDecl`/`StampDecl`/
  `ImplementsDecl` grammar.
