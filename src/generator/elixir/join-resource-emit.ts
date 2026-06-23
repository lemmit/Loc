import type { AssociationIR } from "../../ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// Ash join-resource emitter for `Id<T>[]` reference collections.
//
// One file per association — a thin Ash.Resource module that owns the
// join table.  Two `belongs_to` attrs marked `primary_key?: true` form
// the composite PK, which enforces the set-semantics contract: a target
// appears at most once per owner (see docs/language.md "Reference
// collections" — iteration order is explicitly not part of the wire
// contract).
//
// The owning aggregate declares a `many_to_many :<rel>` pointing at the
// target through this resource (see domain-emit.ts:renderManyToMany);
// the repository's find-emitter lowers `this.<refColl>.contains(param)`
// to `exists(<rel>, id == ^arg(:<param>))` via the same `:rel` name
// (see render-expr.ts:relationshipNameFor).  Three callers, one source
// of truth for naming.
//
// Output path:  lib/<app>/<ctxSnake>/<joinTable>.ex
// Module name:  <ctxModule>.<JoinEntity>   (e.g. `MyApp.Roster.TrainerParty`)
// ---------------------------------------------------------------------------

import { snake, upperFirst } from "../../util/naming.js";

/** C# / Elixir module-name suffix for a join entity — "trainer_party"
 *  → "TrainerParty".  Mirrors the .NET helper at
 *  `src/generator/dotnet/emit/join-entities.ts:joinEntityName`. */
export function joinEntityName(assoc: AssociationIR): string {
  return assoc.joinTable
    .split("_")
    .map((w) => (w.length === 0 ? "" : w[0]!.toUpperCase() + w.slice(1)))
    .join("");
}

/** Render the Ash join-resource module file. */
export function renderJoinResource(
  assoc: AssociationIR,
  ctxModule: string,
  appModule: string,
  /** The owning aggregate's dataSource schema — the join table is created in it
   *  (migration `prefix:`), so the resource must declare the same `schema` or
   *  Ash queries `public.<table>` and the m2m read 500s (`undefined_table`). */
  schema?: string,
): string {
  const moduleName = `${ctxModule}.${joinEntityName(assoc)}`;
  const repoModule = `${appModule}.Repo`;
  const ownerType = `${ctxModule}.${upperFirst(assoc.ownerAgg)}`;
  const targetType = `${ctxModule}.${upperFirst(assoc.targetAgg)}`;
  const ownerAttr = snake(assoc.ownerFk).replace(/_id$/, "");
  const targetAttr = snake(assoc.targetFk).replace(/_id$/, "");
  return `defmodule ${moduleName} do
  use Ash.Resource,
    domain: ${ctxModule},
    data_layer: AshPostgres.DataLayer

  postgres do
    table "${assoc.joinTable}"
    repo ${repoModule}${schema ? `\n    schema "${schema}"` : ""}
  end

  attributes do
    attribute :${snake(assoc.ownerFk)}, :uuid, primary_key?: true, allow_nil?: false
    attribute :${snake(assoc.targetFk)}, :uuid, primary_key?: true, allow_nil?: false
    # The wire contract for \`Id<T>[]\` is a set: composite PK enforces
    # uniqueness, iteration order is not promised across backends.  The
    # ordinal column stays in the schema because TS/.NET write it as an
    # implementation byproduct of their diff-sync; Ash's
    # \`manage_relationship\` doesn't populate it, so we default to 0.
    attribute :ordinal, :integer, allow_nil?: true, default: 0
  end

  relationships do
    belongs_to :${ownerAttr}, ${ownerType},
      source_attribute: :${snake(assoc.ownerFk)},
      define_attribute?: false
    belongs_to :${targetAttr}, ${targetType},
      source_attribute: :${snake(assoc.targetFk)},
      define_attribute?: false
  end

  actions do
    defaults [:read, :destroy]

    create :create do
      primary? true
      accept [:${snake(assoc.ownerFk)}, :${snake(assoc.targetFk)}, :ordinal]
    end
  end
end
`;
}
