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

/** Context for {@link renderDefaultSeed}. */
export interface DefaultSeedCtx {
  /** Name of an in-scope variable holding the target record, which enables a
   *  `this.<field>` default (an operation param such as
   *  `reschedule(to: datetime = this.eta)`) to seed as `<recordVar>.<field>`.
   *  Passed ONLY where the seed site provably has the loaded record in scope —
   *  a per-target decision (a JSX-family op-form pushes `defaultValues` into a
   *  record-less module component, so it opts out).  Omitted → `this.*`
   *  defaults fall back to the type-zero seed. */
  recordVar?: string;
}

/**
 * Render a default-value `ExprIR` to a JS literal/reference expression, or
 * `null` when the expression falls outside the client-evaluable subset (the
 * caller then keeps its type-zero seed).
 *
 * The subset is constants + enum members, plus — when `ctx.recordVar` is set —
 * `this.<field>` member reads against the loaded record.
 */
export function renderDefaultSeed(e: ExprIR, ctx: DefaultSeedCtx = {}): string | null {
  switch (e.kind) {
    case "literal":
      return renderLiteral(e.lit, e.value);
    case "ref":
      // An enum member used as a default (`status: Status = Draft`) lowers to an
      // enum-value ref; its wire form is the bare member-name string.
      if (e.refKind === "enum-value") return JSON.stringify(e.name);
      return null;
    case "this":
      // A bare `this` only means something with a record var in scope; a
      // `this.<field>` read then renders as `<recordVar>.<field>` (below).
      return ctx.recordVar ?? null;
    case "member": {
      // `this.<field>` (or a nested read off it) → `<recordVar>.<field>`.  Any
      // other receiver (a `currentUser.*` claim, etc.) fails to render and
      // falls back — this seed is loaded-record-only, not ambient.
      const recv = renderDefaultSeed(e.receiver, ctx);
      return recv === null ? null : `${recv}.${e.member}`;
    }
    case "paren": {
      const inner = renderDefaultSeed(e.inner, ctx);
      return inner === null ? null : `(${inner})`;
    }
    case "unary": {
      // Negative / logical-not constants — `-1`, `!true`.
      const operand = renderDefaultSeed(e.operand, ctx);
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
