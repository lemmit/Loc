// MVU projection — Model / Msg / init / update from a page's `state {}` +
// named `action`s (fable-elmish-frontend.md §2/§3b).  This is a direct emit,
// NOT a synthesis: one `Model` field per state cell, one `Msg` case per
// action, one `update` arm per action body.  No gensym.

import type { ActionIR, StateFieldIR } from "../../ir/types/loom-ir.js";
import { upperFirst } from "../../util/naming.js";
import { type FsExprCtx, renderFsExpr } from "./fs-expr.js";
import { fsZeroValue, typeToFs } from "./type-fs.js";

/** Msg case name for an action (`inc` → `Inc`, `setCustomer` → `SetCustomer`). */
export function msgCase(action: string): string {
  return upperFirst(action);
}

/** The `Model` record type declaration. */
export function renderModel(state: readonly StateFieldIR[]): string {
  if (state.length === 0) return "type Model = { Unit: unit }";
  const fields = state.map((f) => `    ${upperFirst(f.name)}: ${typeToFs(f.type)}`).join("\n");
  return `type Model =\n  {\n${fields}\n  }`;
}

/** `let init () = { … }, Cmd.none`. */
export function renderInit(state: readonly StateFieldIR[]): string {
  if (state.length === 0) return "let init () = { Unit = () }, Cmd.none";
  const inits = state
    .map((f) => {
      const ctx: FsExprCtx = { stateNames: new Set(), locals: new Set() };
      const v = f.init ? renderFsExpr(f.init, ctx) : fsZeroValue(f.type);
      return `      ${upperFirst(f.name)} = ${v}`;
    })
    .join("\n");
  return `let init () =\n  {\n${inits}\n  }, Cmd.none`;
}

/** The `Msg` discriminated union — one case per action (payload param typed). */
export function renderMsg(actions: readonly ActionIR[]): string {
  if (actions.length === 0) return "type Msg = | NoOp";
  const cases = actions
    .map((a) => {
      const p = a.params[0];
      return p ? `  | ${msgCase(a.name)} of ${typeToFs(p.type)}` : `  | ${msgCase(a.name)}`;
    })
    .join("\n");
  return `type Msg =\n${cases}`;
}

/** Render one action body statement into the `update` arm: a state write
 *  (`:=` / `+=` / `-=`) becomes a `let model = { model with F = … }` rebind. */
function renderUpdateStmt(stmt: ActionIR["body"][number], ctx: FsExprCtx): string | undefined {
  switch (stmt.kind) {
    case "assign": {
      const field = upperFirst(stmt.target.segments[0]!);
      return `      let model = { model with ${field} = ${renderFsExpr(stmt.value, ctx)} }`;
    }
    case "add":
    case "remove": {
      const field = upperFirst(stmt.target.segments[0]!);
      const op = stmt.kind === "add" ? "+" : "-";
      const v = renderFsExpr(stmt.value, ctx);
      // Scalar compound (`+=`/`-=` on a counter); collection add/remove is a
      // follow-up (needs list append/filter).
      return `      let model = { model with ${field} = (model.${field} ${op} ${v}) }`;
    }
    case "let":
      return `      let ${stmt.name} = ${renderFsExpr(stmt.expr, ctx)}`;
    default:
      return `      // TODO feliz update: ${stmt.kind}`;
  }
}

/** The `update` function — one arm per action. */
export function renderUpdate(actions: readonly ActionIR[], state: readonly StateFieldIR[]): string {
  const stateNames = new Set(state.map((s) => s.name));
  if (actions.length === 0) {
    return "let update (msg: Msg) (model: Model) =\n  match msg with\n  | NoOp -> model, Cmd.none";
  }
  const arms = actions
    .map((a) => {
      const p = a.params[0];
      const ctx: FsExprCtx = {
        stateNames,
        locals: new Set(p ? [p.name] : []),
      };
      const head = p ? `  | ${msgCase(a.name)} ${p.name} ->` : `  | ${msgCase(a.name)} ->`;
      const body = a.body.map((s) => renderUpdateStmt(s, ctx)).filter(Boolean);
      return `${head}\n${body.join("\n")}\n      model, Cmd.none`;
    })
    .join("\n");
  return `let update (msg: Msg) (model: Model) =\n  match msg with\n${arms}`;
}
