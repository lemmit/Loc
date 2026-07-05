// ---------------------------------------------------------------------------
// Macro-origin token contract.
//
// This lives at the language/AST layer — not under `src/macros/` — because
// both sides that need it already import from `language/`: the macro
// expander (phase ②, `src/macros/expander.ts`) stamps `OriginToken`s onto
// synthesized AST nodes via `ORIGIN_PROP`, and IR lowering (phase ⑤,
// `src/ir/lower/origin.ts`) reads them back before lowering discards
// `$cstNode` for good. Keeping the token contract here means capturing
// macro provenance at lowering never requires an `ir/` → `macros/` import.
// ---------------------------------------------------------------------------

import type { MacroCall } from "./generated/ast.js";

/** Hidden property on every macro-emitted AST node — the expander sets it
 * when splicing, and the validator/diagnostics layer and IR lowering read
 * it to redirect errors / provenance back at the `with X(...)` call site.
 * Not part of the public Langium AST contract. */
export const ORIGIN_PROP = "$origin" as const;

/** Opaque origin tag attached to every synthesised AST node by the macro
 * factories.  Carries a reference back to the `with X(...)` call site's CST
 * node so diagnostic renderers (and origin capture at lowering) can resolve
 * synthesised members against the user's source position.  Construction is
 * internal to the expander; macro authors never touch the inside. */
export interface OriginToken {
  readonly _kind: "macro-origin";
  readonly macroName: string;
  /** The MacroCall AST node whose expansion produced any nodes tagged with
   * this token.  May lack CST info if it was itself macro-emitted (future:
   * nested macro calls). */
  readonly callNode: MacroCall;
}

/** Read the origin token off a node, if any.  Walks the `$container` chain
 * so a property buried inside a synthesised operation body still reports
 * its origin. */
export function originOf(node: unknown): OriginToken | undefined {
  let cur: unknown = node;
  while (cur && typeof cur === "object") {
    const v = (cur as Record<string, unknown>)[ORIGIN_PROP];
    if (v !== undefined) return v as OriginToken;
    cur = (cur as Record<string, unknown>).$container;
  }
  return undefined;
}
