// MVU projection — Model / Msg / init / update from a page's `state {}` +
// named `action`s (fable-elmish-frontend.md §2/§3b).  This is a direct emit,
// NOT a synthesis: one `Model` field per state cell, one `Msg` case per
// action, one `update` arm per action body.  No gensym.

import type { ActionIR, StateFieldIR } from "../../ir/types/loom-ir.js";
import { upperFirst } from "../../util/naming.js";
import { type FsExprCtx, renderFsExpr } from "./fs-expr.js";
import { fsZeroValue, typeToFs } from "./type-fs.js";
import type { FelizMutation, FelizRead } from "./wire.js";

/** Msg case name for an action (`inc` → `Inc`, `setCustomer` → `SetCustomer`). */
export function msgCase(action: string): string {
  return upperFirst(action);
}

/** The `Model` record type declaration — one field per state cell, plus one
 *  `Remote<'T>` field per api read (its loading/error/loaded envelope).  When
 *  `routed`, a `CurrentPage: Page` field leads (multi-page routing). */
export function renderModel(
  state: readonly StateFieldIR[],
  reads: readonly FelizRead[] = [],
  routed = false,
): string {
  const fields = [
    ...(routed ? ["    CurrentPage: Page"] : []),
    ...state.map((f) => `    ${upperFirst(f.name)}: ${typeToFs(f.type)}`),
    ...reads.map((r) => `    ${r.field}: Remote<${r.resultType}>`),
  ];
  if (fields.length === 0) return "type Model = { Unit: unit }";
  return `type Model =\n  {\n${fields.join("\n")}\n  }`;
}

/** The page-entry `Cmd` dispatcher — one arm per byId read, firing its fetch
 *  keyed off the route `id` bound by the hosting `Page` case.  Emitted only
 *  when byId reads exist (they fetch on page entry, not at init); returns "".
 *
 *      let pageCmd (page: Page) : Cmd<Msg> =
 *        match page with
 *        | ProductDetail id -> Cmd.OfAsync.perform Api.productById id ProductByIdLoaded
 *        | _ -> Cmd.none
 */
export function renderPageCmd(reads: readonly FelizRead[] = []): string {
  const byId = reads.filter((r) => r.single);
  if (byId.length === 0) return "";
  const arms = byId.map(
    (r) => `  | ${r.pageCase} id -> Cmd.OfAsync.perform Api.${r.apiFn} id ${r.msgCase}`,
  );
  return `let pageCmd (page: Page) : Cmd<Msg> =\n  match page with\n${arms.join("\n")}\n  | _ -> Cmd.none`;
}

/** `let init () = { … }, <Cmd>` — every read field starts `Loading`.  List reads
 *  fire their fetch `Cmd` at init; byId reads instead fire via `pageCmd` (so a
 *  detail page loads on entry, not eagerly).  When `routed`, the initial
 *  `CurrentPage` is parsed from the current URL — bound to a `let page` when
 *  there is a `pageCmd` to feed it. */
export function renderInit(
  state: readonly StateFieldIR[],
  reads: readonly FelizRead[] = [],
  routed = false,
): string {
  const hasPageCmd = routed && reads.some((r) => r.single);
  const inits = [
    ...(routed
      ? [
          hasPageCmd
            ? "      CurrentPage = page"
            : "      CurrentPage = parseUrl (Router.currentUrl ())",
        ]
      : []),
    ...state.map((f) => {
      const ctx: FsExprCtx = { stateNames: new Set(), locals: new Set() };
      const v = f.init ? renderFsExpr(f.init, ctx) : fsZeroValue(f.type);
      return `      ${upperFirst(f.name)} = ${v}`;
    }),
    ...reads.map((r) => `      ${r.field} = Loading`),
  ];
  // List reads fire eagerly; byId reads fire on page entry via `pageCmd page`.
  const cmds = reads
    .filter((r) => !r.single)
    .map((r) => `Cmd.OfAsync.perform Api.${r.apiFn} () ${r.msgCase}`);
  if (hasPageCmd) cmds.push("pageCmd page");
  const cmd =
    cmds.length === 0
      ? "Cmd.none"
      : cmds.length === 1
        ? cmds[0]!
        : `Cmd.batch [\n${cmds.map((c) => `    ${c}`).join("\n")}\n  ]`;
  const prefix = hasPageCmd
    ? "let init () =\n  let page = parseUrl (Router.currentUrl ())\n"
    : "let init () =\n";
  if (inits.length === 0) return `let init () = { Unit = () }, ${cmd}`;
  return `${prefix}  {\n${inits.join("\n")}\n  }, ${cmd}`;
}

/** The `Msg` union — one case per action, one `Loaded` case per read (carrying
 *  the decoded `Result<'T, string>`), and two cases per mutation (a `Delete<Agg>`
 *  trigger carrying the target id + a `<Agg>Deleted` result).  When `routed`, a
 *  `UrlChanged` case carries the new URL segments. */
export function renderMsg(
  actions: readonly ActionIR[],
  reads: readonly FelizRead[] = [],
  routed = false,
  mutations: readonly FelizMutation[] = [],
): string {
  const cases = [
    ...(routed ? ["  | UrlChanged of string list"] : []),
    ...actions.map((a) => {
      const p = a.params[0];
      return p ? `  | ${msgCase(a.name)} of ${typeToFs(p.type)}` : `  | ${msgCase(a.name)}`;
    }),
    ...reads.map((r) => `  | ${r.msgCase} of Result<${r.resultType}, string>`),
    ...mutations.flatMap((m) => [
      `  | ${m.dispatchCase} of string`,
      `  | ${m.resultCase} of Result<unit, string>`,
    ]),
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
 *  decoded `Ok` stores `Loaded`, the `Error` stores `LoadError`).  When
 *  `routed`, a `UrlChanged` arm re-parses the URL into `CurrentPage`. */
export function renderUpdate(
  actions: readonly ActionIR[],
  state: readonly StateFieldIR[],
  reads: readonly FelizRead[] = [],
  routed = false,
  mutations: readonly FelizMutation[] = [],
): string {
  const stateNames = new Set(state.map((s) => s.name));
  const byIdReads = reads.filter((r) => r.single);
  const hasPageCmd = routed && byIdReads.length > 0;
  // On navigation, re-parse the URL.  With byId reads, entering a detail page
  // must refetch: reset every byId field to `Loading` and fire `pageCmd` (which
  // issues the fetch for the newly-active detail page, or `Cmd.none`).
  const routeArms = routed
    ? hasPageCmd
      ? [
          "  | UrlChanged segments ->\n" +
            "      let page = parseUrl segments\n" +
            `      { model with CurrentPage = page; ${byIdReads
              .map((r) => `${r.field} = Loading`)
              .join("; ")} }, pageCmd page`,
        ]
      : ["  | UrlChanged segments -> { model with CurrentPage = parseUrl segments }, Cmd.none"]
    : [];
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
  // A delete: the trigger fires the `Cmd`; on success navigate to the list
  // route (the record is gone), on error stay put.
  const mutationArms = mutations.map((m) => {
    const nav = `Cmd.navigate(${m.navigateSegs.map((s) => `"${s}"`).join(", ")})`;
    return (
      `  | ${m.dispatchCase} id -> model, Cmd.OfAsync.perform Api.${m.apiFn} id ${m.resultCase}\n` +
      `  | ${m.resultCase} (Ok ()) -> model, ${nav}\n` +
      `  | ${m.resultCase} (Error _) -> model, Cmd.none`
    );
  });
  const arms = [...routeArms, ...actionArms, ...readArms, ...mutationArms];
  if (arms.length === 0) {
    return "let update (msg: Msg) (model: Model) =\n  match msg with\n  | NoOp -> model, Cmd.none";
  }
  return `let update (msg: Msg) (model: Model) =\n  match msg with\n${arms.join("\n")}`;
}
