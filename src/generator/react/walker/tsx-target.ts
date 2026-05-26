// ---------------------------------------------------------------------------
// TSX walker target — concrete `WalkerTarget` implementation consumed
// by `src/generator/react/body-walker.ts` for the state / navigation /
// match seams.
//
// Behavioural contract: the methods MUST return byte-identical
// fragments to the inlined seams they replaced.  See the matching
// expectations in test/generator/walker-state-mutations.test.ts,
// walker-action.test.ts, walker-button-state-attrs.test.ts.
//
// State syntax (TSX):
//   - read in any position  →  `name`        (caller adds JSX braces)
//   - `state := v`          →  `setName(v);`
//   - `state += v`          →  `setName(name + v);`
//   - `state -= v`          →  `setName(name - v);`
//
// Navigation: `navigate("/path", { state: { … } })` (React Router).
//
// Match: chained ternary — `(p1 ? v1 : (p2 ? v2 : fallback))`.
// ---------------------------------------------------------------------------

import type { TypeIR } from "../../../ir/loom-ir.js";
import type { RenderPosition, WalkerTarget } from "../../_walker/target.js";

/** TSX/React WalkerTarget implementation.  Stateless and module-scope —
 *  the walker threads this object through its `WalkContext` and calls
 *  the methods at the seams it used to inline. */
export const tsxTarget: WalkerTarget = {
  framework: "react",

  stateRead(name: string, _position: RenderPosition): string {
    // React state lives in the function's closure regardless of where
    // we're emitting (JSX child vs. inside a handler).  The walker
    // wraps in `{name}` for JSX child positions; bare `name` here.
    return name;
  },

  stateWrite(name: string, value: string): string {
    const setter = "set" + name[0]!.toUpperCase() + name.slice(1);
    return `${setter}(${value});`;
  },

  stateCompoundWrite(name: string, op: "+" | "-", value: string): string {
    const setter = "set" + name[0]!.toUpperCase() + name.slice(1);
    return `${setter}(${name} ${op} ${value});`;
  },

  renderNavigate(route: string, state: string | undefined): string {
    if (state !== undefined) {
      return `navigate(${JSON.stringify(route)}, { state: ${state} })`;
    }
    return `navigate(${JSON.stringify(route)})`;
  },

  renderMatch(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
    _position: RenderPosition,
  ): string {
    // Chained ternary, right-folded: `p1 ? v1 : (p2 ? v2 : fallback)`.
    // No JSX-brace wrapping — caller is responsible for embedding.
    const fallback = elseArm ?? "null";
    return arms.reduceRight<string>(
      (acc, arm) => `(${arm.predicate} ? ${arm.value} : ${acc})`,
      fallback,
    );
  },

  defaultInitFor(t: TypeIR): string {
    // Mirrors typeDefaultInitFor in walker/page-shell.ts.  Kept here as
    // the WalkerTarget-facing version; the page-shell still has its
    // own copy to avoid a circular dep risk.
    switch (t.kind) {
      case "optional":
        return "null";
      case "primitive":
        switch (t.name) {
          case "int":
          case "long":
          case "decimal":
            return "0";
          case "money":
            return `new Decimal(0)`;
          case "bool":
            return "false";
          case "string":
          case "guid":
            return `""`;
          case "datetime":
            return "new Date()";
          default:
            return "null";
        }
      case "id":
        return `""`;
      case "array":
        return "[]";
      default:
        return "null";
    }
  },
};
