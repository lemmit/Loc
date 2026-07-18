import type {
  AggregateIR,
  BoundedContextIR,
  EnumIR,
  ValueObjectIR,
} from "../../../ir/types/loom-ir.js";
import { type ValueCollectionIR, valueCollectionsFor } from "../../../ir/util/value-collections.js";
import { singleFieldConstraints } from "../../../ir/validate/invariant-classify.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { ectoValidator } from "./changeset-validators.js";
import { NORMALIZE_KEYS_DEFP } from "./key-normalize.js";

// ---------------------------------------------------------------------------
// Vanilla (Ecto) value-object COLLECTION child schema (`charges: Money[]`).
//
// The single-VO field (`total: Money`) stays a plain `:map` (JSONB) column;
// a value-object ARRAY instead persists as an id-less relational CHILD TABLE
// — `<owner>_<field>` — modelled as a child Ecto schema the parent
// `has_many`s + `cast_assoc`s.  This module emits that child schema:
//
//   * a synthetic `:binary_id` PK (so `cast_assoc` + `on_replace: :delete`
//     have row identity for the replace-on-update diff; the migration adds
//     the matching `id uuid` PK);
//   * `belongs_to :<owner>` (the parent FK, `<owner>_id`);
//   * `field :ordinal, :integer` (preserves declared order);
//   * the value object's flattened fields;
//   * `@derive {Jason.Encoder, only: [<vo fields>]}` — the synthetic id /
//     parent FK / ordinal are stripped, so the wire array stays
//     `[{amount,currency},…]`, byte-identical with every backend;
//   * a `changeset/2` that casts the VO fields + ordinal and runs the value
//     object's invariant validators (a negative `Money` is rejected).
// ---------------------------------------------------------------------------

/** Fully-qualified module name for a value-collection child schema. */
export function valueCollectionModule(
  appModule: string,
  ctx: BoundedContextIR,
  vc: ValueCollectionIR,
): string {
  return `${appModule}.${upperFirst(ctx.name)}.${childSuffix(vc)}`;
}

/** Pascal-cased module suffix — `invoice_line_items` → `InvoiceLineItems`. */
function childSuffix(vc: ValueCollectionIR): string {
  return vc.childTable.split("_").map(upperFirst).join("");
}

/** Descriptors for an aggregate's value-collection fields paired with the
 *  resolved VO declaration. */
export function valueCollectionsWithVo(
  agg: AggregateIR,
  ctx: BoundedContextIR,
): { vc: ValueCollectionIR; vo: ValueObjectIR }[] {
  const vosByName = new Map(ctx.valueObjects.map((v) => [v.name, v]));
  return valueCollectionsFor(agg).flatMap((vc) => {
    const vo = vosByName.get(vc.voName);
    return vo ? [{ vc, vo }] : [];
  });
}

/** Emit one child schema module file per value-collection field on every
 *  aggregate in the context. */
export function emitVanillaValueCollectionSchemas(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
): void {
  const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
  const ctxSnake = snake(ctx.name);
  const enumsByName = new Map(ctx.enums.map((e) => [e.name, e]));
  for (const agg of ctx.aggregates) {
    for (const { vc, vo } of valueCollectionsWithVo(agg, ctx)) {
      out.set(
        `lib/${appSnake}/${ctxSnake}/${vc.childTable}.ex`,
        renderChildSchema(appModule, ctx, agg, vc, vo, enumsByName),
      );
    }
  }
}

function ectoFieldType(
  t: import("../../../ir/types/loom-ir.js").TypeIR,
  enumsByName: Map<string, EnumIR>,
): string {
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
    case "enum": {
      const en = enumsByName.get(t.name);
      if (!en) return ":string";
      // Declared-case unquoted atoms (`:Passed`) — see schema-emit's mapTypeToEcto.
      return `Ecto.Enum, values: [${en.values.map((v) => `:${v}`).join(", ")}]`;
    }
    case "optional":
      return ectoFieldType(t.inner, enumsByName);
    default:
      return ":string";
  }
}

function renderChildSchema(
  appModule: string,
  ctx: BoundedContextIR,
  agg: AggregateIR,
  vc: ValueCollectionIR,
  vo: ValueObjectIR,
  enumsByName: Map<string, EnumIR>,
): string {
  const ctxModule = upperFirst(ctx.name);
  const moduleName = `${appModule}.${ctxModule}.${childSuffix(vc)}`;
  const ownerModule = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  const ownerRel = snake(agg.name);

  const voFieldLines = vo.fields.map(
    (f) => `    field :${snake(f.name)}, ${ectoFieldType(f.type, enumsByName)}`,
  );
  const voCols = vo.fields.map((f) => `:${snake(f.name)}`);
  // Wire: ONLY the value object's own fields (id / FK / ordinal stripped).
  const wireAtoms = voCols.join(", ");
  // Cast list: the VO fields + the ordinal (set by the parent's cast_assoc
  // ordering helper); the parent FK is set by Ecto via the association.
  const castCols = [...voCols, ":ordinal"].join(", ");
  const requiredCols = vo.fields
    .filter((f) => !f.optional)
    .map((f) => `:${snake(f.name)}`)
    .join(", ");

  // Value-object invariant validators (a negative `Money` is rejected at the
  // real create/update path, not just in tests) — the same single-field
  // classifier Zod / FluentValidation / the aggregate changeset consume.
  const voFieldNames = new Set(vo.fields.map((f) => snake(f.name)));
  const validatorLines = (vo.invariants ?? []).flatMap((inv) =>
    (singleFieldConstraints(inv) ?? [])
      .filter((c) => voFieldNames.has(snake(c.field)))
      .map((c) => ectoValidator(snake(c.field), c.pattern, inv.message?.text)),
  );
  const validatorBlock = validatorLines.length > 0 ? `\n${validatorLines.join("\n")}` : "";
  const requiredBlock = requiredCols ? `\n    |> validate_required([${requiredCols}])` : "";

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id
  @derive {Jason.Encoder, only: [${wireAtoms}]}
  schema "${vc.childTable}" do
${voFieldLines.join("\n")}
    field :ordinal, :integer
    belongs_to :${ownerRel}, ${ownerModule}, foreign_key: :${vc.parentFk}, type: :binary_id
  end

  @doc false
  def changeset(struct, attrs) do
    attrs = __normalize_keys(attrs)

    struct
    |> cast(attrs, [${castCols}])${requiredBlock}${validatorBlock}
  end

${NORMALIZE_KEYS_DEFP}
end
`;
}
