import type { BoundedContext, TypeRef } from "../../api/index.js";
import {
  callStmt,
  commandHandler,
  defineMacro,
  idRef,
  letStmt,
  memberAccess,
  namedType,
  nameRef,
  param,
  primType,
} from "../../api/index.js";
import { handlerName, handlerTargets, idParamName } from "./_handlers-shared.js";

/** Emit an application-layer `commandHandler` for every public operation of
 * every aggregate in the host context (unfoldable-api-derivation.md, A3).
 *
 *   context Ordering with scaffoldHandlers {
 *     aggregate Order { status: string; operation cancel() { … } }
 *     repository Orders for Order { }
 *   }
 *
 *   ↓ Ordering gains
 *
 *   commandHandler CancelOrder(orderId: Order id) {
 *     let o = Orders.getById(orderId)
 *     o.cancel()
 *   }
 *
 * Host-local: the handlers splice into the context's own `members[]`, so the
 * subtree-splice invariant is untouched.  Pairs with `scaffoldApi`, which emits
 * the matching `route`s from the same `handlerTargets` selection — a route can
 * never target a handler this macro didn't emit. */
export default defineMacro({
  name: "scaffoldHandlers",
  target: "context",
  apiVersion: 1,
  description:
    "Emits a commandHandler for every public operation of every aggregate in " +
    "the context (load-by-id via the aggregate's repository, then the op-call).",
  expand({ target }) {
    const ctx = target as BoundedContext;
    return handlerTargets(ctx).map(({ agg, op, repo }) => {
      const idParam = idParamName(agg.name);
      // Handler params: the id (`orderId: Order id`) followed by the op's own
      // params, threaded through verbatim so the op-call can pass them on.
      const params = [
        param(idParam, idRef(agg.name)),
        ...op.params.filter((p) => p.type != null).map((p) => param(p.name, cloneType(p.type))),
      ];
      const body = [
        // `let o = <Repo>.getById(<idParam>)`
        letStmt(
          "o",
          memberAccess(nameRef(repo.name), "getById", { call: true, args: [nameRef(idParam)] }),
        ),
        // `o.<op>(<op params…>)`
        callStmt(
          ["o", op.name],
          op.params.filter((p) => p.type != null).map((p) => nameRef(p.name)),
        ),
      ];
      return commandHandler(handlerName(op.name, agg.name), params, body);
    });
  },
});

/** Rebuild an operation param's TypeRef as a fresh, macro-tagged handler-param
 * type — the same factory-based reconstruction `crudish` uses so a param typed
 * `Money` / `OrderStatus` / `X id` keeps its resolved type after splicing
 * (hand-rolled `mk*` refs never re-link and silently lower to `string`). */
function cloneType(t: TypeRef): TypeRef {
  const opts = { array: !!t.array, optional: !!t.optional };
  const b = t.base;
  if (b.$type === "PrimitiveType") {
    return primType(b.name as Parameters<typeof primType>[0], opts);
  }
  if (b.$type === "IdType") {
    return idRef(b.target.$refText, opts);
  }
  return namedType((b as { target: { $refText: string } }).target.$refText, opts);
}
