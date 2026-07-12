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
  FindDecl,
  HttpMethod,
  Operation,
  Repository,
} from "../../../language/generated/ast.js";
import {
  isAggregate,
  isCreate,
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
  | { readonly kind: "getById"; readonly agg: Aggregate; readonly repo: Repository };

/** Every eligible source in `ctx` that has a repository to load its aggregate
 * by id.  An aggregate with no repository is skipped (nothing to `getById`
 * through), which keeps `scaffoldHandlers` and `scaffoldApi` in lock-step —
 * neither emits for a source the other can't.
 *
 * Emitted kinds: `getById` (one per aggregate), `create` (every `create`
 * factory action), `operation` (public operations), `find` (every declared
 * repository find).
 *
 * `destroy` is intentionally NOT emitted.  A destroy handler body would need to
 * express a hard-delete, but Loom's handler-statement vocabulary has no
 * repo-delete verb and the domain entity emits no `destroy()` method — so
 * `o.destroy()` fails to compile (CS1061 on .NET) and an empty-body destroy
 * would silently overwrite the auto-derived `Destroy<Agg>` command with a no-op.
 * Wiring destroy needs generator-side work (an entity `destroy()` emit or a
 * repo-delete statement kind) that is out of the macro layer's reach; it is
 * tracked as a follow-up. */
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
 *   - getById   → `Get<Agg>`             (`Order` → `GetOrder`) */
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
  }
}

/** The HTTP method a target binds to: POST for writes (create / operation),
 * GET for reads (find / get-by-id).  (DELETE is reserved for `destroy`, which
 * is not yet emitted — see `handlerTargets`.) */
export function targetMethod(t: HandlerTarget): HttpMethod {
  switch (t.kind) {
    case "create":
    case "operation":
      return "POST";
    case "find":
    case "getById":
      return "GET";
  }
}

/** The route path for a target:
 *   - operation → `/<coll>/{<agg>Id}/<op>`
 *   - create    → `/<coll>`
 *   - find      → `/<coll>/<find>`
 *   - getById   → `/<coll>/{<agg>Id}` */
export function targetPath(t: HandlerTarget): string {
  switch (t.kind) {
    case "operation":
      return routePath(t.agg.name, t.op.name);
    case "create":
      return collectionPath(t.agg.name);
    case "find":
      return `${collectionPath(t.agg.name)}/${snake(t.find.name)}`;
    case "getById":
      return `${collectionPath(t.agg.name)}/{${idParamName(t.agg.name)}}`;
  }
}
