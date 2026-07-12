import type { Route, Subdomain } from "../../../language/generated/ast.js";
import { defineMacro, handlerRef, route } from "../../api/index.js";
import { handlerName, handlerTargets, routePath } from "./_handlers-shared.js";

/** Emit a `route POST <path> -> <Context>.<Handler>` for every public
 * operation of every aggregate across the named subdomain's contexts
 * (unfoldable-api-derivation.md, A3).
 *
 *   api SalesApi with scaffoldApi(of: Sales)
 *
 *   ↓ SalesApi gains
 *
 *   route POST "/orders/{orderId}/cancel" -> Ordering.CancelOrder
 *
 * Host-local: the routes splice into the api's own `routes[]`.  The route's
 * handler segment (`CancelOrder`) is derived from the SAME `handlerTargets`
 * selection + `handlerName` helper that `scaffoldHandlers` uses, so it always
 * resolves to a handler that macro emitted.  `scaffoldHandlers` must be applied
 * to each targeted context (`context X with scaffoldHandlers`) to supply those
 * handlers. */
export default defineMacro({
  name: "scaffoldApi",
  target: "api",
  apiVersion: 1,
  description:
    "Emits a POST route per public operation of every aggregate in the named " +
    "subdomain, targeting the commandHandler scaffoldHandlers emits for it.",
  params: {
    of: { kind: "ref", of: "Subdomain" },
  },
  expand({ args }) {
    const sub = args.of as Subdomain;
    const out: Route[] = [];
    for (const ctx of sub.contexts ?? []) {
      for (const { agg, op } of handlerTargets(ctx)) {
        out.push(
          route(
            "POST",
            routePath(agg.name, op.name),
            handlerRef(ctx.name, handlerName(op.name, agg.name)),
          ),
        );
      }
    }
    return out;
  },
});
