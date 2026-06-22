import type { AggregateIR, BoundedContextIR, ValueObjectIR } from "../../ir/types/loom-ir.js";
import { type ValueCollectionIR, valueCollectionsFor } from "../../ir/util/value-collections.js";
import { snake, upperFirst } from "../../util/naming.js";
import { renderJasonEncoderImpl } from "./jason-camel-emit.js";
import { renderAshType } from "./render-expr.js";
import { renderVoValidations } from "./vo-validation-emit.js";

// ---------------------------------------------------------------------------
// Ash value-object COLLECTION child-resource emitter (`charges: Money[]`).
//
// Unlike a single VO field (`total: Money`), which stays an embedded Ash
// resource folded into a jsonb column, a value-object ARRAY persists as a
// real id-less relational CHILD TABLE — `<owner>_<field>` — the same shape
// the .NET / Java / TS backends already use.  This module emits the Ash
// resource that owns that child table:
//
//   * a SYNTHETIC `uuid_primary_key :id` (the child needs row identity for
//     Ash `manage_relationship` replace-on-update; the migration adds the
//     matching `id uuid` PK);
//   * `belongs_to :<owner>` (the parent FK, `<owner>_id`);
//   * `attribute :ordinal, :integer` (preserves declared order);
//   * the value object's flattened fields as attributes;
//   * the value object's invariant `validations` (so a negative `Money` in
//     the array is rejected at the real create/update path);
//   * a Jason encoder that projects ONLY the value-object's own fields — the
//     synthetic id / parent FK / ordinal are stripped, so the wire array
//     stays `[{amount,currency},…]`, byte-identical with every backend.
//
// The parent aggregate gets a `has_many :<field>` relationship (domain-emit)
// + a `manage_relationship` create/update path (domain/actions) pointing
// here; the child is registered on the context's Ash.Domain (context-emit).
// ---------------------------------------------------------------------------

/** Pascal-cased module suffix for a value-collection child resource —
 *  `invoice_line_items` → `InvoiceLineItems`.  The single source of truth
 *  every caller (resource, parent relationship, manage_relationship, domain
 *  registration) shares, so they stay in lockstep. */
export function valueCollectionEntityName(vc: ValueCollectionIR): string {
  return vc.childTable.split("_").map(upperFirst).join("");
}

/** The value-object collection descriptors for an aggregate, paired with
 *  the resolved VO declaration (the element type's fields + invariants). */
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

/** Render one value-collection child Ash resource module file. */
export function renderValueCollectionResource(
  vc: ValueCollectionIR,
  vo: ValueObjectIR,
  agg: AggregateIR,
  ctxModule: string,
  appModule: string,
  schema?: string,
): string {
  const moduleName = `${ctxModule}.${valueCollectionEntityName(vc)}`;
  const repoModule = `${appModule}.Repo`;
  const ownerModule = `${ctxModule}.${upperFirst(agg.name)}`;
  const ownerAttr = snake(agg.name);
  const parentFk = vc.parentFk;

  const postgresBlockLines: string[] = [
    `    table "${vc.childTable}"`,
    ...(schema ? [`    schema "${schema}"`] : []),
    `    repo ${repoModule}`,
  ];

  // The value object's flattened fields → child-table attributes.  Same
  // column names the migration / relational backends use (bare snake case).
  // `public?: true` so the explicit `accept` + the parent's
  // `manage_relationship` can write each column (Ash 3.x attributes default to
  // `public?: false`, which `accept`/managed input rejects at runtime).
  const voAttrLines = vo.fields.map((f) => {
    const ashType = renderAshType(f.type, ctxModule);
    const allowNil = f.optional ? "true" : "false";
    return `    attribute :${snake(f.name)}, ${ashType}, allow_nil?: ${allowNil}, public?: true`;
  });

  // The value object's invariants enforced as Ash validations on the child
  // (a negative `Money` in the array is rejected at create/update).
  const validationsBlock = renderVoValidations(vo, ctxModule);

  // Wire shape: ONLY the value object's own fields — the synthetic id, the
  // parent FK and the ordinal are stripped so the array stays
  // `[{amount,currency},…]`.
  const wireAtoms = vo.fields.map((f) => `:${snake(f.name)}`);
  const jasonImpl = renderJasonEncoderImpl(moduleName, wireAtoms, appModule);

  return `# Auto-generated.
defmodule ${moduleName} do
  use Ash.Resource,
    domain: ${ctxModule},
    data_layer: AshPostgres.DataLayer

  postgres do
${postgresBlockLines.join("\n")}
  end

  attributes do
    uuid_primary_key :id
    attribute :${parentFk}, :uuid, allow_nil?: false, public?: true
    attribute :ordinal, :integer, allow_nil?: false, public?: true
${voAttrLines.join("\n")}
  end

  relationships do
    belongs_to :${ownerAttr}, ${ownerModule},
      source_attribute: :${parentFk},
      define_attribute?: false
  end
${validationsBlock}
  actions do
    # The parent manages these rows via \`manage_relationship(... type:
    # :direct_control)\`, which needs PRIMARY create / update / destroy actions
    # on the child (create new, update matched, destroy missing — the
    # replace-on-update diff).  \`:read\`/\`:update\`/\`:destroy\` defaults supply
    # primary update + destroy; the explicit primary create accepts the FK +
    # ordinal + VO columns.
    defaults [:read, :update, :destroy]

    create :create do
      primary? true
      accept [:${parentFk}, :ordinal${vo.fields.map((f) => `, :${snake(f.name)}`).join("")}]
    end
  end
end

${jasonImpl}`;
}
