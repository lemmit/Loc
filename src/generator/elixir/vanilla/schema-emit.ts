// ---------------------------------------------------------------------------
// Vanilla Ecto.Schema emit — per-aggregate `lib/<app>/<ctx>/<agg>.ex`.
// Slices 1 + 3 of vanilla-foundation-tdd-plan.md.
//
//   Slice 1: primitives + array-of-primitive + system-field skip.
//   Slice 3 (current): enum → `Ecto.Enum` with values list;
//     valueobject → `:map` (JSONB) — sufficient for wire parity; an
//     `embeds_one` rich-schema path can come later if richer typed
//     query support is needed; id (foreign key reference) →
//     `:binary_id` column; optional wrapper unwraps the inner type.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  ContainmentIR,
  EnrichedAggregateIR,
  EntityPartIR,
  EnumIR,
  ExprIR,
  SystemIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import {
  effectiveSavingShape,
  resolveDataSourceConfig,
} from "../../../ir/util/resolve-datasource.js";
import { isValueCollectionType } from "../../../ir/util/value-collections.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import type { SourceMapRecorder } from "../../_trace/sourcemap.js";
import { isVanillaDocAgg, renderDocSchema } from "./document-emit.js";
import { renderAggregatePureCore } from "./domain-core-emit.js";
import { isEventSourced } from "./eventsourced-emit.js";
import {
  isTpcBase,
  isTphBase,
  isTphConcrete,
  tphBaseUnionFields,
  vanillaTableName,
} from "./inheritance-emit.js";
import { renderInspectImpl } from "./inspect-emit.js";
import { NORMALIZE_KEYS_DEFP } from "./key-normalize.js";
import { provColumn, provenancedFieldsOf } from "./provenance-emit.js";
import { isRefCollField, manyToManyLine, refCollFields } from "./ref-collection-emit.js";
import { valueCollectionModule, valueCollectionsWithVo } from "./value-collection-schema-emit.js";

/** An aggregate's nested entity-part containments are persisted RELATIONALLY
 *  (each part a child table the root `has_many`s + `cast_assoc`s, §11c) rather
 *  than folded inline as `embeds_many` jsonb — true only for a relational-shaped
 *  aggregate.  `shape(embedded)` keeps the inline-embed path; `shape(document)`
 *  is routed to `document-emit` before this is consulted.  Without `sys` the
 *  effective shape defaults to `relational` (the IR default). */
export function usesRelationalContainments(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  sys?: SystemIR,
): boolean {
  if (agg.contains.length === 0) return false;
  const resolved = sys ? resolveDataSourceConfig(agg as EnrichedAggregateIR, ctx, sys) : undefined;
  return effectiveSavingShape(agg as EnrichedAggregateIR, resolved) === "relational";
}

export function emitVanillaSchemas(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
  sys?: SystemIR,
  sourcemap?: SourceMapRecorder,
): void {
  const ctxModule = upperFirst(ctx.name);
  // Per-context enum-lookup table so the schema can pull each enum's
  // values list for the Ecto.Enum constraint.
  const enumsByName = new Map(ctx.enums.map((e) => [e.name, e]));
  const pool = ctx.aggregates;
  for (const agg of ctx.aggregates) {
    // Event-sourced aggregates have no state table — `eventsourced-emit.ts`
    // emits a plain in-memory struct for `<agg>.ex` instead.
    if (isEventSourced(agg)) continue;
    // A TPC (`ownTable`) abstract base owns NO physical table (each concrete is
    // standalone) — the migration emits no `<base>s` table for it, so an Ecto
    // schema over that phantom table would 500 on read.  The polymorphic
    // `find all <Base>` reader (repository-emit) delegates to the concrete
    // repos instead, so the base needs no schema at all.
    if (isTpcBase(agg, pool)) continue;
    const aggSnake = snake(agg.name);
    const ctxSnake = snake(ctx.name);
    const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
    // The Postgres schema the table lands in (the migration creates it with
    // the SAME `resolveDataSourceConfig(...).schema` — owning context's schema
    // by default).  Setting `@schema_prefix` makes every Repo query/insert
    // through this module schema-qualified; without it Ecto hits `public.<t>`
    // while the migration created `<schema>.<t>`, so every query 500s.
    const schemaPrefix = sys
      ? resolveDataSourceConfig(agg as EnrichedAggregateIR, ctx, sys)?.schema
      : undefined;
    const schemaModule = isVanillaDocAgg(agg, ctx, sys)
      ? renderDocSchema(appModule, ctxModule, agg, schemaPrefix)
      : renderSchema(appModule, ctxModule, agg, enumsByName, schemaPrefix, ctx, sys, pool);
    // Append the Inspect-protocol redaction impl (sensitive-field leak guard)
    // after the schema module — emitted only for an aggregate carrying a
    // sensitive leaf; `null` otherwise, so unaffected aggregates stay
    // byte-identical.  Rendered from the IR's synthesized `inspect` member, so
    // the redaction contract matches the TS/.NET backends exactly.
    const inspectImpl = renderInspectImpl(appModule, ctxModule, agg as EnrichedAggregateIR, ctx);
    const schemaPath = `lib/${appSnake}/${ctxSnake}/${aggSnake}.ex`;
    const schemaContent = inspectImpl ? `${schemaModule}\n${inspectImpl}` : schemaModule;
    out.set(schemaPath, schemaContent);
    sourcemap?.file(schemaPath, schemaContent, agg.origin, `${ctx.name}.${agg.name}`);
    // Each entity part (`entity Line { … }`) becomes either an `embedded_schema`
    // module the aggregate `embeds_many`/`embeds_one`s (stored inline as the
    // parent's jsonb column) on an `shape(embedded)` aggregate, OR a real
    // table-backed schema with a `belongs_to` back to its owner on a relational
    // aggregate (§11c — the runtime side of the child-table migration).
    const relational = usesRelationalContainments(agg, ctx, sys);
    for (const part of agg.parts) {
      out.set(
        `lib/${appSnake}/${ctxSnake}/${snake(part.name)}.ex`,
        renderPartSchema(appModule, ctxModule, part, enumsByName, relational),
      );
    }
  }
}

/** Schema line for one containment.  On an embedded aggregate the part folds
 *  inline (`embeds_many`/`embeds_one`); on a relational aggregate (§11c) it is a
 *  child table the root `has_many`s/`has_one`s with `on_replace: :delete` so
 *  `cast_assoc` gives replace-on-update semantics (mirroring the value-object
 *  collection `has_many`).  The FK is `<owner>_id` — the exact column the shared
 *  child-table migration emits (`migrations-builder.ts` `tableForPart`). */
function containmentLine(
  appModule: string,
  ctxModule: string,
  c: ContainmentIR,
  ownerName: string,
  relational: boolean,
): string {
  const partMod = `${appModule}.${ctxModule}.${upperFirst(c.partName)}`;
  if (relational) {
    const fk = `${snake(ownerName)}_id`;
    const rel = c.collection ? "has_many" : "has_one";
    return `    ${rel} :${snake(c.name)}, ${partMod}, foreign_key: :${fk}, on_replace: :delete`;
  }
  return c.collection
    ? `    embeds_many :${snake(c.name)}, ${partMod}`
    : `    embeds_one :${snake(c.name)}, ${partMod}`;
}

/** An entity part as an Ecto schema.  On an embedded owner it is an
 *  `embedded_schema` the parent `cast_embed`s/`embeds_*`s (one jsonb column); on
 *  a relational owner (§11c) it is a real `schema "<plural(part)>"` table the
 *  parent `has_many`s/`cast_assoc`s, carrying a `belongs_to` back to its owner
 *  (the `<owner>_id` FK the shared child-table migration emits).  The wire shape
 *  — `@derive {Jason.Encoder, only: …}` — is identical either way (id + scalar
 *  fields + containments); the synthetic owner FK / `belongs_to` are stripped. */
function renderPartSchema(
  appModule: string,
  ctxModule: string,
  part: EntityPartIR,
  enumsByName: Map<string, EnumIR>,
  relational = false,
): string {
  const moduleName = `${appModule}.${ctxModule}.${upperFirst(part.name)}`;
  const fieldLines = part.fields
    .map((f) => renderFieldLine(f, enumsByName))
    .filter(Boolean)
    .join("\n");
  // Nested part-in-part containments stay inline embeds even on a relational
  // owner (the relational gate rejects them; this keeps embedded output intact).
  const containLines = (part.contains ?? [])
    .map((c) => containmentLine(appModule, ctxModule, c, part.name, false))
    .join("\n");
  // Relational: the parent association — `belongs_to :<owner>, <OwnerMod>` with
  // the migration's `<owner>_id` FK.  Stripped from the wire by `@derive only`.
  // The child table carries `timestamps()` (the shared `tableForPart` migration
  // emits NOT-NULL `inserted_at`/`updated_at`), so the schema must auto-stamp
  // them on insert — `:utc_datetime` mirrors the owner aggregate's convention.
  // (`@derive only` keeps them off the wire.)
  const belongsToLine = relational
    ? `    belongs_to :${snake(part.parentName)}, ${appModule}.${ctxModule}.${upperFirst(part.parentName)}, foreign_key: :${snake(part.parentName)}_id, type: :binary_id`
    : "";
  const timestampsLine = relational ? "    timestamps(type: :utc_datetime)" : "";
  const schemaBody = [fieldLines, containLines, belongsToLine, timestampsLine]
    .filter(Boolean)
    .join("\n");
  // Cast list: scalar columns only (nested embeds round-trip via `cast_embed`).
  const castCols = part.fields
    .filter((f) => !SYSTEM_FIELDS.has(f.name) && mapTypeToEcto(f.type, enumsByName))
    .map((f) => `:${snake(f.name)}`);
  const castEmbeds = (part.contains ?? [])
    .map((c) => `    |> cast_embed(:${snake(c.name)})`)
    .join("\n");
  // Wire shape: id, scalar fields, then containment names (the
  // `@derive Jason.Encoder` atom list).
  const wireAtoms = [
    ":id",
    ...part.fields
      .filter((f) => mapTypeToEcto(f.type, enumsByName))
      .map((f) => `:${snake(f.name)}`),
    ...(part.contains ?? []).map((c) => `:${snake(c.name)}`),
  ].join(", ");
  const castBlock = castEmbeds ? `\n${castEmbeds}` : "";
  // Relational parts live in a real table (`@foreign_key_type` for the
  // `belongs_to`); embedded parts stay an `embedded_schema`.
  const schemaDecl = relational
    ? `  @foreign_key_type :binary_id\n  @derive {Jason.Encoder, only: [${wireAtoms}]}\n  schema "${plural(snake(part.name))}" do`
    : `  @derive {Jason.Encoder, only: [${wireAtoms}]}\n  embedded_schema do`;
  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, UUIDv7, autogenerate: true}
${schemaDecl}
${schemaBody}
  end

  @doc false
  def changeset(struct, attrs) do
    attrs = __normalize_keys(attrs)

    struct
    |> cast(attrs, [${castCols.join(", ")}])${castBlock}
  end

${NORMALIZE_KEYS_DEFP}
end
`;
}

const SYSTEM_FIELDS = new Set(["id", "createdAt", "updatedAt"]);

function renderSchema(
  appModule: string,
  ctxModule: string,
  agg: AggregateIR,
  enumsByName: Map<string, EnumIR>,
  schemaPrefix?: string,
  ctx?: BoundedContextIR,
  sys?: SystemIR,
  pool: readonly AggregateIR[] = ctx?.aggregates ?? [agg],
): string {
  const moduleName = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  // Aggregate-inheritance (inheritance.md): a TPH (`sharedTable`) base OR
  // concrete points at ONE shared table named for the abstract base (the
  // migration names it `plural(snake(base.name))`), NOT the aggregate's own
  // pluralised name.  `vanillaTableName` resolves a concrete to its base.
  // Pointing a TPH concrete's schema at `customers` (a table the migration
  // never creates) is exactly the §8 runtime 500.
  const tableName = vanillaTableName(agg, pool);
  // TPH base/concrete carry the `kind` discriminator (a real text column the
  // shared migration adds).  The concrete filters reads by it + stamps it on
  // insert (repository-emit); the base reads it to hydrate per subtype.
  const isTph = isTphBase(agg, pool) || isTphConcrete(agg, pool);
  const kindLine = isTph ? "    field :kind, :string" : "";
  // The schema's declared fields.  A TPH BASE must declare the UNION of every
  // subtype's columns (its own + each concrete's own) so the polymorphic reader
  // can SELECT them off the shared table; a concrete already carries its merged
  // `[...base, ...own]` fields from enrichment.
  const schemaFields = isTphBase(agg, pool) ? tphBaseUnionFields(agg, pool) : agg.fields;
  // `X id[]` reference collections are NOT stored columns — they live in join
  // tables and are wired below as `many_to_many` relationships.  Drop them from
  // the plain `field` lines (the migration emits no such column, so a
  // `{:array, :binary_id}` field would query a phantom column → runtime 500).
  const declaredLines = schemaFields
    .filter((f) => !isRefCollField(f))
    .map((f) => renderFieldLine(f, enumsByName))
    .filter(Boolean);
  // `many_to_many :party, App.Ctx.Pokemon, join_through: "<schema>.trainer_party", …`
  // — the runtime side of the already-correct join migration.
  const refCollLines = refCollFields(agg).map((rc) => manyToManyLine(appModule, ctxModule, rc));
  // Co-located provenance backing columns — one `<field>_provenance` jsonb
  // (the pass-through `Provenance.Json` Ecto type) per provenanced field,
  // holding the current lineage persisted on the row.  Never cast from client
  // attrs (server-managed); the named-op persist `put_change`s it directly.
  const provLines = provenancedFieldsOf(agg).map(
    (f) => `    field :${provColumn(f.name)}, ${appModule}.Provenance.Json`,
  );
  // Audit timestamp fields (`createdAt`/`updatedAt`, from `with audit`/`auditable`)
  // are lifecycle-stamped onto the changeset (see `stampPutChanges` in
  // `context-emit.ts` / `repository-emit.ts`), so they must be REAL schema
  // fields the stamp can `put_change`.  When present we emit them as explicit
  // `field :created_at|:updated_at, :utc_datetime` (mapped to the audit columns
  // the shared migration adds) and DROP the bundled `timestamps()` macro — Ecto
  // would otherwise declare a second `:updated_at` field and the schema fails to
  // compile.  Without audit fields the plain `timestamps()` stays byte-identical.
  const hasCreatedAt = agg.fields.some((f) => f.name === "createdAt");
  const hasUpdatedAt = agg.fields.some((f) => f.name === "updatedAt");
  const auditTsLines = [
    ...(hasCreatedAt ? ["    field :created_at, :utc_datetime"] : []),
    ...(hasUpdatedAt ? ["    field :updated_at, :utc_datetime"] : []),
  ];
  const fieldLines = [...declaredLines, ...auditTsLines, ...provLines].join("\n");
  // Entity containments (`contains items: Item[]`) → `embeds_many`/`embeds_one`
  // over the part's `embedded_schema` module on an embedded aggregate (stored
  // inline in one jsonb column), or `has_many`/`has_one` onto the part's
  // table-backed schema on a relational aggregate (§11c).
  // Embedded-op bodies append the part struct + `put_embed` (`context-emit.ts`).
  const relational = ctx ? usesRelationalContainments(agg, ctx, sys) : false;
  const containLines = agg.contains
    .map((c) => containmentLine(appModule, ctxModule, c, agg.name, relational))
    .join("\n");
  // Value-object collections (`charges: Money[]`) → `has_many` onto the child
  // schema owning the id-less child table, `preload_order` by `:ordinal` so the
  // array round-trips in declared order; `on_replace: :delete` gives the
  // changeset's `cast_assoc` replace-on-update semantics (delete-then-reinsert,
  // mirroring the TS/.NET repositories).
  const valueCollectionLines = ctx
    ? valueCollectionsWithVo(agg, ctx)
        .map(({ vc }) => {
          const childMod = valueCollectionModule(appModule, ctx, vc);
          return `    has_many :${snake(vc.fieldName)}, ${childMod}, foreign_key: :${vc.parentFk}, on_replace: :delete, preload_order: [asc: :ordinal]`;
        })
        .join("\n")
    : "";
  // The bundled Ecto `timestamps()` (→ `inserted_at`/`updated_at`) is dropped
  // when an explicit `updated_at` audit field is present (it would collide).
  const timestampsLine = hasUpdatedAt ? "" : "    timestamps(type: :utc_datetime)";
  const refCollBlock = refCollLines.join("\n");
  const schemaBody = [
    kindLine,
    fieldLines,
    refCollBlock,
    containLines,
    valueCollectionLines,
    timestampsLine,
  ]
    .filter(Boolean)
    .join("\n");
  const prefixLine = schemaPrefix ? `  @schema_prefix ${JSON.stringify(schemaPrefix)}\n` : "";

  // Pure domain core (`create/1` + `<op>/2`) — emitted only for an aggregate
  // that declares `test "..."` blocks, so the generated ExUnit suite can run
  // the domain logic in memory (no DB).  See `domain-core-emit.ts`.
  const pureCore =
    ctx && agg.tests.length > 0 ? renderAggregatePureCore(appModule, ctx, agg, sys) : [];
  const pureCoreBlock = pureCore.length > 0 ? `\n${pureCore.join("\n")}\n` : "";

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc false
  use Ecto.Schema

  @primary_key {:id, UUIDv7, autogenerate: true}
  @foreign_key_type :binary_id
${prefixLine}
  schema "${tableName}" do
${schemaBody}
  end
${pureCoreBlock}end
`;
}

interface AggField {
  name: string;
  type: TypeIR;
  optional?: boolean;
  default?: ExprIR;
}

function renderFieldLine(field: AggField, enumsByName: Map<string, EnumIR>): string {
  // Skip system-provided fields.  Reference-collection arrays (`X id[]`) are
  // filtered out by the caller before this point — they live in join tables and
  // are emitted as `many_to_many` relationships, not stored columns.
  if (field.name === "id" || field.name === "createdAt" || field.name === "updatedAt") return "";
  // Value-object collection arrays (`charges: Money[]`) persist as a `has_many`
  // child schema (emitted separately), NOT a `{:array, :map}` column — skip the
  // scalar field line; `renderSchema` adds the `has_many` instead.
  if (isValueCollectionType(field.type as TypeIR)) return "";
  const ectoType = mapTypeToEcto(field.type, enumsByName);
  if (!ectoType) return "";
  // A declared Loom default (`field: T = <lit>`) becomes the Ecto schema
  // `default:` so a fresh `%Agg{}` carries it — `base_changeset` then
  // satisfies `validate_required` even when the caller omits the field, and
  // `create/1`'s `apply_action` returns the defaulted value (F6 in
  // docs/audits/test-parity-generated-backends.md).
  const def = field.default ? renderEctoDefault(field.default) : null;
  return `    field :${snake(field.name)}, ${ectoType}${def ? `, default: ${def}` : ""}`;
}

/** Render a simple literal default to its Ecto `default:` value, or `null`
 *  for a non-literal default (skipped — keeps the field's struct default
 *  unset rather than emitting an expression Ecto can't evaluate at compile
 *  time). */
function renderEctoDefault(e: ExprIR): string | null {
  if (e.kind !== "literal") return null;
  switch (e.lit) {
    case "string":
      return JSON.stringify(e.value);
    case "money":
    case "decimal":
      return `Decimal.new(${JSON.stringify(e.value)})`;
    case "bool":
      return e.value;
    case "null":
      return "nil";
    case "int":
    case "long":
      return e.value;
    default:
      // `now` (and anything non-static) can't be a compile-time Ecto default.
      return null;
  }
}

export function mapTypeToEcto(t: TypeIR, enumsByName: Map<string, EnumIR>): string | null {
  switch (t.kind) {
    case "primitive": {
      switch (t.name) {
        case "string":
          return ":string";
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
    }
    case "id":
      // X id → FK column; `belongs_to` association left for a
      // dedicated assoc emit pass.  The column itself is enough for
      // wire shape parity (the agg JSON includes the FK value).
      return ":binary_id";
    case "enum": {
      const en = enumsByName.get(t.name);
      if (!en) return ":string";
      // Ecto.Enum values use the DECLARED casing (quoted atoms `:"Passed"`), not
      // snake — the cross-backend wire contract (and the OpenAPI spec) carries the
      // declared value, so casting `"Passed"` must succeed and the dumped/loaded
      // value must round-trip as `"Passed"` (Jason encodes the atom back to the
      // declared string).  Snake-casing here made the field reject every wire
      // value → 422 "is invalid".
      // Value names are grammar identifiers → valid unquoted atoms; `:"Passed"`
      // would trip Elixir's "quotes not required" warning under -Werror.
      const values = en.values.map((v) => `:${v}`).join(", ");
      return `Ecto.Enum, values: [${values}]`;
    }
    case "valueobject":
      // VO → `:map` (JSONB).  Simplest path that satisfies wire-shape
      // parity: the JSON column holds the value object's own field shape.
      // A richer `embeds_one`-backed path
      // (with its own embedded schema module) can replace this later
      // when typed queries on inner fields are needed.
      return ":map";
    case "array": {
      // Special-case array of VO → {:array, :map} (same JSONB shape).
      // Otherwise wrap the element's Ecto type.
      const inner = mapTypeToEcto(t.element, enumsByName);
      if (!inner) return null;
      return `{:array, ${inner}}`;
    }
    case "optional":
      return mapTypeToEcto(t.inner, enumsByName);
    default:
      return null;
  }
}
