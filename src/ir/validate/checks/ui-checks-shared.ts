// -------------------------------------------------------------------------
// Shared helpers used across more than one `ui-checks` theme leaf: the
// view-effect builtin allowlist, the walker-rendered-expression collector,
// and the named-arg accessor.  Split out of ui-checks.ts by packet 2.6
// (wave-2) — mechanical move, no logic change.
// -------------------------------------------------------------------------

import type { ComponentIR, DerivedIR, ExprIR, PageIR, StateFieldIR } from "../../types/loom-ir.js";

// View-effect builtins (`navigate(…)`, `toast(…)`) lower to bare
// `private-operation`-shaped calls but resolve against the page's imports at
// emit time (`src/generator/_walker/primitives/controls.ts`,
// `elixir/heex-walker-core.ts`), so an action body calling one is legitimate —
// the unresolved-action-ref check must NOT flag them.

export const VIEW_EFFECT_BUILTINS = new Set<string>(["navigate", "toast"]);

/** Every expression surface of a page / component that the frontend WALKER
 *  renders.  `requires` is deliberately absent — it is a gate expression,
 *  rendered by the closed `_frontend/gate-expr.ts` (see the block above). */

export function walkerRenderedExprs(host: PageIR | ComponentIR): ExprIR[] {
  const out: ExprIR[] = [];
  const push = (e?: ExprIR) => {
    if (e) out.push(e);
  };
  push(host.body);
  if ("title" in host) push(host.title);
  for (const d of host.derived as DerivedIR[]) push(d.expr);
  for (const s of host.state as StateFieldIR[]) push(s.init);
  return out;
}

/** Value of a named arg on a primitive call (parallel `argNames`). */

export function namedArg(
  call: Extract<ExprIR, { kind: "call" }>,
  name: string,
): ExprIR | undefined {
  const names = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (names[i] === name) return call.args[i];
  }
  return undefined;
}
