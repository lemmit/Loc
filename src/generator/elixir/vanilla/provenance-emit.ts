// ---------------------------------------------------------------------------
// Vanilla provenance runtime — the Elixir counterpart of the Hono
// `domain/provenance.ts` SDK + the .NET `Domain/Common/ProvLineage.cs` +
// `provenance_records` history table.  Emitted only when the project declares
// at least one `provenanced` field on a `foundation: vanilla` deployable.
//
//   - `<App>.Provenance` — the per-process trace buffer (`record/1` push,
//     `drain/0` clear) + the transactional history flush (`flush/1`).  The BEAM
//     has no AsyncLocal, so the buffer rides the process dictionary, exactly
//     like `RequestContext` rides `Logger.metadata`.
//   - `<App>.Provenance.Json` — a pass-through Ecto type (any JSON-encodable
//     term ↔ a jsonb column) so a scalar `computed_value` (e.g. `128`) and a
//     list `inputs` both round-trip through the same jsonb column shape the
//     Hono/.NET lineages use.
//   - `<App>.Provenance.Record` — the append-only history schema, mirroring the
//     Hono `provenance_records` Drizzle table / the .NET `ProvenanceRecord` EF
//     entity column-for-column (governance stamps included).
//   - An extra migration (`…_create_provenance.exs`, a high timestamp so it
//     sorts after every module's initial migration) that adds the co-located
//     `<field>_provenance` jsonb columns + creates `provenance_records`.
//
// The per-write capture (the trace buffer push + the co-located column
// `put_change`) is wired by `operation-returns-emit.ts` / `context-emit.ts`;
// this module owns the shared runtime + history table.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  FieldIR,
  SystemIR,
} from "../../../ir/types/loom-ir.js";
import { resolveDataSourceConfig } from "../../../ir/util/resolve-datasource.js";
import { plural, snake } from "../../../util/naming.js";
import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";

/** The provenanced fields declared on an aggregate (root fields only —
 *  named-operation write sites, which target root columns, are captured). */
export function provenancedFieldsOf(agg: AggregateIR): FieldIR[] {
  return agg.fields.filter((f) => f.provenanced);
}

/** Every provenanced aggregate across the given contexts, with the Postgres
 *  schema its state table lives in (so the migration ALTER TABLE targets the
 *  right `<schema>.<table>`, not `public`).  `schema` is undefined for the
 *  default (`public`) schema. */
export function provenancedAggregates(
  contexts: BoundedContextIR[],
  sys?: SystemIR,
): Array<{ agg: AggregateIR; fields: FieldIR[]; schema?: string }> {
  const out: Array<{ agg: AggregateIR; fields: FieldIR[]; schema?: string }> = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      const fields = provenancedFieldsOf(agg);
      if (fields.length === 0) continue;
      const schema = sys
        ? resolveDataSourceConfig(agg as EnrichedAggregateIR, ctx, sys)?.schema
        : undefined;
      out.push({ agg, fields, schema });
    }
  }
  return out;
}

/** True iff any aggregate in the given contexts declares a `provenanced`
 *  field — gates the whole runtime (helper module + migration + capture). */
export function contextsHaveProvenanced(contexts: BoundedContextIR[]): boolean {
  return provenancedAggregates(contexts).length > 0;
}

/** Snake-cased name of the co-located backing column for a provenanced field
 *  (`total` → `total_provenance`).  Shared by the schema, the op-body capture,
 *  the persist `put_change`, and the migration so all four agree. */
export function provColumn(fieldName: string): string {
  return `${snake(fieldName)}_provenance`;
}

// A timestamp far in the future so this migration sorts after every module's
// initial + delta migrations (parity with the .NET `29991231235959` provenance
// migration), regardless of how many modules the system has.
const PROVENANCE_MIGRATION_VERSION = "29991231000000";

/** Emit the provenance runtime + migration when any provenanced field exists.
 *  No-op otherwise (keeps non-provenance projects byte-identical). */
export function emitVanillaProvenance(
  appName: string,
  appModule: string,
  contexts: BoundedContextIR[],
  out: Map<string, string>,
  sys?: SystemIR,
): void {
  const provAggs = provenancedAggregates(contexts, sys);
  if (provAggs.length === 0) return;
  const appSnake = appName;
  out.set(`lib/${appSnake}/provenance.ex`, renderProvenanceModule(appModule));
  out.set(
    `priv/repo/migrations/${PROVENANCE_MIGRATION_VERSION}_create_provenance.exs`,
    renderProvenanceMigration(appModule, provAggs),
  );
}

/** `<App>.Provenance` + the nested `Json` type + `Record` schema. */
function renderProvenanceModule(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}.Provenance.Json do
  @moduledoc """
  Pass-through Ecto type: any JSON-encodable term (scalar, list or map) ↔ a
  jsonb column.  Lets a provenanced \`computed_value\` (often a bare integer)
  and the \`inputs\` list share the one jsonb shape the Hono/.NET lineages use,
  without Ecto's built-in \`:map\` type rejecting non-map values.
  """
  use Ecto.Type

  @impl true
  def type, do: :map

  @impl true
  def cast(value), do: {:ok, value}

  @impl true
  def load(value), do: {:ok, value}

  @impl true
  def dump(value), do: {:ok, value}
end

defmodule ${appModule}.Provenance.Record do
  @moduledoc "Append-only history row — one per provenanced write."
  use Ecto.Schema

  @primary_key {:trace_id, :string, autogenerate: false}
  schema "provenance_records" do
    field :snapshot_id, :string
    field :target_type, :string
    field :field, :string
    field :inputs, ${appModule}.Provenance.Json
    field :computed_value, ${appModule}.Provenance.Json
    field :at, :utc_datetime
    field :correlation_id, :string
    field :scope_id, :string
    field :actor_id, :string
    field :parent_id, :string
  end
end

defmodule ${appModule}.Provenance do
  @moduledoc """
  Provenance trace buffer + history flush (vanilla foundation).

  Every \`provenanced\` write-site pushes a lineage map onto a per-process
  buffer via \`record/1\`; the named-operation save drains it (\`flush/1\`) into
  the \`provenance_records\` table inside the aggregate's transaction, stamping
  each row with the ambient request-context ids.  The BEAM has no AsyncLocal,
  so the buffer rides the process dictionary (cleared on drain) — the same
  per-process discipline \`RequestContext\` uses for \`Logger.metadata\`.
  """
  alias ${appModule}.Provenance.Record
  alias ${appModule}.RequestContext

  require Logger

  @buffer_key :loom_prov_traces

  @doc "Push one lineage onto the per-process trace buffer; returns it unchanged."
  @spec record(map()) :: map()
  def record(lineage) do
    Process.put(@buffer_key, [lineage | Process.get(@buffer_key, [])])
    lineage
  end

  @doc "Drain + clear the per-process trace buffer (source order restored)."
  @spec drain() :: [map()]
  def drain do
    traces = @buffer_key |> Process.get([]) |> Enum.reverse()
    Process.delete(@buffer_key)
    traces
  end

  @doc """
  Insert every buffered trace into \`provenance_records\` via \`repo\`, stamping
  the ambient correlation / scope / actor / parent ids.  Call inside the save
  transaction so the history commits atomically with the aggregate.
  """
  @spec flush(module()) :: :ok
  def flush(repo) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    rows =
      Enum.map(drain(), fn lin ->
        %{
          trace_id: UUIDv7.generate(),
          snapshot_id: lin.snapshot_id,
          target_type: lin.target.type,
          field: lin.target.field,
          inputs: lin.inputs,
          computed_value: lin.computed_value,
          at: now,
          correlation_id: RequestContext.correlation_id(),
          scope_id: RequestContext.scope_id(),
          actor_id: RequestContext.actor_id(),
          parent_id: RequestContext.parent_id()
        }
      end)

    if rows != [] do
      repo.insert_all(Record, rows)
      ${renderPhoenixLogCall("provenanceRecorded", [
        { name: "aggregate", valueExpr: "hd(rows).target_type" },
        { name: "count", valueExpr: "length(rows)" },
      ])}
    end

    :ok
  end
end
`;
}

/** The ALTER TABLE (co-located columns) + CREATE TABLE (history) migration.
 *  The history table lands in `public` (a cross-context global); each ALTER
 *  carries the owning aggregate's `prefix:` so it targets the right schema. */
function renderProvenanceMigration(
  appModule: string,
  provAggs: Array<{ agg: AggregateIR; fields: FieldIR[]; schema?: string }>,
): string {
  const alters = provAggs.map(({ agg, fields, schema }) => {
    const table = snake(plural(agg.name));
    const prefix = schema ? `, prefix: ${JSON.stringify(schema)}` : "";
    const cols = fields.map((f) => `      add :${provColumn(f.name)}, :map`).join("\n");
    return `    alter table(:${table}${prefix}) do\n${cols}\n    end`;
  });

  return `defmodule ${appModule}.Repo.Migrations.CreateProvenance do
  use Ecto.Migration

  def change do
${alters.join("\n\n")}

    create table(:provenance_records, primary_key: false) do
      add :trace_id, :string, primary_key: true, null: false
      add :snapshot_id, :string, null: false
      add :target_type, :string, null: false
      add :field, :string, null: false
      add :inputs, :map, null: false
      add :computed_value, :map
      add :at, :utc_datetime, null: false
      add :correlation_id, :string
      add :scope_id, :string
      add :actor_id, :string
      add :parent_id, :string
    end

    create index(:provenance_records, [:target_type, :field])
    create index(:provenance_records, [:correlation_id])
  end
end
`;
}
