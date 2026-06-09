// ---------------------------------------------------------------------------
// Vanilla context module — `lib/<app>/<ctx>.ex`.  Slice 1 of
// vanilla-foundation-tdd-plan.md.
//
// Plain Elixir context module (no `use Ash.Domain`).  Façade that
// re-exports the per-aggregate Repository functions so controllers /
// LiveView callers have a single import point.  When Slice 2 lands the
// mutating actions, they will route through here as well.
// ---------------------------------------------------------------------------

import type { BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";

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
    const aggPascal = upperFirst(agg.name);
    const aggSnake = snake(agg.name);
    const repoMod = `${facadeMod}.${aggPascal}Repository`;
    return `  # ${aggPascal}
  defdelegate list_${aggSnake}s(), to: ${repoMod}, as: :list
  defdelegate get_${aggSnake}(id), to: ${repoMod}, as: :find_by_id
`;
  });

  return `# Auto-generated.
defmodule ${facadeMod} do
  @moduledoc """
  Plain context module for the ${ctx.name} bounded context.  Façade
  re-exporting per-aggregate Repository functions.  Vanilla foundation
  (no Ash.Domain).
  """

${blocks.join("\n")}end
`;
}
