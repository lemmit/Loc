// ---------------------------------------------------------------------------
// Vanilla custom-find HTTP surface — `GET /<plural>/<find>` per repository
// `find`.  The context already exposes a
// `<find>_<agg>` delegate (for workflow `repo-let`); this adds the route +
// controller action that calls it and serialises the result.
//
// Union-returning finds (`Agg or NotFound`) are single-gets whose `nil` is the
// absent variant: a `none` absent → 404, an `error` payload → an RFC-7807
// ProblemDetails at its mapped status (via the shared `problem_variant/5`
// responder), and a found record → the tagged `%{type: "<Agg>", …}` wire — the
// same edge translation the exception-less operation routes emit.
// ---------------------------------------------------------------------------

import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  pagedReturn,
} from "../../../ir/stdlib/generics.js";
import { variantTag } from "../../../ir/stdlib/unions.js";
import type { AggregateIR, BoundedContextIR, FindIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { defaultErrorStatus, errorTitle, errorTypeUri } from "../../../util/error-defaults.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import type { ApiRoute } from "../api-emit.js";
import { renderExpr } from "../render-expr.js";
import { aggregateUsesPrincipalContextFilter } from "./capability-filter.js";
import { isAbstractBase } from "./inheritance-emit.js";

/** Non-`all` custom finds an aggregate's repository declares — the ones that
 *  earn an HTTP `GET /<plural>/<find>` endpoint (`all` is the
 *  enrichment-synthesized list, served by `GET /<plural>` already).  The
 *  `all` filter is inlined rather than importing `repository-emit.customFindsOf`
 *  to avoid an import cycle. */
export function httpFindsOf(ctx: BoundedContextIR, agg: AggregateIR): FindIR[] {
  const repo = (ctx.repositories ?? []).find((r) => r.aggregateName === agg.name);
  // A synthesized find (paged-run queryHandler support) is never auto-exposed by
  // the aggregate controller — the queryHandler's own route is the exposure — so
  // it drives no HTTP find action / route / OpenAPI path.  Its context defdelegate
  // + repository method (via `customFindsOf`) still emit, so the paged queryHandler
  // route can call it.
  return (repo?.finds ?? []).filter((f) => f.name !== "all" && !f.synthesized);
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
  appModule: string,
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
  // Read-side `requires` authorization gate (default-deny): a 403 returned
  // before the query when the currentUser-only predicate fails — the read-side
  // analogue of an operation's `requires` and the twin of the view gate.
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const webModule = `${appModule}Web`;
  const actions = httpFindsOf(ctx, agg).map((f) => {
    const findSnake = snake(f.name);
    const paged = pagedReturn(f.returnType);
    const gateUsesUser = !!f.requires && exprUsesCurrentUser(f.requires);
    // Bind `current_user` when the find is principal-scoped (repo arg) or its
    // gate reads the actor; `requires true` on a non-principal find binds none.
    const cuLine =
      principal || gateUsesUser ? "    current_user = Map.get(conn.assigns, :current_user)\n" : "";
    // A find that reads NO params (param-less and non-paged) binds `_params` so
    // it doesn't trip the unused-variable check; a paged find always reads
    // `page`/`pageSize` off `params`.
    const paramArg = f.params.length > 0 || paged ? "params" : "_params";
    const argReads = [
      ...f.params.map((p) => `params[${JSON.stringify(p.name)}]`),
      // Paged: 1-based `page`/`pageSize` query controls, defaulted + coerced to
      // integers (Phoenix delivers query params as strings).  Matches the
      // shared cross-backend defaults.
      ...(paged
        ? [
            `page_param(params, "page", ${PAGED_DEFAULT_PAGE})`,
            `page_param(params, "pageSize", ${PAGED_DEFAULT_PAGE_SIZE})`,
            // Sort controls (M-T2.6) — strings passed through; the repo whitelists.
            `Map.get(params, "sort", "id")`,
            `Map.get(params, "dir", "asc")`,
          ]
        : []),
      ...(principal ? ["current_user"] : []),
    ].join(", ");
    const call = `${ctxModule}.${findSnake}_${aggSnake}(${argReads})`;

    // Assemble the action from its inner body — wrapping it in an `if not (gate)
    // do <403> else … end` guard when the find declares a `requires` clause.
    // Ungated finds stay byte-identical (no gate, original shape).
    const wrap = (innerBody: string): string => {
      if (!f.requires) {
        return `
  def ${findSnake}(conn, ${paramArg}) do
${cuLine}${innerBody}
  end`;
      }
      const gate = renderExpr(f.requires, {
        thisName: "record",
        contextModule,
        foundation: "vanilla",
      });
      return `
  def ${findSnake}(conn, ${paramArg}) do
${cuLine}    if not (${gate}) do
      ${webModule}.ProblemDetails.problem_response(conn, 403, "Forbidden", ${JSON.stringify(
        `Forbidden: find ${f.name}`,
      )})
    else
${innerBody}
    end
  end`;
    };

    if (paged) {
      // The repository already returns the `%{items, page, pageSize, total,
      // totalPages}` envelope (atom keys) — only `items` needs per-record
      // serialisation; the scalar counters pass straight through to the
      // canonical camelCase JSON.
      return wrap(`    with {:ok, result} <- ${call} do
      json(conn, %{result | items: Enum.map(result.items, &serialize/1)})
    end`);
    }

    const absent = absentSpec(agg, f.returnType, ctx);
    if (absent) {
      // Union find — translate the `nil` absent case; the found record is the
      // SUCCESS variant returned directly (untagged) at 200, matching the
      // emitted spec (`<Agg>Response`) and every other backend
      // (exception-less.md §4).  The error/absent variant is a status response,
      // never a tagged 200 body.
      const absentArm =
        absent.kind === "none"
          ? `        problem_variant(conn, 404, "about:blank", "Not Found", %{})`
          : `        problem_variant(conn, ${absent.status}, ${JSON.stringify(absent.type)}, ${JSON.stringify(absent.title)}, ${absent.hasResource ? `%{resource: ${JSON.stringify(aggPascal)}}` : "%{}"})`;
      return wrap(`    case ${call} do
      {:ok, nil} ->
${absentArm}

      {:ok, record} ->
        json(conn, serialize(record))
    end`);
    }

    if (isSingleReturn(f.returnType)) {
      return wrap(`    case ${call} do
      {:ok, nil} -> json(conn, nil)
      {:ok, record} -> json(conn, serialize(record))
    end`);
    }
    return wrap(`    with {:ok, records} <- ${call} do
      json(conn, Enum.map(records, &serialize/1))
    end`);
  });
  // A `page_param/3` coercion helper — once per controller — backs every paged
  // find's `page`/`pageSize` query reads (Phoenix delivers params as strings; a
  // missing/blank/non-integer param falls back to the shared default).  The
  // auto-`findAll` `index` is paged-by-default now (M-T2.6), so the helper is
  // required on every non-abstract controller even without an explicit paged find.
  const indexAllFind = (ctx.repositories ?? [])
    .find((r) => r.aggregateName === agg.name)
    ?.finds?.find((f) => f.name === "all");
  const indexPaged =
    !isAbstractBase(agg) && !!(indexAllFind && pagedReturn(indexAllFind.returnType));
  const hasPaged = indexPaged || httpFindsOf(ctx, agg).some((f) => pagedReturn(f.returnType));
  const pageParamHelper = hasPaged
    ? `
  defp page_param(params, key, default) do
    case params[key] do
      v when is_integer(v) -> v
      v when is_binary(v) ->
        case Integer.parse(v) do
          {n, _} when n >= 1 -> n
          _ -> default
        end

      _ -> default
    end
  end`
    : "";
  return actions.join("\n") + pageParamHelper;
}
