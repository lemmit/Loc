import type { ExprIR } from "../ir/types/loom-ir.js";
import { intrinsicMatcherSig } from "../util/intrinsic-matchers.js";

// Shared lowering for `expect(...)` statements in the generated e2e (api)
// and UI specs.
//
// Assertions are written as **explicit, typed matchers** —
// `expect(read.sku).toBe("WIDGET-1")`, `expect(list.length).toBeGreaterThanOrEqual(1)` —
// which the IR resolves into `method-call.isIntrinsicMatcher`. The renderer
// unwraps the asserted expression (and an optional `.not.`) and emits the
// native matcher. There is no bare-boolean fallback: the validator
// (`checkExpectMatcher`) requires every `expect` to carry a matcher, so a
// non-matcher reaching here is a compiler invariant violation, not user input.

/** Render one `expect(<x>).<matcher>(…)` to an assertion statement (no
 *  trailing newline). `render` lowers a sub-expression to target source. */
export function renderExpectStmt(expr: ExprIR, render: (e: ExprIR) => string): string {
  const explicit = renderExplicitValueMatcher(expr, render);
  if (explicit) return explicit;
  // Locator matchers are peeled by the caller before this point; reaching here
  // means a bare-boolean `expect`, which the validator rejects.  Fail loudly
  // rather than silently emitting `.toBe(true)`.
  throw new Error(
    "expect requires a matcher (e.g. expect(x).toBe(y) / expect(call).toThrow()); " +
      "got a bare expression with no matcher.",
  );
}

/** When `expr` is an explicit intrinsic value-matcher (`expect(x).toBe(y)`,
 *  with optional `.not.`), render it directly. Returns null for anything
 *  else — including locator matchers, which are rendered by the backend's
 *  own helper since they need locator-specific receiver lowering. */
function renderExplicitValueMatcher(expr: ExprIR, render: (e: ExprIR) => string): string | null {
  if (expr.kind !== "method-call" || !expr.isIntrinsicMatcher) return null;
  const sig = intrinsicMatcherSig(expr.member);
  if (!sig || sig.on !== "value") return null;

  // The matcher's receiver is the asserted expression — usually wrapped in
  // parens as authored (`expect(<inner>).toBe(…)`), and optionally preceded
  // by `.not` for negation.
  let receiver = expr.receiver;
  let negate = false;
  if (receiver.kind === "member" && receiver.member === "not" && sig.negatable) {
    negate = true;
    receiver = receiver.receiver;
  }
  const inner = receiver.kind === "paren" ? receiver.inner : receiver;
  const prefix = negate ? "not." : "";

  // `toBeSameInstant` is temporal equality: compare the two timestamps as
  // instants (epoch ms) so wire-format differences (`…00.0000000Z` vs `…00Z`)
  // don't fail the assertion, but a real difference in time still does. Lowers
  // to a plain vitest `toBe` on `Date.getTime()` — no custom-matcher runtime.
  if (expr.member === "toBeSameInstant") {
    const actual = `new Date(${render(inner)}).getTime()`;
    const expected = `new Date(${render(expr.args[0]!)}).getTime()`;
    return `expect(${actual}).${prefix}toBe(${expected});`;
  }

  const args = expr.args.map((a) => render(a)).join(", ");
  return `expect(${render(inner)}).${prefix}${expr.member}(${args});`;
}
