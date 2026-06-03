import { pagedReturn } from "../../ir/stdlib/generics.js";
import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  FindIR,
  RepositoryIR,
  RetrievalIR,
} from "../../ir/types/loom-ir.js";
import { effectiveSavingShape } from "../../ir/util/resolve-datasource.js";
import { snake, upperFirst } from "../../util/naming.js";
import { type RenderCtx, renderExpr } from "./render-expr.js";

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
  agg: EnrichedAggregateIR,
  contextModule: string,
): string[] {
  // `agg` threaded so renderMethodCall's contains branch (see
  // render-expr.ts) can resolve `this.<refColl>.contains(param)` to
  // `exists(<rel>, id == ^arg(:<param>))` against the join entity.
  const ctx: RenderCtx = { thisName: "record", contextModule, agg };
  // Skip the IR-enriched "all" find: Ash's `defaults [:read, ...]`
  // already provides an equivalent default :read action.  Emitting a
  // custom `read :all do end` block alongside is harmless but
  // redundant; leaving it would also force the domain to keep a
  // duplicate `define :all_X, action: :all` which adds noise without
  // adding behaviour.
  return repo.finds.filter((f) => f.name !== "all").map((find) => renderFindAction(find, agg, ctx));
}

/** Build Ash read-action snippets for each context retrieval targeting
 *  `agg` (retrieval.md) — the Phoenix analog of Hono's `run<Name>` /
 *  .NET's `Run<Name>Async`.  Each becomes a paginated, sorted read whose
 *  `where` is rendered as an Ash `filter expr(...)` with read-action
 *  arguments bound via `^arg(:name)`. */
export function buildRetrievalActions(
  ctx: BoundedContextIR,
  agg: EnrichedAggregateIR,
  contextModule: string,
): string[] {
  const rctx: RenderCtx = { thisName: "record", contextModule, agg };
  return (ctx.retrievals ?? [])
    .filter((r) => r.targetType.kind === "entity" && r.targetType.name === agg.name)
    .map((r) => renderRetrievalAction(r, rctx, agg));
}

/** The owned-containment relationships a retrieval eager-loads, as Ash
 *  load atoms (`:lines`, …).  Every retrieval loads the **whole**
 *  aggregate: explicit `loads:` narrowing is gated at IR validation (not
 *  supported yet — the planned replacement is per-operation autoload, see
 *  validate.ts / load-specifications.md), so the load set is purely a
 *  function of the aggregate.  Only `relational` aggregates expose their
 *  `contains` as Ash relationships; `embedded`/`document` shapes fold the
 *  parts inline (jsonb attributes — always materialised, nothing to
 *  load), so those yield an empty list.  Loading every owned containment
 *  lets a downstream operation read `record.<part>` without a
 *  `%NotLoaded{}` crash.  Cross-aggregate references (`X id`) stay ids and
 *  are never loaded.  Ash realises `load` as a separate batched query per
 *  relationship, so this composes with the action's offset pagination
 *  without the in-memory collection-paging penalty an ORM join-fetch hits. */
function retrievalLoadAtoms(agg: EnrichedAggregateIR): string[] {
  if (effectiveSavingShape(agg) !== "relational") return [];
  return agg.contains.map((c) => `:${snake(c.name)}`);
}

function renderRetrievalAction(r: RetrievalIR, ctx: RenderCtx, agg: EnrichedAggregateIR): string {
  const lines: string[] = [];
  lines.push(`    read :${snake(r.name)} do`);
  for (const p of r.params) {
    lines.push(`      argument :${snake(p.name)}, ${ashArgType(p.type)}`);
  }
  // Offset pagination — the call-site `page: [offset:, limit:]` rides
  // here; `required?: false` keeps an unpaged call returning a plain list.
  lines.push(`      pagination offset?: true, required?: false`);
  // Sort → `prepare build(sort: [field: :dir, ...])` (first path segment
  // per term, mirroring the Hono/.NET v1 single-column sort).
  if (r.sort.length > 0) {
    const terms = r.sort.map((s) => `${snake(s.path[0]!.name)}: :${s.direction}`).join(", ");
    lines.push(`      prepare build(sort: [${terms}])`);
  }
  // Eager-load shape (load-specifications.md / loadPlan).  Every
  // retrieval loads the whole aggregate — every owned containment
  // relationship — so a downstream for-loop op can read `record.<part>`.
  // (Explicit narrowing is gated at IR validation until autoload lands.)
  // Embedded/document aggregates carry parts inline and yield no atoms.
  const loadAtoms = retrievalLoadAtoms(agg);
  if (loadAtoms.length > 0) {
    lines.push(`      prepare build(load: [${loadAtoms.join(", ")}])`);
  }
  // `where` → Ash filter.  Render with read-action arg binding (^arg)
  // and strip the `record.` receiver Ash filters don't use (bare
  // attribute names — same convention as the #762 base_filter).
  const rendered = renderExpr(r.where, { ...ctx, thisName: "record", filterArgs: true }).replace(
    /\brecord\./g,
    "",
  );
  lines.push(`      filter expr(${rendered})`);
  lines.push(`    end`);
  return lines.join("\n");
}

/** Map a Loom param type to the Ash argument type atom.  Conservative:
 *  the common scalars; anything else falls back to `:string` (the prior
 *  hardcoded behaviour for find args). */
function ashArgType(type: import("../../ir/types/loom-ir.js").TypeIR): string {
  if (type.kind === "primitive") {
    switch (type.name) {
      case "int":
        return ":integer";
      case "decimal":
        return ":decimal";
      case "bool":
        return ":boolean";
      case "datetime":
        return ":utc_datetime";
      default:
        return ":string";
    }
  }
  if (type.kind === "id") return ":uuid";
  return ":string";
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
  if (find.returnType.kind !== "array" && !pagedReturn(find.returnType)) {
    lines.push(`      get? true`);
  }
  // Paged (P3b): Ash offset pagination — the controller passes
  // `page: [limit:, offset:, count: true]`; the count gives `total`.
  if (pagedReturn(find.returnType)) {
    lines.push(`      pagination offset?: true, required?: false`);
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
  const aggModule = `${appModule}.${upperFirst(ctx.name)}.${upperFirst(agg.name)}`;
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const findsCtx: RenderCtx = { thisName: "record", contextModule };

  const actionBlocks = repo.finds.map((find) => renderFindAction(find, agg, findsCtx));

  // This file documents the custom finds but is not used in the primary
  // emission path (domain-emit splices find actions inline).
  const content = `# Auto-generated — custom Ash read actions for ${upperFirst(agg.name)}.
# These are spliced inline into lib/${appName}/${ctxSnake}/${aggSnake}.ex by the generator.
# This file is provided for reference only.

defmodule ${aggModule}.Finds do
  @moduledoc """
  Custom read actions for ${upperFirst(agg.name)}.

  Standard CRUD (get / read / create / update / destroy) are auto-emitted
  via \`defaults\` in the resource module.  Only the user-declared finds
  below need explicit action definitions.
  """

  @doc "Custom find actions (for reference):"
  def actions do
    [
${actionBlocks
  .map((b) =>
    b
      .split("\n")
      .map((l) => "      " + l)
      .join("\n"),
  )
  .join(",\n")}
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
export function findRepoFor(ctx: BoundedContextIR, aggName: string): RepositoryIR | undefined {
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

  const arrayReturn: import("../../ir/types/loom-ir.js").TypeIR = {
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
export type { FindIR, RepositoryIR };
