// The Feliz WalkerTarget — F#/Feliz seam implementations consumed by the
// shared `walkBody` (fable-elmish-frontend.md).  The view is expression-valued
// F# code (`Html.div [ … ]`), so it rides the shared engine exactly like the
// JSX-family targets; only the seams below differ.
//
// State reads resolve to the MVU `model.<Field>`; effect handlers dispatch a
// `Msg` (the effect body lives in `update`, not the view).  Expression syntax
// leaves forward to the shared F# leaf table (`FS_LEAVES`).

import { upperFirst } from "../../util/naming.js";
import type { RenderPosition, StateRef, WalkerTarget } from "../_walker/target.js";
import { FS_LEAVES, fsString } from "./fs-expr.js";
import { fsZeroValue } from "./type-fs.js";

/** Msg case name for an action (`inc` → `Inc`). */
function msgCase(action: string): string {
  return upperFirst(action);
}

const unreached = (what: string) => (): never => {
  throw new Error(`feliz: ${what} not yet supported by the Feliz walker`);
};

export const felizTarget: WalkerTarget = {
  framework: "feliz",

  // --- State seam — MVU model reads --------------------------------------
  renderStateRead: (ref: StateRef, _pos: RenderPosition) => `model.${upperFirst(ref.name)}`,
  // The view never writes state directly (effects live in `update`); the
  // shell's emitStmt over action bodies still reaches this, but the Feliz
  // named-handler ignores the emitted body (it dispatches a Msg instead), so a
  // harmless placeholder is correct.
  renderStateWrite: () => "()",
  renderNestedStateWrite: () => "()",

  // --- API seam — not yet wired (Counter/minimal has no remote reads) -----
  buildHookUse: unreached("api hooks") as WalkerTarget["buildHookUse"],
  renderApiCall: unreached("api calls") as WalkerTarget["renderApiCall"],
  renderApiHoisting: () => [],

  // --- Control-flow seams — implemented as examples exercise them ---------
  renderMatch: unreached("match (value)") as WalkerTarget["renderMatch"],
  renderMatchChild: unreached("match (child)") as WalkerTarget["renderMatchChild"],
  renderForEach: unreached("For") as WalkerTarget["renderForEach"],
  renderNavigate: unreached("navigate") as WalkerTarget["renderNavigate"],
  renderConditionalChild: unreached("conditional child") as WalkerTarget["renderConditionalChild"],

  defaultInitFor: (type) => fsZeroValue(type),

  // --- Markup seams — F# flavoured ---------------------------------------
  renderComment: (text: string) => `(* ${text} *)`,
  // Child-position interpolation: any JS expression becomes a text node.
  renderInterpolation: (js: string) => `Html.text (string (${js}))`,
  renderAttrBinding: (name: string, js: string) => `prop.custom("${name}", ${js})`,
  renderStyleAttr: () => "",
  // Raw text for markup TEXT position — F# string-body escaping (the pack
  // wraps it in `Html.text "…"` or `prop.text "…"`).
  escapeText: (text: string) => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"'),

  // --- Handler seams — MVU dispatch --------------------------------------
  // A button's `onClick: inc` reaches this with statements `["inc();"]`; the
  // hoisted wrapper (`renderNamedHandler`) turns `inc` into `dispatch Inc`.
  renderEventHandler: (stmts, expr) =>
    `fun _ -> ${expr ?? (stmts ?? []).map((s) => s.replace(/;\s*$/, "")).join("; ")}`,
  // Declare a named action as a dispatch wrapper at the view top: the effect
  // body itself is projected into `update`, so the view handler only
  // dispatches the Msg.  Ignores `bodyStmts` (they belong to `update`).
  renderNamedHandler: (name, param) =>
    param
      ? `    let ${name} ${param} = dispatch (${msgCase(name)} ${param})`
      : `    let ${name} () = dispatch ${msgCase(name)}`,

  // --- Expression-syntax leaves (F#) — forwarded to the shared table ------
  exprLiteral: (lit, value) => FS_LEAVES.literal(lit, value),
  exprBinary: (left, right, op) => FS_LEAVES.binary(left, right, op as never),
  exprUnary: (op, operand) => FS_LEAVES.unary(op as "-" | "!", operand),
  exprTernary: (cond, then, otherwise) => FS_LEAVES.ternary(cond, then, otherwise),
  exprConvert: (value, target, from) => FS_LEAVES.convert(value, target as never, from as never),
  exprList: (elements) => FS_LEAVES.list(elements),
  exprObject: (fields) => FS_LEAVES.object([...fields]),
};

export { fsString };
