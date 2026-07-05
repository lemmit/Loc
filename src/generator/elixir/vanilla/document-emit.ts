// ---------------------------------------------------------------------------
// Vanilla `shape(document)` persistence (DEBT-07) — the plain-Ecto counterpart
// of the node/dotnet/python/java document emit.
//
// A document-shaped aggregate persists as ONE jsonb column — the canonical
// `(id, data, version)` table the migrations-builder already emits — instead of
// the normalised table-per-entity tree.  Route A (slice 1): the blob is a TYPED
// `embeds_one :data, <Agg>.Data` embedded schema (`renderDocDataSchema`), so
// `row.data` rehydrates into a `%<Agg>.Data{}` struct carrying every domain
// field.  Validation lives on that embed's `changeset/2` (cast + `cast_embed` +
// the same invariant validators the relational `base_changeset` runs); the root
// `<Agg>Changeset.document_changeset/3` casts inbound attrs INTO the embed
// (`on_replace: :update` giving merge-on-update semantics) and stamps `version`.
// Enums stay `:string` and value objects stay `:map` inside `<Agg>.Data`, and
// `@primary_key false` keeps `id` out of the blob, so the stored jsonb keys +
// the wire remain byte-identical to the pre-Route-A map path.  Reads project the
// struct back through `serialize/1` (snake-cased jsonb keys → camelCase wire).
//
// Beyond CRUD, this module also emits custom finds, named + returning operations,
// and pure functions.  Route A slice 2: these all render in STRUCT mode against
// the rehydrated `%<Agg>.Data{}` embed (`record = row.data`) via the SHARED
// relational body renderer (`renderReturningStmt`) — no `docMap` fork; an op
// re-embeds the mutated struct + bumps version, a find filters in memory over the
// struct.  The residual the document path can't express yet (audited/provenanced
// ops, collection mutation, derived / dereferenced-entity / collection-method
// reads, paged/union finds) is gated at validate time
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
  SystemIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { isDocumentShaped, resolveDataSourceConfig } from "../../../ir/util/resolve-datasource.js";
import {
  type SingleFieldPattern,
  singleFieldConstraints,
} from "../../../ir/validate/invariant-classify.js";
import { elixirRegexBody, plural, snake, upperFirst } from "../../../util/naming.js";
import { statementSubRegions } from "../../_trace/sourcemap.js";
import { opUsesCurrentUser, stmtUsesParam } from "../domain/predicates.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import { NORMALIZE_KEYS_DEFP } from "./key-normalize.js";
import { managedTimestampNames } from "./managed-timestamps.js";
import { type OpFragment, renderReturningStmt } from "./operation-returns-emit.js";

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
  // Route A: the blob is a TYPED `embeds_one :data, <Agg>.Data` embedded schema
  // (not a bare `field :data, :map`), so `row.data` rehydrates into a struct with
  // every domain field — the seam that lets the relational renderers run against
  // `record = row.data` (slices 2+).  The migration is unchanged (`add :data,
  // :map`); Ecto round-trips the embed to/from that jsonb column.  Enums stay
  // `:string` and value objects stay `:map` inside `<Agg>.Data` so the stored
  // jsonb + the wire remain byte-identical to the pre-Route-A map path.
  const root = `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc "Document-shaped aggregate — the whole tree persists as one jsonb \`data\` blob."
  use Ecto.Schema

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id
${prefixLine}
  schema "${tableName}" do
    embeds_one :data, ${moduleName}.Data, on_replace: :update
    field :version, :integer, default: 1
    timestamps(type: :utc_datetime)
  end
end
`;
  return `${root}\n${renderDocDataSchema(appModule, ctxModule, agg)}`;
}

/** The `<Agg>.Data` embedded schema — THE domain shape the whole document folds
 *  into (`@primary_key false`, so no `id` leaks into the blob).  Scalar fields
 *  use the same document cast types as the pre-Route-A schemaless changeset (enum
 *  → `:string`, value object → `:map`), so the stored jsonb keys/values + the
 *  wire stay byte-identical; containments nest as `embeds_many`/`embeds_one`.
 *  Its `changeset/2` casts the scalar fields + `cast_embed`s the parts + runs the
 *  aggregate's single-field invariant validators (the same set the old
 *  `document_changeset` ran). */
function renderDocDataSchema(appModule: string, ctxModule: string, agg: AggregateIR): string {
  const dataMod = `${appModule}.${ctxModule}.${upperFirst(agg.name)}.Data`;
  const fields = docFields(agg);
  const fieldLines = fields.map((f) => `    field :${snake(f.name)}, ${castType(f.type)}`);
  const containLines = agg.contains.map(
    (c) =>
      `    ${c.collection ? "embeds_many" : "embeds_one"} :${snake(c.name)}, ${appModule}.${ctxModule}.${upperFirst(c.partName)}`,
  );
  const schemaBody = [...fieldLines, ...containLines].join("\n");
  const castCols = fields.map((f) => `:${snake(f.name)}`).join(", ");
  const requiredCols = fields
    .filter((f) => !f.optional)
    .map((f) => `:${snake(f.name)}`)
    .join(", ");
  const castEmbeds = agg.contains.map((c) => `    |> cast_embed(:${snake(c.name)})`).join("\n");
  const castEmbedBlock = castEmbeds ? `\n${castEmbeds}` : "";
  // Wire/derive atom list: id is absent (@primary_key false), then domain fields
  // + containments — the fields Jason would dump if the struct is encoded directly.
  const wireAtoms = [
    ...fields.map((f) => `:${snake(f.name)}`),
    ...agg.contains.map((c) => `:${snake(c.name)}`),
  ].join(", ");
  // The aggregate's single-field invariants become Ecto validators on the embed
  // changeset (the same set the pre-Route-A `document_changeset` carried).
  const castFieldSet = new Set(fields.map((f) => snake(f.name)));
  const validatorLines = (agg.invariants ?? [])
    .flatMap((inv) => singleFieldConstraints(inv) ?? [])
    .filter((c) => castFieldSet.has(snake(c.field)))
    .map((c) => ectoValidator(snake(c.field), c.pattern));
  const validatorBlock = validatorLines.length > 0 ? `\n${validatorLines.join("\n")}` : "";
  const requiredBlock = requiredCols ? `\n    |> validate_required([${requiredCols}])` : "";
  return `# Auto-generated.
defmodule ${dataMod} do
  @moduledoc "Embedded domain shape for the document aggregate — the whole tree stored in the jsonb \`data\` column."
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key false
  @derive {Jason.Encoder, only: [${wireAtoms}]}
  embedded_schema do
${schemaBody}
  end

  @doc false
  def changeset(struct, attrs) do
    attrs = __normalize_keys(attrs)

    struct
    |> cast(attrs, [${castCols}])${castEmbedBlock}${requiredBlock}${validatorBlock}
  end

${NORMALIZE_KEYS_DEFP}
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
  const aggMod = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  const changesetMod = `${aggMod}Changeset`;
  // Route A: the validation now lives on the `<Agg>.Data` embedded schema's
  // `changeset/2` (cast + cast_embed + invariant validators).  This root
  // changeset just casts the incoming attrs INTO the `:data` embed (so
  // `on_replace: :update` gives merge-on-update semantics for free) and stamps
  // the version.  `record` is `%<Agg>{}` on insert and the existing row on update.
  return `# Auto-generated.
defmodule ${changesetMod} do
  @moduledoc "Casts document attrs into the embedded \`:data\` schema + stamps the version."
  import Ecto.Changeset

  @doc "Cast \`attrs\` into the aggregate's embedded document, stamping \`version\`."
  def document_changeset(%${aggMod}{} = record, attrs, version) when is_map(attrs) do
    record
    |> cast(%{"data" => attrs}, [])
    |> cast_embed(:data, with: &${aggMod}.Data.changeset/2, required: true)
    |> put_change(:version, version)
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
  // struct-mode predicate (`record = row.data`).  `all` is dropped (the `list/0` CRUD seam
  // already covers it).
  const findFns = finds.filter((f) => f.name !== "all").map((f) => renderDocFindFn(f, aggModule));
  const findBlock = findFns.length > 0 ? `\n\n${findFns.join("\n\n")}` : "";

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
    %${aggModule}{}
    |> ${changesetMod}.document_changeset(attrs, 1)
    |> Repo.insert()
  end

  @spec update(${aggModule}.t(), map()) :: {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def update(%${aggModule}{} = record, attrs) when is_map(attrs) do
    # cast_embed(:data, on_replace: :update) casts the incoming (possibly
    # partial) attrs ONTO the existing embedded document, so unspecified fields
    # keep their stored values (the merge-on-update semantics the old manual
    # Map.merge gave) and validate_required still sees the retained values.
    record
    |> ${changesetMod}.document_changeset(attrs, record.version + 1)
    |> Repo.update()
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
 *  Route A slice 2: the predicate renders in STRUCT mode (`docStruct`) against the
 *  rehydrated `%<Agg>.Data{}` embed bound as `record` (`this.<field>` →
 *  `record.<snake>`, enums as their stored strings, money/decimal native) — the
 *  same relational renderer, no `docMap` fork.  A find with no `where` clause
 *  falls back to the per-param convention predicate (`record.<p> == <p>`).
 *  Single-return finds yield the first match (or `nil`); list finds yield every
 *  match. */
function renderDocFindFn(f: FindIR, aggModule: string): string {
  const fnName = snake(f.name);
  const argNames = f.params.map((p) => snake(p.name));
  const single = isDocSingleReturn(f.returnType);
  const rc: RenderCtx = {
    thisName: "record",
    contextModule: "",
    foundation: "vanilla",
    docStruct: true,
  };
  const predicate = f.filter
    ? renderExpr(f.filter, rc)
    : argNames.length > 0
      ? argNames.map((n) => `record.${n} == ${n}`).join(" and ")
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
      |> Enum.filter(fn row ->
        record = row.data
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
// (struct mode: `this.<field>` → `record.<field>` on the rehydrated embed), then re-embeds
// the whole mutated map through the document repository's own `update/2` (which
// re-runs the schemaless changeset + bumps `version`).
//
// Scope (validate-gated in `validateVanillaDocumentScope`): scalar-shaped bodies
// — `assign` / scalar `+=`/`-=` / `precondition` / `requires` / `let` / `emit`,
// value-object-subfield reads, and pure-`function` calls.  A RETURNING op
// (`: A or B`) is emitted too (the in-memory tagged tuple — parity with the
// relational non-audited returning path).  Audited/provenanced ops, collection
// mutation, and derived reads stay gated (they need the struct/transaction
// machinery the document path deliberately omits).
// ---------------------------------------------------------------------------

/** Bind the op's referenced params + render its body statements in STRUCT mode
 *  (`docStruct`) via the SHARED relational body renderer `renderReturningStmt` —
 *  `record` is the rehydrated `%<Agg>.Data{}` embed, so `field := value` →
 *  `record = %{record | field: value}`, guards raise, `emit` broadcasts, exactly
 *  as the relational path.  No `docMap` fork. */
function docOpStructBody(
  op: OperationIR,
  agg: AggregateIR,
  facadeMod: string,
  ctx: BoundedContextIR,
  /** Source-map Milestone 3 collector (`--sourcemap`) — only allocated by the
   *  caller when a recorder is present (zero cost otherwise).  Unlike the
   *  relational named/returning-op paths, a document op's body is never
   *  filtered (no emit-hoisting restructuring here), so `op.statements` and
   *  `body` line up 1:1 already. */
  opFragments?: OpFragment[],
): { params: string[]; body: string[] } {
  const rc: RenderCtx = {
    thisName: "record",
    contextModule: facadeMod,
    foundation: "vanilla",
    docStruct: true,
    agg: agg as EnrichedAggregateIR,
  };
  // Bind only the params the body references (an unused binding trips
  // `--warnings-as-errors`); `params` itself is always read by the `is_map` guard.
  const usedParams = op.params.filter((p) => op.statements.some((s) => stmtUsesParam(s, p.name)));
  const params = usedParams.map(
    (p) => `    ${snake(p.name)} = Map.get(params, ${JSON.stringify(p.name)})`,
  );
  const body = op.statements.map((s, i) => renderReturningStmt(s, ctx, rc, i));
  if (opFragments && body.length > 0) {
    opFragments.push({
      fragmentText: body.join("\n"),
      subRegions: statementSubRegions(op.statements, body, `${ctx.name}.${agg.name}.${op.name}`),
    });
  }
  return { params, body };
}

/** `<op>_<agg>(row, params)` for a document aggregate (Route A slice 2) — bind
 *  the rehydrated embed as `record`, run the body in struct mode, then re-embed
 *  the mutated struct + bump the version.  `cast_embed` is skipped on the write
 *  back (the struct is already validated on read); `put_embed` stores it verbatim. */
export function renderDocNamedOpFunction(
  facadeMod: string,
  op: OperationIR,
  agg: AggregateIR,
  ctx: BoundedContextIR,
  opFragments?: OpFragment[],
): string {
  const opSnake = snake(op.name);
  const aggPascal = upperFirst(agg.name);
  const aggSnake = snake(agg.name);
  const aggModule = `${facadeMod}.${aggPascal}`;
  const repoMod = `${aggModule}Repository`;
  const { params, body } = docOpStructBody(op, agg, facadeMod, ctx, opFragments);
  const prelude = [`    record = row.data`, ...params, ...body].join("\n");
  const actorParam = opUsesCurrentUser(op) ? ", current_user \\\\ nil" : "";
  return `  @doc "Named operation \`${op.name}\` on \`${aggPascal}\` (document shape) — runs the body against the embedded struct, then re-embeds + bumps version."
  @spec ${opSnake}_${aggSnake}(${aggModule}.t(), map()) ::
          {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def ${opSnake}_${aggSnake}(%${aggModule}{} = row, params${actorParam}) when is_map(params) do
${prelude}

    row
    |> Ecto.Changeset.change(%{version: row.version + 1})
    |> Ecto.Changeset.put_embed(:data, Map.from_struct(record))
    |> ${repoMod}.persist_change()
  end`;
}

/** `<op>_<agg>(row, params)` for a RETURNING (`: A or B`) document operation —
 *  runs the body in struct mode, returning the tagged result the controller's
 *  `<op>_<agg>_result/2` translates to HTTP (success → 200 + wire, error variant
 *  → RFC-7807).  Mirrors the relational non-audited returning path: the
 *  fall-through success returns the IN-MEMORY wire projection off the mutated
 *  embed (no DB round-trip). */
export function renderDocReturningOpFunction(
  facadeMod: string,
  op: OperationIR,
  agg: AggregateIR,
  ctx: BoundedContextIR,
  opFragments?: OpFragment[],
): string {
  const opSnake = snake(op.name);
  const aggPascal = upperFirst(agg.name);
  const aggSnake = snake(agg.name);
  const aggModule = `${facadeMod}.${aggPascal}`;
  const actorParam = opUsesCurrentUser(op) ? ", current_user \\\\ nil" : "";
  const lastIsReturn = op.statements[op.statements.length - 1]?.kind === "return";
  const succeedsWithAggregate =
    op.returnType?.kind === "union" &&
    op.returnType.variants.some((v) => v.kind === "entity" && v.name === agg.name);
  const successTail =
    !lastIsReturn && succeedsWithAggregate ? `\n    {:ok, ${docWireMap(agg)}}` : "";
  const { params, body } = docOpStructBody(op, agg, facadeMod, ctx, opFragments);
  // `record = row.data` is live only when the body reads/writes `record` or the
  // success wire projects its fields; otherwise skip it (and underscore `row`,
  // read only for `.data`) so the struct-guarded head doesn't warn under -Werror.
  const usesRecord = body.some((l) => /\brecord\b/.test(l)) || successTail !== "";
  const recordBind = usesRecord ? [`    record = row.data`] : [];
  const rowName = usesRecord ? "row" : "_row";
  const prelude = [...recordBind, ...params, ...body].join("\n");
  return `  @doc "Returning operation \`${op.name}\` on \`${aggPascal}\` (document shape, exception-less)."
  @spec ${opSnake}_${aggSnake}(${aggModule}.t(), map()) ::
          {:ok, term()} | {:error, binary(), map()}
  def ${opSnake}_${aggSnake}(%${aggModule}{} = ${rowName}, params${actorParam}) when is_map(params) do
${prelude}${successTail}
  end`;
}

/** The success wire map a returning op projects off the mutated embed — the same
 *  `id` + stored-field shape (camelCase keys) the document `serialize/1` emits,
 *  so the op response matches `GET /<plural>/:id`.  `id` comes off the root row
 *  (the embed carries none — `@primary_key false`); the fields off `record`. */
function docWireMap(agg: AggregateIR): string {
  const entries = [
    `"id" => row.id`,
    ...docFields(agg).map((f) => `${JSON.stringify(f.name)} => record.${snake(f.name)}`),
  ];
  return `%{${entries.join(", ")}}`;
}
