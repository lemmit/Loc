// Seed-declaration checks (database-seeding.md, declarative form).
//
// Model-level so the foreign-aggregate rule can compare a row's resolved
// aggregate against the seed's enclosing context.  This slice covers the
// false-positive-free subset: a row may only seed an aggregate of its own
// context, and a row's record may not repeat a field name.  Create-parameter
// shape-checking, `@handle` resolution, and the `raw`-bypasses-invariant
// warning are later slices.

import { AstUtils, type ValidationAcceptor } from "langium";
import type { Model, Seed, SeedRef, SeedRow } from "../generated/ast.js";
import { isBoundedContext, isSeed, isSeedRef } from "../generated/ast.js";

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

  checkSeedHandles(seed, accept);
}

/** `@handle` reference rules (database-seeding.md §3.1):
 *  - a handle is bound by at most one row (`loom.seed-duplicate-handle`);
 *  - every `@ref` resolves to a bound handle (`loom.seed-unresolved-ref`);
 *  - the reference graph is acyclic (`loom.seed-cycle`). */
function checkSeedHandles(seed: Seed, accept: ValidationAcceptor): void {
  // Bound handles → the row that binds each (first binding wins).
  const boundBy = new Map<string, SeedRow>();
  for (const row of seed.rows) {
    if (!row.handle) continue;
    if (boundBy.has(row.handle)) {
      accept("error", `Duplicate seed handle '@${row.handle}' in this seed block.`, {
        node: row,
        property: "handle",
        code: "loom.seed-duplicate-handle",
      });
      continue;
    }
    boundBy.set(row.handle, row);
  }

  // Unresolved refs.
  for (const ref of seedRefsIn(seed)) {
    const h = ref.handle;
    if (h && !boundBy.has(h)) {
      accept("error", `Seed reference '@${h}' does not match any '@handle' in this seed block.`, {
        node: ref,
        property: "handle",
        code: "loom.seed-unresolved-ref",
      });
    }
  }

  // Cycle detection over row → referenced-handle edges.
  const rowRefs = new Map<SeedRow, Set<string>>();
  for (const row of seed.rows) {
    const refs = new Set<string>();
    for (const ref of AstUtils.streamAllContents(row.value)) {
      if (isSeedRef(ref) && ref.handle && boundBy.has(ref.handle)) refs.add(ref.handle);
    }
    rowRefs.set(row, refs);
  }
  const state = new Map<SeedRow, 0 | 1 | 2>();
  const visit = (row: SeedRow): boolean => {
    if (state.get(row) === 2) return false;
    if (state.get(row) === 1) return true; // back-edge → cycle
    state.set(row, 1);
    for (const h of rowRefs.get(row) ?? []) {
      const dep = boundBy.get(h);
      if (dep && dep !== row && visit(dep)) {
        state.set(row, 2);
        return true;
      }
    }
    state.set(row, 2);
    return false;
  };
  for (const row of seed.rows) {
    if (visit(row)) {
      accept("error", "Seed rows form a `@handle` reference cycle.", {
        node: row,
        code: "loom.seed-cycle",
      });
      break;
    }
  }
}

/** Every `@ref` expression anywhere inside a seed's rows. */
function seedRefsIn(seed: Seed): SeedRef[] {
  const out: SeedRef[] = [];
  for (const row of seed.rows) {
    for (const n of AstUtils.streamAllContents(row.value)) {
      if (isSeedRef(n)) out.push(n);
    }
  }
  return out;
}
