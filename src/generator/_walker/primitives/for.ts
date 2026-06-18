// For-comprehension primitive: emitFor renders a `For { each: <coll>,
// <item> => <markup> }` list comprehension.  The collection expression
// and the per-item markup body walk through the shared engine; the
// framework-divergent iteration shape (`.map` + keyed Fragment / Vue
// `v-for` / Svelte `{#each}`) is delegated to the active target's
// `renderForEach` seam — the markup-structural analogue of `match` /
// ternary children, NOT the domain-level collection ops the expression
// renderers own.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { lambdaArg, namedArgValue, positionalArgs } from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import { emitExpr, extendLambdaParams, propagateChildFlags, walk } from "../walker-core.js";

/** `For { each: <coll>, <item> => <markup> }`.
 *
 *  Surface:
 *    - `each:` — the collection expression (or the first positional
 *      non-lambda arg).  Required.
 *    - the item renderer — the first positional lambda (`o => Card { … }`),
 *      whose param binds to the emitted iteration variable.  Required.
 *
 *  The list key is the synthesised loop index.  A source-level `key:`
 *  override isn't offered: the grammar can't place a second lambda arg
 *  next to a brace-body item lambda (`o => Card { … }`), so it would be
 *  unwritable in practice; the `renderForEach` seam still takes a
 *  `keyExpr` so a programmatic IR (or a future grammar) can supply one.
 *
 *  Lowers to the target's native iteration via `renderForEach`. */
export function emitFor(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  const positionals = positionalArgs(call);
  // Collection: `each:` named arg, else the first positional non-lambda.
  const collArg = namedArgValue(call, "each") ?? positionals.find((a) => a.kind !== "lambda");
  if (!collArg) {
    return ctx.target.renderComment(
      `For: missing 'each:' collection expression (e.g. For { each: orders, o => … })`,
    );
  }
  // Item renderer: first positional lambda, else a `render:` named lambda.
  const itemLam =
    positionals.find((a): a is ExprIR & { kind: "lambda" } => a.kind === "lambda") ??
    lambdaArg(call, "render");
  if (!itemLam) {
    return ctx.target.renderComment(
      `For: missing item lambda (e.g. For { each: orders, o => Card { … } })`,
    );
  }
  if (!itemLam.body) {
    // Block-body lambdas have no markup result — a For item must be an
    // expression (markup).  Surface the gap rather than emit nothing.
    return ctx.target.renderComment(`For: item lambda must be an expression body, not a block`);
  }

  const collExpr = emitExpr(collArg, ctx);
  const itemVar = itemLam.param;
  const indexVar = `${itemVar}Idx`;

  // Walk the per-item markup with the item param bound to the emitted
  // iteration variable (its own name — the target spells the loop
  // binding identically).
  const bodyCtx: WalkContext = {
    ...ctx,
    lambdaParams: extendLambdaParams(ctx, itemVar, itemVar),
  };
  const body = walk(itemLam.body, bodyCtx, depth + 1);
  propagateChildFlags(ctx, bodyCtx);

  // TSX wraps each iteration in a keyed `<Fragment>` — flag the shell
  // to import it.  Vue/Svelte iterate natively and never read this.
  if (ctx.target.framework === "react") ctx.usesFragment = true;

  return ctx.target.renderForEach(collExpr, itemVar, indexVar, indexVar, body, depth);
}
