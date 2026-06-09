// ---------------------------------------------------------------------------
// Vanilla Ecto.Schema emit — per-aggregate `lib/<app>/<ctx>/<agg>.ex`.
// Slice 1 of vanilla-foundation-tdd-plan.md.
//
// Produces a plain `Ecto.Schema` module with columns derived from
// `AggregateIR.fields`.  No Ash.Resource, no actions, no policies —
// pure data + cast/validate on the changeset module (next slice).
// ---------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";

export function emitVanillaSchemas(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
): void {
  const ctxModule = upperFirst(ctx.name);
  for (const agg of ctx.aggregates) {
    const aggSnake = snake(agg.name);
    const ctxSnake = snake(ctx.name);
    const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
    out.set(`lib/${appSnake}/${ctxSnake}/${aggSnake}.ex`, renderSchema(appModule, ctxModule, agg));
  }
}

function renderSchema(appModule: string, ctxModule: string, agg: AggregateIR): string {
  const moduleName = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  const tableName = snake(plural(agg.name));
  const fieldLines = agg.fields.map(renderFieldLine).filter(Boolean).join("\n");

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
  type: { kind: string; name?: string; element?: { kind: string; name?: string } };
  optional?: boolean;
}

function renderFieldLine(field: AggField): string {
  // Skip system-provided fields and ref-collection arrays — those are
  // join tables, handled separately when Slice 3 lands.
  if (field.name === "id" || field.name === "createdAt" || field.name === "updatedAt") return "";
  const ectoType = mapTypeToEcto(field.type);
  if (!ectoType) return ""; // unsupported in Slice 1; later slices fill in
  return `    field :${snake(field.name)}, ${ectoType}`;
}

function mapTypeToEcto(t: AggField["type"]): string | null {
  switch (t.kind) {
    case "primitive": {
      switch (t.name) {
        case "string":
          return ":string";
        case "int":
          return ":integer";
        case "decimal":
          return ":decimal";
        case "bool":
          return ":boolean";
        case "datetime":
          return ":utc_datetime";
        case "date":
          return ":date";
        case "uuid":
          return "Ecto.UUID";
        default:
          return ":string";
      }
    }
    case "ref":
      // X id → FK column.  Slice 3 lands the belongs_to association.
      return ":binary_id";
    case "enum":
      // Enum → string column (camelCase Jason.Encoder maps it to the
      // wire enum tag).  Slice 3 may move this to Ecto.Enum.
      return ":string";
    case "array": {
      const elem = mapTypeToEcto(t.element ?? { kind: "primitive", name: "string" });
      if (!elem) return null;
      return `{:array, ${elem}}`;
    }
    default:
      return null;
  }
}
