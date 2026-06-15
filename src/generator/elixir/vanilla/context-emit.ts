// ---------------------------------------------------------------------------
// Vanilla context module — `lib/<app>/<ctx>.ex`.  Slices 1, 2, 5c of
// vanilla-foundation-tdd-plan.md.
//
// Plain Elixir context module (no `use Ash.Domain`).  Façade that
// re-exports the per-aggregate Repository functions plus named-
// operation handlers (Slice 5c prerequisite — workflows on vanilla
// need `<op>_<agg>(record, params)` for cross-aggregate operation
// calls in the workflow body).
// ---------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR, OperationIR } from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import {
  customFindsOfAgg,
  esContextNeedsEnsure,
  isEventSourced,
  renderEnsureHelper,
  renderEsContextBlock,
} from "./eventsourced-emit.js";
import { customFindsOf } from "./repository-emit.js";

/** Operation names whose `<op>_<agg>` collide with the CRUD
 *  defdelegates emitted above (list/get/create/update/delete).  Skipped
 *  for named-op emission to avoid Elixir function-clause redefinition.
 *  Exported so the controller emitter (`api-emit.ts`) only mounts a
 *  per-operation member route for ops that actually have a `<op>_<agg>`
 *  context function — CRUD-verb-named ops are served by the generic
 *  create/update/delete routes instead, exactly as the named-op emission
 *  here skips them. */
export const CRUD_RESERVED_NAMES = new Set([
  "create",
  "update",
  "delete",
  "destroy",
  "list",
  "get",
]);

export function emitVanillaContextModule(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
): void {
  const ctxSnake = snake(ctx.name);
  const ctxModule = upperFirst(ctx.name);
  const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
  out.set(`lib/${appSnake}/${ctxSnake}.ex`, renderContextModule(appModule, ctxModule, ctx));
}

function renderContextModule(appModule: string, ctxModule: string, ctx: BoundedContextIR): string {
  const facadeMod = `${appModule}.${ctxModule}`;
  const blocks = ctx.aggregates.map((agg) => {
    // Event-sourced aggregates expose create/get/list + per-op command
    // runners (emit→append→fold) instead of the CRUD defdelegates.
    if (isEventSourced(agg)) {
      return renderEsContextBlock(appModule, ctxModule, agg, customFindsOfAgg(ctx, agg));
    }
    const aggPascal = upperFirst(agg.name);
    const aggSnake = snake(agg.name);
    const repoMod = `${facadeMod}.${aggPascal}Repository`;
    // Skip ops whose names collide with the CRUD defdelegates above —
    // notably `update`/`destroy` from `with crudish` would redefine
    // `update_<agg>/2`/`delete_<agg>/1` otherwise.  The CRUD seam
    // already provides those names.
    const opBlocks = (agg.operations ?? [])
      .filter((op) => !CRUD_RESERVED_NAMES.has(op.name))
      .map((op) => renderNamedOpFunction(facadeMod, agg, aggPascal, aggSnake, op));
    // Custom-find defdelegates — `<find>_<agg>(args...)` routes to the
    // repository fn emitted by `customFindsOf`.  Workflow `repo-let`
    // lowering (for a non-getById method) calls through this seam.
    const repo = (ctx.repositories ?? []).find((r) => r.aggregateName === agg.name);
    const findLines = customFindsOf(repo).map((f) => {
      const findSnake = snake(f.name);
      const findArgs = f.params.map((p) => snake(p.name)).join(", ");
      return `  defdelegate ${findSnake}_${aggSnake}(${findArgs}), to: ${repoMod}, as: :${findSnake}`;
    });
    const findBlock = findLines.length > 0 ? `\n${findLines.join("\n")}\n` : "";
    return `  # ${aggPascal}
  defdelegate list_${aggSnake}s(), to: ${repoMod}, as: :list
  defdelegate get_${aggSnake}(id), to: ${repoMod}, as: :find_by_id
  defdelegate create_${aggSnake}(attrs), to: ${repoMod}, as: :insert
  defdelegate update_${aggSnake}(record, attrs), to: ${repoMod}, as: :update
  defdelegate delete_${aggSnake}(record), to: ${repoMod}, as: :delete
${findBlock}${opBlocks.length > 0 ? `\n${opBlocks.join("\n\n")}\n` : ""}`;
  });

  // Retrieval defdelegates — `run_<retrieval>_<agg>(args..., opts \\ [])`
  // routes to the per-retrieval Ecto query module under
  // `Retrievals.<Name>`.  Workflow `repo-run` lowerings (follow-up
  // slice) call through this seam.
  const retrievalLines = (ctx.retrievals ?? [])
    .filter((r) => r.targetType.kind === "entity")
    .map((r) => {
      const aggName = (r.targetType as { kind: "entity"; name: string }).name;
      const retSnake = snake(r.name);
      const aggSnake = snake(aggName);
      const retMod = `${facadeMod}.Retrievals.${upperFirst(r.name)}`;
      // `defdelegate` carries the function arity through to the target.
      // `\\\\ []` is the default for the trailing `opts` arg.
      const args = r.params.map((p) => snake(p.name));
      const argList = args.length > 0 ? `${args.join(", ")}, opts \\\\ []` : "opts \\\\ []";
      return `  defdelegate run_${retSnake}_${aggSnake}(${argList}), to: ${retMod}, as: :run`;
    });
  const retrievalBlock =
    retrievalLines.length > 0 ? `\n  # Retrievals\n${retrievalLines.join("\n")}\n` : "";

  // Private `ensure/2` guard helper shared by the ES command runners (only
  // emitted when an ES command body actually has a precondition/requires, so
  // it never sits unused under --warnings-as-errors).
  const ensureBlock = esContextNeedsEnsure(ctx) ? `\n${renderEnsureHelper()}\n` : "";

  return `# Auto-generated.
defmodule ${facadeMod} do
  @moduledoc """
  Plain context module for the ${ctx.name} bounded context.  Façade
  re-exporting per-aggregate Repository functions plus named-operation
  handlers (Slice 5c prerequisite — workflows on vanilla need
  \`<op>_<agg>(record, params)\` for cross-aggregate calls in the
  workflow body).  Vanilla foundation (no Ash.Domain).
  """

${blocks.join("\n")}${retrievalBlock}${ensureBlock}end
`;
}

// Slice 5c prerequisite — named operation functions per aggregate
// operation.  Each `<op>_<agg>(record, params)` casts the params via
// the aggregate's Changeset module (using the per-action
// `change_<op>/2` helper from Slice 2) and runs `Repo.update`.  This
// is the seam workflows call when their body invokes
// `<aggregate>.<operation>(args)`.
function renderNamedOpFunction(
  facadeMod: string,
  agg: AggregateIR,
  aggPascal: string,
  aggSnake: string,
  op: OperationIR,
): string {
  const opSnake = snake(op.name);
  const aggModule = `${facadeMod}.${aggPascal}`;
  const csMod = `${aggModule}Changeset`;
  const repoMod = `${aggModule}Repository`;
  void agg; // reserved for future per-op-param introspection
  return `  @doc "Named operation \`${op.name}\` on \`${aggPascal}\` — Slice 5c."
  @spec ${opSnake}_${aggSnake}(${aggModule}.t(), map()) ::
          {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t() | term()}
  def ${opSnake}_${aggSnake}(%${aggModule}{} = record, params) when is_map(params) do
    record
    |> ${csMod}.change_${opSnake}(params)
    |> ${repoMod}.persist_change()
  end`;
}
