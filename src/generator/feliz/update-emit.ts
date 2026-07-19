// MVU projection — Model / Msg / init / update from a page's `state {}` +
// named `action`s (fable-elmish-frontend.md §2/§3b).  This is a direct emit,
// NOT a synthesis: one `Model` field per state cell, one `Msg` case per
// action, one `update` arm per action body.  No gensym.

import type { ActionIR, StateFieldIR, StoreIR } from "../../ir/types/loom-ir.js";
import { typeIsFile } from "../../ir/util/file-field.js";
import { upperFirst } from "../../util/naming.js";
import { type FsExprCtx, renderFsExpr, storeModelField, storeMsgCase } from "./fs-expr.js";
import { fsZeroValue, typeToFs } from "./type-fs.js";
import type {
  FelizAction,
  FelizAsyncEffect,
  FelizBoundState,
  FelizFieldArray,
  FelizFileUpload,
  FelizForm,
  FelizMutation,
  FelizOperationForm,
  FelizRead,
  FelizWorkflowForm,
  FormRecord,
} from "./wire.js";
import {
  fileSelectMsg,
  fileUploadedMsg,
  formHasFieldErrors,
  formTouchedField,
  formTouchMsg,
  opHasForm,
} from "./wire.js";

/** The F# Model type for a `state {}` field.  A `File`-typed field holds the
 *  uploaded reference (`FileRef option`, `None` before/when cleared) — the
 *  standalone `FileUpload(bind:)` writes it via the upload result Msg — not the
 *  `string` that `typeToFs` would spell for the passive `File` leaf. */
function stateFieldFsType(f: StateFieldIR): string {
  return typeIsFile(f.type) ? "FileRef option" : typeToFs(f.type);
}

/** The F# init value for a `state {}` field with no `= <init>` — `None` for a
 *  `File` field (its `FileRef option` starts empty), else the type's zero. */
function stateFieldZero(f: StateFieldIR): string {
  return typeIsFile(f.type) ? "None" : fsZeroValue(f.type);
}

/** Msg case name for an action (`inc` → `Inc`, `setCustomer` → `SetCustomer`). */
export function msgCase(action: string): string {
  return upperFirst(action);
}

/** Coerce a numeric-literal `state` init to an F# `decimal` literal when the
 *  field is `money`/`decimal`.  A DSL `price: money = 0` renders the init as the
 *  bare int `0`, which F# then implicitly converts `int → decimal` — a
 *  conversion Fable rejects (`op_Implicit not supported`).  Suffixing `m`
 *  (`0` → `0m`, `9.99` → `9.99m`) makes it a decimal literal outright.  Only
 *  touches a plain numeric literal; any other init expression is left as-is. */
function decimalLit(rendered: string, type: StateFieldIR["type"]): string {
  if (typeToFs(type) !== "decimal") return rendered;
  return /^-?\d+(\.\d+)?$/.test(rendered) ? `${rendered}m` : rendered;
}

/** The `Set<Field>` Msg case a two-way-bound input contributes.  A `bool` state
 *  (a `Toggle` / controlled `Modal`) carries the bool directly; every other
 *  state (`Field`/`NumberField`/`SelectField`/…) carries the raw input `string`
 *  and the update arm converts it to the field's type. */
function boundSetMsg(b: FelizBoundState): string {
  const payload = typeToFs(b.type) === "bool" ? "bool" : "string";
  return `  | Set${upperFirst(b.name)} of ${payload}`;
}

/** The `update` arm a two-way-bound input contributes — assign the Model field
 *  from the dispatched value, converting the raw input `string` to the field's
 *  type (a bad/partial number parses to the zero value, never throwing). */
function boundSetArm(b: FelizBoundState): string {
  const field = upperFirst(b.name);
  const fs = typeToFs(b.type);
  const conv =
    fs === "bool"
      ? "v"
      : fs === "int"
        ? "(match System.Int32.TryParse v with | true, n -> n | _ -> 0)"
        : fs === "decimal"
          ? "(match System.Decimal.TryParse v with | true, n -> n | _ -> 0m)"
          : "v";
  return `  | Set${field} v -> { model with ${field} = ${conv} }, Cmd.none`;
}

/** The `Msg` cases a form's dynamic-row fields contribute — an `Add`/`Remove of
 *  int` per array plus one indexed `Set … of int * string` per row sub-field. */
function fieldArrayMsgs(f: FormRecord): string[] {
  return f.fieldArrays.flatMap((fa) => [
    `  | ${fa.addMsg}`,
    `  | ${fa.removeMsg} of int`,
    ...fa.rowFields.map((rf) => `  | ${rf.setMsg} of int * string`),
  ]);
}

/** The `update` arms a form's dynamic-row fields contribute — append an empty
 *  row, remove a row by index (`List.indexed`/filter/`snd`), and set one row
 *  sub-field at an index (`List.mapi`).  `formField` is the Model field holding
 *  the form record. */
function fieldArrayUpdateArms(f: FormRecord): string[] {
  const acc = `model.${f.formField}.`;
  const withForm = (listExpr: string, fa: FelizFieldArray): string =>
    `{ model with ${f.formField} = { model.${f.formField} with ${fa.fieldName} = ${listExpr} } }, Cmd.none`;
  return f.fieldArrays.flatMap((fa) => [
    `  | ${fa.addMsg} -> ${withForm(`${acc}${fa.fieldName} @ [ ${fa.emptyRowBinding} ]`, fa)}`,
    `  | ${fa.removeMsg} i -> ${withForm(
      `${acc}${fa.fieldName} |> List.indexed |> List.filter (fun (j, _) -> j <> i) |> List.map snd`,
      fa,
    )}`,
    ...fa.rowFields.map(
      (rf) =>
        `  | ${rf.setMsg} (i, v) -> ${withForm(
          `${acc}${fa.fieldName} |> List.mapi (fun j row -> if j = i then { row with ${rf.wireName} = v } else row)`,
          fa,
        )}`,
    ),
  ]);
}

/** The `Model` record type declaration — one field per state cell, plus one
 *  `Remote<'T>` field per api read (its loading/error/loaded envelope).  When
 *  `routed`, a `CurrentPage: Page` field leads (multi-page routing). */
export function renderModel(
  state: readonly StateFieldIR[],
  reads: readonly FelizRead[] = [],
  routed = false,
  forms: readonly FormRecord[] = [],
  authUi = false,
  /** UI-gate mode (D-AUTH-OIDC): a page carries `requires`, so the verified
   *  session claims are decoded + held on the Model for a gated view to test. */
  pageGate = false,
): string {
  const fields = [
    ...(authUi ? ["    Session: SessionState"] : []),
    ...(pageGate ? ["    CurrentUser: CurrentUser option"] : []),
    ...(routed ? ["    CurrentPage: Page"] : []),
    ...state.map((f) => `    ${upperFirst(f.name)}: ${stateFieldFsType(f)}`),
    ...reads.map((r) => `    ${r.field}: Remote<${r.resultType}>`),
    ...forms.flatMap((f) => [
      `    ${f.formField}: ${f.formType}`,
      // The set of field names the user has blurred — gates each inline error so
      // an untouched field stays quiet (react-hook-form's onTouched behaviour).
      ...(formHasFieldErrors(f) ? [`    ${formTouchedField(f.formField)}: Set<string>`] : []),
    ]),
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
  forms: readonly FormRecord[] = [],
  authUi = false,
  pageGate = false,
): string {
  const hasPageCmd = routed && reads.some((r) => r.single);
  const inits = [
    ...(authUi ? ["      Session = Checking"] : []),
    ...(pageGate ? ["      CurrentUser = None"] : []),
    ...(routed
      ? [
          hasPageCmd
            ? "      CurrentPage = page"
            : "      CurrentPage = parseUrl (Router.currentPath ())",
        ]
      : []),
    ...state.map((f) => {
      const ctx: FsExprCtx = { stateNames: new Set(), locals: new Set() };
      const v = f.init ? decimalLit(renderFsExpr(f.init, ctx), f.type) : stateFieldZero(f);
      return `      ${upperFirst(f.name)} = ${v}`;
    }),
    ...reads.map((r) => `      ${r.field} = Loading`),
    ...forms.flatMap((f) => [
      `      ${f.formField} = ${f.emptyBinding}`,
      ...(formHasFieldErrors(f) ? [`      ${formTouchedField(f.formField)} = Set.empty`] : []),
    ]),
  ];
  // List reads fire eagerly; byId reads fire on page entry via `pageCmd page`.
  const cmds = reads
    .filter((r) => !r.single)
    .map((r) => `Cmd.OfAsync.perform Api.${r.apiFn} () ${r.msgCase}`);
  if (hasPageCmd) cmds.push("pageCmd page");
  // The auth gate probes the session at init (batched with the reads).
  if (authUi) cmds.push("Cmd.OfAsync.perform Auth.checkSession () SessionChecked");
  const cmd =
    cmds.length === 0
      ? "Cmd.none"
      : cmds.length === 1
        ? cmds[0]!
        : `Cmd.batch [\n${cmds.map((c) => `    ${c}`).join("\n")}\n  ]`;
  const prefix = hasPageCmd
    ? "let init () =\n  let page = parseUrl (Router.currentPath ())\n"
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
  forms: readonly FelizForm[] = [],
  operationForms: readonly FelizOperationForm[] = [],
  workflowForms: readonly FelizWorkflowForm[] = [],
  authUi = false,
  asyncEffects: readonly FelizAsyncEffect[] = [],
  pageGate = false,
  opActions: readonly FelizAction[] = [],
  boundState: readonly FelizBoundState[] = [],
  fileUploads: readonly FelizFileUpload[] = [],
): string {
  const cases = [
    // Under a page gate the probe carries the decoded claims (None on 401);
    // otherwise it's a bare authenticated? boolean.
    ...(authUi ? [`  | SessionChecked of ${pageGate ? "CurrentUser option" : "bool"}`] : []),
    ...(routed ? ["  | UrlChanged of string list"] : []),
    // One `Set<Field>` per two-way-bound controlled input (Field/Toggle/…).
    ...boundState.map(boundSetMsg),
    // Per standalone `FileUpload(bind:)`: a file-picked trigger (the browser
    // File) + an upload-completed result (the returned FileRef).
    ...fileUploads.flatMap((u) => [
      `  | ${fileSelectMsg(u.name)} of Browser.Types.File`,
      `  | ${fileUploadedMsg(u.name)} of Result<FileRef, string>`,
    ]),
    ...actions.map((a) => {
      const p = a.params[0];
      return p ? `  | ${msgCase(a.name)} of ${typeToFs(p.type)}` : `  | ${msgCase(a.name)}`;
    }),
    ...reads.map((r) => `  | ${r.msgCase} of Result<${r.resultType}, string>`),
    ...mutations.flatMap((m) => [
      `  | ${m.dispatchCase} of string`,
      `  | ${m.resultCase} of Result<unit, string>`,
    ]),
    // A create form: one `Set` per field + a `Submit` trigger + a `Created` result.
    ...forms.flatMap((f) => [
      ...f.fields.map((fld) => `  | ${fld.setMsg} of string`),
      ...(formHasFieldErrors(f) ? [`  | ${formTouchMsg(f.formType)} of string`] : []),
      ...fieldArrayMsgs(f),
      `  | ${f.submitMsg}`,
      `  | ${f.resultMsg} of Result<${f.resultType}, string>`,
    ]),
    // An operation form: `Set` per param + a `Submit … of string` (carries the
    // route id) + a `Done` result (the op returns 204 → `unit`).
    ...operationForms.flatMap((f) => [
      ...f.fields.map((fld) => `  | ${fld.setMsg} of string`),
      ...(formHasFieldErrors(f) ? [`  | ${formTouchMsg(f.formType)} of string`] : []),
      ...fieldArrayMsgs(f),
      `  | ${f.submitMsg} of string`,
      `  | ${f.doneMsg} of Result<unit, string>`,
    ]),
    // A workflow form: `Set` per param + a PARAMLESS `Submit` + a `Done` result.
    ...workflowForms.flatMap((f) => [
      ...f.fields.map((fld) => `  | ${fld.setMsg} of string`),
      ...(formHasFieldErrors(f) ? [`  | ${formTouchMsg(f.formType)} of string`] : []),
      ...fieldArrayMsgs(f),
      `  | ${f.submitMsg}`,
      `  | ${f.doneMsg} of Result<unit, string>`,
    ]),
    // An async effect (`match await`): a trigger carrying the route id (+ any op
    // args) + a result carrying the decoded `<outcome> option` (a matched variant
    // → Some, an unmatched tag / failure → None/Error).  `<outcome>` is the single
    // variant's record type, or the discriminated-union type for a multi-variant.
    ...asyncEffects.flatMap((e) => [
      `  | ${e.triggerMsg} of ${["string", ...e.params.map((p) => p.fsType)].join(" * ")}`,
      `  | ${e.resultMsg} of Result<${e.outcomeType} option, string>`,
    ]),
    // A one-click action (`Action { instance.op }`): a trigger carrying the
    // route id + a `Done` result (the op returns 204 → `unit`).
    ...opActions.flatMap((a) => [
      `  | ${a.triggerMsg} of string`,
      `  | ${a.doneMsg} of Result<unit, string>`,
    ]),
  ];
  if (cases.length === 0) return "type Msg = | NoOp";
  return `type Msg =\n${cases.join("\n")}`;
}

/** One rendered fragment of an `update` arm body.  A statement contributes a
 *  model rebind / side-effect `line`, a trailing `cmd` (an Elmish command — a
 *  dispatched sibling action, …), or both.  The arm assembler concatenates the
 *  lines and batches the cmds into the arm's `(model, Cmd)` tail — so a `call`
 *  to a sibling action issues `Cmd.ofMsg` instead of the hardcoded `Cmd.none`. */
interface UpdateArmPart {
  line?: string;
  cmd?: string;
}

/** The Elmish `Msg` application form for a dispatched action: `Inc` (nullary)
 *  or `SetTerm arg` (one param).  Action Msg cases carry 0 or 1 param
 *  (`renderMsg` / the arm head), so a single rendered arg suffices. */
function dispatchMsg(action: string, args: readonly string[]): string {
  const head = msgCase(action);
  return args.length === 0 ? head : `${head} ${args.join(" ")}`;
}

/** Render one action-body statement into `update`-arm fragment(s).  Covers the
 *  same set the reference JSX walker renders in a page event handler
 *  (walker-core `emitStmt`): state writes (`:=` / `+=` / `-=`, scalar AND
 *  collection), `let` bindings, bare expression statements, and `call`s to a
 *  sibling action / a ui function.  Backend-only statement kinds (`precondition`
 *  / `requires` / `emit` / `return`) have no meaning in a frontend action — the
 *  JSX walker throws on them too — so they stay a fail-fast throw (a defensive
 *  invariant, unreachable on valid `.ddd`). */
/** The Model field an assign/add/remove target resolves to.  Inside a store
 *  action body the target is a store field (bound as a `let` local at lowering)
 *  → its namespaced `<Store><Field>`; a page/component target is `<Field>`. */
function targetModelField(name: string, ctx: FsExprCtx): string {
  if (ctx.storeScope?.fields.has(name)) return storeModelField(ctx.storeScope.store, name);
  return upperFirst(name);
}

function renderUpdateStmt(stmt: ActionIR["body"][number], ctx: FsExprCtx): UpdateArmPart {
  switch (stmt.kind) {
    case "assign": {
      const field = targetModelField(stmt.target.segments[0]!, ctx);
      return {
        line: `      let model = { model with ${field} = ${renderFsExpr(stmt.value, ctx)} }`,
      };
    }
    case "add":
    case "remove": {
      const field = targetModelField(stmt.target.segments[0]!, ctx);
      const v = renderFsExpr(stmt.value, ctx);
      // A collection target appends / removes-by-value on the F# list (`@` cons,
      // `List.filter` drop); a scalar target is an arithmetic compound
      // (`+`/`-`).  `stmt.collection` (set at lowering) is the discriminator —
      // the JS frontends read the same flag to choose `[...xs, v]` vs `x + v`.
      const value = stmt.collection
        ? stmt.kind === "add"
          ? `(model.${field} @ [ ${v} ])`
          : `(model.${field} |> List.filter (fun x -> x <> ${v}))`
        : `(model.${field} ${stmt.kind === "add" ? "+" : "-"} ${v})`;
      return { line: `      let model = { model with ${field} = ${value} }` };
    }
    case "let":
      return { line: `      let ${stmt.name} = ${renderFsExpr(stmt.expr, ctx)}` };
    case "expression":
      // Bare expression statement (`name(args)` for effect).  A bare value in a
      // pure MVU arm must be discarded — `<expr> |> ignore` keeps the arm
      // well-typed regardless of the expression's result type.
      return { line: `      ${renderFsExpr(stmt.expr, ctx)} |> ignore` };
    case "call": {
      const args = stmt.args.map((a) => renderFsExpr(a, ctx));
      if (stmt.target === "action") {
        // Dispatch the sibling action's Msg — every combined action is emitted
        // as a Model/Msg/update arm, so re-dispatch re-enters the update loop,
        // matching the JS frontends' direct handler call + re-render.
        return { cmd: `Cmd.ofMsg (${dispatchMsg(stmt.name, args)})` };
      }
      if (stmt.target === "function") {
        // A call to a ui `function` (typically `extern`) — a fully-qualified or
        // in-scope F# function.  Discard its result (effect-position call).
        return { line: `      ${stmt.name}(${args.join(", ")}) |> ignore` };
      }
      if (stmt.target === "store-action" && stmt.store) {
        // `<Store>.<action>(…)` — the store folds into the single Elmish Model,
        // so a store action is a Msg case; dispatch it (re-entering the update
        // loop, which re-renders).  Same shape as a sibling-action call.
        const head = storeMsgCase(stmt.store, stmt.name);
        return { cmd: `Cmd.ofMsg (${args.length === 0 ? head : `${head} ${args.join(" ")}`})` };
      }
      // `private-operation`: a backend concept with no frontend arm.  Fail fast
      // rather than silently dropping it.
      throw new Error(
        `feliz: unsupported '${stmt.target}' call '${stmt.name}' in the MVU update arm — ` +
          `the Feliz frontend dispatches sibling/store actions and ui functions here. ` +
          `Rework the action, or extend the 'call' arm in update-emit.ts.`,
      );
    }
    case "variant-match":
      // `match await <op>()` (async effect).  A SUPPORTED effect is projected at
      // the `renderUpdate` level (its own trigger/result Msg cases + arms) and its
      // action is filtered out of the plain-action path, so its body never reaches
      // here; an UNSUPPORTED shape is gated at validation
      // (`loom.feliz-async-effect-unsupported`).  Either way this arm is a
      // defensive backstop, unreachable on validated `.ddd`.  See M-T6.15.
      throw new Error(
        "feliz: a `match await` (async effect) statement reached the per-statement update " +
          "renderer — a supported effect is projected at the update level, an unsupported one " +
          "is gated at validation (loom.feliz-async-effect-unsupported). See M-T6.15.",
      );
    default:
      // `precondition` / `requires` / `emit` / `return` are backend-only
      // statement kinds — the reference JSX walker (`emitStmt`) throws on them
      // too ("no meaning in a page event handler").  Unreachable on valid
      // frontend `.ddd`; a defensive fail-fast, not a silent drop.
      throw new Error(
        `feliz: unsupported action statement '${stmt.kind}' in the MVU update arm — ` +
          `it has no meaning in a frontend action (backend-only). ` +
          `This is unreachable on valid .ddd; see update-emit.ts.`,
      );
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
  forms: readonly FelizForm[] = [],
  operationForms: readonly FelizOperationForm[] = [],
  workflowForms: readonly FelizWorkflowForm[] = [],
  authUi = false,
  stores: readonly StoreIR[] = [],
  asyncEffects: readonly FelizAsyncEffect[] = [],
  pageGate = false,
  opActions: readonly FelizAction[] = [],
  boundState: readonly FelizBoundState[] = [],
  fileUploads: readonly FelizFileUpload[] = [],
): string {
  const stateNames = new Set(state.map((s) => s.name));
  // One `| Set<Field> v -> …` arm per two-way-bound controlled input.
  const boundArms = boundState.map(boundSetArm);
  // Per standalone `FileUpload(bind:)`: the file-picked trigger fires the upload
  // `Cmd` (multipart POST /files), and the result sets the `File` Model field to
  // `Some ref` on success (an error is dropped — the field stays as it was).
  const fileUploadArms = fileUploads.map((u) => {
    const field = upperFirst(u.name);
    return (
      `  | ${fileSelectMsg(u.name)} file -> model, Cmd.OfAsync.perform Api.uploadFile file ${fileUploadedMsg(u.name)}\n` +
      `  | ${fileUploadedMsg(u.name)} (Ok fileRef) -> { model with ${field} = Some fileRef }, Cmd.none\n` +
      `  | ${fileUploadedMsg(u.name)} (Error _) -> model, Cmd.none`
    );
  });
  const byIdReads = reads.filter((r) => r.single);
  // The auth gate: the session probe resolves to Authed / Anon.  Under a page
  // gate it also stashes the decoded claims (`Some user`) so a gated view can
  // test them; `None` (401 / decode failure) falls to Anon.
  const authArms = authUi
    ? pageGate
      ? [
          "  | SessionChecked (Some user) ->\n" +
            "      { model with Session = Authed; CurrentUser = Some user }, Cmd.none\n" +
            "  | SessionChecked None -> { model with Session = Anon }, Cmd.none",
        ]
      : [
          "  | SessionChecked true -> { model with Session = Authed }, Cmd.none\n" +
            "  | SessionChecked false -> { model with Session = Anon }, Cmd.none",
        ]
    : [];
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
  // Assemble one `| Msg [param] -> …body… model, <cmd>` arm from a rendered
  // body.  Shared by page/component actions and store actions (which fold into
  // the same single-program Model/Msg/update — the store arm just renders under
  // a `storeScope` so its own fields resolve to their namespaced Model field).
  const assembleArm = (head: string, body: readonly ActionIR["body"][number][], ctx: FsExprCtx) => {
    const parts = body.map((s) => renderUpdateStmt(s, ctx));
    const lines = parts.map((pt) => pt.line).filter((l): l is string => l !== undefined);
    const cmds = parts.map((pt) => pt.cmd).filter((c): c is string => c !== undefined);
    const cmd =
      cmds.length === 0
        ? "Cmd.none"
        : cmds.length === 1
          ? cmds[0]
          : `Cmd.batch [ ${cmds.join("; ")} ]`;
    const bodyLines = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    return `${head}\n${bodyLines}      model, ${cmd}`;
  };
  const actionArms = actions.map((a) => {
    const p = a.params[0];
    const ctx: FsExprCtx = { stateNames, locals: new Set(p ? [p.name] : []) };
    const head = p ? `  | ${msgCase(a.name)} ${p.name} ->` : `  | ${msgCase(a.name)} ->`;
    return assembleArm(head, a.body, ctx);
  });
  // Store action arms — one Msg case per `<Store>.<action>`, rendered with a
  // `storeScope` so the store's own fields (bound as `let` locals at lowering)
  // resolve to their namespaced Model field (`count` → `model.CartCount`).
  const storeArms = stores.flatMap((store) => {
    const fields = new Set(store.state.map((f) => f.name));
    return store.actions.map((a) => {
      const p = a.params[0];
      const ctx: FsExprCtx = {
        stateNames,
        locals: new Set(p ? [p.name] : []),
        storeScope: { store: store.name, fields },
      };
      const msg = storeMsgCase(store.name, a.name);
      const head = p ? `  | ${msg} ${p.name} ->` : `  | ${msg} ->`;
      return assembleArm(head, a.body, ctx);
    });
  });
  const readArms = reads.map(
    (r) =>
      `  | ${r.msgCase} (Ok data) -> { model with ${r.field} = Loaded data }, Cmd.none\n` +
      `  | ${r.msgCase} (Error e) -> { model with ${r.field} = LoadError e }, Cmd.none`,
  );
  // A delete: the trigger fires the `Cmd`; on success navigate to the list
  // route (the record is gone), on error stay put.
  const mutationArms = mutations.map((m) => {
    const nav = `Cmd.navigatePath(${m.navigateSegs.map((s) => `"${s}"`).join(", ")})`;
    return (
      `  | ${m.dispatchCase} id -> model, Cmd.OfAsync.perform Api.${m.apiFn} id ${m.resultCase}\n` +
      `  | ${m.resultCase} (Ok ()) -> model, ${nav}\n` +
      `  | ${m.resultCase} (Error _) -> model, Cmd.none`
    );
  });
  // A `Touch<Form> field` arm — records a blurred field name in the touched set
  // so its inline error becomes visible (shared by create / operation / workflow
  // forms; empty for a form with no message-bearing fields).
  const touchArm = (f: FormRecord): string[] =>
    formHasFieldErrors(f)
      ? [
          `  | ${formTouchMsg(f.formType)} field -> { model with ${formTouchedField(
            f.formField,
          )} = Set.add field model.${formTouchedField(f.formField)} }, Cmd.none`,
        ]
      : [];
  // A create form: per-field setters (functional record update), a submit that
  // fires the POST `Cmd`, and a `Created` result that resets the form + navigates.
  const formArms = forms.map((f) => {
    const setters = f.fields.map(
      (fld) =>
        `  | ${fld.setMsg} v -> { model with ${f.formField} = { model.${f.formField} with ${fld.wireName} = v } }, Cmd.none`,
    );
    // On success land on the NEW record's DETAIL page (`/<coll>/<id>`), not the
    // collection — the standard create→detail CRUD flow every other Loom frontend
    // follows.  The create Api fn resolves the new record's id (from the `{ id }`
    // response envelope), so append it to the collection segments.
    const nav = `Cmd.navigatePath(${[...f.navigateSegs.map((s) => `"${s}"`), "created"].join(
      ", ",
    )})`;
    return [
      ...setters,
      ...touchArm(f),
      ...fieldArrayUpdateArms(f),
      `  | ${f.submitMsg} -> model, Cmd.OfAsync.perform Api.${f.apiFn} model.${f.formField} ${f.resultMsg}`,
      `  | ${f.resultMsg} (Ok created) -> { model with ${f.formField} = ${f.emptyBinding} }, ${nav}`,
      `  | ${f.resultMsg} (Error _) -> model, Cmd.none`,
    ].join("\n");
  });
  // An operation form: per-field setters, a submit that fires the id-qualified
  // POST `Cmd` (the api fn is curried `(id) (form)`), and a `Done` result that
  // resets the form + navigates.
  const operationArms = operationForms.map((f) => {
    const setters = f.fields.map(
      (fld) =>
        `  | ${fld.setMsg} v -> { model with ${f.formField} = { model.${f.formField} with ${fld.wireName} = v } }, Cmd.none`,
    );
    const nav = `Cmd.navigatePath(${f.navigateSegs.map((s) => `"${s}"`).join(", ")})`;
    // A PARAM-LESS op (`confirm()`) has no form record: the submit posts `()`
    // (empty body) and the done arm doesn't reset a form field.
    if (!opHasForm(f)) {
      return [
        `  | ${f.submitMsg} id -> model, Cmd.OfAsync.perform (Api.${f.apiFn} id) () ${f.doneMsg}`,
        `  | ${f.doneMsg} (Ok ()) -> model, ${nav}`,
        `  | ${f.doneMsg} (Error _) -> model, Cmd.none`,
      ].join("\n");
    }
    return [
      ...setters,
      ...touchArm(f),
      ...fieldArrayUpdateArms(f),
      `  | ${f.submitMsg} id -> model, Cmd.OfAsync.perform (Api.${f.apiFn} id) model.${f.formField} ${f.doneMsg}`,
      `  | ${f.doneMsg} (Ok ()) -> { model with ${f.formField} = ${f.emptyBinding} }, ${nav}`,
      `  | ${f.doneMsg} (Error _) -> model, Cmd.none`,
    ].join("\n");
  });
  // A workflow form: per-field setters, a PARAMLESS submit firing the POST
  // `Cmd`, and a `Done` result that resets + navigates.
  const workflowArms = workflowForms.map((f) => {
    const setters = f.fields.map(
      (fld) =>
        `  | ${fld.setMsg} v -> { model with ${f.formField} = { model.${f.formField} with ${fld.wireName} = v } }, Cmd.none`,
    );
    const nav = `Cmd.navigatePath(${f.navigateSegs.map((s) => `"${s}"`).join(", ")})`;
    return [
      ...setters,
      ...touchArm(f),
      ...fieldArrayUpdateArms(f),
      `  | ${f.submitMsg} -> model, Cmd.OfAsync.perform Api.${f.apiFn} model.${f.formField} ${f.doneMsg}`,
      `  | ${f.doneMsg} (Ok ()) -> { model with ${f.formField} = ${f.emptyBinding} }, ${nav}`,
      `  | ${f.doneMsg} (Error _) -> model, Cmd.none`,
    ].join("\n");
  });
  // An async effect (`match await`) projects to four arms: the trigger fires the
  // `Cmd.OfAsync.perform` (the api fn is curried `(id) ()`), then the result
  // reduces the decoded `<Succ> option` — the success arm under `(Ok (Some p))`
  // (its body rendered with `p` bound), the `else` body under BOTH `(Ok None)`
  // (the tag didn't match / no success) and `(Error _)` (a thrown / non-2xx).
  const asyncEffectArms = asyncEffects.flatMap((e) => {
    const elseCtx: FsExprCtx = { stateNames, locals: new Set() };
    // Trigger arm: destructure `(id, <param>, …)` (named after the op params) and
    // fire the curried api fn.
    const argNames = e.params.map((p) => p.name);
    const triggerPat = e.params.length === 0 ? "id" : `(id, ${argNames.join(", ")})`;
    const apiArgs = ["id", ...argNames].join(" ");
    const arms: string[] = [
      `  | ${e.triggerMsg} ${triggerPat} -> model, Cmd.OfAsync.perform (Api.${e.apiFn} ${apiArgs}) () ${e.resultMsg}`,
    ];
    // One result arm per named variant.  Single-variant → `(Ok (Some b))`;
    // multi-variant → `(Ok (Some (<DuCase> b)))`.  A variant that binds a local
    // its body never reads gets a `_` binder so `--warnings-as-errors` stays green.
    for (const v of e.variants) {
      const ctx: FsExprCtx = { stateNames, locals: new Set(v.binding ? [v.binding] : []) };
      const inner = (b: string) => (e.isMulti ? `(${v.duCase} ${b})` : b);
      const arm = assembleArm(
        `  | ${e.resultMsg} (Ok (Some ${inner(v.binding ?? "_")})) ->`,
        v.body,
        ctx,
      );
      if (v.binding) {
        const bodyPortion = arm.slice(arm.indexOf("\n") + 1);
        const used = new RegExp(`\\b${v.binding}\\b`).test(bodyPortion);
        arms.push(used ? arm : `  | ${e.resultMsg} (Ok (Some ${inner("_")})) ->\n${bodyPortion}`);
      } else {
        arms.push(arm);
      }
    }
    // The unmatched / failure outcome reduces the `else` body — or a no-op when
    // the source had no `else` (an empty body → `model, Cmd.none`).
    const elseBody = e.elseBody ?? [];
    arms.push(assembleArm(`  | ${e.resultMsg} (Ok None) ->`, elseBody, elseCtx));
    arms.push(assembleArm(`  | ${e.resultMsg} (Error _) ->`, elseBody, elseCtx));
    return arms;
  });
  // A one-click action: the trigger fires the id-qualified POST `Cmd`; on
  // success it refetches the detail read (`pageCmd` when byId reads exist, so the
  // UI reflects the mutation — the MVU twin of React's query invalidation), on
  // error it stays put.
  const opActionArms = opActions.map((a) => {
    const refetch = hasPageCmd ? "pageCmd model.CurrentPage" : "Cmd.none";
    return (
      `  | ${a.triggerMsg} id -> model, Cmd.OfAsync.perform Api.${a.apiFn} id ${a.doneMsg}\n` +
      `  | ${a.doneMsg} (Ok ()) -> model, ${refetch}\n` +
      `  | ${a.doneMsg} (Error _) -> model, Cmd.none`
    );
  });
  const arms = [
    ...authArms,
    ...routeArms,
    ...boundArms,
    ...fileUploadArms,
    ...actionArms,
    ...storeArms,
    ...asyncEffectArms,
    ...readArms,
    ...mutationArms,
    ...formArms,
    ...operationArms,
    ...workflowArms,
    ...opActionArms,
  ];
  if (arms.length === 0) {
    return "let update (msg: Msg) (model: Model) =\n  match msg with\n  | NoOp -> model, Cmd.none";
  }
  return `let update (msg: Msg) (model: Model) =\n  match msg with\n${arms.join("\n")}`;
}
