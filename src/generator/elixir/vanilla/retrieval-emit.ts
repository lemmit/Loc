// ---------------------------------------------------------------------------
// Vanilla foundation — `retrieval` emission (retrieval.md).
//
// On `foundation: vanilla` a retrieval is a plain Ecto query module — no
// Ash read action, no `Ash.Query.filter`.  One module per retrieval at
// `lib/<app>/<ctx>/retrievals/<retrieval>.ex`:
//
//     defmodule <App>.<Ctx>.Retrievals.<Name> do
//       import Ecto.Query
//       alias <App>.Repo
//       def run(arg1, arg2, ..., opts \\ []) do
//         query = from(record in <Agg>, where: <predicate>)
//         query = if opts[:limit], do: limit(query, ^opts[:limit]), else: query
//         query = if opts[:offset], do: offset(query, ^opts[:offset]), else: query
//         query = order_by(query, [record], [asc: record.<field>, ...])
//         {:ok, Repo.all(query)}
//       end
//     end
//
// The context facade adds `defdelegate run_<retrieval>_<agg>(args..., opts \\\\ [])`
// so workflow `repo-run` lowerings (a follow-up slice) can call
// `Context.run_<ret>_<agg>(args..., page: [limit:, offset:])`.
//
// The `where` predicate uses `filterArgs: true` + `foundation: "vanilla"`
// so a declared retrieval param renders as Ecto's `^name` pin form (not
// Ash's `^arg(:name)` read-action binding), and an `enum-value` is the
// stored string column (`"confirmed"`), not an atom (`:confirmed`).
// Mirrors the established vanilla `view-emit.ts` shape.
// ---------------------------------------------------------------------------

import type { BoundedContextIR, RetrievalIR, SortTermIR } from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";

/** Per-context fan-out: emit one Ecto query module per retrieval. */
export function emitVanillaRetrievals(
  appName: string,
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
): void {
  const retrievals = ctx.retrievals ?? [];
  if (retrievals.length === 0) return;
  const ctxSnake = snake(ctx.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  for (const r of retrievals) {
    if (r.targetType.kind !== "entity") continue;
    out.set(
      `lib/${appName}/${ctxSnake}/retrievals/${snake(r.name)}.ex`,
      renderRetrievalModule(r, contextModule, appModule),
    );
  }
}

function renderRetrievalModule(r: RetrievalIR, contextModule: string, appModule: string): string {
  const aggName = (r.targetType as { kind: "entity"; name: string }).name;
  const moduleName = `${contextModule}.Retrievals.${upperFirst(r.name)}`;
  const aggModule = `${contextModule}.${upperFirst(aggName)}`;
  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule,
    foundation: "vanilla",
    // Retrieval params bind via Ecto pin syntax (`^needle`) inside the
    // `from ... where: ...` macro.
    filterArgs: true,
  };
  const args = r.params.map((p) => snake(p.name));
  const argList = args.length > 0 ? `${args.join(", ")}, opts \\\\ []` : "opts \\\\ []";
  const whereExpr = renderExpr(r.where, renderCtx);
  const sortClause = renderSortClause(r.sort);

  // Build the Ecto pipeline in stages.  `from(...)` opens, conditional
  // `limit`/`offset` apply pagination opts (`page: [limit: 10, offset: 0]`
  // surfaces as `opts[:limit]` / `opts[:offset]` at the call site), then
  // `order_by` closes when a `sort:` clause is declared.  Each stage is a
  // pipe step so the source compiles cleanly even when pagination opts
  // are absent.
  const pipeline: string[] = [];
  pipeline.push(`    query = from(record in ${aggModule}, where: ${whereExpr})`);
  pipeline.push(`    query = if opts[:limit], do: limit(query, ^opts[:limit]), else: query`);
  pipeline.push(`    query = if opts[:offset], do: offset(query, ^opts[:offset]), else: query`);
  if (sortClause) pipeline.push(`    query = ${sortClause}`);
  pipeline.push(`    {:ok, Repo.all(query)}`);

  // `opts` is always referenced (the if/else above) — no unused-var
  // warning even when params are empty.  Params themselves are referenced
  // in `whereExpr` whenever the retrieval is well-formed (the validator
  // would already have errored on a stray param).
  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  Retrieval: ${upperFirst(r.name)}

  Source aggregate: ${upperFirst(aggName)}
  Foundation: vanilla (plain Ecto).
  """

  import Ecto.Query
  alias ${appModule}.Repo

  @doc "Execute the retrieval; returns {:ok, [aggregate]}."
  def run(${argList}) do
${pipeline.join("\n")}
  end
end
`;
}

function renderSortClause(sort: SortTermIR[]): string | undefined {
  if (sort.length === 0) return undefined;
  // Render each term as `asc: record.<field>` / `desc: record.<field>`.
  // Nested paths (`order.customer.name`) lower to a `record.customer.name`
  // chain — Ecto's `order_by` accepts the dotted form when the path is
  // through preloaded relations.  Retrievals don't yet declare `loads:`,
  // so today every sort term is a single-segment field; the dotted form
  // still parses cleanly for the future case.
  const terms = sort.map((t) => {
    const path = t.path.map((seg) => snake(seg.name)).join(".");
    return `${t.direction}: record.${path}`;
  });
  return `order_by(query, [record], [${terms.join(", ")}])`;
}
