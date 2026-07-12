// Shared selection + naming logic for the explicit application/transport
// scaffold macros (unfoldable-api-derivation.md, A3).  `scaffoldHandlers`
// (context-targeted) emits a `commandHandler` per (aggregate, public operation)
// and `scaffoldApi` (api-targeted) emits the `route` that binds to it — so the
// two MUST agree on (a) which (aggregate, operation) pairs are eligible and
// (b) the derived handler name / route path.  Both derive everything here, so a
// route can never target a handler the other macro didn't emit.

import type {
  Aggregate,
  BoundedContext,
  Operation,
  Repository,
} from "../../../language/generated/ast.js";
import { isAggregate, isOperation, isRepository } from "../../../language/generated/ast.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";

/** Handler name for an operation on an aggregate: `<Op><Agg>` (`cancel` on
 * `Order` → `CancelOrder`).  Both the `commandHandler` name and the `route`
 * target's handler segment route through this. */
export function handlerName(opName: string, aggName: string): string {
  return `${upperFirst(opName)}${upperFirst(aggName)}`;
}

/** The id parameter name a generated handler takes: `<agg>Id` (`Order` →
 * `orderId`).  Deliberately NOT `id` — a bare `id` handler param is reserved
 * (`loom.handler-param-reserved-id`). */
export function idParamName(aggName: string): string {
  return `${lowerFirst(aggName)}Id`;
}

/** The route path for an operation on an aggregate:
 * `/<plural-snake-agg>/{<agg>Id}/<snake-op>` (`cancel` on `Order` →
 * `/orders/{orderId}/cancel`). */
export function routePath(aggName: string, opName: string): string {
  return `/${snake(plural(aggName))}/{${idParamName(aggName)}}/${snake(opName)}`;
}

/** One eligible (aggregate, public operation) pair in a context, carrying the
 * repository that loads the aggregate by id. */
export interface HandlerTarget {
  readonly agg: Aggregate;
  readonly op: Operation;
  readonly repo: Repository;
}

/** Every (aggregate, public operation) pair in `ctx` that has a repository to
 * load the aggregate by id.  An aggregate with no repository is skipped (there
 * is nothing to `getById` through), which keeps `scaffoldHandlers` and
 * `scaffoldApi` in lock-step — neither emits for a pair the other can't. */
export function handlerTargets(ctx: BoundedContext): HandlerTarget[] {
  const members = ctx.members ?? [];
  const repos = members.filter(isRepository);
  const out: HandlerTarget[] = [];
  for (const agg of members.filter(isAggregate)) {
    const repo = repos.find((r) => r.aggregate?.$refText === agg.name);
    if (!repo) continue;
    for (const op of (agg.members ?? []).filter(isOperation)) {
      // Public surface only — `private operation`s are internal helpers, not
      // application-layer commands.
      if (op.private) continue;
      out.push({ agg, op, repo });
    }
  }
  return out;
}
