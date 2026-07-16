import type { Criterion, Route } from "../../../language/generated/ast.js";
import { defineMacro, handlerRef, route } from "../../api/index.js";
import { criterionAggName, pagedHandlerName, pagedRoutePath } from "./_paged-shared.js";

/** Emit the `route` half of the ergonomic paged criterion read
 * (read-path-architecture.md, "The ergonomic default").  The transport twin of
 * `scaffoldPaged`:
 *
 *   api SalesApi with scaffoldPagedApi(of: InRegion) { }
 *
 *   ↓ SalesApi gains
 *
 *   route GET "/orders/projections/in_region" -> Sales.ListOrderByInRegion
 *
 * The scaffolded read mounts on the aggregate's collection route under the
 * `/projections` namespace (the locked home for scaffolded reads — Phase-3
 * sign-off).  Method, path, and handler segment all derive from the SAME
 * criterion `scaffoldPaged` reads (the aggregate + context both come off the
 * criterion's `of T` target and its container context), so the route always
 * resolves to the handler that macro emits — `scaffoldPaged` must be applied to
 * the criterion's context (`context X with scaffoldPaged(of: <crit>)`) to supply
 * it. */
export default defineMacro({
  name: "scaffoldPagedApi",
  target: "api",
  apiVersion: 1,
  description:
    "Emits the GET route (on the aggregate collection route + /projections) that " +
    "binds to the paged queryHandler scaffoldPaged emits for the named criterion.",
  params: {
    of: { kind: "ref", of: "Criterion" },
  },
  expand({ args }) {
    const crit = args.of as Criterion;
    const aggName = criterionAggName(crit);
    // The criterion is a context member — its container context hosts the
    // handler `scaffoldPaged` splices, so it is the route's handler-ref context.
    const ctx = crit.$container;
    if (!ctx?.name) return [];
    const out: Route[] = [
      route(
        "GET",
        pagedRoutePath(aggName, crit.name),
        handlerRef(ctx.name, pagedHandlerName(aggName, crit.name)),
      ),
    ];
    return out;
  },
});
