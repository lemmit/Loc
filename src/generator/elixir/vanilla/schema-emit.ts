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

import type { AggregateIR, BoundedContextIR, EnumIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";

export function emitVanillaSchemas(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
): void {
  const ctxModule = upperFirst(ctx.name);
  // Per-context enum-lookup table so the schema can pull each enum's
  // values list for the Ecto.Enum constraint.
  const enumsByName = new Map(ctx.enums.map((e) => [e.name, e]));
  for (const agg of ctx.aggregates) {
    const aggSnake = snake(agg.name);
    const ctxSnake = snake(ctx.name);
    const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
    out.set(
      `lib/${appSnake}/${ctxSnake}/${aggSnake}.ex`,
      renderSchema(appModule, ctxModule, agg, enumsByName),
    );
  }
}

function renderSchema(
  appModule: string,
  ctxModule: string,
  agg: AggregateIR,
  enumsByName: Map<string, EnumIR>,
): string {
  const moduleName = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  const tableName = snake(plural(agg.name));
  const fieldLines = agg.fields
    .map((f) => renderFieldLine(f, enumsByName))
    .filter(Boolean)
    .join("\n");

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "${tableName}" do
${fieldLines}
    timestamps(type: :utc_datetime)
  end
end
`;
}

interface AggField {
  name: string;
  type: TypeIR;
  optional?: boolean;
}

function renderFieldLine(field: AggField, enumsByName: Map<string, EnumIR>): string {
  // Skip system-provided fields and ref-collection arrays (the latter
  // live in join tables; covered when a richer fixture exercises them).
  if (field.name === "id" || field.name === "createdAt" || field.name === "updatedAt") return "";
  const ectoType = mapTypeToEcto(field.type, enumsByName);
  if (!ectoType) return "";
  return `    field :${snake(field.name)}, ${ectoType}`;
}

function mapTypeToEcto(t: TypeIR, enumsByName: Map<string, EnumIR>): string | null {
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
      const values = en.values.map((v) => `:${snake(v)}`).join(", ");
      return `Ecto.Enum, values: [${values}]`;
    }
    case "valueobject":
      // VO → `:map` (JSONB).  Simplest path that satisfies wire-shape
      // parity: the JSON column holds the same object shape Ash's
      // embedded resource emits.  A richer `embeds_one`-backed path
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
