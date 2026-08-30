// MVU projection — Model / Msg / init / update from a page's `state {}` +
// named `action`s (fable-elmish-frontend.md §2/§3b).  This is a direct emit,
// NOT a synthesis: one `Model` field per state cell, one `Msg` case per
// action, one `update` arm per action body.  No gensym.

import type { ActionIR, StateFieldIR, StoreIR } from "../../ir/types/loom-ir.js";
import { typeIsFile } from "../../ir/util/file-field.js";
import { upperFirst } from "../../util/naming.js";
import {
  type FsExprCtx,
  ROUTE_ID_FROM_MODEL,
  ROUTE_ID_FROM_URL,
  renderFsExpr,
  storeModelField,
  storeMsgCase,
} from "./fs-expr.js";
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
  findReadCmd,
  formFileSelectMsg,
  formFileUploadedMsg,
  formHasFieldErrors,
  formTouchedField,
  formTouchMsg,
  opHasForm,
  pagedReadCmd,
  readLoadedType,
  refetchMsgCase,
  wfHasForm,
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
  const fs = typeToFs(b.type);
  // An ARRAY-typed binding is not a text input — it is `DataGrid(selection:)`,
  // which reports a whole `string list`.  Carrying it as a raw `string` would
  // not typecheck against the Model field.
  const payload = b.type.kind === "array" ? fs : fs === "bool" ? "bool" : "string";
  return `  | Set${upperFirst(b.name)} of ${payload}`;
}

/** The `update` arm a two-way-bound input contributes — assign the Model field
 *  from the dispatched value, converting the raw input `string` to the field's
 *  type (a bad/partial number parses to the zero value, never throwing).
 *
 *  `refetch` names the server-paged read this field is a CONTROL for (a
 *  scaffolded list's `pageNum`/`sortKey`/`sortDir`): the arm then binds the
 *  updated model first and fires the read off THAT, so the request carries the
 *  new page/sort rather than the one it just replaced. */
function boundSetArm(
  b: FelizBoundState,
  refetch?: FelizRead,
  renderFindArgs: (r: FelizRead) => string[] = () => [],
): string {
  const field = upperFirst(b.name);
  const fs = typeToFs(b.type);
  const conv =
    b.type.kind === "array" || fs === "bool"
      ? "v"
      : fs === "int"
        ? "(match System.Int32.TryParse v with | true, n -> n | _ -> 0)"
        : fs === "decimal"
          ? "(match System.Decimal.TryParse v with | true, n -> n | _ -> 0m)"
          : "v";
  if (refetch) {
    // A find read's ARGUMENT is a control in exactly the way a paged read's
    // page/sort cell is: change it and the query has to be re-issued off the
    // UPDATED model, or the view keeps showing the answer to the previous
    // question.  (Riverpod gets this for free — the Flutter `.family` provider
    // is re-watched with the new argument — so this arm is what keeps the two
    // frontends behaving the same.)
    const cmd = refetch.find
      ? findReadCmd(refetch, renderFindArgs(refetch))
      : pagedReadCmd(refetch, "__m");
    return `  | Set${field} v -> let __m = { model with ${field} = ${conv} } in __m, ${cmd}`;
  }
  return `  | Set${field} v -> { model with ${field} = ${conv} }, Cmd.none`;
}

/** Model field name → the server-paged read it controls, so `boundSetArm` can
 *  turn that field's setter into a refetch.  Built from the reads rather than
 *  passed in, so a control can never be wired to a read that isn't paged.
 *
 *  The SORT KEY is deliberately absent.  A sortable header dispatches the
 *  direction LAST on both of its branches — `SetSortDir` alone when re-clicking
 *  the active column, and `SetSortKey` then `SetSortDir "asc"` when selecting a
 *  new one (`renderSortableHeader`, pinned by `table-controls.test.ts`).  So
 *  refetching on the key as well would fire TWO requests for one click, with a
 *  window where they are in flight carrying different sorts and the later
 *  ARRIVAL — not the later request — wins.  Riding the direction arm gives
 *  exactly one request per user action. */
function refetchByControlField(reads: readonly FelizRead[]): Map<string, FelizRead> {
  const m = new Map<string, FelizRead>();
  for (const r of reads) {
    const c = r.paging?.controls;
    if (!c) continue;
    for (const f of [c.pageField, c.sortDirField]) m.set(f, r);
  }
  // A user-declared find read is controlled by the state cells its ARGUMENTS
  // name — `QueryView { of: K.Doc.byVis(chosen) }` beside a `Select(bind:
  // chosen)`.  Registered after the paged controls so a cell that is both keeps
  // the paged refetch (which re-issues the whole page/sort request), never two
  // fetches for one keystroke.
  for (const r of reads) {
    for (const a of r.find?.argExprs ?? []) {
      if (a.kind !== "ref") continue;
      const f = upperFirst(a.name);
      if (!m.has(f)) m.set(f, r);
    }
  }
  return m;
}

/** The `Msg` cases a form's FLAT fields contribute.  A typeable field carries
 *  its raw input `string` (`Set<Form><Field> of string`); a `File` field is not
 *  typed at all, so it carries the PICKED browser file and, separately, the
 *  upload RESULT — the same two-Msg shape a standalone `FileUpload(bind:)` uses,
 *  scoped to the form cell.  Shared by create / operation / workflow forms so
 *  the three can't drift. */
function formFieldMsgs(f: FormRecord): string[] {
  return f.fields.flatMap((fld) =>
    fld.inputKind === "file"
      ? [
          `  | ${formFileSelectMsg(f.formType, fld.wireName)} of Browser.Types.File`,
          `  | ${formFileUploadedMsg(f.formType, fld.wireName)} of Result<FileRef, string>`,
        ]
      : [`  | ${fld.setMsg} of string`],
  );
}

/** The `update` arms a form's FLAT fields contribute — a functional record
 *  update per typeable field, and for a `File` field the upload pair: the pick
 *  fires the multipart `Cmd` (`Api.uploadFile` → POST /files) and the result
 *  writes `Some fileRef` into the form cell (an error leaves the cell as it was,
 *  so the required-guard keeps the submit disabled). */
function formFieldSetterArms(f: FormRecord): string[] {
  return f.fields.flatMap((fld) => {
    const set = (v: string): string =>
      `{ model with ${f.formField} = { model.${f.formField} with ${fld.wireName} = ${v} } }, Cmd.none`;
    if (fld.inputKind !== "file") return [`  | ${fld.setMsg} v -> ${set("v")}`];
    const pick = formFileSelectMsg(f.formType, fld.wireName);
    const done = formFileUploadedMsg(f.formType, fld.wireName);
    return [
      `  | ${pick} file -> model, Cmd.OfAsync.perform Api.uploadFile file ${done}`,
      `  | ${done} (Ok fileRef) -> ${set("Some fileRef")}`,
      `  | ${done} (Error _) -> model, Cmd.none`,
    ];
  });
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
    ...reads.flatMap((r) => [
      `    ${r.field}: Remote<${r.resultType}>`,
      // A server-paged read carries the envelope's page metadata in a SIBLING
      // `PageMeta` record, so the list field stays a plain `'T list` for
      // `View.idOptions` and the realtime refetch (M-T2.6 Feliz leg).
      ...(r.paging ? [`    ${r.paging.metaField}: PageMeta`] : []),
    ]),
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
  // Two page-entry reads can share ONE hosting `Page` case — a detail page's
  // byId read plus its entity-history read.  One arm per CASE, batching the
  // fetches: a second `| OrderDetail id ->` arm would be unreachable (FS0026)
  // and its fetch would silently never fire.  A lone read keeps the unbatched
  // arm, byte-identical to before.
  const byCase = new Map<string, FelizRead[]>();
  for (const r of byId) {
    const key = r.pageCase ?? "";
    byCase.set(key, [...(byCase.get(key) ?? []), r]);
  }
  const arms = [...byCase.entries()].map(([pageCase, rs]) => {
    const cmds = rs.map((r) => `Cmd.OfAsync.perform Api.${r.apiFn} id ${r.msgCase}`);
    return cmds.length === 1
      ? `  | ${pageCase} id -> ${cmds[0]}`
      : `  | ${pageCase} id -> Cmd.batch [ ${cmds.join("; ")} ]`;
  });
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
  /** Model-field name → an init expression that REPLACES the field's declared
   *  initializer.  Fed by the store-persistence layer (`persist: local|session|
   *  url`), which seeds a persisted store field from its backing store instead
   *  of from the `.ddd` default — the Feliz answer to Zustand's `persist`
   *  hydration.  Empty on every other app, so their `init` is byte-identical. */
  initOverrides: ReadonlyMap<string, string> = new Map(),
): string {
  const hasPageCmd = routed && reads.some((r) => r.single);
  // A user-declared find read is issued with its ARGUMENTS, and those are
  // page `state {}` cells / store fields / the route id.  `init` binds the
  // initial record as `__m` before building the `Cmd`s (the same trick a
  // page/sort-controlled paged read already uses), so the arguments resolve
  // against the record this very `init` is returning.
  const findArgCtx: FsExprCtx = {
    stateNames: new Set(state.map((f) => f.name)),
    locals: new Set(),
    modelExpr: "__m",
    ...(routed ? { routeId: ROUTE_ID_FROM_URL } : {}),
  };
  const findArgs = (r: FelizRead): string[] =>
    (r.find?.argExprs ?? []).map((a) => renderFsExpr(a, findArgCtx));
  const hasFindArgs = reads.some((r) => (r.find?.argExprs.length ?? 0) > 0);
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
      // `init` has no `model` yet, so a state initialiser that reads the route
      // `id` re-parses the current URL — the same source `CurrentPage` is seeded
      // from two lines up.
      const ctx: FsExprCtx = {
        stateNames: new Set(),
        locals: new Set(),
        ...(routed ? { routeId: ROUTE_ID_FROM_URL } : {}),
      };
      const modelField = upperFirst(f.name);
      // A persisted store field hydrates from its backing store; the declared
      // `= <init>` becomes the FALLBACK inside the loader, not the seed here.
      const override = initOverrides.get(modelField);
      const v =
        override ?? (f.init ? decimalLit(renderFsExpr(f.init, ctx), f.type) : stateFieldZero(f));
      return `      ${modelField} = ${v}`;
    }),
    ...reads.flatMap((r) => [
      `      ${r.field} = Loading`,
      // `TotalPages = 1`, not 0: the pager labels "Page 1 of N" before the first
      // response lands, and `Next` must not be enabled against an unknown count.
      // The ROW count seeds at 0 instead — "0 results" until the rows arrive is
      // true of the empty list beside it; "1 result" would not be.  `Page` seeds
      // at the 1-based first page, `PageSize` at 0 (unknown until the server says).
      ...(r.paging
        ? [`      ${r.paging.metaField} = { Page = 1; PageSize = 0; Total = 0; TotalPages = 1 }`]
        : []),
    ]),
    ...forms.flatMap((f) => [
      `      ${f.formField} = ${f.emptyBinding}`,
      ...(formHasFieldErrors(f) ? [`      ${formTouchedField(f.formField)} = Set.empty`] : []),
    ]),
  ];
  // List reads fire eagerly; byId reads fire on page entry via `pageCmd page`.
  const cmds = reads
    .filter((r) => !r.single)
    .map((r) =>
      // A paged read's first fetch already carries the state's initial page and
      // sort, so it can't disagree with what the pager renders.
      r.paging?.controls
        ? pagedReadCmd(r, "__m")
        : r.find
          ? findReadCmd(r, findArgs(r))
          : `Cmd.OfAsync.perform Api.${r.apiFn} () ${r.msgCase}`,
    );
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
  // A paged read's init `Cmd` reads the model's own page/sort cells, so the
  // record has to be BOUND before the `Cmd` is built rather than returned
  // inline as the tuple's first element.
  if (reads.some((r) => r.paging?.controls) || hasFindArgs) {
    const body = inits.map((l) => `  ${l}`).join("\n");
    return `${prefix}  let __m =\n    {\n${body}\n    }\n  __m, ${cmd}`;
  }
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
  /** The `StoreUrlChanged` case a `persist: url` store's `popstate`
   *  subscription dispatches (`store-persist.ts`).  One case for the whole app
   *  — every url store reads the same query string. */
  urlStoreMsg?: string,
): string {
  const cases = [
    ...(urlStoreMsg ? [`  | ${urlStoreMsg}`] : []),
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
    ...reads.flatMap((r) => [
      `  | ${r.msgCase} of Result<${readLoadedType(r)}, string>`,
      // The realtime handler has no `model` in scope, so it asks for a refetch
      // rather than issuing one — dispatching a paramless read there would
      // silently reset the user's page and sort.  Only a CONTROLLED read has
      // that state to lose, and only it dispatches this (see `realtime.ts`), so
      // declaring it for every paged read would emit a case nothing raises.
      ...(r.paging?.controls ? [`  | ${refetchMsgCase(r.field)}`] : []),
    ]),
    ...mutations.flatMap((m) => [
      `  | ${m.dispatchCase} of string`,
      `  | ${m.resultCase} of Result<unit, string>`,
    ]),
    // A create form: one `Set` per field + a `Submit` trigger + a `Created` result.
    ...forms.flatMap((f) => [
      ...formFieldMsgs(f),
      ...(formHasFieldErrors(f) ? [`  | ${formTouchMsg(f.formType)} of string`] : []),
      ...fieldArrayMsgs(f),
      `  | ${f.submitMsg}`,
      `  | ${f.resultMsg} of Result<${f.resultType}, string>`,
    ]),
    // An operation form: `Set` per param + a `Submit … of string` (carries the
    // route id) + a `Done` result (the op returns 204 → `unit`).
    ...operationForms.flatMap((f) => [
      ...formFieldMsgs(f),
      ...(formHasFieldErrors(f) ? [`  | ${formTouchMsg(f.formType)} of string`] : []),
      ...fieldArrayMsgs(f),
      `  | ${f.submitMsg} of string`,
      `  | ${f.doneMsg} of Result<unit, string>`,
    ]),
    // A workflow form: `Set` per param + a PARAMLESS `Submit` + a `Done` result.
    ...workflowForms.flatMap((f) => [
      ...formFieldMsgs(f),
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

/** Fold a (possibly nested) write target into the immutable F# record `with`
 *  update.  The ROOT segment is the Model field (PascalCase / store-namespaced,
 *  via `targetModelField`); NESTED segments are wire-record fields, which keep
 *  their exact (lowercase) source names (see `wire.ts`).  Built inside-out:
 *  `order.shipping.zip := v` →
 *  `{ model with Order = { model.Order with shipping = { model.Order.shipping with zip = v } } }`.
 *  A single-segment target collapses to `{ model with <Field> = v }` (the flat
 *  case), byte-identical to the previous root-only emission. */
function nestedFsWith(segments: readonly string[], value: string, ctx: FsExprCtx): string {
  const rootField = targetModelField(segments[0]!, ctx);
  let expr = value;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (i === 0) {
      expr = `{ model with ${rootField} = ${expr} }`;
    } else {
      // Receiver at level i: `model.<Root>.<seg1>…<seg_{i-1}>`.
      const receiver = [`model.${rootField}`, ...segments.slice(1, i)].join(".");
      expr = `{ ${receiver} with ${segments[i]} = ${expr} }`;
    }
  }
  return expr;
}

function renderUpdateStmt(stmt: ActionIR["body"][number], ctx: FsExprCtx): UpdateArmPart {
  switch (stmt.kind) {
    case "assign": {
      return {
        line: `      let model = ${nestedFsWith(stmt.target.segments, renderFsExpr(stmt.value, ctx), ctx)}`,
      };
    }
    case "add":
    case "remove": {
      const seg = stmt.target.segments;
      const rootField = targetModelField(seg[0]!, ctx);
      // The current value at the (possibly nested) target — the read the compound
      // is relative to.  The root is the Model field; nested segments are
      // wire-record fields (exact lowercase source names).
      const readPath = [`model.${rootField}`, ...seg.slice(1)].join(".");
      const v = renderFsExpr(stmt.value, ctx);
      // A collection target appends / removes-by-value on the F# list (`@` cons,
      // `List.filter` drop); a scalar target is an arithmetic compound
      // (`+`/`-`).  `stmt.collection` (set at lowering) is the discriminator —
      // the JS frontends read the same flag to choose `[...xs, v]` vs `x + v`.
      const value = stmt.collection
        ? stmt.kind === "add"
          ? `(${readPath} @ [ ${v} ])`
          : `(${readPath} |> List.filter (fun x -> x <> ${v}))`
        : `(${readPath} ${stmt.kind === "add" ? "+" : "-"} ${v})`;
      // Fold the new value back in through the same nested `with` chain.
      return { line: `      let model = ${nestedFsWith(seg, value, ctx)}` };
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
  /** The `| StoreUrlChanged -> …` arm re-seeding every `persist: url` store
   *  field from the query string (`store-persist.ts`); undefined when the app
   *  has no url store, so its `update` is byte-identical. */
  storeUrlArm?: string,
): string {
  const stateNames = new Set(state.map((s) => s.name));
  // An update arm runs outside every page view fn, so a body that reads the
  // route `id` resolves it off the already-parsed `CurrentPage`.  Spread into
  // every arm ctx below (a non-routed ui has no `Page` type at all).
  const armRouteId = routed ? { routeId: ROUTE_ID_FROM_MODEL } : {};
  // One `| Set<Field> v -> …` arm per two-way-bound controlled input.
  // A control of a server-paged read turns its setter into a refetch; every
  // other bound input keeps the plain `Cmd.none` assignment.
  const refetches = refetchByControlField(reads);
  // A refetched find read's arguments resolve against `__m` — the record the
  // arm has just bound with the new control value — for the same reason
  // `pagedReadCmd` is handed `"__m"` there.
  const refetchArgCtx: FsExprCtx = {
    stateNames,
    locals: new Set(),
    modelExpr: "__m",
    ...armRouteId,
  };
  const boundArms = boundState.map((b) =>
    boundSetArm(b, refetches.get(upperFirst(b.name)), (r) =>
      (r.find?.argExprs ?? []).map((a) => renderFsExpr(a, refetchArgCtx)),
    ),
  );
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
    const ctx: FsExprCtx = { stateNames, locals: new Set(p ? [p.name] : []), ...armRouteId };
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
        ...armRouteId,
      };
      const msg = storeMsgCase(store.name, a.name);
      const head = p ? `  | ${msg} ${p.name} ->` : `  | ${msg} ->`;
      return assembleArm(head, a.body, ctx);
    });
  });
  const readArms = reads.map((r) => {
    if (r.paging) {
      return (
        `  | ${r.msgCase} (Ok (data, meta)) -> { model with ${r.field} = Loaded data; ${r.paging.metaField} = meta }, Cmd.none\n` +
        `  | ${r.msgCase} (Error e) -> { model with ${r.field} = LoadError e }, Cmd.none` +
        (r.paging.controls
          ? `\n  | ${refetchMsgCase(r.field)} -> model, ${pagedReadCmd(r, "model")}`
          : "")
      );
    }
    return (
      `  | ${r.msgCase} (Ok data) -> { model with ${r.field} = Loaded data }, Cmd.none\n` +
      `  | ${r.msgCase} (Error e) -> { model with ${r.field} = LoadError e }, Cmd.none`
    );
  });
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
    const setters = formFieldSetterArms(f);
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
    const setters = formFieldSetterArms(f);
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
    const setters = formFieldSetterArms(f);
    const nav = `Cmd.navigatePath(${f.navigateSegs.map((s) => `"${s}"`).join(", ")})`;
    // A PARAM-LESS workflow (`run()`) has no form record: the submit posts `()`
    // (empty body) and the done arm doesn't reset a form field.
    if (!wfHasForm(f)) {
      return [
        `  | ${f.submitMsg} -> model, Cmd.OfAsync.perform Api.${f.apiFn} () ${f.doneMsg}`,
        `  | ${f.doneMsg} (Ok ()) -> model, ${nav}`,
        `  | ${f.doneMsg} (Error _) -> model, Cmd.none`,
      ].join("\n");
    }
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
    const elseCtx: FsExprCtx = { stateNames, locals: new Set(), ...armRouteId };
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
      const ctx: FsExprCtx = {
        stateNames,
        locals: new Set(v.binding ? [v.binding] : []),
        ...armRouteId,
      };
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
    ...(storeUrlArm ? [storeUrlArm] : []),
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
