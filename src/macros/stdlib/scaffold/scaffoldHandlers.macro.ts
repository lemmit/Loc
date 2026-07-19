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
import { contractRecords } from "./_contracts-shared.js";
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
 *   queryHandler   GetOrder(query: GetOrderQuery): OrderResponse  { let o = Orders.getById(query.orderId)  return o }
 *   queryHandler   ByStatusOrder(query: ByStatusOrderQuery): OrderResponse[] { let r = Orders.byStatus(query.status)  return r }
 *   commandHandler CreateOrder(cmd: CreateOrderCommand): Order id {
 *     let o = Order.create({ code: cmd.code, status: cmd.status })
 *     return o.id
 *   }
 *   commandHandler CancelOrder(orderId: Order id) {   // cmd omitted — cancel has no params
 *     let o = Orders.getById(orderId)
 *     o.cancel()
 *   }
 *
 * Each handler now consumes the `command`/`query` contract record `_contracts-
 * shared` splices alongside it (the two derive their field sets from the same
 * source, so a handler body's `cmd.<field>` / `query.<field>` always names a
 * record field).  A single record param per handler; a path-param id stays a
 * SEPARATE handler param (a route `{orderId}` can't live in a body record), and
 * an empty command record (op with no params, destroy) is omitted entirely.
 * Read handlers (getById / find over the aggregate) declare a `<Agg>Response`
 * return — the wire is already that shape (transport projects the entity), so
 * the declaration only aligns with reality.
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
    // Contract records FIRST (readable `unfold` output: the API contract, then
    // the handlers that realise it), then the handlers.  The records are
    // additive + inert in PR1 — no handler references them yet, so generation is
    // byte-identical with vs without them.
    const handlers = handlerTargets(ctx).map(buildHandler);
    return [...contractRecords(ctx), ...handlers];
  },
});

/** Build the `commandHandler` / `queryHandler` AST for one target.  Each
 * handler takes a SINGLE `command`/`query` record param (the contract record
 * `_contracts-shared` splices alongside it) and references its fields as
 * `cmd.<field>` / `query.<field>`; a path-param id rides as a separate handler
 * param, and an empty record is omitted.  The body shape otherwise mirrors the
 * hand-written handler — the same IR the equivalent explicit source lowers to. */
function buildHandler(t: HandlerTarget) {
  switch (t.kind) {
    case "operation": {
      const idParam = idParamName(t.agg.name);
      const opParams = t.op.params.filter((p) => p.type != null);
      // `(orderId: Order id[, cmd: <Op><Agg>Command])` — the id rides as a path
      // param (a route `{orderId}` can't live in a body record); the op's own
      // params ride in the command record.  An op with no params omits `cmd`.
      const params = [
        param(idParam, idRef(t.agg.name)),
        ...(opParams.length > 0 ? [param("cmd", namedType(`${targetHandlerName(t)}Command`))] : []),
      ];
      const body = [
        // `let o = <Repo>.getById(<idParam>)`
        letStmt(
          "o",
          memberAccess(nameRef(t.repo.name), "getById", { call: true, args: [nameRef(idParam)] }),
        ),
        // `o.<op>(cmd.<p>, …)` — the op's args read off the command record.
        callStmt(
          ["o", t.op.name],
          opParams.map((p) => memberAccess(nameRef("cmd"), p.name)),
        ),
      ];
      return commandHandler(targetHandlerName(t), params, body);
    }
    case "create": {
      // A create handler takes the aggregate's create-INPUT fields (the same
      // shape the factory `<Agg>.create(...)` accepts and the create command
      // record exposes) as a single `cmd: <Create<Agg>>Command` body record.
      const fields = writableCreateFields(t.agg).filter((f) => f.type != null);
      const params =
        fields.length > 0 ? [param("cmd", namedType(`${targetHandlerName(t)}Command`))] : [];
      const body = [
        // `let o = <Agg>.create({ <field>: cmd.<field>, … })` — a factory-let;
        // each field value reads off the command record.  `computeSaves`
        // persists the constructed `o` at exit.
        letStmt(
          "o",
          memberAccess(nameRef(t.agg.name), "create", {
            call: true,
            args: [
              objectLit(
                fields.map((f) => ({ name: f.name, value: memberAccess(nameRef("cmd"), f.name) })),
              ),
            ],
          }),
        ),
        // `return o.id` — the new aggregate's id.
        returnStmt(memberAccess(nameRef("o"), "id")),
      ];
      // Return type `<Agg> id` (a create yields the new id, not a response).
      return commandHandler(targetHandlerName(t), params, body, { returnType: idRef(t.agg.name) });
    }
    case "find": {
      // A query handler running the repository find.  Its params ride in a
      // single `query: <Find>Query` record (assembled from path/query-string);
      // `let r = <Repo>.<find>(query.<p>, …)` lowers to a repo-let and `return r`
      // yields the read's response shape.
      const findParams = t.find.params.filter((p) => p.type != null);
      const params =
        findParams.length > 0 ? [param("query", namedType(`${targetHandlerName(t)}Query`))] : [];
      const body = [
        letStmt(
          "r",
          memberAccess(nameRef(t.repo.name), t.find.name, {
            call: true,
            args: findParams.map((p) => memberAccess(nameRef("query"), p.name)),
          }),
        ),
        returnStmt(nameRef("r")),
      ];
      // Reads over the aggregate declare a `<Agg>Response[]` return (the wire is
      // already that shape via transport projection); non-aggregate finds keep
      // their own return type.
      return queryHandler(
        targetHandlerName(t),
        params,
        responseReturnType(t.find.returnType, t.agg.name),
        body,
      );
    }
    case "getById": {
      // The canonical get-by-id read: the id rides in a single-field
      // `query: Get<Agg>Query` record (bound from the route path), then load +
      // return the aggregate as `<Agg>Response`.
      const idField = idParamName(t.agg.name);
      const params = [param("query", namedType(`${targetHandlerName(t)}Query`))];
      const body = [
        letStmt(
          "o",
          memberAccess(nameRef(t.repo.name), "getById", {
            call: true,
            args: [memberAccess(nameRef("query"), idField)],
          }),
        ),
        returnStmt(nameRef("o")),
      ];
      // Return type is the aggregate's response record.
      return queryHandler(targetHandlerName(t), params, namedType(`${t.agg.name}Response`), body);
    }
    case "destroy": {
      // The canonical hard-delete: load one aggregate by id, then remove it.
      // `<Repo>.delete(o)` lowers to a first-class `repo-delete` handler
      // statement (every domain-logic backend renders it to its own repository
      // delete verb).  A void commandHandler — there is nothing meaningful to
      // return after a delete (the entity is gone; `return o.id` would read a
      // just-removed row), so the handler yields no value, exactly like a
      // fire-and-forget `operation` commandHandler.
      const idParam = idParamName(t.agg.name);
      const params = [param(idParam, idRef(t.agg.name))];
      const body = [
        // `let o = <Repo>.getById(<idParam>)`
        letStmt(
          "o",
          memberAccess(nameRef(t.repo.name), "getById", { call: true, args: [nameRef(idParam)] }),
        ),
        // `<Repo>.delete(o)` — a repo-delete statement.
        callStmt([t.repo.name, "delete"], [nameRef("o")]),
      ];
      return commandHandler(targetHandlerName(t), params, body);
    }
  }
}

/** The declared return type for a read handler.  A find/getById yielding the
 * aggregate (`Order` / `Order[]`) declares the response record instead
 * (`OrderResponse` / `OrderResponse[]`) — the transport layer already projects
 * the entity to that shape, so this only aligns the declaration with the wire.
 * A find returning a non-aggregate type (scalar / projection) keeps it. */
function responseReturnType(t: TypeRef, aggName: string): TypeRef {
  const b = t.base;
  const isAgg =
    b.$type === "NamedType" && (b as { target: { $refText: string } }).target.$refText === aggName;
  if (isAgg) {
    return namedType(`${aggName}Response`, { array: !!t.array, optional: !!t.optional });
  }
  return cloneType(t);
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
