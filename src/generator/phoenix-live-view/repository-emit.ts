import type {
  AggregateIR,
  BoundedContextIR,
  FindIR,
  RepositoryIR,
} from "../../ir/loom-ir.js";
import { pascal, snake, plural } from "../../util/naming.js";
import { renderExpr, type RenderCtx } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Repository / find emission for Ash.
//
// Ash auto-generates standard CRUD actions (`get`, `read`, `create`,
// `update`, `destroy`) from `defaults`.  Only user-declared `find <name>`
// entries in a `repository` block need explicit Ash read actions.
//
// Strategy: emit explicit read actions as a side-channel file
//   `lib/<app>/<context>/<aggregate>_finds.ex`
// that the resource module `use`-includes.  The resource's `actions do`
// block declares only the defaults; the finds file appends extra actions.
//
// Alternative (splice into domain-emit's actions block): also supported —
// `buildFindActions` returns a list of action snippet strings that
// domain-emit can splice directly.  Both strategies are exported; the
// orchestrator chooses which to use.
// ---------------------------------------------------------------------------

/** Build Ash read action snippets for each custom find on a repository.
 *  Returns an array of multi-line strings, each representing one
 *  `read :<name> do … end` block suitable for splicing into a resource's
 *  `actions do … end` section by domain-emit.ts. */
export function buildFindActions(
  repo: RepositoryIR,
  agg: AggregateIR,
  contextModule: string,
): string[] {
  const ctx: RenderCtx = { thisName: "record", contextModule };
  return repo.finds.map((find) => renderFindAction(find, agg, ctx));
}

function renderFindAction(find: FindIR, agg: AggregateIR, ctx: RenderCtx): string {
  const lines: string[] = [];
  lines.push(`    read :${snake(find.name)} do`);
  // Arguments
  for (const p of find.params) {
    lines.push(`      argument :${snake(p.name)}, :string`);
  }
  // Filter preparation
  if (find.filter) {
    const filterExpr = renderFilterPreparation(find, agg, ctx);
    lines.push(`      filter ${filterExpr}`);
  } else if (find.params.length > 0) {
    // Convention-based: match params to same-named fields
    const conditions = buildConventionFilter(find, agg);
    if (conditions) {
      lines.push(`      filter expr(${conditions})`);
    }
  }
  // Single-result reads
  if (find.returnType.kind !== "array") {
    lines.push(`      get? true`);
  }
  lines.push(`    end`);
  return lines.join("\n");
}

function renderFilterPreparation(find: FindIR, _agg: AggregateIR, ctx: RenderCtx): string {
  // Render as an Ash expr(...) filter
  const exprStr = renderExpr(find.filter!, { ...ctx, thisName: "record" });
  return `expr(${exprStr})`;
}

function buildConventionFilter(find: FindIR, agg: AggregateIR): string {
  const conditions: string[] = [];
  for (const p of find.params) {
    const matchedField = agg.fields.find(
      (f) => f.name === p.name || `${f.name.replace(/Id$/, "")}Id` === p.name,
    );
    if (matchedField) {
      conditions.push(`${snake(matchedField.name)} == ^arg(:${snake(p.name)})`);
    }
  }
  return conditions.join(" and ");
}

/** Emit a standalone finds file for an aggregate.
 *
 *  Path: `lib/<app>/<ctxSnake>/<aggSnake>_finds.ex`
 *
 *  The emitted module uses `Ash.Resource.Info` to get action definitions and
 *  re-opens the resource module to add custom read actions.  Elixir does not
 *  support reopening modules, so instead this emits the actions as a string
 *  that domain-emit splices inline — this function is provided for
 *  documentation and alternate-strategy callers.
 *
 *  In the primary strategy the orchestrator uses `buildFindActions` and
 *  domain-emit splices them into the resource's `actions do` block. */
export function emitFindsSideFile(
  appName: string,
  ctx: BoundedContextIR,
  agg: AggregateIR,
  repo: RepositoryIR,
  appModule: string,
): { path: string; content: string } {
  const ctxSnake = snake(ctx.name);
  const aggSnake = snake(agg.name);
  const aggModule = `${appModule}.${pascal(ctx.name)}.${pascal(agg.name)}`;
  const contextModule = `${appModule}.${pascal(ctx.name)}`;
  const findsCtx: RenderCtx = { thisName: "record", contextModule };

  const actionBlocks = repo.finds.map((find) =>
    renderFindAction(find, agg, findsCtx),
  );

  // This file documents the custom finds but is not used in the primary
  // emission path (domain-emit splices find actions inline).
  const content = `# Auto-generated — custom Ash read actions for ${pascal(agg.name)}.
# These are spliced inline into lib/${appName}/${ctxSnake}/${aggSnake}.ex by the generator.
# This file is provided for reference only.

defmodule ${aggModule}.Finds do
  @moduledoc """
  Custom read actions for ${pascal(agg.name)}.

  Standard CRUD (get / read / create / update / destroy) are auto-emitted
  via \`defaults\` in the resource module.  Only the user-declared finds
  below need explicit action definitions.
  """

  @doc "Custom find actions (for reference):"
  def actions do
    [
${actionBlocks.map((b) => b.split("\n").map((l) => "      " + l).join("\n")).join(",\n")}
    ]
  end
end
`;
  return {
    path: `lib/${appName}/${ctxSnake}/${aggSnake}_finds.ex`,
    content,
  };
}

/** Find the repository for an aggregate in a context, if declared. */
export function findRepoFor(
  ctx: BoundedContextIR,
  aggName: string,
): RepositoryIR | undefined {
  return ctx.repositories.find((r) => r.aggregateName === aggName);
}

/** Synthesise view finds as extra read actions — matches dotnet/index.ts
 *  `mergeViewsAsFinds` pattern so views become first-class reads. */
export function mergeViewFindsForAgg(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): RepositoryIR | undefined {
  const matchingViews = ctx.views.filter((v) => v.aggregateName === agg.name);
  if (matchingViews.length === 0) return repo;

  const arrayReturn: import("../../ir/loom-ir.js").TypeIR = {
    kind: "array",
    element: { kind: "entity", name: agg.name },
  };
  const synthesised: FindIR[] = matchingViews.map((v) => ({
    name: snake(v.name),
    params: [],
    returnType: arrayReturn,
    filter: v.filter,
  }));

  if (!repo) {
    return {
      name: `${agg.name}Repository`,
      aggregateName: agg.name,
      finds: synthesised,
    };
  }
  return { ...repo, finds: [...repo.finds, ...synthesised] };
}

// Re-export for convenience
export type { RepositoryIR, FindIR };
export { plural, pascal, snake };
