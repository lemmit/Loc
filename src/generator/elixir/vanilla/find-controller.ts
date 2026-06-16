// ---------------------------------------------------------------------------
// Vanilla custom-find HTTP surface — `GET /<plural>/<find>` per repository
// `find`, matching the Ash path (`elixir/api-emit.ts`) so the same `.ddd`
// yields the same OpenAPI on either foundation.  The context already exposes a
// `<find>_<agg>` delegate (for workflow `repo-let`); this adds the route +
// controller action that calls it and serialises the result.
//
// Union-returning finds are excluded — their absence-variant → ProblemDetails
// translation is a separate slice (the `validateUnionFindShapes` elixir
// exemption), so they keep their internal-only delegate for now.
// ---------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR, FindIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import type { ApiRoute } from "../api-emit.js";

/** Non-`all`, non-union custom finds an aggregate's repository declares — the
 *  ones that earn an HTTP `GET /<plural>/<find>` endpoint.  (`all` is the
 *  enrichment-synthesized list, served by `GET /<plural>` already; union finds
 *  keep their internal-only delegate pending the absence-producer slice.)  The
 *  `all`/`returnType` filter is inlined rather than importing
 *  `repository-emit.customFindsOf` to avoid an import cycle. */
export function httpFindsOf(ctx: BoundedContextIR, agg: AggregateIR): FindIR[] {
  const repo = (ctx.repositories ?? []).find((r) => r.aggregateName === agg.name);
  return (repo?.finds ?? []).filter((f) => f.name !== "all" && f.returnType.kind !== "union");
}

/** True when the find returns zero-or-one record (`Customer?` / `Customer`)
 *  rather than a list — mirrors `repository-emit.ts`'s fetch-shape choice. */
function isSingleReturn(t: TypeIR): boolean {
  if (t.kind === "optional" && t.inner.kind === "entity") return true;
  if (t.kind === "entity") return true;
  return false;
}

/** `GET /<plural>/<find>` routes — must be registered *before* the
 *  `/<plural>/:id` show route so the literal segment wins in Phoenix's
 *  in-order match (`/orders/recent` would otherwise bind `:id = "recent"`). */
export function findRoutes(agg: AggregateIR, ctx: BoundedContextIR): ApiRoute[] {
  const aggsPath = snake(plural(agg.name));
  const controller = `${upperFirst(agg.name)}Controller`;
  return httpFindsOf(ctx, agg).map((f) => ({
    method: "get" as const,
    path: `/${aggsPath}/${snake(f.name)}`,
    controller,
    action: `:${snake(f.name)}`,
  }));
}

/** Controller actions for the aggregate's HTTP finds — read the declared
 *  params from the query string, call the context delegate, and serialise the
 *  `{:ok, _}` result (a list maps each element; a single record is serialised
 *  or `nil`).  Empty when the aggregate has no HTTP finds. */
export function renderFindActions(
  ctxModule: string,
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string {
  const aggSnake = snake(agg.name);
  const actions = httpFindsOf(ctx, agg).map((f) => {
    const findSnake = snake(f.name);
    // A param-less find never reads `params` — bind `_params` so it doesn't
    // trip the unused-variable check.
    const paramArg = f.params.length > 0 ? "params" : "_params";
    const argReads = f.params.map((p) => `params[${JSON.stringify(p.name)}]`).join(", ");
    const call = `${ctxModule}.${findSnake}_${aggSnake}(${argReads})`;
    if (isSingleReturn(f.returnType)) {
      return `
  def ${findSnake}(conn, ${paramArg}) do
    case ${call} do
      {:ok, nil} -> json(conn, nil)
      {:ok, record} -> json(conn, serialize(record))
    end
  end`;
    }
    return `
  def ${findSnake}(conn, ${paramArg}) do
    with {:ok, records} <- ${call} do
      json(conn, Enum.map(records, &serialize/1))
    end
  end`;
  });
  return actions.join("\n");
}
