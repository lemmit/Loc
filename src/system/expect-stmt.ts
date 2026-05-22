import type { ExprIR } from "../ir/loom-ir.js";
import { intrinsicMatcherSig } from "../language/type-system.js";

// Shared lowering for `expect <expr>` statements in the generated e2e (api)
// and UI specs.
//
// Assertions are written as **explicit, typed matchers** —
// `expect(read.sku).toBe("WIDGET-1")`, `expect(list.length).toBeGreaterThanOrEqual(1)` —
// which the IR resolves into `method-call.isIntrinsicMatcher`. The renderer
// unwraps the asserted expression (and an optional `.not.`) and emits the
// native matcher. A bare boolean expression falls back to
// `expect(<x>).toBe(true)` — no operator-from-shape inference any more.

/** Render one `expect <expr>` to an assertion statement (no trailing
 *  newline). `render` lowers a sub-expression to target source. */
export function renderExpectStmt(expr: ExprIR, render: (e: ExprIR) => string): string {
  const explicit = renderExplicitValueMatcher(expr, render);
  if (explicit) return explicit;
  return `expect(${render(expr)}).toBe(true);`;
}

/** When `expr` is an explicit intrinsic value-matcher (`expect(x).toBe(y)`,
 *  with optional `.not.`), render it directly. Returns null for anything
 *  else — including locator matchers, which are rendered by the backend's
 *  own helper since they need locator-specific receiver lowering. */
function renderExplicitValueMatcher(
  expr: ExprIR,
  render: (e: ExprIR) => string,
): string | null {
  if (expr.kind !== "method-call" || !expr.isIntrinsicMatcher) return null;
  const sig = intrinsicMatcherSig(expr.member);
  if (!sig || sig.on !== "value") return null;

  // The matcher's receiver is the asserted expression — usually wrapped in
  // parens as authored (`expect(<inner>).toBe(…)`), and optionally preceded
  // by `.not` for negation.
  let receiver = expr.receiver;
  let negate = false;
  if (
    receiver.kind === "member" &&
    receiver.member === "not" &&
    sig.negatable
  ) {
    negate = true;
    receiver = receiver.receiver;
  }
  const inner = receiver.kind === "paren" ? receiver.inner : receiver;
  const args = expr.args.map((a) => render(a)).join(", ");
  const prefix = negate ? "not." : "";
  return `expect(${render(inner)}).${prefix}${expr.member}(${args});`;
}
