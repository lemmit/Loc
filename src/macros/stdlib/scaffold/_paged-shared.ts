// Shared selection + naming logic for the paged read scaffold macros
// (read-path-architecture.md, "The ergonomic default").  `scaffoldPaged`
// (context-targeted) emits the paged `queryHandler` over the read-only
// port (`<Repo>.run(<Criterion>(args))`) and `scaffoldPagedApi`
// (api-targeted) emits the `route` that binds to it — so the two MUST agree
// on the derived handler name and route path.  Both derive everything here,
// exactly like the `scaffoldHandlers` / `scaffoldApi` pair does through
// `_handlers-shared.ts`.

import type { Criterion } from "../../../language/generated/ast.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { collectionPath } from "./_handlers-shared.js";

/** The aggregate a criterion targets — the `T` in `criterion X(...) of T`.
 * Read off the criterion's target `TypeRef` base (`NamedType`/`IdType`, both
 * carrying a `target.$refText`). */
export function criterionAggName(crit: Criterion): string {
  const base = crit.target.base as { target?: { $refText?: string } };
  return base.target?.$refText ?? "";
}

/** The handler name a paged criterion read derives: `List<Agg>By<Criterion>`
 * (`InRegion` of `Order` → `ListOrderByInRegion`).  The single source of truth
 * both macros route through — the `queryHandler` name AND the `route`'s handler
 * segment — so a route always resolves to the emitted handler. */
export function pagedHandlerName(aggName: string, critName: string): string {
  return `List${upperFirst(aggName)}By${upperFirst(critName)}`;
}

/** The route path for a paged criterion read: the aggregate collection route
 * plus `/projections/<snake-criterion>` (`InRegion` of `Order` →
 * `/orders/projections/in_region`).  The `/projections` namespace is the locked
 * home for scaffolded reads (read-path-architecture.md, Phase-3 sign-off). */
export function pagedRoutePath(aggName: string, critName: string): string {
  return `${collectionPath(aggName)}/projections/${snake(critName)}`;
}
