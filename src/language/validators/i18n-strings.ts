// `loom.user-visible-concat` (M-T1.11, i18n-strings.md Phase 1).
//
// String concatenation in a user-visible page slot produces output that can't
// be translated: `"Order " + order.id` pins the variable to the right of a
// fixed English prefix, but languages differ in word order, plural agreement,
// gender, and number/date formatting — none of which `+` can express. The whole
// message must be authored as one unit so a translator owns its structure.
//
// This validator (phase ④) walks every page primitive and flags a `+`
// concatenation sitting in one of its user-visible text slots
// (src/util/user-visible-slots.ts). A backtick template (`` `Order {order.id}` ``)
// is a distinct AST node (`TemplateStr`), never a `BinaryChain`, so it is
// always accepted — it IS the rewrite the diagnostic points to.
//
// SEVERITY — ERROR. The template→ICU runtime has landed (an interpolated
// user-visible slot now extracts to an ICU catalog entry and renders through the
// React `t()` shim), so interpolation is the first-class, translatable form and
// concat in a user-visible slot is a hard mistake — it pins the variable to one
// side of a fixed English string, which no translation can reorder.
//
// Only STRING concatenation is flagged: a `+` whose operands include a string
// literal. A purely numeric `+` in a value slot (`Stat { "Total", count + 1 }`)
// is arithmetic, not text composition, and is left alone.

import { AstUtils, type ValidationAcceptor } from "langium";
import { diagMessage } from "../../diagnostics/messages.js";
import { USER_VISIBLE_SLOTS, type UserVisibleSlot } from "../../util/user-visible-slots.js";
import type { BuilderCall, Expression } from "../generated/ast.js";
import { isBinaryChain, isParenExpr, isStringLit } from "../generated/ast.js";

/** Unwrap redundant parentheses to reach the operative expression. */
function unwrap(e: Expression): Expression {
  return isParenExpr(e) ? unwrap(e.inner) : e;
}

/** A string `+` concatenation: a `+`-chain with at least one string-literal
 *  operand.  Returns the offending chain (for the diagnostic node) or undefined.
 *  A purely numeric chain (no string operand) is arithmetic, not text. */
function stringConcat(e: Expression): Expression | undefined {
  const inner = unwrap(e);
  if (!isBinaryChain(inner) || !inner.ops.includes("+")) return undefined;
  const operands = [inner.head, ...inner.rest];
  return operands.some((o) => isStringLit(unwrap(o))) ? inner : undefined;
}

/** The AST entry filling one of a primitive's user-visible slots, or undefined
 *  when the call doesn't supply it.  Positional slots count only the unnamed
 *  entries; a named slot matches by `name`. */
function slotEntry(
  bc: BuilderCall,
  slot: UserVisibleSlot,
): BuilderCall["entries"][number] | undefined {
  if (slot.kind === "named") return bc.entries.find((e) => e.name === slot.name);
  let positional = -1;
  for (const entry of bc.entries) {
    if (typeof entry.name === "string") continue;
    positional += 1;
    if (positional === slot.index) return entry;
  }
  return undefined;
}

export function checkUserVisibleConcat(
  model: import("../generated/ast.js").Model,
  accept: ValidationAcceptor,
): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "BuilderCall") continue;
    const bc = node as BuilderCall;
    const slots = USER_VISIBLE_SLOTS[bc.type];
    if (!slots) continue;
    for (const slot of slots) {
      const entry = slotEntry(bc, slot);
      if (!entry) continue;
      const chain = stringConcat(entry.value);
      if (!chain) continue;
      accept("error", diagMessage("loom.user-visible-concat", { type: bc.type }), {
        node: chain,
        code: "loom.user-visible-concat",
      });
    }
  }
}
