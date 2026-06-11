// ---------------------------------------------------------------------------
// Vanilla per-aggregate Changeset module — `lib/<app>/<ctx>/<agg>_changeset.ex`.
// Slice 2 of vanilla-foundation-tdd-plan.md.
//
// Plain Ecto.Changeset cast/3 + validate_required.  Per-action
// `change_<op>/2` helpers wrap the basic cast with the action's param
// allow-list, mirroring what `with crudish` would expose on the Ash
// path.  Per-field `validate_*` (length, format, …) deferred to a later
// slice.  The constraints ARE available at the IR layer now —
// `src/ir/validate/invariant-classify.ts`'s `singleFieldShape` yields
// min/max/between/len-*/regex patterns from invariants (the same
// classifier Zod and FluentValidation consume); this emitter just
// doesn't consume it yet.
// ---------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR, OperationIR } from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";

interface AggField {
  name: string;
  type: { kind: string; name?: string };
  optional?: boolean;
}

const SYSTEM_FIELDS = new Set(["id", "createdAt", "updatedAt"]);

export function emitVanillaChangesets(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
): void {
  const ctxModule = upperFirst(ctx.name);
  for (const agg of ctx.aggregates) {
    const aggSnake = snake(agg.name);
    const ctxSnake = snake(ctx.name);
    const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
    out.set(
      `lib/${appSnake}/${ctxSnake}/${aggSnake}_changeset.ex`,
      renderChangeset(appModule, ctxModule, agg),
    );
  }
}

function renderChangeset(appModule: string, ctxModule: string, agg: AggregateIR): string {
  const aggPascal = upperFirst(agg.name);
  const aggModule = `${appModule}.${ctxModule}.${aggPascal}`;
  const changesetMod = `${aggModule}Changeset`;
  const allFields = (agg.fields as AggField[]).filter((f) => !SYSTEM_FIELDS.has(f.name));
  const requiredFields = allFields.filter((f) => !f.optional);

  const allCols = allFields.map((f) => `:${snake(f.name)}`).join(", ");
  const requiredCols = requiredFields.map((f) => `:${snake(f.name)}`).join(", ");

  // Per-action changeset helpers — one per create + operation + destroy.
  const actionHelpers = [
    ...(agg.creates ?? []).map((op) => renderActionHelper(aggModule, op, "create")),
    ...agg.operations.map((op) => renderActionHelper(aggModule, op, "operation")),
    ...(agg.destroys ?? []).map((op) => renderActionHelper(aggModule, op, "destroy")),
  ]
    .filter(Boolean)
    .join("\n\n");

  return `# Auto-generated.
defmodule ${changesetMod} do
  @moduledoc false
  import Ecto.Changeset
  alias ${aggModule}

  @all_fields [${allCols}]
  @required_fields [${requiredCols}]

  @doc "Default cast/3 helper applied by every per-action changeset below."
  def base_changeset(struct \\\\ %${aggPascal}{}, attrs) do
    struct
    |> cast(attrs, @all_fields)
    |> validate_required(@required_fields)
  end

${actionHelpers}
end
`;
}

function renderActionHelper(
  aggModule: string,
  op: OperationIR,
  kind: "create" | "operation" | "destroy",
): string {
  const aggPascal = aggModule.split(".").pop()!;
  const opName = snake(op.name);
  const paramCols = op.params.map((p) => `:${snake(p.name)}`).join(", ");
  const allowList = paramCols ? `[${paramCols}]` : "[]";

  if (kind === "create") {
    return `  @doc "Changeset for the create action \`${op.name}\`."
  def change_${opName}(attrs) do
    %${aggPascal}{}
    |> cast(attrs, ${allowList})
    |> validate_required(${allowList})
  end`;
  }
  if (kind === "destroy") {
    // Destroy doesn't cast attrs — the caller supplies the record and
    // the changeset only marks the action.  Repository handles the
    // actual Repo.delete/2.
    return `  @doc "Changeset for the destroy action \`${op.name}\` — pass-through (Repo.delete handles the actual removal)."
  def change_${opName}(struct) do
    Ecto.Changeset.change(struct)
  end`;
  }
  // operation (mutate)
  return `  @doc "Changeset for the operation \`${op.name}\`."
  def change_${opName}(struct, attrs) do
    struct
    |> cast(attrs, ${allowList})
    |> validate_required(${allowList})
  end`;
}
