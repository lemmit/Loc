# Aggregate inheritance

Loom lets one aggregate **extend** another so subtypes share a common field set
and can be queried polymorphically. An `abstract aggregate` declares the shared
base; concrete aggregates `extends` it; the `inheritanceUsing: …` header modifier
picks how the hierarchy maps to tables.

> Design rationale, the full strategy comparison, and the deferred patterns live
> in [`proposals/aggregate-inheritance.md`](old/proposals/aggregate-inheritance.md).
> This page is the reference for what ships today.

## Declaration surface

```ddd
context Parties {
  // The abstract base: shared fields, no table/repo/routes of its own.
  abstract aggregate Party inheritanceUsing: ownTable {
    name: string
    email: string
  }

  // Concrete subtypes inherit Party's fields and add their own.
  aggregate Customer extends Party inheritanceUsing: ownTable {
    creditLimit: decimal
  }
  aggregate Supplier extends Party inheritanceUsing: ownTable {
    rating: int
  }
}
```

- **`abstract aggregate <Name>`** — a base that is never instantiated directly.
  It owns no table, repository, controller, or routes. It may declare fields
  (and derived getters); it may **not** declare lifecycle behaviour
  (`create` / `operation`) or a `repository` (`loom.abstract-aggregate-behavior`,
  `loom.abstract-repository`).
- **`aggregate <X> extends <Base>`** — a concrete subtype. `<Base>` must be an
  `abstract aggregate` in the same context (`loom.extends-non-abstract`,
  `loom.extends-self`).
- **`inheritanceUsing: sharedTable|ownTable`** — the table-mapping strategy,
  declared on the base (and optionally each concrete). Allowed only on an
  abstract base or a concrete subtype (`loom.inheritance-modifier-misplaced`).
  When omitted it defaults to **`sharedTable`** (TPH).

### Field inheritance

A concrete's inherited fields are merged into its `wireShape` by the enrichment
pass: `id`, then the base fields (in declaration order), then the concrete's own
fields. An own field shadows a like-named base field (no override semantics — the
own declaration simply wins). Because the merge is backend-neutral, every backend
DTO for `Customer` carries the same `name` / `email` / `creditLimit` shape.

## Storage strategies

| | `ownTable` — TPC (Table-per-Concrete) | `sharedTable` — TPH (Table-per-Hierarchy) |
|---|---|---|
| Tables | one per concrete (`customers`, `suppliers`); no base table | one shared table named for the base (`parties`) |
| Columns | base + own columns duplicated on each concrete table | base columns + every concrete's columns, per-concrete columns forced nullable |
| Discriminator | none (the table identifies the type) | a non-null `kind` column; each repo filters/stamps it |
| Backends | **all five** (node/Hono, .NET, Phoenix, Python, Java) | **all five** (node/Hono, .NET, Phoenix, Python, Java) |
| `<Base> id` references | rejected (`loom.polymorphic-id-ref-unsupported` — ambiguous FK across N tables) | allowed (unambiguous single-table FK) |

The default is `sharedTable`, so a hierarchy with no `inheritanceUsing: …` is TPH.

### Polymorphic reads (`find all <Base>`)

Both strategies provide a polymorphic read home that returns the union of all
concrete subtypes. The abstract base owns no repository, so the reader is emitted
per backend as infrastructure that **delegates to the concrete loaders** (so
contained parts and `X id[]` associations load correctly) rather than a flat
column union:

This holds for **both** layouts. It used to be a TPC-only property on
node/Hono: the TPH reader hand-rolled `select().from(schema.<base>)` + a `kind`
switch, which meant it read the shared table through none of the machinery the
concrete repositories apply to it — no capability `filter`, no tenancy
predicate, no contained parts. Under `tenantOwned` that is a cross-tenant read
as soon as the reader is routed. Both layouts now delegate.

| Backend (`platform:`) | polymorphic base reader |
|---|---|
| `node` (Hono / Drizzle) | a read-only `<Base>Repository` whose `findAll()` concatenates each concrete repo's `all()`; a `<Base>` discriminated-union response type |
| `dotnet` (.NET / EF Core) | `public abstract class <Base>` carrying the shared fields; concretes declare `: <Base>` and inherit them; EF excludes the base via `modelBuilder.Ignore<<Base>>()` so each concrete maps standalone; a read-only `I<Base>Repository` / `<Base>Repository` whose `FindAllAsync()` returns `IReadOnlyList<<Base>>` |
| `phoenix` (Ecto) | the context module gains `list_<bases>/0` = the union of the concrete `list_<concrete>/0` reads; the base emits no Ecto schema |
| `python` (FastAPI / SQLAlchemy) | a read-only `<Base>` repository whose `find_all` concatenates each concrete repo's reads; a `<Base>` union response type |
| `java` (Spring Boot / JPA) | a read-only `<Base>Repository` whose `findAll()` concatenates each concrete repo's reads; a `<Base>` union response type |

Under TPC, identity stays **per-concrete** (each concrete keeps its own
strongly-typed `<Concrete>Id`); there is no shared `<Base>Id`, and a polymorphic
`<Base> id` reference is rejected — so the readers expose `findAll` only, with no
polymorphic `findById` target. Under TPH the shared table does carry a
single identity, so `<Base> id` refs and a `findById` on the base reader are
available there.

## Backend gating

TPC emission is wired on every backend. TPH emission ships on all five backends
(node/Hono, .NET, Phoenix, Python, Java) — the gate fires only when **no DB
backend** hosts the context, which is an **IR-validate error** (not a warning):
there is no implemented emission target. The error names the offending
platform(s) and suggests either hosting the context on a DB backend deployable
or switching to `inheritanceUsing: ownTable` (which works everywhere).

> Platform-literal note (D-PHOENIX-SURFACE / D-NODE-PLATFORM): the canonical
> backend literals are `node` (the JS runtime, ex-`hono`), `dotnet`, and
> `phoenix` (ex-`phoenixLiveView`). The legacy spellings still parse as aliases.

## Validation rules

| Code | Fires when |
|---|---|
| `loom.extends-non-abstract` | `extends` names an aggregate that is not `abstract` |
| `loom.extends-self` | an aggregate `extends` itself |
| `loom.inheritance-modifier-misplaced` | `inheritanceUsing: …` on an aggregate that is neither an abstract base nor a subtype |
| `loom.abstract-aggregate-behavior` | an abstract base declares `create` / `operation` lifecycle behaviour |
| `loom.abstract-aggregate-contains` | an abstract base declares `contains` — the base owns no repository and concretes do not inherit its parts, so the part's table would have no reader and no writer. Declare the containment on each concrete instead |
| `loom.abstract-repository` | a `repository` targets an abstract base |
| `loom.polymorphic-id-ref-unsupported` | a `<Base> id` reference to an `ownTable` (TPC) base |
| `loom.es-tph-forced-own-table` | event-sourced / document opt-out forces `ownTable` on a TPH member |
| `loom.tph-filter-unsupported` | **.NET only** — a TPH *subtype* carries a capability `filter` whose predicate reads a column the hierarchy ROOT does not declare (see below) |
| `loom.tenancy-inherited-stance-conflict` | a subtype declares the opposite tenancy stance from the base it inherits its columns from (`abstract … with tenantOwned` + `… extends … crossTenant`) |
| (storage gate) | a `sharedTable` (TPH) hierarchy whose context has no node/Hono, .NET, Phoenix, Python, or Java host |

## Capabilities and inheritance — what propagates and what does not

Only the base's **fields** are merged onto a subtype (by the enrich pass). Its
capability *identity* is not: a stance, a stamp and a capability `filter` all
stay on the aggregate that declared them. Two consequences worth stating,
because both used to be silent:

- **Declare the tenancy stance on every concrete.** `abstract aggregate Vehicle
  with tenantOwned` gives every subtype the `tenant_id` column, but nothing
  stamps or filters it until the subtype says `with tenantOwned` too. A subtype
  with no stance is `loom.tenancy-stance-unmarked`; one that says `crossTenant`
  against a `tenantOwned` base is `loom.tenancy-inherited-stance-conflict`.
- **A subtype's `filter` reads through the hierarchy.** `criterion Live of Car =
  !this.retired` works when `retired` lives on the abstract base — the predicate
  is typed and lowered against the merged field set on every backend.

### The one .NET restriction

EF Core registers a query filter on the **root** entity type of a hierarchy
only. Loom therefore hosts every TPH filter on the root config, guarding a
subtype's filter with the discriminator so it constrains that subtype's rows
alone and prefixing its name (`Car_LiveFilter`) so two subtypes carrying the
same capability cannot overwrite each other's key:

```csharp
// VehicleConfiguration.cs — `criterion Live of Car = !this.retired`
builder.HasQueryFilter("Car_LiveFilter", x => EF.Property<string>(x, "kind") != "Car" || (!x.Retired));
```

A predicate reading a **subtype-only** column cannot be hosted that way at all
(the root-typed lambda has no such member, and both workarounds — a CLR downcast
and `EF.Property` — fail as soon as the query source is a sibling subtype), so
it is rejected with `loom.tph-filter-unsupported`. Move the field to the
abstract base, switch to `inheritanceUsing: ownTable`, or host the context off
.NET. The other four backends have no such restriction.

## Deferred (gated, not emitted)

- **Mixed strategy (proposal Pattern 3)** — a per-concrete `inheritanceUsing: ownTable`
  override of a TPH base, and the `UNION ALL` `find all <Base>` it would require,
  are rejected (`loom.tph-own-override-unsupported`,
  `loom.polymorphic-id-ref-mixed-strategy`).
- **`contains` on a TPH concrete (proposal Pattern 4)** — now **supported**: the
  part emits its own table FK'd to the shared base table (TPT-via-`contains`,
  since a TPH concrete's id is the shared-table row id); `loom.tph-contains-unsupported`
  is no longer emitted. TPC concretes are unaffected — each is a standalone table
  and its parts join normally.
- **TPH on React** — N/A; the frontend consumes the concrete wire shapes, it
  does not own storage. TPH ships on node/Hono (`kind` column), .NET (EF Core
  `HasDiscriminator`), Phoenix (Ecto shared-table schemas self-filtering on
  the `kind` column), Python, and Java; see backend gating above.
