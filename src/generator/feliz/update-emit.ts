// MVU projection — Model / Msg / init / update from a page's `state {}` +
// named `action`s (fable-elmish-frontend.md §2/§3b).  This is a direct emit,
// NOT a synthesis: one `Model` field per state cell, one `Msg` case per
// action, one `update` arm per action body.  No gensym.

import type { ActionIR, StateFieldIR } from "../../ir/types/loom-ir.js";
import { upperFirst } from "../../util/naming.js";
import { type FsExprCtx, renderFsExpr } from "./fs-expr.js";
import { fsZeroValue, typeToFs } from "./type-fs.js";
import type { FelizRead } from "./wire.js";

/** Msg case name for an action (`inc` → `Inc`, `setCustomer` → `SetCustomer`). */
export function msgCase(action: string): string {
  return upperFirst(action);
}

/** The `Model` record type declaration — one field per state cell, plus one
 *  `Remote<'T>` field per api read (its loading/error/loaded envelope). */
export function renderModel(
  state: readonly StateFieldIR[],
  reads: readonly FelizRead[] = [],
): string {
  const fields = [
    ...state.map((f) => `    ${upperFirst(f.name)}: ${typeToFs(f.type)}`),
    ...reads.map((r) => `    ${r.field}: Remote<${r.resultType}>`),
  ];
  if (fields.length === 0) return "type Model = { Unit: unit }";
  return `type Model =\n  {\n${fields.join("\n")}\n  }`;
}

/** `let init () = { … }, <Cmd>` — reads start `Loading` and fire their fetch
 *  `Cmd` at init (batched when there is more than one). */
export function renderInit(
  state: readonly StateFieldIR[],
  reads: readonly FelizRead[] = [],
): string {
  const inits = [
    ...state.map((f) => {
      const ctx: FsExprCtx = { stateNames: new Set(), locals: new Set() };
      const v = f.init ? renderFsExpr(f.init, ctx) : fsZeroValue(f.type);
      return `      ${upperFirst(f.name)} = ${v}`;
    }),
    ...reads.map((r) => `      ${r.field} = Loading`),
  ];
  const cmds = reads.map((r) => `Cmd.OfAsync.perform Api.${r.apiFn} () ${r.msgCase}`);
  const cmd =
    cmds.length === 0
      ? "Cmd.none"
      : cmds.length === 1
        ? cmds[0]!
        : `Cmd.batch [\n${cmds.map((c) => `    ${c}`).join("\n")}\n  ]`;
  if (inits.length === 0) return `let init () = { Unit = () }, ${cmd}`;
  return `let init () =\n  {\n${inits.join("\n")}\n  }, ${cmd}`;
}

/** The `Msg` union — one case per action, plus one `Loaded` case per read
 *  carrying the decoded `Result<'T, string>`. */
export function renderMsg(actions: readonly ActionIR[], reads: readonly FelizRead[] = []): string {
  const cases = [
    ...actions.map((a) => {
      const p = a.params[0];
      return p ? `  | ${msgCase(a.name)} of ${typeToFs(p.type)}` : `  | ${msgCase(a.name)}`;
    }),
    ...reads.map((r) => `  | ${r.msgCase} of Result<${r.resultType}, string>`),
  ];
  if (cases.length === 0) return "type Msg = | NoOp";
  return `type Msg =\n${cases.join("\n")}`;
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

/** The `update` function — one arm per action, plus two arms per read (the
 *  decoded `Ok` stores `Loaded`, the `Error` stores `LoadError`). */
export function renderUpdate(
  actions: readonly ActionIR[],
  state: readonly StateFieldIR[],
  reads: readonly FelizRead[] = [],
): string {
  const stateNames = new Set(state.map((s) => s.name));
  const actionArms = actions.map((a) => {
    const p = a.params[0];
    const ctx: FsExprCtx = {
      stateNames,
      locals: new Set(p ? [p.name] : []),
    };
    const head = p ? `  | ${msgCase(a.name)} ${p.name} ->` : `  | ${msgCase(a.name)} ->`;
    const body = a.body.map((s) => renderUpdateStmt(s, ctx)).filter(Boolean);
    return `${head}\n${body.join("\n")}\n      model, Cmd.none`;
  });
  const readArms = reads.map(
    (r) =>
      `  | ${r.msgCase} (Ok data) -> { model with ${r.field} = Loaded data }, Cmd.none\n` +
      `  | ${r.msgCase} (Error e) -> { model with ${r.field} = LoadError e }, Cmd.none`,
  );
  const arms = [...actionArms, ...readArms];
  if (arms.length === 0) {
    return "let update (msg: Msg) (model: Model) =\n  match msg with\n  | NoOp -> model, Cmd.none";
  }
  return `let update (msg: Msg) (model: Model) =\n  match msg with\n${arms.join("\n")}`;
}
