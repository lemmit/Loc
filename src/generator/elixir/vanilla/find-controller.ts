// ---------------------------------------------------------------------------
// Vanilla custom-find HTTP surface — `GET /<plural>/<find>` per repository
// `find`, matching the Ash path (`elixir/api-emit.ts`) so the same `.ddd`
// yields the same OpenAPI on either foundation.  The context already exposes a
// `<find>_<agg>` delegate (for workflow `repo-let`); this adds the route +
// controller action that calls it and serialises the result.
//
// Union-returning finds (`Agg or NotFound`) are single-gets whose `nil` is the
// absent variant: a `none` absent → 404, an `error` payload → an RFC-7807
// ProblemDetails at its mapped status (via the shared `problem_variant/5`
// responder), and a found record → the tagged `%{type: "<Agg>", …}` wire — the
// same edge translation the exception-less operation routes emit.
// ---------------------------------------------------------------------------

import { variantTag } from "../../../ir/stdlib/unions.js";
import type { AggregateIR, BoundedContextIR, FindIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { defaultErrorStatus, errorTitle, errorTypeUri } from "../../../util/error-defaults.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import type { ApiRoute } from "../api-emit.js";
import { aggregateUsesPrincipalContextFilter } from "./capability-filter.js";

/** Non-`all` custom finds an aggregate's repository declares — the ones that
 *  earn an HTTP `GET /<plural>/<find>` endpoint (`all` is the
 *  enrichment-synthesized list, served by `GET /<plural>` already).  The
 *  `all` filter is inlined rather than importing `repository-emit.customFindsOf`
 *  to avoid an import cycle. */
export function httpFindsOf(ctx: BoundedContextIR, agg: AggregateIR): FindIR[] {
  const repo = (ctx.repositories ?? []).find((r) => r.aggregateName === agg.name);
  return (repo?.finds ?? []).filter((f) => f.name !== "all");
}

/** True when the aggregate has any union-returning find (→ the controller needs
 *  the shared `problem_variant/5` responder). */
export function aggregateHasUnionFind(ctx: BoundedContextIR, agg: AggregateIR): boolean {
  return httpFindsOf(ctx, agg).some((f) => f.returnType.kind === "union");
}

/** True when the find returns zero-or-one record (`Customer?` / `Customer`) or
 *  a union (`Customer or NotFound`) rather than a list. */
function isSingleReturn(t: TypeIR): boolean {
  if (t.kind === "optional" && t.inner.kind === "entity") return true;
  if (t.kind === "entity") return true;
  if (t.kind === "union") return true;
  return false;
}

/** The absent variant of a union find, with its HTTP translation.  `none`
 *  rides the 404 path; an `error` payload becomes a ProblemDetails at its
 *  mapped status carrying `resource: "<Agg>"` when the payload declares one. */
function absentSpec(
  agg: AggregateIR,
  t: TypeIR,
  ctx: BoundedContextIR,
):
  | { kind: "none" }
  | { kind: "error"; status: number; type: string; title: string; hasResource: boolean }
  | null {
  if (t.kind !== "union") return null;
  const other = t.variants.find((v) => !(v.kind === "entity" && v.name === agg.name));
  if (!other) return null;
  if (other.kind === "none") return { kind: "none" };
  const tag = variantTag(other);
  const payload = ctx.payloads.find((p) => p.name === tag);
  return {
    kind: "error",
    status: ctx.errorStatusOverrides?.[tag] ?? defaultErrorStatus(tag),
    type: errorTypeUri(tag),
    title: errorTitle(tag),
    hasResource: (payload?.fields ?? []).some((f) => f.name === "resource"),
  };
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

/** Controller actions for the aggregate's HTTP finds. */
export function renderFindActions(
  ctxModule: string,
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string {
  const aggSnake = snake(agg.name);
  const aggPascal = upperFirst(agg.name);
  // A principal (tenancy) find threads the request actor; pull it off
  // `conn.assigns` and pass it as the trailing find arg.  Non-principal finds
  // stay byte-identical.
  const principal = aggregateUsesPrincipalContextFilter(agg);
  const cuLine = principal ? "    current_user = Map.get(conn.assigns, :current_user)\n" : "";
  const actions = httpFindsOf(ctx, agg).map((f) => {
    const findSnake = snake(f.name);
    // A param-less find never reads `params` — bind `_params` so it doesn't
    // trip the unused-variable check.
    const paramArg = f.params.length > 0 ? "params" : "_params";
    const argReads = [
      ...f.params.map((p) => `params[${JSON.stringify(p.name)}]`),
      ...(principal ? ["current_user"] : []),
    ].join(", ");
    const call = `${ctxModule}.${findSnake}_${aggSnake}(${argReads})`;

    const absent = absentSpec(agg, f.returnType, ctx);
    if (absent) {
      // Union find — translate the `nil` absent case, tag the found record.
      const absentArm =
        absent.kind === "none"
          ? `        problem_variant(conn, 404, "about:blank", "Not Found", %{})`
          : `        problem_variant(conn, ${absent.status}, ${JSON.stringify(absent.type)}, ${JSON.stringify(absent.title)}, ${absent.hasResource ? `%{resource: ${JSON.stringify(aggPascal)}}` : "%{}"})`;
      return `
  def ${findSnake}(conn, ${paramArg}) do
${cuLine}    case ${call} do
      {:ok, nil} ->
${absentArm}

      {:ok, record} ->
        json(conn, Map.put(serialize(record), :type, ${JSON.stringify(aggPascal)}))
    end
  end`;
    }

    if (isSingleReturn(f.returnType)) {
      return `
  def ${findSnake}(conn, ${paramArg}) do
${cuLine}    case ${call} do
      {:ok, nil} -> json(conn, nil)
      {:ok, record} -> json(conn, serialize(record))
    end
  end`;
    }
    return `
  def ${findSnake}(conn, ${paramArg}) do
${cuLine}    with {:ok, records} <- ${call} do
      json(conn, Enum.map(records, &serialize/1))
    end
  end`;
  });
  return actions.join("\n");
}
