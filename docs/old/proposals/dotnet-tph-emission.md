# .NET TPH emission — design note

> **[2026-06-20 status audit]** Inline `TPH_CAPABLE = {node, dotnet, elixir}` quote is stale — actual set is five (`{…, python, java}`, `system-checks.ts:~1230`). .NET TPH itself ships (accurate).

> Status: **SHIPPED**. [`aggregate-inheritance.md`](./aggregate-inheritance.md)
> **I2** — TPH (`sharedTable`) storage on the **.NET / EF Core** backend.
> Phoenix TPH has since shipped too (see
> [`phoenix-tph-emission.md`](./phoenix-tph-emission.md)) — TPH is now
> live on all five DB backends (`TPH_CAPABLE = {node, dotnet, elixir, python, java}`
> in `src/ir/validate/checks/system-checks.ts`).
> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only, so elixir TPH is the vanilla Ecto emission; `foundation: ash` is now a validation error.)**
>
> Prereq (PR #975): the TPH/TPC predicates are consolidated in the
> platform-neutral `src/ir/util/inheritance.ts`, so the .NET generator
> imports them without crossing platform folders. This doc records the
> design that landed; the per-file plan below maps 1:1 onto the diff.

## What shipped (the pre-landing state this note was written against)

At the time this note was written, TPH existed on Hono/Drizzle only
(`src/generator/typescript/emit/schema.ts:emitTphTable`); .NET had TPC
(`emit/entity.ts:renderAbstractBaseEntity` + `efcore.ts:Ignore<Base>()`)
but TPH was gated by `loom.tph-backend-unsupported`, and Phoenix had
neither. **Today TPC and TPH both ship on all five DB backends.**

So the .NET frontier was **TPH only** (TPC already shipped). EF Core has
native TPH (`HasDiscriminator`), so EF derives the single wide table from
the model — no hand-built DDL (`.NET` uses the EF model via
`EnsureCreated`, not `MigrationsIR`).

## Cross-backend parity contract (pin to Hono — `emit/schema.ts:emitTphTable`)

- **One table** named for the abstract base (snake-plural of base name).
- A single **`id`** primary-key column (plain string/uuid — *not* a
  per-concrete strongly-typed id).
- A **`kind`** discriminator column; discriminator **value = the concrete
  aggregate's own name** (`discriminatorValue(agg, pool)` ⇒ `agg.name`).
- Base fields, then **each concrete's own fields forced nullable**
  (`ownFieldsOf(concrete, base)`).

The decisive consequence for .NET: **the base owns the shared `Id`**
(typed `<Base>Id`); **concretes inherit it** and declare no `Id` of their
own. This is the one structural divergence from the shipped TPC path
(where the base declares *no* `Id` and each concrete keeps its own
`<Concrete>Id`).

## Per-file plan

### 1. `src/ir/validate/checks/system-checks.ts` — relax the gate
`validateInheritanceStorage`: replace the `hostedByHono =
backendPlatforms.has("node")` check with a `TPH_CAPABLE = {node, dotnet}`
set (`hostedByCapable = [...backendPlatforms].some(p =>
TPH_CAPABLE.has(p))`); update the `others` filter + the diagnostic text
("Hono and .NET backends"). **Lands with emission, not before** — relaxing
alone would let a dotnet-TPH model pass validate and emit broken code.

### 2. `src/generator/dotnet/emit/entity.ts`
- **`renderAbstractBaseEntity(base, ns, { tph })`** — add a `tph` flag.
  When set, the base is a *mapped* abstract class that **owns the key**:
  emit `public <Base>Id Id { get; internal set; }` + a private
  parameterless ctor (EF) setting `Id = default!`. (TPC base stays
  Id-less.)
- **`SuperTypeInfo`** — add `sharesIdentity?: boolean`. For a TPH
  concrete (`true`): in `renderEntity`, **skip the `Id` property line**
  (line ~114) and its `ctor` assignment (Id is inherited); the
  `State` / `_Create` / `Create` factory keep setting `Id` via the
  inherited `internal set` accessor, but typed as the **base's** id
  (`createInputFieldList` already excludes `id`; the synthesized `id`
  in `_Create`/`Create` uses `<Base>Id`). Audit each `entity.name`Id`
  reference in the Create/State path and switch to the base id type when
  `sharesIdentity`.

### 3. `src/generator/dotnet/emit/efcore.ts`
- **DbContext (`renderDbContext`)**: a TPH base is **no longer
  `Ignore<Base>()`d** — add `DbSet<Base> <BasePlural>` and an
  `ApplyConfiguration(new <Base>Configuration())`. TPH concretes keep
  their `DbSet<Concrete>` (EF auto-filters by discriminator).
- **`renderConfiguration(agg, ns, ctx, { tph })`**:
  - *TPH base* → `ToTable("<baseplural>")` + `HasKey(x => x.Id)` +
    `HasDiscriminator<string>("kind")` chained
    `.HasValue<C>("C")` over `tphConcretesOf(base, pool)` + the base's
    own property configs.
  - *TPH concrete* → **no `ToTable` / `HasKey`** (inherited); configure
    only `ownFieldsOf(concrete, base)` (strongly-typed id/VO/enum
    `HasConversion`s) — EF maps them as the shared table's nullable
    columns.

### 4. `src/generator/dotnet/index.ts`
- The `if (agg.isAbstract) { renderAbstractBaseEntity; return; }` early
  exit gains a TPH branch: a **TPH base** emits the mapped class +
  `<Base>Configuration.cs` (with `HasDiscriminator`) and is added to the
  DbContext — it is *not* a no-table abstract.
- The concrete dispatch grows a `tphBase` lookup
  (`isTphBase` parallel to the existing `tpcBase`/`isTpcBase`):
  pass `superType.sharesIdentity = true`; for a TPH concrete the
  per-aggregate configuration is the concrete (own-fields-only) variant,
  and **no separate table / join config** for the shared columns.
- Repositories/routes for TPH concretes are unchanged in shape — EF's
  `DbSet<Concrete>` routes to the shared table and applies the
  discriminator automatically.

### 5. Tests + CI
- `test/generator/dotnet/*` — vitest emitted-string assertions:
  base config contains `HasDiscriminator<string>("kind").HasValue<…>`;
  concrete class is `: <Base>` with no `Id` property; concrete config has
  no `ToTable`.
- **`examples/tph-dotnet.ddd`** fixture (abstract base + 2 concretes,
  `inheritanceUsing(sharedTable)`, dotnet deployable) added to the
  `build-generated-dotnet` matrix — `dotnet build /warnaserror` is the
  **decisive** compile gate (no local SDK; the P3b/P4c pattern).

## Risk / sequencing

The structural risk is concentrated in **§2** (the base-owns-`Id`
restructure). EF config (§3) is mechanical once the entity shape is right.

### Status of the in-flight implementation (#981)

§1–§5 of the **domain + storage** layer are implemented and the
`dotnet-build` gate confirmed them after two fixes CI surfaced:
- `PartyId` is now emitted for the TPH base (`context-scaffolding-emit.ts`
  was skipping every abstract aggregate's id class).
- the concrete no longer re-declares the base's synthesized `inspect`
  derived (CS0108) — `SuperTypeInfo.derivedNames` filters inherited
  derived members, as it already does for inherited fields.

**Remaining (the larger follow-on the `<Concrete>Id` → `<Base>Id` shift
forces):** because EF-native TPH keys the whole hierarchy on the base's
`PartyId`, a TPH concrete's id is `PartyId` *everywhere* — but the
application layer still emits `CustomerId` (~49 `${agg.name}Id` sites
across `cqrs/commands.ts`, `cqrs/queries.ts`, `dto-mapping.ts`,
`emit/api.ts`, `emit/repository.ts`, the wire DTO). The clean fix is a
single `concreteIdClass(agg, ctx)` helper (`isTphConcrete(agg) ?
<base>Id : <agg>Id`) routed through those emit sites, so the repository
`GetByIdAsync`, the `ICommand<…>` / command-record id params, the query
id, the controller route param, and the response DTO all name the shared
`PartyId`. That threading is the bulk of the remaining work; it's
mechanical but wide, and `dotnet build /warnaserror` is the gate.

Phoenix TPH is a separate, later slice. **(Superseded 2026: the Ash foundation was removed; the elixir TPH that shipped is the plain-Ecto emission — `foundation: ash` is now a validation error.)**
