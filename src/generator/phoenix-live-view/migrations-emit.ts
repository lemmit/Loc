import type {
  AggregateIR,
  AssociationIR,
  BoundedContextIR,
  FieldIR,
  TypeIR,
} from "../../ir/loom-ir.js";
import { plural, snake } from "../../util/naming.js";

/** True for `Id<T>[]` reference-collection fields — they persist via a
 * separate join table (emitted below), not a column on this row. */
function isRefCollection(t: TypeIR): boolean {
  return t.kind === "array" && t.element.kind === "id";
}

// ---------------------------------------------------------------------------
// Migration emission for Phoenix LiveView / Ash.
//
// For each aggregate (collected in stable name order across all contexts),
// emit a single Ecto migration file:
//   priv/repo/migrations/<timestamp>_create_<table>.exs
//
// Base timestamp: 20260101000000 + index offset (1 per aggregate) keeps
// file ordering deterministic across regens regardless of when the
// generator runs.
//
// Standard CRUD Ash generates means we still need the schema/table;
// AshPostgres will run `ash.migrate` which executes these files.
// ---------------------------------------------------------------------------

const BASE_TIMESTAMP = 20260101000000;

export function emitMigrations(
  _appName: string,
  contexts: BoundedContextIR[],
  appModule: string,
  out: Map<string, string>,
): void {
  // Collect all aggregates in stable order: by context name, then by
  // aggregate name within context.
  const allAggregates: Array<{ agg: AggregateIR; ctx: BoundedContextIR }> = [];
  const sortedContexts = [...contexts].sort((a, b) => a.name.localeCompare(b.name));
  for (const ctx of sortedContexts) {
    const sortedAggs = [...ctx.aggregates].sort((a, b) => a.name.localeCompare(b.name));
    for (const agg of sortedAggs) {
      allAggregates.push({ agg, ctx });
    }
  }

  for (let i = 0; i < allAggregates.length; i++) {
    const { agg } = allAggregates[i]!;
    const timestamp = BASE_TIMESTAMP + i;
    const tableName = plural(snake(agg.name));
    const migrationName = `Create${agg.name}s`; // PascalCase plural
    const path = `priv/repo/migrations/${timestamp}_create_${tableName}.exs`;
    const content = renderMigration(agg, migrationName, tableName, appModule);
    out.set(path, content);

    // Also emit part-entity migrations (child tables)
    for (let j = 0; j < agg.parts.length; j++) {
      const part = agg.parts[j]!;
      // sub-offset: add 0.1, 0.2 etc — but timestamps must be integers.
      // Use a large offset range: allAggregates.length * 10 + i*10 + j+1
      const partTimestamp = BASE_TIMESTAMP + allAggregates.length * 10 + i * 10 + (j + 1);
      const partTable = plural(snake(part.name));
      const partMigrationName = `Create${part.name}s`;
      const partPath = `priv/repo/migrations/${partTimestamp}_create_${partTable}.exs`;
      const partContent = renderPartMigration(part, agg, partMigrationName, partTable, appModule);
      out.set(partPath, partContent);
    }
  }

  // Join-table migrations come AFTER every aggregate / part has been
  // created so the `references(:owner, …)` and `references(:target, …)`
  // FK targets resolve.  Offset base is well above the part block.
  const joinBase = BASE_TIMESTAMP + allAggregates.length * 100;
  let joinIdx = 0;
  for (const { agg } of allAggregates) {
    for (const assoc of agg.associations ?? []) {
      const ts = joinBase + joinIdx;
      joinIdx += 1;
      const migrationName = `Create${pascalSnake(assoc.joinTable)}`;
      const path = `priv/repo/migrations/${ts}_create_${assoc.joinTable}.exs`;
      out.set(path, renderJoinMigration(assoc, migrationName, appModule));
    }
  }
}

/** "trainer_party" → "TrainerParty" — for migration module names. */
function pascalSnake(s: string): string {
  return s
    .split("_")
    .map((w) => (w.length === 0 ? "" : w[0]!.toUpperCase() + w.slice(1)))
    .join("");
}

function renderMigration(
  agg: AggregateIR,
  migrationName: string,
  tableName: string,
  appModule: string,
): string {
  const columns = buildColumns(agg.fields, agg.idValueType);
  return `defmodule ${appModule}.Repo.Migrations.${migrationName} do
  use Ecto.Migration

  def change do
    create table(:${tableName}, primary_key: false) do
      add :id, ${idColumnType(agg.idValueType)}, primary_key: true, null: false
${columns}
      timestamps()
    end
${buildIndexes(agg)}
  end
end
`;
}

function renderPartMigration(
  part: import("../../ir/loom-ir.js").EntityPartIR,
  parentAgg: AggregateIR,
  migrationName: string,
  tableName: string,
  appModule: string,
): string {
  const parentTable = plural(snake(parentAgg.name));
  const columns = buildColumns(part.fields, parentAgg.idValueType);
  return `defmodule ${appModule}.Repo.Migrations.${migrationName} do
  use Ecto.Migration

  def change do
    create table(:${tableName}, primary_key: false) do
      add :id, ${idColumnType(parentAgg.idValueType)}, primary_key: true, null: false
      add :${snake(parentAgg.name)}_id, references(:${parentTable}, type: ${idColumnType(parentAgg.idValueType)}, on_delete: :delete_all), null: false
${columns}
      timestamps()
    end
${buildPartIndexes(parentAgg)}
  end
end
`;
}

function buildColumns(fields: FieldIR[], idValueType: string): string {
  return (
    fields
      // Reference collections live in their own join table — no column on
      // the owner row.  Same suppression as in the Ash resource emitter.
      .filter((f) => !isRefCollection(f.type))
      .map((f) => {
        const col = fieldToColumn(f, idValueType);
        return `      add :${snake(f.name)}, ${col.type}${col.opts}`;
      })
      .join("\n")
  );
}

function renderJoinMigration(
  assoc: AssociationIR,
  migrationName: string,
  appModule: string,
): string {
  const ownerTable = plural(snake(assoc.ownerAgg));
  const targetTable = plural(snake(assoc.targetAgg));
  return `defmodule ${appModule}.Repo.Migrations.${migrationName} do
  use Ecto.Migration

  def change do
    create table(:${assoc.joinTable}, primary_key: false) do
      add :${snake(assoc.ownerFk)}, references(:${ownerTable}, type: :uuid, on_delete: :delete_all), null: false, primary_key: true
      add :${snake(assoc.targetFk)}, references(:${targetTable}, type: :uuid, on_delete: :delete_all), null: false, primary_key: true
      # Ordinal is nullable + defaulted (0) so plain
      # manage_relationship writes succeed without per-row ordinal
      # injection.  See join-resource-emit.ts for the parity note.
      add :ordinal, :integer, null: true, default: 0
    end
    create index(:${assoc.joinTable}, [:${snake(assoc.targetFk)}])
  end
end
`;
}

interface ColumnSpec {
  type: string;
  opts: string;
}

function fieldToColumn(field: FieldIR, _idValueType: string): ColumnSpec {
  const nullable = field.optional ? ", null: true" : ", null: false";
  const t = typeToEctoColumn(field.type);
  return { type: t.colType, opts: `${t.opts}${nullable}` };
}

interface ColType {
  colType: string;
  opts: string;
}

function typeToEctoColumn(t: TypeIR): ColType {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
          return { colType: ":integer", opts: "" };
        case "long":
          return { colType: ":bigint", opts: "" };
        case "decimal":
          return { colType: ":decimal", opts: "" };
        case "money":
          // `precision: 19, scale: 4` is the finance default —
          // matches Drizzle's money column shape so cross-backend
          // schema migrations are structurally identical.
          return { colType: ":decimal", opts: ", precision: 19, scale: 4" };
        case "string":
          return { colType: ":text", opts: "" };
        case "bool":
          return { colType: ":boolean", opts: "" };
        case "datetime":
          return { colType: ":utc_datetime", opts: "" };
        case "guid":
          return { colType: ":uuid", opts: "" };
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      // Foreign key reference — raw UUID
      return { colType: ":uuid", opts: "" };
    case "enum":
      return { colType: ":text", opts: "" }; // Ash stores atoms as text
    case "valueobject":
      return { colType: ":map", opts: "" }; // Embedded as JSON
    case "entity":
      return { colType: ":map", opts: "" };
    case "array":
      return { colType: `{:array, ${typeToEctoColumn(t.element).colType}}`, opts: "" };
    case "optional":
      return typeToEctoColumn(t.inner);
  }
}

function idColumnType(idValueType: string): string {
  switch (idValueType) {
    case "int":
      return ":integer";
    case "long":
      return ":bigint";
    case "string":
      return ":string";
    default:
      return ":uuid";
  }
}

function buildIndexes(agg: AggregateIR): string {
  const idxLines: string[] = [];
  for (const field of agg.fields) {
    if (field.type.kind === "id") {
      const tableName = plural(snake(agg.name));
      idxLines.push(`    create index(:${tableName}, [:${snake(field.name)}])`);
    }
  }
  return idxLines.join("\n") + (idxLines.length > 0 ? "\n" : "");
}

function buildPartIndexes(parentAgg: AggregateIR): string {
  const partTable = `${plural(snake(parentAgg.name))}`;
  void partTable;
  return "";
}

export { plural, snake };
