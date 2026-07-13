import type { Route, Subdomain } from "../../../language/generated/ast.js";
import { defineMacro, handlerRef, route } from "../../api/index.js";
import { handlerTargets, targetHandlerName, targetMethod, targetPath } from "./_handlers-shared.js";

/** Emit a `route <METHOD> <path> -> <Context>.<Handler>` for every eligible
 * source of every aggregate across the named subdomain's contexts
 * (unfoldable-api-derivation.md, A3 + A3.2).  The HTTP method and path depend on
 * the source kind:
 *
 *   api SalesApi with scaffoldApi(of: Sales)
 *
 *   ↓ SalesApi gains
 *
 *   route GET  "/orders/{orderId}"          -> Ordering.GetOrder
 *   route GET  "/orders/by_status"          -> Ordering.ByStatus
 *   route POST "/orders"                    -> Ordering.CreateOrder
 *   route POST "/orders/{orderId}/cancel"   -> Ordering.CancelOrder
 *
 * Host-local: the routes splice into the api's own `routes[]`.  The route's
 * method, path, and handler segment are all derived from the SAME
 * `handlerTargets` selection + `target*` helpers that `scaffoldHandlers` uses,
 * so a route always resolves to a handler that macro emitted.
 * `scaffoldHandlers` must be applied to each targeted context
 * (`context X with scaffoldHandlers`) to supply those handlers. */
export default defineMacro({
  name: "scaffoldApi",
  target: "api",
  apiVersion: 1,
  description:
    "Emits a route per operation, create, find, and get-by-id read of every " +
    "aggregate in the named subdomain — POST for writes, GET for reads — " +
    "targeting the handler scaffoldHandlers emits for it.",
  params: {
    of: { kind: "ref", of: "Subdomain" },
  },
  expand({ args }) {
    const sub = args.of as Subdomain;
    const out: Route[] = [];
    for (const ctx of sub.contexts ?? []) {
      for (const t of handlerTargets(ctx)) {
        out.push(route(targetMethod(t), targetPath(t), handlerRef(ctx.name, targetHandlerName(t))));
      }
    }
    return out;
  },
});
