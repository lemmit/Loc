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
  FindIR,
  OperationIR,
  StmtIR,
  SystemIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { isDocumentShaped, resolveDataSourceConfig } from "../../../ir/util/resolve-datasource.js";
import {
  type SingleFieldPattern,
  singleFieldConstraints,
} from "../../../ir/validate/invariant-classify.js";
import { elixirRegexBody, escapeElixirIdent, plural, snake, upperFirst } from "../../../util/naming.js";
import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";
import { opUsesCurrentUser, stmtUsesParam } from "../domain/predicates.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import { NORMALIZE_KEYS_DEFP } from "./key-normalize.js";
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
  finds: readonly FindIR[] = [],
): string {
  const aggModule = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  const repoMod = `${aggModule}Repository`;
  const changesetMod = `${aggModule}Changeset`;

  // Custom finds (DEBT-07).  A document row keeps every field inside the opaque
  // jsonb `data` blob, so a find can't push its predicate into an Ecto `where`
  // over flattened columns — it loads the table and filters IN MEMORY, rendering
  // the predicate against the normalised (string-keyed) `data` map via the
  // shared `docMap` render mode.  `all` is dropped (the `list/0` CRUD seam
  // already covers it).
  const findFns = finds.filter((f) => f.name !== "all").map((f) => renderDocFindFn(f, aggModule));
  const findBlock = findFns.length > 0 ? `\n\n${findFns.join("\n\n")}` : "";
  // The `__doc_data/1` normaliser is only referenced by the custom-find filters,
  // so gate it (an unused defp trips `mix compile --warnings-as-errors`).
  const docDataHelper =
    findFns.length > 0
      ? `\n\n  defp __doc_data(record), do: Map.new(record.data || %{}, fn {k, v} -> {to_string(k), v} end)`
      : "";

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
    attrs = __normalize_keys(attrs)

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
    # Merge the incoming attrs over the current document (snake-cased string
    # keys, as the jsonb column round-trips), then re-validate the merged whole.
    # Normalise camelCase wire keys to snake BEFORE the merge, so a camelCase
    # field overwrites the stored snake key cleanly instead of landing beside it.
    merged = Map.merge(record.data || %{}, __normalize_keys(stringify_keys(attrs)))

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
  end${findBlock}

  defp stringify_keys(map) do
    Map.new(map, fn {k, v} -> {to_string(k), v} end)
  end${docDataHelper}

${NORMALIZE_KEYS_DEFP}
end
`;
}

/** True iff the find's declared return type produces ZERO-OR-ONE record (an
 *  optional / bare entity / union) rather than a list — mirrors the relational
 *  `isSingleReturn` in `repository-emit.ts`. */
function isDocSingleReturn(t: TypeIR): boolean {
  return (
    t.kind === "union" ||
    t.kind === "entity" ||
    (t.kind === "optional" && t.inner.kind === "entity")
  );
}

/** One document custom-find function — an IN-MEMORY filter over the loaded rows.
 *  The predicate renders against the normalised (string-keyed) `data` map through
 *  the shared `docMap` render mode (`this.<field>` → `data["<snake>"]`, enums as
 *  their stored strings, money/decimal as native JSON numbers).  A find with no
 *  `where` clause falls back to the per-param convention predicate (`data["<p>"]
 *  == <p>`), matching the relational convention-find shape.  Single-return finds
 *  yield the first match (or `nil`); list finds yield every match. */
function renderDocFindFn(f: FindIR, aggModule: string): string {
  const fnName = snake(f.name);
  const argNames = f.params.map((p) => snake(p.name));
  const single = isDocSingleReturn(f.returnType);
  const rc: RenderCtx = {
    thisName: "record",
    contextModule: "",
    foundation: "vanilla",
    docMap: "data",
  };
  const predicate = f.filter
    ? renderExpr(f.filter, rc)
    : argNames.length > 0
      ? argNames.map((n) => `data[${JSON.stringify(n)}] == ${n}`).join(" and ")
      : "true";
  const specArgs = argNames.map(() => "term()").join(", ");
  const specTail = single
    ? `{:ok, ${aggModule}.t() | nil} | {:error, term()}`
    : `{:ok, [${aggModule}.t()]} | {:error, term()}`;
  const result = single ? "List.first(results)" : "results";
  return `  @spec ${fnName}(${specArgs}) :: ${specTail}
  def ${fnName}(${argNames.join(", ")}) do
    results =
      ${aggModule}
      |> Repo.all()
      |> Enum.filter(fn record ->
        data = __doc_data(record)
        ${predicate}
      end)

    {:ok, ${result}}
  end`;
}

// ---------------------------------------------------------------------------
// Named operations (DEBT-07) — the document counterpart of
// `context-emit.ts:renderNamedOpFunction`.  A document aggregate has no
// flattened columns, so an op body can't struct-update `record` and `put_change`
// real columns; instead it works over a normalised copy of the jsonb `data` map
// (`this.<field>` → `data["<snake>"]` via the `docMap` render mode), then persists
// the whole mutated map through the document repository's own `update/2` (which
// re-runs the schemaless changeset + bumps `version`).
//
// v1 scope (validate-gated in `validateVanillaDocumentScope`): scalar-shaped
// bodies — `assign` / scalar `+=`/`-=` / `precondition` / `requires` / `let` /
// `emit`.  Returning ops, audited/provenanced ops, collection mutation, and
// value-object-subfield / derived / function-call reads stay gated (they need
// the struct machinery the document path deliberately omits).
// ---------------------------------------------------------------------------

/** `<op>_<agg>(record, params)` for a document aggregate — normalise the jsonb
 *  `data`, run the (scalar) op body against it, then persist via the document
 *  repository's `update/2`. */
export function renderDocNamedOpFunction(
  facadeMod: string,
  op: OperationIR,
  agg: AggregateIR,
): string {
  const opSnake = snake(op.name);
  const aggPascal = upperFirst(agg.name);
  const aggSnake = snake(agg.name);
  const aggModule = `${facadeMod}.${aggPascal}`;
  const repoMod = `${aggModule}Repository`;
  const rc: RenderCtx = {
    thisName: "record",
    contextModule: facadeMod,
    foundation: "vanilla",
    docMap: "data",
    agg: agg as EnrichedAggregateIR,
  };
  // Bind only the params the body references (an unused binding trips
  // `--warnings-as-errors`); `params` itself is always read by the `is_map`
  // guard, so a param-less op never warns.
  const usedParams = op.params.filter((p) => op.statements.some((s) => stmtUsesParam(s, p.name)));
  const paramBinds = usedParams.map(
    (p) => `    ${snake(p.name)} = Map.get(params, ${JSON.stringify(p.name)})`,
  );
  const bodyLines = op.statements.map((s) => renderDocOpStmt(s, rc));
  const prelude = [
    ...paramBinds,
    `    data = Map.new(record.data || %{}, fn {k, v} -> {to_string(k), v} end)`,
    ...bodyLines,
  ].join("\n");
  const actorParam = opUsesCurrentUser(op) ? ", current_user \\\\ nil" : "";
  return `  @doc "Named operation \`${op.name}\` on \`${aggPascal}\` (document shape) — runs the body over the jsonb data, then re-validates + persists."
  @spec ${opSnake}_${aggSnake}(${aggModule}.t(), map()) ::
          {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def ${opSnake}_${aggSnake}(%${aggModule}{} = record, params${actorParam}) when is_map(params) do
${prelude}
    ${repoMod}.update(record, data)
  end`;
}

/** Render one statement of a document op body over the `data` map.  Only the
 *  scalar-shaped statement kinds the validator admits reach here; anything else
 *  is a construction bug (the gate let through a shape the document path can't
 *  emit) and throws rather than misgenerating. */
function renderDocOpStmt(s: StmtIR, rc: RenderCtx): string {
  const key = (seg: string) => JSON.stringify(snake(seg));
  switch (s.kind) {
    case "precondition":
      return `    if not (${renderExpr(s.expr, rc)}), do: raise(ArgumentError, ${JSON.stringify(`Precondition failed: ${s.source}`)})`;
    case "requires":
      return `    if not (${renderExpr(s.expr, rc)}), do: raise(ArgumentError, ${JSON.stringify(`Forbidden: ${s.source}`)})`;
    case "assign": {
      const field = key(s.target.segments[0] ?? "");
      return `    data = Map.put(data, ${field}, ${renderExpr(s.value, rc)})`;
    }
    case "add": {
      // Scalar compound `+=` only (collection add is validate-gated on document).
      const field = key(s.target.segments[0] ?? "");
      return `    data = Map.put(data, ${field}, data[${field}] + ${renderExpr(s.value, rc)})`;
    }
    case "remove": {
      const field = key(s.target.segments[0] ?? "");
      return `    data = Map.put(data, ${field}, data[${field}] - ${renderExpr(s.value, rc)})`;
    }
    case "let":
      return `    ${escapeElixirIdent(snake(s.name))} = ${renderExpr(s.expr, rc)}`;
    case "emit": {
      const fields = s.fields.map((f) => `${snake(f.name)}: ${renderExpr(f.value, rc)}`).join(", ");
      const appModule = rc.contextModule.split(".")[0]!;
      const struct = `%${rc.contextModule}.Events.${upperFirst(s.eventName)}{${fields}}`;
      const logCall = renderPhoenixLogCall("eventDispatched", [
        { name: "event_type", valueExpr: `"${upperFirst(s.eventName)}"` },
        { name: "aggregate", valueExpr: `"${upperFirst(rc.agg?.name ?? "")}"` },
      ]);
      return `    ${logCall}\n    Phoenix.PubSub.broadcast(${appModule}.PubSub, "events", ${struct})`;
    }
    case "expression":
      return `    _ = ${renderExpr(s.expr, rc)}`;
    default:
      throw new Error(
        `vanilla document op: unsupported statement kind '${s.kind}' reached the emitter (should be validate-gated by loom.vanilla-document-unsupported)`,
      );
  }
}

// ---------------------------------------------------------------------------
// Controller serialize — merge the document `data` back over the id.
// ---------------------------------------------------------------------------

/** The document-shaped `serialize/1` body — the wireShape-driven projection
 *  (mirrors the relational serializer #1628 introduced).
 *
 *  The stored `data` jsonb is keyed by `snake(f.name)` (the schemaless
 *  changeset casts `@all_fields = [:snake…]`), so a bare `Map.merge(%{id:},
 *  data)` shipped snake_case keys (`commit_sha`) — diverging from the canonical
 *  camelCase wire (`commitSha`) every other backend emits.  This projects each
 *  stored field under its declared name (already camelCase) reading the
 *  snake-cased `data` key, so the wire keys line up.  Emits exactly the fields
 *  the changeset stores (`id` + `docFields`) — no derived / timestamp leak —
 *  identical to the old merge except for the key casing. */
export function renderDocSerialize(agg: AggregateIR): string {
  const entries = [
    `      "id" => record.id`,
    ...docFields(agg).map((f) => `      "${f.name}" => Map.get(data, "${snake(f.name)}")`),
  ];
  // Normalise the `data` keys to strings first: a freshly-inserted record
  // carries the schemaless changeset's ATOM-keyed applied map (`%{item_count:
  // 3}`), while a DB-loaded record carries the STRING-keyed jsonb map — read
  // both uniformly so the create response matches the read response.
  return `  defp serialize(record) do
    data = Map.new(record.data || %{}, fn {k, v} -> {to_string(k), v} end)

    %{
${entries.join(",\n")}
    }
  end`;
}
