// Frontend authorization-gate expression renderer (D-AUTH-OIDC, UI gate).
//
// A `page { requires <expr> }` (and, later, an operation UI gate) carries a
// currentUser-only boolean `ExprIR` — the same gate the backend evaluates to a
// 403.  The generated frontend evaluates it client-side against the verified
// session claims (`useSession().user`) so a forbidden page renders a `<Forbidden/>`
// fallback instead of its body, the read-side mirror of the backend gate.
//
// This is a deliberately small, closed renderer — NOT the full backend
// `render-expr`.  The gate validator (the page/operation `requires` rules)
// restricts gates to `currentUser` + constants +
// boolean/comparison operators, so only that subset is rendered here; anything
// outside it throws (a gate the UI can't evaluate is a generation-time error, not
// silent degradation).  The output is plain JS boolean syntax, identical across
// the JS-family frontends (React / Vue / Svelte / Angular), so each framework
// host reuses this one renderer.

import type { BinOp, ExprIR } from "../../ir/types/loom-ir.js";

/** Binary operators that differ between Loom source and JS output; the rest
 *  pass through verbatim. */
const JS_BIN_OP: Partial<Record<BinOp, string>> = {
  "==": "===",
  "!=": "!==",
};

/**
 * Render a currentUser-only gate `ExprIR` to a JS boolean expression, with
 * `userVar` as the rendered name of the session-user local (e.g. `currentUser`).
 * Throws on any node outside the gate subset.
 */
export function renderGateExpr(e: ExprIR, userVar: string): string {
  switch (e.kind) {
    case "ref":
      if (e.refKind === "current-user") return userVar;
      // An enum-typed claim compares against the enum member's wire value —
      // the bare member name string (`role == Admin` → `role === "Admin"`).
      if (e.refKind === "enum-value") return JSON.stringify(e.name);
      throw new Error(
        `UI gate: reference '${e.name}' (${e.refKind}) is not evaluable client-side — a gate may only touch currentUser and constants.`,
      );
    case "literal":
      return renderLiteral(e.lit, e.value);
    case "member":
      // Claim access — `currentUser.role`, `currentUser.org.tier`.  The
      // session-user local is bound loosely (dynamic JWT claims), so chained
      // access stays type-clean.
      return `${renderGateExpr(e.receiver, userVar)}.${e.member}`;
    case "method-call":
      // The only method the gate grammar admits is collection membership
      // (`currentUser.permissions.contains(x)` → `.includes(x)`).
      if (e.isCollectionOp && e.member === "contains") {
        return `${renderGateExpr(e.receiver, userVar)}.includes(${e.args
          .map((a) => renderGateExpr(a, userVar))
          .join(", ")})`;
      }
      throw new Error(`UI gate: method '.${e.member}' is not supported in a UI gate.`);
    case "binary":
      return `${renderGateExpr(e.left, userVar)} ${JS_BIN_OP[e.op] ?? e.op} ${renderGateExpr(
        e.right,
        userVar,
      )}`;
    case "unary":
      return `${e.op}${renderGateExpr(e.operand, userVar)}`;
    case "paren":
      return `(${renderGateExpr(e.inner, userVar)})`;
    case "ternary":
      return `${renderGateExpr(e.cond, userVar)} ? ${renderGateExpr(
        e.then,
        userVar,
      )} : ${renderGateExpr(e.otherwise, userVar)}`;
    default:
      throw new Error(`UI gate: expression kind '${e.kind}' is not supported in a UI gate.`);
  }
}

/**
 * Best-effort variant of `renderGateExpr`: returns the rendered gate
 * string, or `null` when the expression touches anything outside the
 * currentUser-only subset (i.e. `renderGateExpr` throws).  Action-button
 * gating uses this to decide whether an operation's `requires` predicate is
 * client-evaluable — a gate referencing `this.<field>` / params is left
 * ungated (the backend 403 still enforces it).
 */
export function tryRenderGate(e: ExprIR, userVar: string): string | null {
  try {
    return renderGateExpr(e, userVar);
  } catch {
    return null;
  }
}

function renderLiteral(lit: string, value: string): string {
  switch (lit) {
    case "string":
      return JSON.stringify(value);
    case "bool":
    case "int":
    case "long":
    case "decimal":
      return value;
    case "null":
      return "null";
    default:
      // money / now / anything else has no meaningful client-side gate form.
      throw new Error(`UI gate: ${lit} literal is not supported in a UI gate.`);
  }
}
