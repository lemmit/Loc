import type {
  AggregateIR,
  BoundedContextIR,
  ViewIR,
} from "../../ir/loom-ir.js";
import { pascal, snake } from "../../util/naming.js";
import { renderExpr, type RenderCtx } from "./render-expr.js";

// ---------------------------------------------------------------------------
// View emission for Phoenix LiveView / Ash.
//
// For each `view` declared in the context, emit:
//
//   lib/<app>/<ctx>/views/<view_snake>.ex
//
// Two forms:
//   - Shorthand (`view ActiveOrders = Order where status == Confirmed`):
//     emit a module wrapping an `Ash.Query` with a filter on the source
//     aggregate's read action.  Returns the aggregate's full wire shape.
//   - Full form (`view X { fields ... bind ... }`):
//     emit a module that builds an `Ash.Query` with calculations/loads for
//     each declared field.  v0 emits the filter only; full bind is a
//     stretch goal — noted in the module doc.
// ---------------------------------------------------------------------------

export function emitViews(
  appName: string,
  ctx: BoundedContextIR,
  appModule: string,
  out: Map<string, string>,
): void {
  if (ctx.views.length === 0) return;
  const ctxSnake = snake(ctx.name);
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  const contextModule = `${appModule}.${pascal(ctx.name)}`;

  for (const view of ctx.views) {
    const agg = aggsByName.get(view.aggregateName);
    if (!agg) continue; // validator already errored

    const path = `lib/${appName}/${ctxSnake}/views/${snake(view.name)}.ex`;
    const content = renderView(view, agg, ctx, contextModule, appModule);
    out.set(path, content);
  }
}

function renderView(
  view: ViewIR,
  agg: AggregateIR,
  ctx: BoundedContextIR,
  contextModule: string,
  appModule: string,
): string {
  void ctx;
  void appModule;
  const moduleName = `${contextModule}.Views.${pascal(view.name)}`;
  const aggModule = `${contextModule}.${pascal(view.name)}`;
  void aggModule;
  const renderCtx: RenderCtx = { thisName: "record", contextModule };

  const filterClause = buildFilterClause(view, agg, renderCtx);
  const isShorthand = !view.output;

  const returnTypeDoc = isShorthand
    ? `list of ${pascal(agg.name)} records`
    : `list of maps with fields: ${view.output!.fields.map((f) => snake(f.name)).join(", ")}`;

  // Build the query function body
  const queryBody = buildQueryBody(view, agg, filterClause, contextModule, isShorthand);

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  View: ${pascal(view.name)}

  Returns ${returnTypeDoc}.
  Source aggregate: ${pascal(agg.name)}
  ${isShorthand ? "Form: shorthand" : "Form: full (bind projections are stretch-goal; v0 emits filter only)"}
  """

  alias ${contextModule}

  @doc "Execute the view query and return results."
  def run(opts \\\\ []) do
${queryBody}
  end
end
`;
}

function buildFilterClause(
  view: ViewIR,
  _agg: AggregateIR,
  renderCtx: RenderCtx,
): string | undefined {
  if (!view.filter) return undefined;
  const exprStr = renderExpr(view.filter, renderCtx);
  return exprStr;
}

function buildQueryBody(
  view: ViewIR,
  agg: AggregateIR,
  filterClause: string | undefined,
  contextModule: string,
  isShorthand: boolean,
): string {
  const aggSnake = snake(agg.name);
  const readAction = isShorthand ? "read" : "read";

  if (!filterClause) {
    // No filter — just issue a plain read
    return `    ${contextModule}.${readAction}_${aggSnake}(opts)`;
  }

  // Build an Ash.Query with the filter, then pass to the code-interface read
  const lines: string[] = [];
  lines.push(`    query =`);
  lines.push(`      ${contextModule}.${pascal(agg.name)}`);
  lines.push(`      |> Ash.Query.filter(${filterClause})`);
  lines.push(``);
  lines.push(`    ${contextModule}.read_${aggSnake}(query: query)`);

  return lines.join("\n");
}
