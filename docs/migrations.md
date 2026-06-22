# Migrations

`MigrationsIR` is the schema delta a generated stack applies to bring its
Postgres database in line with the `.ddd` source. It is the **only secondary IR
in the compiler** — every backend consumes `LoomModel` directly for everything
else, but schema migration is the one place where (a) the table layout is a pure
function of the enriched IR that every DB backend needs identically, and (b) the
output is *stateful* (it diffs against what was emitted last time). Deriving it
once in phase ⑨ and handing the same `MigrationsIR[]` to Drizzle, EF Core, Ecto,
Flyway, and the Python runner means a schema change is bit-for-bit equivalent
across all five backends — cross-backend consistency falls out of having one
canonical source rather than five hand-kept emitters.

> Builder: [`src/system/migrations-builder.ts`](../src/system/migrations-builder.ts).
> Type: [`src/ir/types/migrations-ir.ts`](../src/ir/types/migrations-ir.ts).
> SQL renderer: [`src/generator/sql-pg.ts`](../src/generator/sql-pg.ts).

## The shape

One `MigrationsIR` is produced **per owning module**:

```ts
interface MigrationsIR {
  module: string;        // .loom/snapshots/<module>.snapshot.json is keyed here
  storageName: string;   // physical storage binding (pg, analyticsDb), or ""
  baseline: SchemaSnapshot | null;   // last regen's schema, null on first run
  next: SchemaSnapshot;              // schema the current source describes
  steps: MigrationStep[];            // ordered ops baseline → next; [] = no-op
  version: string;       // YYYYMMDDHHMMSS slug, drives file ordering
  name: string;          // "Initial", "AddOrderStatus", …
}
```

A `SchemaSnapshot` is an alphabetically-sorted list of `TableShape`s
(`{ name, schema?, columns, primaryKey, foreignKeys, indexes }`). `MigrationStep`
is a closed union of `createTable` / `dropTable` / `addColumn` / `dropColumn` /
`alterColumnNullable` / `alterColumnType` / `addIndex` / `dropIndex`. Backends
only translate steps to native syntax — they never re-derive the schema from the
IR.

## Phase ⑨ derivation

`buildMigrations(sys, snapshots)` (called by the system orchestrator, not by
`ir/`) walks every module:

1. Skip modules with no `migrationsOwner` (frontend-only subdomains emit nothing).
2. Build `next = schemaFromModule(module, shapeOf, schemaOf)` — the table list
   the current source describes.
3. Read `baseline` from the `SnapshotStore` (`.loom/snapshots/<module>.snapshot.json`).
4. `steps = diffSchema(baseline, next)` — a pure diff. Same snapshot in ⇒ empty
   steps, so regenerating a clean repo is a no-op.
5. Stamp `next` with the bumped `version` (monotonic: `String(BigInt(lastVersion)
   + 1n)`, starting from `BASE_TIMESTAMP = "20260101000000"`) and append to
   `migrationHistory`, then write it back to disk as the next baseline.

`diffSchema` emits drops first, then creates **ordered by FK dependency** (Kahn's
sort with an alphabetical tiebreak) so an inline `REFERENCES` never points at a
not-yet-created table, then per-table column/index diffs.

## `migrationsOwner` — one backend per module owns schema

Schema emission is assigned to exactly one deployable per module so two backends
sharing a module don't both create the tables. `assignMigrationsOwner`
([`enrichments.ts`](../src/ir/enrich/enrichments.ts)) walks `sys.deployables` in
declaration order and picks the **first deployable that hosts any context of the
module AND whose platform owns a database** (`PlatformSurface.needsDb`, read via
`descriptorFor` — no hardcoded platform list). Failing that, `migrationsOwner`
stays undefined and no migrations are emitted.

At distribution time (`migrationsForDeployable` in
[`system/index.ts`](../src/system/index.ts)), every `needsDb` deployable that hosts
a context of the module still *receives* that module's `MigrationsIR` (each
compose service has its own database, so each must run the migrations) — but only
the `migrationsOwner` derivation gates whether the slice is built at all.

## How IR maps to tables

`schemaFromModule` collects every aggregate in the module (alphabetical) and
produces tables. The shape depends on the aggregate's saving shape, persistence
mode, and inheritance:

**Aggregate → table.** `aggregate Order` → table `orders` (`plural(snake(name))`),
`id` PK typed from `idValueType`, one column per scalar/enum/`X id` field.

```ddd
context Sales {
  aggregate Order {
    placedAt: datetime
    customer: Customer id
    status: OrderStatus
  }
}
```

```sql
CREATE TABLE orders (
  id UUID NOT NULL,
  placed_at TIMESTAMP WITH TIME ZONE NOT NULL,
  customer_id UUID NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (customer_id) REFERENCES customers ON DELETE RESTRICT
);
CREATE INDEX orders_customer_id_idx ON orders (customer_id);
```

A `Customer id` field becomes a `customer_id` FK (`ON DELETE RESTRICT`) plus a
covering index. Type mapping: `int→INTEGER`, `long→BIGINT`, `decimal`/`money→
DECIMAL`, `string→TEXT`, `bool→BOOLEAN`, `datetime→TIMESTAMP WITH TIME ZONE`,
`guid→UUID`, `json→JSONB`.

**Containments → child tables.** A contained entity part gets its own table with
a `<parent>_id` FK (`ON DELETE CASCADE`) back to the owner. The FK-dependency
sort guarantees the parent is created first even though `pipelines` sorts before
`projects` alphabetically.

**Value objects → flattened columns.** A `price: Money` field destructures into
`price_amount`, `price_currency` (recursively for nested VOs), each tagged with a
`voGroup` so Phoenix/Ash can regroup them into a single `:map`. Relational
backends emit the columns as-is.

**Reference collections → join tables.** A `X id[]` field never produces a column.
Enrichment derives one `AssociationIR` per such field, and the builder lays down a
join table keyed by `(owner_fk, target_fk)` with both FKs `ON DELETE CASCADE` plus
an `ordinal` column (nullable, default `0`).

```ddd
aggregate Order { items: Product id[] }
```

```sql
CREATE TABLE order_items (
  order_id UUID NOT NULL,
  product_id UUID NOT NULL,
  ordinal INTEGER NULL DEFAULT 0,
  PRIMARY KEY (order_id, product_id),
  FOREIGN KEY (order_id) REFERENCES orders ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products ON DELETE CASCADE
);
CREATE INDEX order_items_product_id_idx ON order_items (product_id);
```

A VO *array* (`charges: Money[]`) produces an id-less child table
(`<parent>_<field>`) of flattened VO columns keyed by `(parent_fk, ordinal)`;
Phoenix skips it (it stores the array inline as `{:array, :map}`).

**Inheritance.** TPC (`inheritanceUsing(ownTable)`): the abstract base emits **no
table**, each concrete is standalone with the merged field set. TPH
(`sharedTable`): one shared table named for the base, with `id`, a `kind`
discriminator (`TEXT NOT NULL`), the base's own columns, then every concrete's own
columns **forced nullable** and de-duplicated by name. A TPH concrete's contained
parts FK to the shared base table. See [`inheritance.md`](inheritance.md).

**Other persistence shapes.** `shape(document)` → a `(id, data jsonb, version int)`
triple; `shape(embedded)` → a queryable root row with one JSONB column per
containment; `persistedAs(eventLog)` and `eventSourced` workflows → an append-only
`<name>_events` stream keyed by `(stream_id, version)`. Correlation-bearing
workflows get a state table; a durable channel adds the shared `__loom_outbox`
table.

**Schema qualification.** Each table is stamped with its owning context's Postgres
schema (`snake(context.name)` by default, or the dataSource `schema:` override).
The SQL renderer emits `CREATE SCHEMA IF NOT EXISTS` and qualifies table/FK/index
references. `undefined` means the unqualified `public` schema.

## The Postgres SQL renderer

`renderPgStep(step)` ([`src/generator/sql-pg.ts`](../src/generator/sql-pg.ts))
translates one `MigrationStep` to Postgres DDL. It is **shared by the TS, .NET,
Python, and Java backends** — calling the same renderer means a migration written
by any of them is bit-for-bit equivalent SQL. Phoenix is the exception: it stays
in Ecto DSL (its output is Elixir, not SQL) so AshPostgres + `ecto.migrate` keep
working, and translates `MigrationStep` itself in
[`elixir/migrations-emit.ts`](../src/generator/elixir/migrations-emit.ts).

It also exports `renderSeedRowInsert` (the `raw` seed-path `INSERT`, shared so
seed SQL is bit-identical cross-backend).

## Where output lands, and boot-time application

| Backend | Output path | Applied at boot via |
|---|---|---|
| Hono / Drizzle | `db/migrations/<tag>.sql` + `meta/_journal.json` | `migrate()` from `drizzle-orm/node-postgres/migrator` (also `npm run db:migrate`) |
| .NET / EF Core | `Migrations/<slug>.cs` (`migrationBuilder.Sql(...)`) | `Database.Migrate()` → `__EFMigrationsHistory` |
| Phoenix / Ecto | `priv/repo/migrations/<ts>_create_<table>.exs` | `ecto.migrate` (Ash or vanilla foundation) |
| Java / Spring | `src/main/resources/db/migration/V<v>.<n>__<Mod>_<Name>.sql` | Flyway |
| Python / FastAPI | `migrations/<tag>.sql` | `run_migrations()` from the FastAPI lifespan; `__loom_migrations` tracking table |

Files use a module-qualified tag (`<version>_<module>_<name>`) because every
module's *initial* migration shares `BASE_TIMESTAMP` + `"Initial"` — without the
module, filenames and migration ids collide and only the last module's tables
survive. Down migrations are no-ops everywhere (operators roll forward, not back).

Some feature DDL is **not** part of the platform-neutral `MigrationsIR` — provenance
(`<field>_provenance` jsonb columns + `provenance_records`) and per-operation audit
(`audit_records`) are feature-local and hand-emitted by each backend as a *late*
migration (a far-future version like `29991231235959`) that sorts after every
module's initial migration so the tables already exist when the `ALTER`s run.

## Relationship to `.loom/` and `wire-spec.json`

Two `.loom/` artifacts come out of phase ⑨ and are easy to conflate:

- **`.loom/snapshots/<module>.snapshot.json`** *is* the migration baseline — the
  serialized `SchemaSnapshot` (`next`) written on every `generate system` run and
  diffed on the next regen. Tracked in git so the diff is stable across machines.
- **`.loom/wire-spec.json`** is the JSON-Schema-shaped derivation of every
  aggregate's `wireShape` — the network contract, not the database schema. Both are
  diffable change detectors, but they describe different surfaces (the JSON over the
  wire vs. the tables on disk).

See [`loom-artifacts.md`](loom-artifacts.md) for the full `.loom/` bundle and
[`technical.md`](technical.md) § Phase ⑨ for the orchestration walk-through.
