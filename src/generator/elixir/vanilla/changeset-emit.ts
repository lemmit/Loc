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
import {
  type SingleFieldPattern,
  singleFieldConstraints,
} from "../../../ir/validate/invariant-classify.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { isEventSourced } from "./eventsourced-emit.js";

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
    // Event-sourced aggregates mutate via emit+fold, not Ecto changesets.
    if (isEventSourced(agg)) continue;
    const aggSnake = snake(agg.name);
    const ctxSnake = snake(ctx.name);
    const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
    out.set(
      `lib/${appSnake}/${ctxSnake}/${aggSnake}_changeset.ex`,
      renderChangeset(appModule, ctxModule, agg),
    );
  }
}

/** Map a recognised single-field invariant pattern to the idiomatic Ecto
 *  changeset validator pipe line — `validate_number` for numeric bounds,
 *  `validate_length` for string-length bounds, `validate_format` for regex. */
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
      return `    |> validate_format(:${field}, ~r/${p.pattern}/)`;
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

  // Per-field constraint validators derived from single-field invariants (the
  // same `singleFieldConstraints` classifier Zod / FluentValidation / the Java
  // validator consume) — `f >= N` → `validate_number`, `f.length <= N` →
  // `validate_length`, `f.matches(r)` → `validate_format`.  Guarded / cross-field
  // invariants return null and keep their domain-level enforcement.  Only fields
  // that are actually cast (`@all_fields`) get a validator.
  const castFields = new Set(allFields.map((f) => snake(f.name)));
  const validatorLines = (agg.invariants ?? [])
    .flatMap((inv) => singleFieldConstraints(inv) ?? [])
    .filter((c) => castFields.has(snake(c.field)))
    .map((c) => ectoValidator(snake(c.field), c.pattern));
  const validatorBlock = validatorLines.length > 0 ? `\n${validatorLines.join("\n")}` : "";

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
    |> validate_required(@required_fields)${validatorBlock}
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
