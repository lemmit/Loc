// Seed-declaration checks (database-seeding.md, declarative form).
//
// Model-level so the foreign-aggregate rule can compare a row's resolved
// aggregate against the seed's enclosing context.  This slice covers the
// false-positive-free subset: a row may only seed an aggregate of its own
// context, and a row's record may not repeat a field name.  Create-parameter
// shape-checking, `@handle` resolution, and the `raw`-bypasses-invariant
// warning are later slices.

import { AstUtils, type ValidationAcceptor } from "langium";
import type { Model, Seed } from "../generated/ast.js";
import { isBoundedContext, isSeed } from "../generated/ast.js";

export function checkSeeds(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (isSeed(node)) checkSeed(node, accept);
  }
}

function checkSeed(seed: Seed, accept: ValidationAcceptor): void {
  const ownCtx = AstUtils.getContainerOfType(seed, isBoundedContext);
  for (const row of seed.rows) {
    // Rule 1 — a seed may only populate aggregates of its own context.
    // (Same scoping a workflow body has; a cross-context seed would seed
    // through another context's create surface.)
    const agg = row.aggregate.ref;
    if (agg && ownCtx) {
      const aggCtx = AstUtils.getContainerOfType(agg, isBoundedContext);
      if (aggCtx && aggCtx !== ownCtx) {
        accept(
          "error",
          `Seed row references aggregate '${agg.name}' from context ` +
            `'${aggCtx.name}', but the seed is declared in context ` +
            `'${ownCtx.name}'. A seed may only populate aggregates of its ` +
            `own context.`,
          { node: row, property: "aggregate", code: "loom.seed-foreign-aggregate" },
        );
      }
    }

    // Rule 2 — a record may not repeat a field name.
    const seen = new Set<string>();
    for (const f of row.value.fields) {
      if (seen.has(f.name)) {
        accept("error", `Duplicate field '${f.name}' in seed row '${agg?.name ?? "?"}'.`, {
          node: f,
          property: "name",
          code: "loom.seed-duplicate-field",
        });
      }
      seen.add(f.name);
    }
  }
}
