// ---------------------------------------------------------------------------
// Vanilla `shape(document)` persistence (DEBT-07) — the plain-Ecto counterpart
// of the node/dotnet/python/java document emit.
//
// A document-shaped aggregate persists as ONE jsonb column — the canonical
// `(id, data, version)` table the migrations-builder already emits — instead of
// the normalised table-per-entity tree.  Vanilla has no domain instance to
// serialise (unlike Python's `_to_doc(aggregate)`); its validation layer is the
// Ecto changeset, so the faithful equivalent of "validate through the normal
// path, then serialise" is a **schemaless changeset** (`cast({%{}, @types},
// attrs, …)` + the same `validate_required` / invariant validators the
// relational `base_changeset` runs) whose validated map IS the stored document.
// Document and relational therefore share one validation contract; only the
// storage differs.  Reads merge `data` back over the id (`serialize/1`); the
// wire shape is identical to the relational path (snake-cased field keys).
//
// v1 scope: CRUD aggregates (`with crudish`).  Custom finds + named operations
// on a document aggregate are gated at validate time
// (`loom.vanilla-document-unsupported`) rather than misgenerated — see
// `validateVanillaDocumentScope`.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  FieldIR,
  SystemIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { isDocumentShaped, resolveDataSourceConfig } from "../../../ir/util/resolve-datasource.js";
import {
  type SingleFieldPattern,
  singleFieldConstraints,
} from "../../../ir/validate/invariant-classify.js";
import { elixirRegexBody, plural, snake, upperFirst } from "../../../util/naming.js";
import { managedTimestampNames } from "./managed-timestamps.js";

/** True iff the aggregate's effective saving shape is `document` (binding-aware,
 *  matching the migration + validator).  `sys` may be absent in a few legacy
 *  test paths — then the header alone decides (`agg.savingShape`). */
export function isVanillaDocAgg(agg: AggregateIR, ctx: BoundedContextIR, sys?: SystemIR): boolean {
  const enriched = agg as EnrichedAggregateIR;
  const resolved = sys ? resolveDataSourceConfig(enriched, ctx, sys) : undefined;
  return isDocumentShaped(enriched, resolved);
}

/** The aggregate's stored document fields (declared fields minus `id` and any
 *  server-managed `createdAt`/`updatedAt` stamp/audit column), snake-cased — the
 *  schemaless-changeset cast/required allow-list.  A plain declared timestamp
 *  field stays in (cast like any column). */
function docFields(agg: AggregateIR): FieldIR[] {
  const managedTs = managedTimestampNames(agg);
  return agg.fields.filter((f) => f.name !== "id" && !managedTs.has(f.name));
}

/** Ecto type atom for a schemaless `cast/3` types map.  Simpler than the
 *  schema column type: an enum casts as a plain `:string` (no `Ecto.Enum`
 *  schemaless support), a value object / json as `:map`, an id as
 *  `:binary_id`. */
function castType(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return ":integer";
        case "decimal":
        case "money":
          return ":decimal";
        case "bool":
          return ":boolean";
        case "datetime":
          return ":utc_datetime";
        case "guid":
          return "Ecto.UUID";
        case "json":
          return ":map";
        default:
          return ":string";
      }
    case "id":
      return ":binary_id";
    case "enum":
      return ":string";
    case "valueobject":
      return ":map";
    case "array": {
      const inner = castType(t.element);
      return `{:array, ${inner}}`;
    }
    case "optional":
      return castType(t.inner);
    default:
      return ":string";
  }
}

// ---------------------------------------------------------------------------
// Schema — `(id, data, version)`.
// ---------------------------------------------------------------------------

export function renderDocSchema(
  appModule: string,
  ctxModule: string,
  agg: AggregateIR,
  schemaPrefix?: string,
): string {
  const moduleName = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  const tableName = snake(plural(agg.name));
  const prefixLine = schemaPrefix ? `  @schema_prefix ${JSON.stringify(schemaPrefix)}\n` : "";
  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc "Document-shaped aggregate — the whole tree persists as one jsonb \`data\` blob."
  use Ecto.Schema

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id
${prefixLine}
  schema "${tableName}" do
    field :data, :map
    field :version, :integer, default: 1
    timestamps(type: :utc_datetime)
  end
end
`;
}

// ---------------------------------------------------------------------------
// Changeset — schemaless validation over the document fields.
// ---------------------------------------------------------------------------

function ectoValidator(field: string, p: SingleFieldPattern): string {
  switch (p.kind) {
    case "min":
      return `    |> validate_number(:${field}, greater_than_or_equal_to: ${p.n})`;
    case "max":
      return `    |> validate_number(:${field}, less_than_or_equal_to: ${p.n})`;
    case "between":
      return `    |> validate_number(:${field}, greater_than_or_equal_to: ${p.lo}, less_than_or_equal_to: ${p.hi})`;
    case "len-min":
      return `    |> validate_length(:${field}, min: ${p.n})`;
    case "len-max":
      return `    |> validate_length(:${field}, max: ${p.n})`;
    case "len-eq":
      return `    |> validate_length(:${field}, is: ${p.n})`;
    case "len-range":
      return `    |> validate_length(:${field}, min: ${p.lo}, max: ${p.hi})`;
    case "regex":
      return `    |> validate_format(:${field}, ~r/${elixirRegexBody(p.pattern)}/)`;
  }
}

export function renderDocChangeset(appModule: string, ctxModule: string, agg: AggregateIR): string {
  const changesetMod = `${appModule}.${ctxModule}.${upperFirst(agg.name)}Changeset`;
  const fields = docFields(agg);
  const required = fields.filter((f) => !f.optional);
  const typeEntries = fields.map((f) => `${snake(f.name)}: ${castType(f.type)}`).join(", ");
  const allCols = fields.map((f) => `:${snake(f.name)}`).join(", ");
  const requiredCols = required.map((f) => `:${snake(f.name)}`).join(", ");
  const castFields = new Set(fields.map((f) => snake(f.name)));
  const validatorLines = (agg.invariants ?? [])
    .flatMap((inv) => singleFieldConstraints(inv) ?? [])
    .filter((c) => castFields.has(snake(c.field)))
    .map((c) => ectoValidator(snake(c.field), c.pattern));
  const validatorBlock = validatorLines.length > 0 ? `\n${validatorLines.join("\n")}` : "";

  return `# Auto-generated.
defmodule ${changesetMod} do
  @moduledoc "Schemaless validation for the document aggregate — the validated map IS the stored document."
  import Ecto.Changeset

  @types %{${typeEntries}}
  @all_fields [${allCols}]
  @required_fields [${requiredCols}]

  @doc "Validate \`attrs\` against the document field types; the applied map becomes the jsonb \`data\`."
  def document_changeset(attrs) when is_map(attrs) do
    {%{}, @types}
    |> cast(attrs, @all_fields)
    |> validate_required(@required_fields)${validatorBlock}
  end
end
`;
}

// ---------------------------------------------------------------------------
// Repository — CRUD over the `(id, data, version)` row.
// ---------------------------------------------------------------------------

export function renderDocRepository(
  appModule: string,
  ctxModule: string,
  agg: AggregateIR,
): string {
  const aggModule = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  const repoMod = `${aggModule}Repository`;
  const changesetMod = `${aggModule}Changeset`;

  return `# Auto-generated.
defmodule ${repoMod} do
  @moduledoc "Document-shaped repository — CRUD over the (id, data, version) jsonb row."
  alias ${appModule}.Repo

  @spec list() :: {:ok, [${aggModule}.t()]} | {:error, term()}
  def list do
    {:ok, Repo.all(${aggModule})}
  end

  @spec find_by_id(binary()) :: {:ok, ${aggModule}.t()} | {:error, :not_found}
  def find_by_id(id) when is_binary(id) do
    case Repo.get(${aggModule}, id) do
      nil -> {:error, :not_found}
      record -> {:ok, record}
    end
  end

  @spec insert(map()) :: {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def insert(attrs) when is_map(attrs) do
    case Ecto.Changeset.apply_action(${changesetMod}.document_changeset(attrs), :insert) do
      {:ok, data} ->
        %${aggModule}{id: Ecto.UUID.generate(), data: data, version: 1}
        |> Repo.insert()

      {:error, changeset} ->
        {:error, changeset}
    end
  end

  @spec update(${aggModule}.t(), map()) :: {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def update(%${aggModule}{} = record, attrs) when is_map(attrs) do
    # Merge the incoming attrs over the current document (string keys, as the
    # jsonb column round-trips), then re-validate the merged whole.
    merged = Map.merge(record.data || %{}, stringify_keys(attrs))

    case Ecto.Changeset.apply_action(${changesetMod}.document_changeset(merged), :update) do
      {:ok, data} ->
        record
        |> Ecto.Changeset.change(%{data: data, version: record.version + 1})
        |> Repo.update()

      {:error, changeset} ->
        {:error, changeset}
    end
  end

  @spec delete(${aggModule}.t()) :: {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def delete(%${aggModule}{} = record) do
    Repo.delete(record)
  end

  @doc "Persist a pre-built changeset (named-operation seam — unused on the document path)."
  @spec persist_change(Ecto.Changeset.t()) ::
          {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def persist_change(%Ecto.Changeset{data: %${aggModule}{}} = changeset) do
    Repo.update(changeset)
  end

  defp stringify_keys(map) do
    Map.new(map, fn {k, v} -> {to_string(k), v} end)
  end
end
`;
}

// ---------------------------------------------------------------------------
// Controller serialize — merge the document `data` back over the id.
// ---------------------------------------------------------------------------

/** The document-shaped `serialize/1` body: the wire map is the stored `data`
 *  (snake-cased field keys, matching the relational `Map.from_struct` shape)
 *  merged under the row id.  (The relational path dumps the whole struct.) */
export function renderDocSerialize(): string {
  return `  defp serialize(record) do
    Map.merge(%{id: record.id}, record.data || %{})
  end`;
}
