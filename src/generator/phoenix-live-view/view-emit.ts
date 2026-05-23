import type { AggregateIR, BoundedContextIR, ExprIR, ViewIR } from "../../ir/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";
import { type RenderCtx, renderExpr } from "./render-expr.js";

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
//     emit a module that builds an `Ash.Query`, issues `Ash.Query.load/2`
//     for any association paths needed by auxiliaries, reads the source
//     aggregate with `Ash.read!/1`, then pipes through `Enum.map/2` to
//     project each bind expression into the declared output shape.
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
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;

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
  const moduleName = `${contextModule}.Views.${upperFirst(view.name)}`;
  const renderCtx: RenderCtx = { thisName: "record", contextModule };

  const isShorthand = !view.output;

  const returnTypeDoc = isShorthand
    ? `list of ${upperFirst(agg.name)} records`
    : `list of maps with fields: ${view.output!.fields.map((f) => snake(f.name)).join(", ")}`;

  // Build the query function body
  const queryBody = isShorthand
    ? buildShorthandBody(view, agg, renderCtx, contextModule)
    : buildFullFormBody(view, agg, renderCtx, contextModule);

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  View: ${upperFirst(view.name)}

  Returns ${returnTypeDoc}.
  Source aggregate: ${upperFirst(agg.name)}
  Form: ${isShorthand ? "shorthand" : "full (bind projection)"}
  """

  alias ${contextModule}.${upperFirst(agg.name)}
  require Ash.Query

  @doc "Execute the view query and return results."
  # currentUser threading.  Controllers pass
  # \`conn.assigns.current_user\` here; views that don't reference
  # currentUser ignore it (default = nil).
  def run(current_user \\\\ nil) do
    _ = current_user
${queryBody}
  end
end
`;
}

// ---------------------------------------------------------------------------
// Shorthand form — filter only, returns aggregate's full wire shape
// ---------------------------------------------------------------------------

function buildShorthandBody(
  view: ViewIR,
  agg: AggregateIR,
  renderCtx: RenderCtx,
  contextModule: string,
): string {
  const aggModule = `${contextModule}.${upperFirst(agg.name)}`;
  const lines: string[] = [];

  if (!view.filter) {
    lines.push(`    ${aggModule}`);
    lines.push(`    |> Ash.read!()`);
    return lines.join("\n");
  }

  const filterExpr = renderExpr(view.filter, renderCtx);
  lines.push(`    ${aggModule}`);
  lines.push(`    |> Ash.Query.filter(${filterExpr})`);
  lines.push(`    |> Ash.read!()`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Full form — filter + auxiliary loads + Enum.map projection
// ---------------------------------------------------------------------------

function buildFullFormBody(
  view: ViewIR,
  agg: AggregateIR,
  renderCtx: RenderCtx,
  contextModule: string,
): string {
  const output = view.output!;
  const aggModule = `${contextModule}.${upperFirst(agg.name)}`;
  const lines: string[] = [];

  // Build the query pipeline: start with the aggregate module
  lines.push(`    ${aggModule}`);

  // Emit Ash.Query.filter if a filter exists
  if (view.filter) {
    const filterExpr = renderExpr(view.filter, renderCtx);
    lines.push(`    |> Ash.Query.filter(${filterExpr})`);
  }

  // Emit Ash.Query.load for auxiliary association paths (X id follows).
  // Each auxiliary has a path like ["lines"] or ["customerId"] whose
  // first segment is an association to pre-load on the source aggregate.
  // Collect unique top-level association names from auxiliaries.
  const loadKeys = collectLoadKeys(view);
  if (loadKeys.length > 0) {
    const keyList = loadKeys.map((k) => `:${k}`).join(", ");
    lines.push(`    |> Ash.Query.load([${keyList}])`);
  }

  lines.push(`    |> Ash.read!()`);

  // Emit Enum.map projection
  lines.push(`    |> Enum.map(fn record ->`);
  lines.push(`      %{`);

  for (const bind of output.binds) {
    const key = snake(bind.name);
    const valueExpr = renderBindExpr(bind.expr, renderCtx);
    lines.push(`        ${key}: ${valueExpr},`);
  }

  // Remove trailing comma from last entry for clean Elixir style
  if (output.binds.length > 0) {
    const last = lines[lines.length - 1]!;
    lines[lines.length - 1] = last.replace(/,$/, "");
  }

  lines.push(`      }`);
  lines.push(`    end)`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Collect association keys to pre-load from auxiliary paths.
// Each auxiliary path[0] is the field name on the source aggregate that
// holds the association.  We deduplicate and only emit each once.
// ---------------------------------------------------------------------------

function collectLoadKeys(view: ViewIR): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];

  // Also scan bind expressions for member accesses that are collection ops
  // (e.g. lines.count) — those are direct associations, not X id follows,
  // and don't appear in auxiliaries.  Collect them from the bind exprs.
  if (view.output) {
    for (const bind of view.output.binds) {
      const topField = topLevelAssociation(bind.expr);
      if (topField && !seen.has(topField)) {
        seen.add(topField);
        keys.push(topField);
      }
    }
    // Auxiliary paths (X id follows) also need loading
    for (const aux of view.output.auxiliaries) {
      const field = aux.path[0];
      if (field && !seen.has(field)) {
        seen.add(field);
        keys.push(field);
      }
    }
  }

  return keys;
}

/** Walk the expression tree to find the top-level association field being
 *  accessed via a member chain on `this`.  Returns the field name if the
 *  expression is of the form `this.field.something` (where `field` is an
 *  association — i.e. the receiver type is an array or entity) or nil. */
function topLevelAssociation(expr: ExprIR): string | undefined {
  if (expr.kind === "member") {
    const recv = expr.receiver;
    // Direct association member: record.lines.count → "lines"
    if (recv.kind === "ref" && (recv.refKind === "this-prop" || recv.refKind === "this-derived")) {
      // Only emit a load if the receiver type is array (collection) or entity
      const rt = expr.receiverType;
      if (rt.kind === "array" || rt.kind === "entity") {
        return snake(recv.name);
      }
    }
    // Recurse for deeper chains
    return topLevelAssociation(recv);
  }
  if (expr.kind === "method-call" && expr.isCollectionOp) {
    return topLevelAssociation(expr.receiver);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Render a bind expression with `X id` follow rewriting for Elixir.
// For non-follow shapes, delegates to renderExpr.
// ---------------------------------------------------------------------------

function renderBindExpr(expr: ExprIR, ctx: RenderCtx): string {
  // X id follow: member access on an Id-typed receiver becomes a map lookup.
  // In the Elixir/Ash world we pre-load the association via Ash.Query.load,
  // so `customerId.name` is just `record.customer.name` (the association is
  // already hydrated).  For now we fall back to standard renderExpr, which
  // handles this-prop chains, collection ops, etc.
  return renderExpr(expr, ctx);
}
