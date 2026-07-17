// Frontend form-default-seed renderer.
//
// A `field: T = <expr>` (aggregate) — and, later, a `param: T = <expr>`
// (operation / workflow) — carries a lowered default `ExprIR`.  The scaffolded
// create/operation form seeds `useForm({ defaultValues })` so the input starts
// pre-filled at that default instead of the type-zero placeholder.
//
// This is a deliberately small, CLOSED renderer over the subset of default
// expressions a JS-family frontend can evaluate with no server round-trip and
// no page context: compile-time constants and enum members.  It is the seed
// analogue of `gate-expr.ts` (the currentUser-only UI-gate renderer) and, like
// `tryRenderGate`, it is BEST-EFFORT: anything outside the closed subset
// (`now()`, `currentUser.*`, `this.*`, a sequence, a cross-aggregate lookup)
// returns `null` so the caller falls back to the type-zero seed.  A default the
// client can't evaluate is not an error here — it is the boundary where a later
// slice routes to an ambient client expression or a server prepare endpoint.
//
// The output is plain JS literal syntax, identical across the JS-family
// frontends (React / Vue / Svelte / Angular), so every framework host reuses
// this one renderer — same rationale as `gate-expr.ts`.

import type { ExprIR } from "../../ir/types/loom-ir.js";

/**
 * Render a default-value `ExprIR` to a JS literal expression, or `null` when
 * the expression falls outside the client-evaluable constant subset (the
 * caller then keeps its type-zero seed).
 */
export function renderDefaultSeed(e: ExprIR): string | null {
  switch (e.kind) {
    case "literal":
      return renderLiteral(e.lit, e.value);
    case "ref":
      // An enum member used as a default (`status: Status = Draft`) lowers to an
      // enum-value ref; its wire form is the bare member-name string.
      if (e.refKind === "enum-value") return JSON.stringify(e.name);
      return null;
    case "paren": {
      const inner = renderDefaultSeed(e.inner);
      return inner === null ? null : `(${inner})`;
    }
    case "unary": {
      // Negative / logical-not constants — `-1`, `!true`.
      const operand = renderDefaultSeed(e.operand);
      return operand === null ? null : `${e.op}${operand}`;
    }
    default:
      return null;
  }
}

function renderLiteral(lit: string, value: string): string | null {
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
      // money / now / anything else needs a runtime carrier (Decimal, a clock)
      // or is ambient — deferred to the ambient-default slice.
      return null;
  }
}
