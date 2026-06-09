// Vanilla foundation — Ecto schema emission (vanilla-foundation-tdd-plan.md
// slice 1; D-VANILLA-PHOENIX-FOUNDATION).
//
// Under `foundation: vanilla` an aggregate is a plain `Ecto.Schema` (no
// `Ash.Resource`).  The field types reuse the proven saga-schema mapping
// (`ectoIdType` / `ectoStateFieldType` from dispatch-emit) so a vanilla
// aggregate column agrees with the canonical `MigrationsIR` table the
// migration emitter derives — the migration stays the source of truth.
//
//   lib/<app>/<ctx>/<agg>.ex   — `use Ecto.Schema` + `@primary_key` + fields
//
// Slice 1 covers id + scalar fields (primitive / id / enum).  Value-object
// flattening, containment (embedded), and `X id[]` join tables follow in the
// relationships slice — those need the migration's column flattening, not a
// straight per-field map.

import type { AggregateIR, BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { ectoIdType, ectoStateFieldType } from "../dispatch-emit.js";

/** Whether a field maps to a single scalar column (slice 1 scope).  Value
 *  objects, containments, and `X id[]` collections are deferred to the
 *  relationships slice (they don't map to one straight Ecto field). */
function isScalarField(f: AggregateIR["fields"][number]): boolean {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  return t.kind === "id" || t.kind === "primitive" || t.kind === "enum";
}

/** Emit one `Ecto.Schema` module per aggregate in the context. */
export function emitVanillaSchemas(
  appName: string,
  ctx: BoundedContextIR,
  appModule: string,
  out: Map<string, string>,
): void {
  const ctxSnake = snake(ctx.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  for (const agg of ctx.aggregates) {
    out.set(
      `lib/${appName}/${ctxSnake}/${snake(agg.name)}.ex`,
      renderVanillaSchema(agg, contextModule),
    );
  }
}

function renderVanillaSchema(agg: AggregateIR, contextModule: string): string {
  const table = plural(snake(agg.name));
  const pkType = ectoIdType(agg.idValueType);
  const fieldLines = agg.fields
    .filter(isScalarField)
    .map((f) => `    field :${snake(f.name)}, ${ectoStateFieldType(f.type)}`);
  return `# Auto-generated.
defmodule ${contextModule}.${upperFirst(agg.name)} do
  @moduledoc "Ecto schema for the ${upperFirst(agg.name)} aggregate (vanilla foundation)."

  use Ecto.Schema

  @primary_key {:id, ${pkType}, autogenerate: false}
  schema "${table}" do
${fieldLines.length > 0 ? fieldLines.join("\n") + "\n" : ""}    timestamps()
  end
end
`;
}
