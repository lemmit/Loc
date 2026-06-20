# Phoenix / Ash TPH emission — design note

> **[2026-06-20 status audit]** 'all three DB backends' understated — the `loom.tph-backend-unsupported` gate admits five (`system-checks.ts:~1230`). Phoenix TPH itself ships (accurate).

> Status: **SHIPPED.** The last TPH ✗ in the parity matrix — TPH (`sharedTable`)
> on **Phoenix / Ash** — closed via the shared-table multi-resource +
> `base_filter` design below; `loom.tph-backend-unsupported` now admits all
> three DB backends (`node` / `dotnet` / `phoenix`). The per-file plan maps 1:1
> onto the diff; `mix compile --warnings-as-errors` against real Ash 3.x (the
> `phoenix-build` `tph.ddd` fixture) is the decisive gate.

## The design problem: Ash has no native STI

Unlike EF Core (`HasDiscriminator`) and Drizzle (a hand-rolled discriminator
column), **Ash 3.x has no native single-table-inheritance.** Two paths were
considered and rejected:

- **`AshParental` extension** — a community STI extension. Rejected: it adds a
  third-party dependency to *every generated Phoenix project*, which the
  toolchain avoids (generated apps depend only on Ash + Phoenix + their pinned
  stack). A generated backend must compile against the stock Ash 3.x dep set
  the `phoenix-build` gate pins.
- **Fat single resource** (one `Party` resource with a `kind` attribute and all
  concrete columns) — rejected: it collapses `Customer`/`Vendor` into one Ash
  resource, destroying Loom's per-concrete aggregate model (each concrete has
  its own struct `.t()`, code-interface `create_*`/`list_*`, LiveView, wire
  shape). It would also diverge structurally from the Hono/.NET TPH wire.

**Chosen: shared-table multi-resource + `base_filter` on a `kind`
discriminator.** ash_postgres supports multiple resources mapping to one table;
each concrete resource declares `table "<base_plural>"`, a `kind` attribute, and
a `base_filter` (with `base_filter_sql`) so it reads/writes only its own rows.
This keeps each concrete a first-class Ash resource (struct, code interface,
LiveView) while sharing one physical table — the TPH contract, and structurally
parallel to .NET (`HasDiscriminator`) / Hono (`kind` column).

## What already exists (verified against code)

- **The shared table** — `src/system/migrations-builder.ts:88` already keeps a
  TPH base (`isTphBase`) and emits ONE table for the hierarchy (base columns +
  every concrete's own columns, nullable; `kind` discriminator). Phoenix
  consumes the same `MigrationsIR` via `migrations-emit.ts`, so **the migration
  side is already done** — the gap is purely the Ash *resource* emission.
- **`base_filter`** — `src/generator/phoenix-live-view/domain-emit.ts:125`
  already emits `base_filter` (Loom's analog to EF `HasQueryFilter`, used for
  capability filters). The TPH `kind` filter reuses this machinery.
- **`postgres do table "…" repo … end`** per resource (`domain-emit.ts:97`).
- **The TPC base reader** — `context-emit.ts:317` emits a polymorphic
  `find all <Base>` as the union of the concretes' `list_*!()` code-interface
  calls (Ash has no cross-resource read action). The TPH base reader is
  identical in shape (the concretes just happen to share a table).
- **The cross-backend contract** — `discriminatorValue(agg) == agg.name`,
  `tableOwnerName(agg) == base` (`src/ir/util/inheritance.ts`).

## Per-file plan

### 1. `src/generator/phoenix-live-view/domain-emit.ts` — the TPH concrete resource
For a TPH concrete (`isTphConcrete`):
- **Table** → `table "<snake plural of tableOwnerName(agg)>"` (the base's shared
  table) instead of its own.
- **`kind` attribute** → `attribute :kind, :string` (string to match the
  cross-backend wire value `agg.name`); not client-writable.
- **Stamp on create** → default the `kind` to the concrete's `discriminatorValue`
  — either `default: "<Concrete>"` on the attribute or a `change set_attribute`
  in the create action. (Decide per what compiles cleanly + round-trips.)
- **`base_filter`** → `base_filter expr(kind == "<Concrete>")` + the
  `base_filter_sql "kind = '<concrete>'"` ash_postgres requires alongside it, so
  each resource sees only its rows.
- **Attributes** → the concrete's full (enrichment-merged) field set, same as a
  standalone resource — the shared table carries every column.

The abstract TPH base owns no resource (same as the TPC base — `isAbstract`
continues are already in place at `domain-emit.ts:59`, `context-emit.ts:72/95`).

### 2. `src/generator/phoenix-live-view/context-emit.ts` — the base reader
Extend the polymorphic-read-home loop (currently `isTpcBase`-gated at line 324)
to also fire for `isTphBase` — the union body is identical (`list_<concrete>!()
++ …`); a TPH concrete's `list_*` already filters by `kind` via its
`base_filter`, so the union is correct without change.

### 3. `src/ir/validate/checks/system-checks.ts` — the gate
Add `phoenix` to `TPH_CAPABLE` (currently `{node, dotnet}`). **Lands with the
emission**, not before.

### 4. Tests + CI
- `phoenix-render`/domain-emit unit tests: a TPH concrete resource emits
  `table "parties"`, `attribute :kind`, `base_filter expr(kind == "Customer")`.
- A phoenix-hosted TPH `.ddd` fixture in the `phoenix-build` matrix —
  `mix compile --warnings-as-errors` against real Ash 3.x is the **decisive
  gate** (no local Elixir; mirrors the showcase phoenix split).

## Open questions — resolved at the `phoenix-build` gate

1. **Two Ash resources, one table** — ✅ Ash 3.x compiles two resources sharing a
   `table` cleanly, no extra config (no `migration_defaults`/reference note
   needed). The decisive unknown; the green gate confirmed it.
2. **`kind` type** — ✅ string (`attribute :kind, :string`), matching the
   cross-backend wire value (`agg.name`).
3. **`base_filter_sql`** — ✅ not needed. `base_filter expr(kind == "<Concrete>")`
   compiles and filters without an explicit `base_filter_sql` companion.
4. **Create-stamp mechanism** — ✅ attribute `default:` (`default: "<Concrete>",
   allow_nil?: false`) rather than a create-action change.
5. **`base_filter` placement** (surfaced at the gate, not anticipated) — it is a
   DSL entry **inside the `resource do … end` section**, not a top-level resource
   macro; emitting it at module top level fails with `undefined function
   base_filter/1`. (This also corrected the latent capability-filter path.)

**Outcome:** shipped in #992. The design was driven the same way .NET TPH was —
push the `tph.ddd` fixture, read the `mix compile` errors, iterate — and cleared
in two gate rounds (a fixture-naming harness fix, then the `base_filter`
placement fix).

## References

- [Ash polymorphic-resources (ash_postgres)](https://hexdocs.pm/ash_postgres/polymorphic-resources.html)
  — native `polymorphic?` is one-resource-many-tables (the inverse of TPH).
- [ash_postgres migrations & tasks](https://hexdocs.pm/ash_postgres/migrations-and-tasks.html)
  — multiple resources sharing a table; `base_filter_sql`.
