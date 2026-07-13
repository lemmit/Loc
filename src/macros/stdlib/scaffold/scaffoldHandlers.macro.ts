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
  objectLit,
  param,
  primType,
  queryHandler,
  returnStmt,
  writableCreateFields,
} from "../../api/index.js";
import {
  type HandlerTarget,
  handlerTargets,
  idParamName,
  targetHandlerName,
} from "./_handlers-shared.js";

/** Emit an application-layer `commandHandler` / `queryHandler` for every
 * eligible source of every aggregate in the host context
 * (unfoldable-api-derivation.md, A3 + A3.2).
 *
 *   context Ordering with scaffoldHandlers {
 *     aggregate Order {
 *       code: string
 *       status: string
 *       create(code: string) { … }
 *       operation cancel() { … }
 *     }
 *     repository Orders for Order { find byStatus(status: string): Order[] }
 *   }
 *
 *   ↓ Ordering gains
 *
 *   queryHandler   GetOrder(orderId: Order id): Order      { let o = Orders.getById(orderId)  return o }
 *   queryHandler   ByStatus(status: string): Order[]       { let r = Orders.byStatus(status)  return r }
 *   commandHandler CreateOrder(code: string, status: string): Order id {
 *     let o = Order.create({ code: code, status: status })
 *     return o.id
 *   }
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
    "Emits a commandHandler/queryHandler for every operation, create, find, and " +
    "get-by-id read of every aggregate in the context (load/construct via the " +
    "aggregate's repository or factory, then the op-call / find / return).",
  expand({ target }) {
    const ctx = target as BoundedContext;
    return handlerTargets(ctx).map(buildHandler);
  },
});

/** Build the `commandHandler` / `queryHandler` AST for one target.  The body
 * shape mirrors what the corresponding hand-written handler carries — i.e. the
 * exact AST that lowers to the same IR the equivalent explicit source would. */
function buildHandler(t: HandlerTarget) {
  switch (t.kind) {
    case "operation": {
      const idParam = idParamName(t.agg.name);
      // Handler params: the id (`orderId: Order id`) followed by the op's own
      // params, threaded through verbatim so the op-call can pass them on.
      const params = [
        param(idParam, idRef(t.agg.name)),
        ...t.op.params.filter((p) => p.type != null).map((p) => param(p.name, cloneType(p.type))),
      ];
      const body = [
        // `let o = <Repo>.getById(<idParam>)`
        letStmt(
          "o",
          memberAccess(nameRef(t.repo.name), "getById", { call: true, args: [nameRef(idParam)] }),
        ),
        // `o.<op>(<op params…>)`
        callStmt(
          ["o", t.op.name],
          t.op.params.filter((p) => p.type != null).map((p) => nameRef(p.name)),
        ),
      ];
      return commandHandler(targetHandlerName(t), params, body);
    }
    case "create": {
      // A create handler takes the aggregate's create-INPUT fields (the same
      // shape the factory `<Agg>.create(...)` accepts and the auto-derived
      // create command exposes — deriving from the create action's declared
      // params instead would leave the other non-null create fields unset and
      // the factory-let would null-fill them, breaking non-nullable columns).
      const fields = writableCreateFields(t.agg).filter((f) => f.type != null);
      const params = fields.map((f) => param(f.name, cloneType(f.type)));
      const body = [
        // `let o = <Agg>.create({ <field>: <field>, … })` — a factory-let; each
        // field value is the handler param of the same name.  `computeSaves`
        // persists the constructed `o` at exit.
        letStmt(
          "o",
          memberAccess(nameRef(t.agg.name), "create", {
            call: true,
            args: [objectLit(fields.map((f) => ({ name: f.name, value: nameRef(f.name) })))],
          }),
        ),
        // `return o.id` — the new aggregate's id.
        returnStmt(memberAccess(nameRef("o"), "id")),
      ];
      // Return type `<Agg> id`.
      return commandHandler(targetHandlerName(t), params, body, { returnType: idRef(t.agg.name) });
    }
    case "find": {
      // A query handler running the repository find.  Params thread the find's
      // own params through verbatim; `let r = <Repo>.<find>(<params>)` lowers to
      // a repo-let and `return r` yields the find's declared return type.
      const params = t.find.params
        .filter((p) => p.type != null)
        .map((p) => param(p.name, cloneType(p.type)));
      const body = [
        letStmt(
          "r",
          memberAccess(nameRef(t.repo.name), t.find.name, {
            call: true,
            args: t.find.params.filter((p) => p.type != null).map((p) => nameRef(p.name)),
          }),
        ),
        returnStmt(nameRef("r")),
      ];
      return queryHandler(targetHandlerName(t), params, cloneType(t.find.returnType), body);
    }
    case "getById": {
      // The canonical get-by-id read: load one aggregate by id, return it.
      const idParam = idParamName(t.agg.name);
      const params = [param(idParam, idRef(t.agg.name))];
      const body = [
        letStmt(
          "o",
          memberAccess(nameRef(t.repo.name), "getById", { call: true, args: [nameRef(idParam)] }),
        ),
        returnStmt(nameRef("o")),
      ];
      // Return type is the bare aggregate.
      return queryHandler(targetHandlerName(t), params, namedType(t.agg.name), body);
    }
  }
}

/** Rebuild a source param / field / return TypeRef as a fresh, macro-tagged
 * handler-param type — the same factory-based reconstruction `crudish` uses so
 * a type of `Money` / `OrderStatus` / `X id` / `Order[]` keeps its resolved
 * type after splicing (hand-rolled `mk*` refs never re-link and silently lower
 * to `string`). */
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
