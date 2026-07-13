// Shared selection + naming logic for the explicit application/transport
// scaffold macros (unfoldable-api-derivation.md, A3).  `scaffoldHandlers`
// (context-targeted) emits a `commandHandler` / `queryHandler` per eligible
// source (aggregate operation / create / repository find / get-by-id) and
// `scaffoldApi` (api-targeted) emits the `route` that binds to it — so the two
// MUST agree on (a) which sources are eligible and (b) the derived handler name
// / HTTP method / route path.  Both derive everything here, so a route can
// never target a handler the other macro didn't emit.
//
// A3.2 generalises the original A3 (operations only) to a DISCRIMINATED target
// set spanning three more source kinds:
//   - `create`  → commandHandler constructing the aggregate     → POST /<coll>
//   - `find`    → queryHandler running the repository find       → GET  /<coll>/<find>
//   - `getById` → queryHandler loading one aggregate by id       → GET  /<coll>/{<agg>Id}
// plus the original `operation` (unchanged: POST /<coll>/{id}/<op>).
//
// `destroy` is deliberately NOT emitted here — see the note on `handlerTargets`.

import type {
  Aggregate,
  BoundedContext,
  Create,
  Destroy,
  FindDecl,
  HttpMethod,
  Operation,
  Repository,
} from "../../../language/generated/ast.js";
import {
  isAggregate,
  isCreate,
  isDestroy,
  isOperation,
  isRepository,
} from "../../../language/generated/ast.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";

/** The id parameter name a generated handler takes: `<agg>Id` (`Order` →
 * `orderId`).  Deliberately NOT `id` — a bare `id` handler param is reserved
 * (`loom.handler-param-reserved-id`). */
export function idParamName(aggName: string): string {
  return `${lowerFirst(aggName)}Id`;
}

/** The plural-snake collection path segment for an aggregate: `Order` →
 * `/orders`.  The base of every create / find / get-by-id route. */
export function collectionPath(aggName: string): string {
  return `/${snake(plural(aggName))}`;
}

/** Handler name for an operation on an aggregate: `<Op><Agg>` (`cancel` on
 * `Order` → `CancelOrder`).  Unchanged from A3. */
export function handlerName(opName: string, aggName: string): string {
  return `${upperFirst(opName)}${upperFirst(aggName)}`;
}

/** The route path for an operation on an aggregate:
 * `/<plural-snake-agg>/{<agg>Id}/<snake-op>` (`cancel` on `Order` →
 * `/orders/{orderId}/cancel`). */
export function routePath(aggName: string, opName: string): string {
  return `${collectionPath(aggName)}/{${idParamName(aggName)}}/${snake(opName)}`;
}

/** One eligible source in a context, carrying the aggregate + the repository
 * that loads it by id.  Discriminated on `kind`: the kind-specific declaration
 * (`op` / `create` / `find`) rides alongside; `getById` is a synthetic per-
 * aggregate read with no source declaration. */
export type HandlerTarget =
  | {
      readonly kind: "operation";
      readonly agg: Aggregate;
      readonly repo: Repository;
      readonly op: Operation;
    }
  | {
      readonly kind: "create";
      readonly agg: Aggregate;
      readonly repo: Repository;
      readonly create: Create;
    }
  | {
      readonly kind: "find";
      readonly agg: Aggregate;
      readonly repo: Repository;
      readonly find: FindDecl;
    }
  | { readonly kind: "getById"; readonly agg: Aggregate; readonly repo: Repository }
  | {
      readonly kind: "destroy";
      readonly agg: Aggregate;
      readonly repo: Repository;
      readonly destroy: Destroy;
    };

/** The aggregate's CANONICAL destroy — the unnamed `destroy { }` terminator
 * (`d.name == null`, matching `lowerDestroy`'s `canonical` rule).  This is the
 * exact source the repository's delete verb is gated on (`agg.canonicalDestroy`
 * → `delete`/`DeleteAsync`/… emission), so scaffolding a destroy handler only
 * when one is present keeps the handler body's `<Repo>.delete(o)` call bound to
 * a delete verb the repo actually emits.  `with crudish` supplies one; an
 * explicit unnamed `destroy { }` does too. */
function canonicalDestroyOf(agg: Aggregate): Destroy | undefined {
  return (agg.members ?? []).filter(isDestroy).find((d) => d.name == null);
}

/** Every eligible source in `ctx` that has a repository to load its aggregate
 * by id.  An aggregate with no repository is skipped (nothing to `getById`
 * through), which keeps `scaffoldHandlers` and `scaffoldApi` in lock-step —
 * neither emits for a source the other can't.
 *
 * Emitted kinds: `getById` (one per aggregate), `create` (every `create`
 * factory action), `operation` (public operations), `find` (every declared
 * repository find), `destroy` (only when the aggregate has a CANONICAL destroy).
 *
 * `destroy` is emitted only for an aggregate carrying a canonical (unnamed)
 * `destroy { }` terminator — the exact source the repository's delete verb is
 * gated on.  The handler body loads the aggregate by id then calls
 * `<Repo>.delete(o)`, a first-class `repo-delete` handler statement (added in
 * the repo-delete slice) that every domain-logic backend renders to its own
 * repository delete verb.  An aggregate with no canonical destroy silently skips
 * the destroy target — mirroring how an aggregate with no repository is skipped
 * entirely — so a `route DELETE ...` is never emitted for a delete verb the
 * backend didn't generate. */
export function handlerTargets(ctx: BoundedContext): HandlerTarget[] {
  const members = ctx.members ?? [];
  const repos = members.filter(isRepository);
  const out: HandlerTarget[] = [];
  for (const agg of members.filter(isAggregate)) {
    const repo = repos.find((r) => r.aggregate?.$refText === agg.name);
    if (!repo) continue;
    // Read side first: get-by-id, then each declared find.
    out.push({ kind: "getById", agg, repo });
    for (const find of repo.finds ?? []) {
      out.push({ kind: "find", agg, repo, find });
    }
    // Write side: each `create` factory action.  Creates are never `private`.
    for (const create of (agg.members ?? []).filter(isCreate)) {
      out.push({ kind: "create", agg, repo, create });
    }
    // Public operations only — `private operation`s are internal helpers.
    for (const op of (agg.members ?? []).filter(isOperation)) {
      if (op.private) continue;
      out.push({ kind: "operation", agg, repo, op });
    }
    // Destroy: only when a canonical `destroy { }` is present (so the repo emits
    // the delete verb the handler body calls).  DELETE /<coll>/{<agg>Id}.
    const destroy = canonicalDestroyOf(agg);
    if (destroy) out.push({ kind: "destroy", agg, repo, destroy });
  }
  return out;
}

/** The derived handler name for a target — the single source of truth both
 * macros route through (the `commandHandler`/`queryHandler` name AND the
 * `route`'s handler segment), so a route always resolves to an emitted handler.
 *
 *   - operation → `<Op><Agg>`            (`cancel` on `Order` → `CancelOrder`)
 *   - create    → `Create<Agg>`, or `<Name><Agg>` for a named factory
 *                 (`create place(...)` → `PlaceOrder`)
 *   - find      → `<Find>`                (`byStatus` → `ByStatus`)
 *   - getById   → `Get<Agg>`             (`Order` → `GetOrder`)
 *   - destroy   → `Destroy<Agg>`         (`Order` → `DestroyOrder`) */
export function targetHandlerName(t: HandlerTarget): string {
  switch (t.kind) {
    case "operation":
      return handlerName(t.op.name, t.agg.name);
    case "create":
      return t.create.name
        ? `${upperFirst(t.create.name)}${upperFirst(t.agg.name)}`
        : `Create${upperFirst(t.agg.name)}`;
    case "find":
      return upperFirst(t.find.name);
    case "getById":
      return `Get${upperFirst(t.agg.name)}`;
    case "destroy":
      return `Destroy${upperFirst(t.agg.name)}`;
  }
}

/** The HTTP method a target binds to: POST for writes (create / operation),
 * GET for reads (find / get-by-id), DELETE for `destroy`. */
export function targetMethod(t: HandlerTarget): HttpMethod {
  switch (t.kind) {
    case "create":
    case "operation":
      return "POST";
    case "find":
    case "getById":
      return "GET";
    case "destroy":
      return "DELETE";
  }
}

/** The route path for a target:
 *   - operation → `/<coll>/{<agg>Id}/<op>`
 *   - create    → `/<coll>`
 *   - find      → `/<coll>/<find>`
 *   - getById   → `/<coll>/{<agg>Id}`
 *   - destroy   → `/<coll>/{<agg>Id}` (same resource, DELETE method) */
export function targetPath(t: HandlerTarget): string {
  switch (t.kind) {
    case "operation":
      return routePath(t.agg.name, t.op.name);
    case "create":
      return collectionPath(t.agg.name);
    case "find":
      return `${collectionPath(t.agg.name)}/${snake(t.find.name)}`;
    case "getById":
    case "destroy":
      return `${collectionPath(t.agg.name)}/{${idParamName(t.agg.name)}}`;
  }
}
