// The Feliz WalkerTarget — F#/Feliz seam implementations consumed by the
// shared `walkBody` (fable-elmish-frontend.md).  The view is expression-valued
// F# code (`Html.div [ … ]`), so it rides the shared engine exactly like the
// JSX-family targets; only the seams below differ.
//
// State reads resolve to the MVU `model.<Field>`; effect handlers dispatch a
// `Msg` (the effect body lives in `update`, not the view).  Expression syntax
// leaves forward to the shared F# leaf table (`FS_LEAVES`).

import type { BoundedContextIR, ExprIR, FieldIR, TypeIR } from "../../ir/types/loom-ir.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import { stringNamed } from "../_walker/shared/args.js";
import type { RenderPosition, StateRef, WalkerTarget } from "../_walker/target.js";
import { emitExpr } from "../_walker/walker-core.js";
import { opActionGate } from "./auth-gate.js";
import { FELIZ_GRID_ROW_VAR, renderFelizDataGridChild } from "./data-grid-child.js";
import { FS_LEAVES, fsString, renderFsIntrinsic, storeModelField } from "./fs-expr.js";
import { fsZeroValue } from "./type-fs.js";
import {
  byIdFieldName,
  type FelizFieldArray,
  type FelizFormField,
  type FelizRowField,
  felizAction,
  felizCreateForm,
  felizOperationForm,
  felizWorkflowForm,
  fieldErrorFn,
  formTouchedField,
  formTouchMsg,
  idLabelsFrom,
  pageMetaFieldName,
  pageMetaMember,
  projectionFieldName,
  readFieldName,
} from "./wire.js";

/** Msg case name for an action (`inc` → `Inc`). */
function msgCase(action: string): string {
  return upperFirst(action);
}

/** The visible label for a `Modal`'s `trigger: Button("Rename", …)` (its first
 *  positional string literal), else the modal `title:` literal, else "Action". */
function modalTriggerLabel(call: ExprIR & { kind: "call" }): string {
  const names = call.argNames ?? [];
  const trigIdx = names.indexOf("trigger");
  const trigger = trigIdx >= 0 ? call.args[trigIdx] : undefined;
  if (trigger?.kind === "call") {
    const lit = trigger.args.find((a, i) => !(trigger.argNames ?? [])[i] && a.kind === "literal");
    if (lit?.kind === "literal" && lit.lit === "string") return String(lit.value);
  }
  const titleIdx = names.indexOf("title");
  const title = titleIdx >= 0 ? call.args[titleIdx] : undefined;
  if (title?.kind === "literal" && title.lit === "string") return String(title.value);
  return "Action";
}

/** True when a value is already an F# `string` — so `Html.text` can take it
 *  directly, without the `string (…)` coercion.  `string` is the only F#
 *  representation that needs no cast; every other primitive (int / decimal /
 *  money / bool / datetime) must be coerced. */
function isStringType(type: TypeIR | undefined): boolean {
  return type?.kind === "primitive" && type.name === "string";
}

/** Enum name → allowed values, resolved from a form's owning bounded context so
 *  an enum-typed field renders a `<select>`.  Empty when the BC is absent (the
 *  enum field then renders as text — byte-identical to before enum-select). */
function enumsFromBc(bc: BoundedContextIR | undefined): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (bc) for (const e of bc.enums) m.set(e.name, e.values);
  return m;
}

/** Value-object name → its fields, resolved from a form's owning bounded context
 *  so a VO-typed field is flattened into per-sub-field inputs.  Empty when the
 *  BC is absent (the VO field is then dropped — as before nested-VO support). */
function vosFromBc(bc: BoundedContextIR | undefined): Map<string, readonly FieldIR[]> {
  const m = new Map<string, readonly FieldIR[]>();
  if (bc) for (const vo of bc.valueObjects) m.set(vo.name, vo.fields);
  return m;
}

/** The `data-testid` a form field carries so the SHARED (testid-driven) page
 *  objects can fill it: `<base>-input-<jsonKey>` for a normal field, and
 *  `<base>-input-<objectKey>-<jsonKey>` for a FLATTENED value-object sub-field
 *  (`price-amount`) — matching the `fillBlock` recursion in
 *  `_frontend/page-objects-builder.ts` (`${testId}-${vf.name}`). */
function fieldTestid(base: string, fld: FelizFormField): string {
  return fld.objectKey
    ? `${base}-input-${fld.objectKey}-${fld.jsonKey}`
    : `${base}-input-${fld.jsonKey}`;
}

/** One form field → its typed input (shared by create / operation / workflow
 *  forms — the markup is identical, only the field set differs).  The widget is
 *  derived from the field's `inputKind`:

 *   - `number` — `prop.type'.number` + string `onChange` (form state is string).
 *   - `checkbox` — `prop.type'.checkbox` + `prop.isChecked (… = "true")`; the
 *     bool `onChange` sets the string `"true"`/`"false"` (encoder reads that).
 *   - `select` — `Html.select` of `Html.option`s over the enum's values; an
 *     OPTIONAL enum leads with a blank option (its "" encodes to null).
 *   - `text` — a plain text input.
 *  Rendered on ONE line so it stays offside-safe inside the form's Feliz
 *  children list.  (`type'` — Feliz's apostrophe-suffixed name, since `type` is
 *  an F# keyword.)  `base` is the form's testid namespace (`orders-new` /
 *  `orders-op-addLine` / `workflow-place_order`); the input carries
 *  `<base>-input-<field>` via `prop.custom` so the shared page objects drive it. */
function renderFormInput(formField: string, fld: FelizFormField, base: string): string {
  const value = `model.${formField}.${fld.wireName}`;
  const tidP = `prop.custom("data-testid", "${fieldTestid(base, fld)}"); `;
  if (fld.inputKind === "checkbox") {
    // A bool checkbox is always a legitimate value (checked/unchecked) — no
    // required-ness, so no touched onBlur / inline error.
    return `Html.input [ ${tidP}prop.className "checkbox"; prop.type'.checkbox; prop.isChecked (${value} = "true"); prop.onChange (fun (v: bool) -> dispatch (${fld.setMsg} (if v then "true" else "false"))) ]`;
  }
  // Message-bearing fields (required, non-checkbox) get a touched onBlur + an
  // inline error below the input — the Elmish mirror of react-hook-form's
  // per-field `errors.<f>.message`, shown once the field has been blurred.
  const validated = fld.required;
  const onBlur = validated
    ? `; prop.onBlur (fun _ -> dispatch (${formTouchMsg(formField)} "${fld.wireName}"))`
    : "";
  // a11y: a validated input links to its error via `aria-describedby` and marks
  // itself `aria-invalid` when the field is touched AND currently in error (the
  // same condition that reveals the visible message).  Unvalidated fields carry
  // no error binding, so no aria.
  const errorId = `${formField}-${fld.wireName}-error`;
  const aria = validated
    ? `; prop.ariaInvalid ((model.${formTouchedField(formField)} |> Set.contains "${fld.wireName}") && (Validation.${fieldErrorFn(formField, fld.wireName)} model.${formField} |> Option.isSome)); prop.ariaDescribedBy "${errorId}"`
    : "";
  const wrap = (input: string): string => {
    if (!validated) return input;
    // The touched-gated message goes through the `View.fieldError` helper (the
    // codebase's convention for repeated view logic, beside `View.remoteList`)
    // rather than an inlined match at every input.  It carries the `errorId` the
    // input's `aria-describedby` references.
    const errEl = `(View.fieldError model.${formTouchedField(formField)} "${fld.wireName}" "${errorId}" (Validation.${fieldErrorFn(formField, fld.wireName)} model.${formField}))`;
    return `Html.div [ prop.className "form-control"; prop.children [ ${input}; ${errEl} ] ]`;
  };
  if (fld.inputKind === "select") {
    const opts = (fld.enumValues ?? []).map(
      (v) => `Html.option [ prop.value "${v}"; prop.text "${v}" ]`,
    );
    // An optional enum can be "unset" → a leading blank option (encodes to null).
    const allOpts = fld.required ? opts : ['Html.option [ prop.value ""; prop.text "" ]', ...opts];
    return wrap(
      `Html.select [ ${tidP}prop.className "select select-bordered w-full"; prop.value ${value}; prop.onChange (fun (v: string) -> dispatch (${fld.setMsg} v))${onBlur}${aria}; prop.children [ ${allOpts.join("; ")} ] ]`,
    );
  }
  if (fld.inputKind === "idselect" && fld.idTarget) {
    // Options load at runtime from the target's `.all` (`View.idOptions` maps the
    // Remote list to `<option>`s); a leading blank option is the unselected state
    // (a required FK is guarded, so it must be chosen before submit).
    const listField = `model.${readFieldName(fld.idTarget)}`;
    const label = fld.idLabelField ?? "id";
    return wrap(
      `Html.select [ ${tidP}prop.className "select select-bordered w-full"; prop.value ${value}; prop.onChange (fun (v: string) -> dispatch (${fld.setMsg} v))${onBlur}${aria}; prop.children (Html.option [ prop.value ""; prop.text "" ] :: View.idOptions ${listField} (fun x -> x.id) (fun x -> x.${label})) ]`,
    );
  }
  const typeProp = fld.inputKind === "number" ? "prop.type'.number; " : "";
  // A scalar array renders as a comma-separated text input (the encoder splits
  // it into a JSON array); the placeholder hints the format.
  const placeholder = fld.isArray ? `${fld.wireName} (comma-separated)` : fld.wireName;
  return wrap(
    `Html.input [ ${tidP}prop.className "input input-bordered w-full"; ${typeProp}prop.placeholder "${placeholder}"; prop.value ${value}; prop.onChange (fun (v: string) -> dispatch (${fld.setMsg} v))${onBlur}${aria} ]`,
  );
}

/** One dynamic-row sub-field input — the row-scoped sibling of `renderFormInput`.
 *  Bound to `row.<wireName>` (the `List.mapi` lambda binds `row` + the index `i`)
 *  and dispatching the INDEXED setter `<setMsg> (i, v)`.  One line (offside-safe
 *  inside the row's Feliz children list). */
function renderRowInput(fld: FelizRowField): string {
  const value = `row.${fld.wireName}`;
  const set = (v: string): string => `dispatch (${fld.setMsg} (i, ${v}))`;
  if (fld.inputKind === "checkbox") {
    return `Html.input [ prop.className "checkbox"; prop.type'.checkbox; prop.isChecked (${value} = "true"); prop.onChange (fun (v: bool) -> ${set('if v then "true" else "false"')}) ]`;
  }
  if (fld.inputKind === "select") {
    const opts = (fld.enumValues ?? []).map(
      (v) => `Html.option [ prop.value "${v}"; prop.text "${v}" ]`,
    );
    const allOpts = fld.required ? opts : ['Html.option [ prop.value ""; prop.text "" ]', ...opts];
    return `Html.select [ prop.className "select select-bordered"; prop.value ${value}; prop.onChange (fun (v: string) -> ${set("v")}); prop.children [ ${allOpts.join("; ")} ] ]`;
  }
  const typeProp = fld.inputKind === "number" ? "prop.type'.number; " : "";
  return `Html.input [ prop.className "input input-bordered"; ${typeProp}prop.placeholder "${fld.wireName}"; prop.value ${value}; prop.onChange (fun (v: string) -> ${set("v")}) ]`;
}

/** A dynamic-row form field (`items: LineItem[]`) → a repeatable sub-form: a
 *  labelled group whose rows come from `model.<form>.<field> |> List.mapi`, each
 *  row a line of sub-field inputs + a Remove button, followed by an Add button.
 *  One line (offside-safe): `[ label; yield! (rows); addBtn ]` — F# allows an
 *  implicit yield alongside the `yield!` splice. */
function renderFieldArray(formField: string, fa: FelizFieldArray): string {
  const rowInputs = fa.rowFields.map(renderRowInput);
  const remove = `Html.button [ prop.className "btn btn-sm btn-error"; prop.onClick (fun _ -> dispatch (${fa.removeMsg} i)); prop.text "Remove" ]`;
  const row = `Html.div [ prop.className "flex gap-2 items-end"; prop.children [ ${[...rowInputs, remove].join("; ")} ] ]`;
  const rows = `model.${formField}.${fa.fieldName} |> List.mapi (fun i row -> ${row})`;
  const label = `Html.label [ prop.className "font-semibold"; prop.text "${fa.label}" ]`;
  const add = `Html.button [ prop.className "btn btn-sm"; prop.onClick (fun _ -> dispatch ${fa.addMsg}); prop.text "Add ${fa.elementLabel}" ]`;
  return `Html.div [ prop.className "flex flex-col gap-2"; prop.children [ ${label}; yield! (${rows}); ${add} ] ]`;
}

/** A route path → a `Router.navigatePath(<segments>)` call (Feliz.Router).  Each
 *  literal path segment becomes a quoted arg; a `:param` segment interpolates
 *  the matching named arg's value (or its bare name when no arg matches). */
function routerNavigate(
  routeTemplate: string,
  args: ReadonlyArray<{ name: string; value: string }>,
): string {
  const byName = new Map(args.map((a) => [a.name, a.value]));
  const segs = routeTemplate.split("/").filter((s) => s.length > 0);
  const rendered = segs.map((s) => {
    if (!s.startsWith(":")) return fsString(s);
    const name = s.slice(1);
    // `Router.navigate` args are `obj[]`; a param value renders as `string <v>`.
    return `(string ${byName.get(name) ?? name})`;
  });
  // `Router.navigate` needs ≥1 arg; the root path (`/`) navigates to `""`.
  if (rendered.length === 0) return `Router.navigatePath("")`;
  return `Router.navigatePath(${rendered.join(", ")})`;
}

/** Collapse a walked markup fragment to ONE line.  The walker joins children
 *  with `\n<indent>`, but only re-indents a child's FIRST line, so a multi-line
 *  `if`/`match` spliced into a Feliz `[ … ]` list is offside-broken (the
 *  continuation lines keep the walker's inconsistent columns).  A single-line
 *  expression sidesteps offside entirely.  Safe to flatten: Feliz emits BLOCK
 *  comments (`(* … *)`, never `//`), and F#-source newlines here are all
 *  structural (string-literal newlines are the escape `\n`, two chars). */
function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

/** A predicate-arm `match` → an F# `if/elif/else` chain on ONE line (both value
 *  and markup-child position — the arm values are already rendered).  With no
 *  `else` arm the terminal is `Html.none` (renders nothing). */
function renderFsMatch(
  arms: ReadonlyArray<{ predicate: string; value: string }>,
  elseArm: string | undefined,
): string {
  const terminal = oneLine(elseArm ?? "Html.none");
  if (arms.length === 0) return `(${terminal})`;
  const parts = arms.map(
    (a, i) => `${i === 0 ? "if" : "elif"} ${oneLine(a.predicate)} then ${oneLine(a.value)}`,
  );
  return `(${parts.join(" ")} else ${terminal})`;
}

export const felizTarget: WalkerTarget = {
  framework: "feliz",

  // --- State seam — MVU model reads --------------------------------------
  renderStateRead: (ref: StateRef, _pos: RenderPosition) => `model.${upperFirst(ref.name)}`,
  // `currentUser.<claim>` in a body (D-AUTH-OIDC, the read-side of the gate) →
  // an option-match against the decoded claims on the Model; the None branch
  // (no session yet) yields the claim type's zero value so the expression stays
  // well-typed.  One line (offside-safe inside a Feliz children list).  Emitting
  // this pulls in the claims machinery (index.ts's `uiBodyUsesCurrentUser` joins
  // `pageGate`), so `model.CurrentUser` is always in scope here.
  renderCurrentUserAccess: (field: string, memberType: TypeIR) =>
    `(match model.CurrentUser with Some currentUser -> currentUser.${upperFirst(field)} | None -> ${fsZeroValue(memberType)})`,
  // The view never writes state directly (effects live in `update`); the
  // shell's emitStmt over action bodies still reaches this, but the Feliz
  // named-handler ignores the emitted body (it dispatches a Msg instead), so a
  // harmless placeholder is correct.
  renderStateWrite: () => "()",
  renderNestedStateWrite: () => "()",

  // --- Store seam — stores fold into the single Elmish Model (Stage 5) ------
  // A store field reads from its namespaced Model field; the page-view shell
  // binds a local (`let <local> = model.<Store><Field>`) that the body walk
  // references, exactly as it binds `let <action> () = dispatch <Msg>`.
  renderStoreFieldRead: (ref: { storeName: string; field: string }) =>
    `model.${storeModelField(ref.storeName, ref.field)}`,
  // A `<Store>.<action>(args)` call → the shell-bound dispatcher local.
  renderStoreActionCall: (
    ref: { storeName: string; action: string; local: string },
    renderedArgs: string,
  ) => (renderedArgs.length > 0 ? `${ref.local} ${renderedArgs}` : `${ref.local} ()`),

  // --- API seam — MVU projection (fable-elmish-frontend.md §2.3/§7.2) -------
  // An Elmish read is NOT a per-component hook: the `<param>.<agg>.all` site
  // resolves to the Model field holding its `Remote<'T>`, the shell wires the
  // init `Cmd` + `Loaded` `Msg` + `update` arm (see index.ts's read wiring).
  // So `buildHookUse` names the Model field, `renderApiCall` returns it as the
  // value QueryView matches on, and `renderApiHoisting` emits nothing (there is
  // no page-top hoist to make).
  buildHookUse: (detected) => {
    // A query-time PROJECTION read (M-T1.3 Phase 1) resolves to its own Model
    // field — `Remote<<Proj>Row option>`, filled by the init Cmd and rendered
    // through `View.remoteOne`, exactly like a byId read's arm.  No import and
    // no hoist: Elmish has neither (see `feliz/projection-read.ts`).
    if (detected.kind === "projection") {
      const field = projectionFieldName(detected.aggregateName);
      return { varName: field, hookName: lowerFirst(field), importFrom: "", argsRendered: [] };
    }
    // A `byId` read resolves to the `<Agg>ById` Model field (its `Remote<'T
    // option>` envelope); `all` (and any other read) to `All<Plural>`.  The
    // page-entry `Cmd` — not this call — issues the byId fetch, so the view
    // only names the field it matches on.
    const field =
      detected.operation === "byId"
        ? byIdFieldName(detected.aggregateName)
        : readFieldName(detected.aggregateName);
    return { varName: field, hookName: lowerFirst(field), importFrom: "", argsRendered: [] };
  },
  renderApiCall: (call) => call.varName ?? readFieldName(call.aggregateName),
  // The magic route `id` (`byId(id)`) resolves to the local `id` the page view
  // function binds from its `Page` case (`| ProductDetail id -> …View … id`).
  renderRouteId: () => "id",
  renderApiHoisting: () => [],
  // The `data:` lambda param binds to the match arm the QueryView pack emits
  // (`| Loaded <binding> -> …`), so a read handle's data dereferences to that
  // binding directly (no `.data` — the arm already unwrapped the `Remote`).
  renderQueryDataAccess: (handle) => lowerFirst(handle),
  // The Elmish decoder SPLITS the paged envelope: the rows land in the read's
  // `Remote<'T list>` Model field and the page METADATA in a sibling `PageMeta`
  // record (see `FelizReadPaging`).  So the scaffold's `rows.items` is the
  // binding itself, while `rows.total` / `rows.totalPages` / `rows.pageSize`
  // are fields of that sibling — named off the read's handle, since the binding
  // is a list with no such member.  Every member of the envelope resolves here;
  // there is no Feliz-shaped gap left for the validator to gate.
  renderPagedEnvelopeMember: ({ member, binding, handle }) => {
    if (member === "items") return binding;
    const meta = pageMetaMember(member);
    return meta ? `model.${pageMetaFieldName(handle)}.${meta}` : undefined;
  },

  // --- Control-flow seams — QueryView's loading/error/empty/data + Table's
  // per-row `For` exercise these in a parseable, Fable-verifiable position. --
  // `match { p => v, else => e }` in value position → an `if/elif/else` chain
  // (F# has no predicate-arm switch expression).
  renderMatch: (arms, elseArm) => renderFsMatch(arms, elseArm),
  // Same chain in child (markup) position — the arm values are Feliz elements.
  renderMatchChild: (arms, elseArm) => renderFsMatch(arms, elseArm),
  // `body: cond ? then : else` → `(if cond then <then> else <else>)`, on ONE
  // line so it stays offside-safe inside a Feliz `[ … ]` list.
  renderConditionalChild: (cond, thenS, elseS) =>
    `(if ${oneLine(cond)} then ${oneLine(thenS)} else ${oneLine(elseS)})`,
  // `For { each: coll, x => <markup> }` → `yield! coll |> List.map (fun x -> …)`
  // spliced into the enclosing Feliz children list (the `yield!` and its
  // bracket-delimited body are offside-safe there).  An `empty:` arm folds into
  // a single-line element guard — `React.fragment` re-wraps the mapped list so
  // the whole thing is ONE child expression, offside-safe like the ternary.
  renderForEach: (coll, itemVar, _indexVar, _keyExpr, body, _depth, emptyBody) => {
    if (emptyBody === undefined) {
      return `yield! ${coll} |> List.map (fun ${itemVar} ->\n  ${body})`;
    }
    const frag = `React.fragment (${coll} |> List.map (fun ${itemVar} -> ${oneLine(body)}))`;
    return `(if List.isEmpty ${coll} then ${oneLine(emptyBody)} else ${frag})`;
  },
  // Cross-page navigation → `Router.navigatePath(<segments>)` (Feliz.Router).  A
  // `then: navigate(<Page>)` / `Anchor(to:)` reaches here with the target
  // page's route template; `:param` segments interpolate the matching arg.
  renderNavigate: (routeTemplate, args) => routerNavigate(routeTemplate, args),

  // `Button(to: "/products")` → `Router.navigatePath("products")`.  A literal path
  // is split into segments; a non-literal (a ref) navigates to it as one.
  renderNavigateExpr: (toArg) => {
    const lit = toArg.match(/^"(.*)"$/);
    if (!lit) return `Router.navigatePath(${toArg})`;
    return routerNavigate(lit[1]!, []);
  },

  // `DestroyForm(of: <Agg>)` → a delete button that DISPATCHES `Delete<Agg> id`
  // (the route id is bound by the detail page's view fn).  The mutation `Cmd` +
  // navigate-on-success live in `update` (wired by index.ts's `collectPage
  // Mutations`); the view only dispatches.  Falls through to the shared comment
  // path when the `of:` arg isn't a plain aggregate ref.
  renderDestroyForm: (call, ctx) => {
    if (call.kind !== "call") return null;
    const names = call.argNames ?? [];
    const idx = names.indexOf("of");
    const ofArg = idx >= 0 ? call.args[idx] : undefined;
    const agg = ofArg?.kind === "ref" ? ofArg.name : undefined;
    if (!agg) return null;
    ctx.usesRouteId = true; // the delete dispatches with the route `id`
    return `Html.button [ prop.className "btn btn-error"; prop.onClick (fun _ -> dispatch (Delete${upperFirst(agg)} id)); prop.text "Delete ${upperFirst(agg)}" ]`;
  },

  // `FileLink(<file-ref>)` → a plain daisyUI download anchor.  Feliz forks the
  // shared primitive because its "markup" is F# (`Html.a [ … ]`), not an HTML
  // string.  A `File` wire field is a `FileRef option` (always — see wire.ts), so
  // the guard is a `Some`/`None` match: `Some` hrefs the `url` and labels with the
  // `key`; `None` (an unset optional `File?`) renders an em-dash.
  renderFileLink: (call, ctx) => {
    if (call.kind !== "call") return null;
    const argNames = call.argNames ?? [];
    const named = argNames.indexOf("value");
    const arg = named >= 0 ? call.args[named] : (call.args ?? []).find((_, i) => !argNames[i]);
    if (!arg) return null;
    const recv = emitExpr(arg, ctx);
    const anchor =
      'Html.a [ prop.className "link link-primary"; prop.href __f.url; prop.download __f.key; prop.text __f.key ]';
    return `(match ${recv} with Some __f -> ${anchor} | None -> Html.text "—")`;
  },

  // `ProvenanceInfo(of: <record>, field: "<name>")` → a native `<details>`
  // disclosure over the co-located `<field>_provenance` (a `ProvLineage option`
  // on the decoded record).  Feliz forks because its "markup" is F# (`Html.details
  // [ … ]`).  A SINGLE-LINE expression (the walker doesn't re-indent seam output),
  // wrapped in `Html.span` so it starts with `Html.` (a bare `(match …)` list item
  // curries onto its sibling); a `Some`/`None` match guards the nullish lineage.
  renderProvenanceInfo: (call, ctx) => {
    if (call.kind !== "call") return null;
    const argNames = call.argNames ?? [];
    const ofIdx = argNames.indexOf("of");
    const ofArg = ofIdx >= 0 ? call.args[ofIdx] : (call.args ?? []).find((_, i) => !argNames[i]);
    const fieldIdx = argNames.indexOf("field");
    const fieldArg = fieldIdx >= 0 ? call.args[fieldIdx] : undefined;
    if (!ofArg || fieldArg?.kind !== "literal") {
      return felizTarget.renderComment("ProvenanceInfo: missing record or field");
    }
    const lineage = `${emitExpr(ofArg, ctx)}.${String(fieldArg.value)}_provenance`;
    const rule =
      'Html.div [ prop.children [ Html.dt [ prop.text "Rule" ]; Html.dd [ Html.code [ prop.text __p.snapshotId ] ] ] ]';
    const value =
      'Html.div [ prop.children [ Html.dt [ prop.text "Value" ]; Html.dd [ prop.text __p.computedValue ] ] ]';
    const inputRow =
      "Html.div [ prop.children [ Html.dt [ prop.text __i.path ]; Html.dd [ prop.text __i.value ] ] ]";
    const dl = `Html.dl [ prop.children (List.append [ ${rule}; ${value} ] [ for __i in __p.inputs -> ${inputRow} ]) ]`;
    const details = `Html.details [ prop.className "loom-provenance"; prop.children [ Html.summary [ prop.text "?" ]; ${dl} ] ]`;
    const match = `(match ${lineage} with Some __p -> ${details} | None -> Html.none)`;
    return `Html.span [ prop.children [ ${match} ] ]`;
  },

  // `Action { <instance>.<op> }` → a one-click operation button that DISPATCHES
  // `<Op><Agg> id` (the route id bound by the detail page's view fn).  The
  // trigger `Msg` + POST `Cmd` + refetch-on-success live in `update`/`Api` (wired
  // by index.ts's `collectPageActions`); the view only dispatches.  The Feliz
  // seam OWNS the primitive (never falls through to the shared React-shaped
  // `emitAction`): resolution is bounded to a parameterless public op on a
  // single-record QueryView instance (`ctx.paramTypes` — the collector's twin);
  // an unresolved instance / param-carrying op (that's an `OperationForm`) emits
  // a comment, not broken F#.  Under `auth: ui`, a currentUser-only op `requires`
  // hides the button via `model.CurrentUser` (the action-level page-gate mirror).
  renderAction: (call, ctx) => {
    if (call.kind !== "call") return null;
    const argNames = call.argNames ?? [];
    const opRef = (call.args ?? []).find((_, i) => !argNames[i]);
    if (opRef?.kind !== "member" || opRef.receiver.kind !== "ref") {
      return felizTarget.renderComment("Action: first argument must be <instance>.<operation>");
    }
    const aggName = ctx.paramTypes?.get(opRef.receiver.name);
    const agg = aggName ? ctx.aggregatesByName.get(aggName) : undefined;
    const op = agg?.operations.find(
      (o) => o.name === opRef.member && o.visibility === "public" && o.params.length === 0,
    );
    if (!agg || !op) {
      return felizTarget.renderComment(
        `Action(${opRef.receiver.name}.${opRef.member}): no parameterless public operation in scope (use OperationForm for an op with parameters)`,
      );
    }
    const action = felizAction(agg.name, op);
    ctx.usesRouteId = true; // the action dispatches with the route `id`
    const button = `Html.button [ prop.className "btn btn-primary"; prop.onClick (fun _ -> dispatch (${action.triggerMsg} id)); prop.text "${action.label}" ]`;
    if (ctx.authUi) {
      const gate = opActionGate(op);
      if (gate) {
        // One-line `match` (offside-safe, §24) referencing the Model's decoded
        // claims; no session → the button is hidden.
        return `(match model.CurrentUser with Some currentUser when ${gate} -> ${button} | _ -> Html.none)`;
      }
    }
    return button;
  },

  // `CreateForm(of: <Agg>)` → one `Html.input` per required create-input field
  // (bound to `model.<Agg>Form.<field>` + dispatching `Set<Agg>Form<Field>`) and
  // a submit button dispatching `Submit<Agg>Form`.  The form STATE + encoder +
  // POST `Cmd` live in `update`/`Api` (wired by index.ts's `collectPageForms`);
  // the view only reads/dispatches.  The field set is derived identically here
  // and in index.ts (both `felizCreateForm` off the same enriched aggregate).
  renderCreateForm: (call, ctx) => {
    if (call.kind !== "call") return null;
    const names = call.argNames ?? [];
    const idx = names.indexOf("of");
    const ofArg = idx >= 0 ? call.args[idx] : undefined;
    const aggName = ofArg?.kind === "ref" ? ofArg.name : undefined;
    const agg = aggName ? ctx.aggregatesByName.get(aggName) : undefined;
    if (!agg || !aggName) return null;
    const form = felizCreateForm(
      agg,
      enumsFromBc(ctx.bcByAggregate.get(aggName)),
      idLabelsFrom(ctx.aggregatesByName.values()),
      vosFromBc(ctx.bcByAggregate.get(aggName)),
    );
    // The testid namespace the SHARED page objects fill against — the scaffold's
    // `testid:` arg (`orders-new`) when present, else the same `<plural>-new`
    // default the page-object builder computes from the aggregate.
    const base = stringNamed(call, "testid") ?? `${snake(plural(agg.name))}-new`;
    const inputs = form.fields.map((fld) => renderFormInput(form.formField, fld, base));
    const arrays = form.fieldArrays.map((fa) => renderFieldArray(form.formField, fa));
    const disabled =
      form.fields.length > 0
        ? `prop.disabled (not (Validation.${form.validFn} model.${form.formField})); `
        : "";
    const submit = `Html.button [ prop.custom("data-testid", "${base}-submit"); prop.className "btn btn-primary"; ${disabled}prop.onClick (fun _ -> dispatch ${form.submitMsg}); prop.text "Create ${upperFirst(form.aggregate)}" ]`;
    return `Html.div [ prop.custom("data-testid", "${base}"); prop.className "flex flex-col gap-3"; prop.children [ ${[...inputs, ...arrays, submit].join("; ")} ] ]`;
  },

  // `OperationForm(of: <Agg>, op: <op>)` → one `Html.input` per op param + a
  // submit button dispatching `Submit<Op><Agg>Form id` (the op is instance-
  // qualified, so it carries the route id).  The form state + encoder + POST
  // live in `update`/`Api` (wired by index.ts's `collectPageOperationForms`).
  // Falls through when the args aren't `of:`+`op:` refs or the op is unknown /
  // non-public / paramless.
  renderOperationForm: (call, ctx) => {
    if (call.kind !== "call") return null;
    const names = call.argNames ?? [];
    const ofArg = names.indexOf("of") >= 0 ? call.args[names.indexOf("of")] : undefined;
    const opArg = names.indexOf("op") >= 0 ? call.args[names.indexOf("op")] : undefined;
    // Resolve the op through either shape: the by-name `OperationForm(of:, op:)`,
    // or the instance-qualified `OperationForm(<binding>.<op>)` used inside a
    // single-record QueryView data lambda (the scaffold Detail's op modals),
    // whose receiver resolves via `ctx.paramTypes` (the collector's twin).
    let aggName: string | undefined;
    let opName: string | undefined;
    if (ofArg?.kind === "ref" && opArg?.kind === "ref") {
      aggName = ofArg.name;
      opName = opArg.name;
    } else {
      const inst = call.args.find((_, i) => !names[i]);
      if (inst?.kind === "member" && inst.receiver.kind === "ref") {
        aggName = ctx.paramTypes?.get(inst.receiver.name);
        opName = inst.member;
      }
    }
    if (!aggName || !opName) return null;
    const agg = ctx.aggregatesByName.get(aggName);
    const op = agg?.operations.find((o) => o.name === opName && o.visibility === "public");
    if (!agg || !op) return null;
    const form = felizOperationForm(
      agg,
      op,
      enumsFromBc(ctx.bcByAggregate.get(aggName)),
      idLabelsFrom(ctx.aggregatesByName.values()),
      vosFromBc(ctx.bcByAggregate.get(aggName)),
    );
    // A PARAM-LESS op (`confirm()`) renders too — an empty form with just the
    // submit (no inputs, no validity guard); the page object still drives it as
    // trigger → submit → form-detach.  (Only the whole-body `null` fall-throughs
    // above — unresolved refs / unknown op — bail.)
    ctx.usesRouteId = true; // the op dispatches with the route `id`
    // Testid namespace: the scaffold's `testid:` arg (`orders-op-addLine`) or the
    // `<plural>-op-<op>` default the page-object builder computes.  The form
    // container is `<base>-form`, the submit `<base>-submit` — the exact ids the
    // op page-object method waits for / clicks.
    const base = stringNamed(call, "testid") ?? `${snake(plural(agg.name))}-op-${op.name}`;
    const inputs = form.fields.map((fld) => renderFormInput(form.formField, fld, base));
    const arrays = form.fieldArrays.map((fa) => renderFieldArray(form.formField, fa));
    // The submit guard reads `Validation.<validFn>`, only emitted when the form
    // has flat fields; an array-only form has no required-field guard.
    const disabled =
      form.fields.length > 0
        ? `prop.disabled (not (Validation.${form.validFn} model.${form.formField})); `
        : "";
    const submit = `Html.button [ prop.custom("data-testid", "${base}-submit"); prop.className "btn btn-primary"; ${disabled}prop.onClick (fun _ -> dispatch (${form.submitMsg} id)); prop.text "${upperFirst(form.op)} ${upperFirst(form.aggregate)}" ]`;
    return `Html.div [ prop.custom("data-testid", "${base}-form"); prop.className "flex flex-col gap-3"; prop.children [ ${[...inputs, ...arrays, submit].join("; ")} ] ]`;
  },

  // `WorkflowForm(runs: <wf>)` → one `Html.input` per workflow param + a
  // (paramless) submit button dispatching `Submit<Wf>Form`.  The form state +
  // encoder + POST `/workflows/<wf>` Cmd live in `update`/`Api` (wired by
  // index.ts's `collectPageWorkflowForms`).  Falls through when `runs:` isn't a
  // ref to a reachable workflow with scalar params.
  renderWorkflowForm: (call, ctx) => {
    if (call.kind !== "call") return null;
    const names = call.argNames ?? [];
    const runsArg = names.indexOf("runs") >= 0 ? call.args[names.indexOf("runs")] : undefined;
    const wfName = runsArg?.kind === "ref" ? runsArg.name : undefined;
    const wf = wfName ? ctx.workflowsByName.get(wfName) : undefined;
    if (!wf || !wfName) return null;
    const form = felizWorkflowForm(
      wf,
      enumsFromBc(ctx.bcByWorkflow.get(wfName)),
      idLabelsFrom(ctx.aggregatesByName.values()),
      vosFromBc(ctx.bcByWorkflow.get(wfName)),
    );
    if (form.fields.length === 0 && form.fieldArrays.length === 0) return null;
    // Testid namespace: the scaffold's `testid:` arg (`workflow-place_order`) or
    // the `workflow-<snake(wf)>` default the workflow page-object builder computes.
    const base = stringNamed(call, "testid") ?? `workflow-${snake(wf.name)}`;
    const inputs = form.fields.map((fld) => renderFormInput(form.formField, fld, base));
    const arrays = form.fieldArrays.map((fa) => renderFieldArray(form.formField, fa));
    const disabled =
      form.fields.length > 0
        ? `prop.disabled (not (Validation.${form.validFn} model.${form.formField})); `
        : "";
    const submit = `Html.button [ prop.custom("data-testid", "${base}-submit"); prop.className "btn btn-primary"; ${disabled}prop.onClick (fun _ -> dispatch ${form.submitMsg}); prop.text "Run ${upperFirst(form.workflow)}" ]`;
    return `Html.div [ prop.custom("data-testid", "${base}"); prop.className "flex flex-col gap-3"; prop.children [ ${[...inputs, ...arrays, submit].join("; ")} ] ]`;
  },

  // `Modal(trigger: Button(…), OperationForm(<agg>.<op>))` — the scaffold detail's
  // action dialog.  Rendered as a native `<details>` DISCLOSURE (no MVU open-state
  // needed): the `<summary>` is the trigger label, and the wrapped operation form
  // (rendered inline through the SAME `renderOperationForm` seam) is revealed on
  // click.  The form's Model/Msg/update/Api wiring is collected independently by
  // index.ts (its `collectPageOperationForms` walks the nested `OperationForm`),
  // so this only renders markup.  Returns null when there's no OperationForm child
  // or the op has no renderable form (→ the shared `emitModal` stub/comment path).
  renderModal(call: ExprIR, ctx): string | null {
    if (call.kind !== "call") return null;
    const names = call.argNames ?? [];
    const formChild = call.args.find(
      (a, i): a is ExprIR & { kind: "call" } =>
        !names[i] && a.kind === "call" && a.name === "OperationForm",
    );
    if (!formChild) return null;
    const form = felizTarget.renderOperationForm?.(formChild, ctx, 0);
    if (!form) return null;
    const label = modalTriggerLabel(call).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    // The op page-object method CLICKS the trigger (`<slug>-op-<op>`) before it
    // waits for the form (`<slug>-op-<op>-form`, on the OperationForm wrapper the
    // seam above emits).  The scaffold puts that trigger testid on the Modal's
    // `trigger: Button(…, testid:)` (not the Modal call itself), so read it off
    // the trigger Button; the `<summary>` IS the trigger in this native
    // `<details>` disclosure.  Fall back to the Modal's own `testid:` (a custom
    // page may set it there).
    const names2 = call.argNames ?? [];
    const triggerArg =
      names2.indexOf("trigger") >= 0 ? call.args[names2.indexOf("trigger")] : undefined;
    const triggerTid =
      (triggerArg?.kind === "call" ? stringNamed(triggerArg, "testid") : undefined) ??
      stringNamed(call, "testid");
    const summaryTid = triggerTid ? `prop.custom("data-testid", "${triggerTid}"); ` : "";
    // ONE line (the op form is one line) so it stays offside-safe spliced into
    // the enclosing Group's children list; paren-wrapped against sibling absorption.
    // A native <details> styled as a daisyUI `collapse` disclosure — the summary
    // is the trigger, the operation form the revealed `collapse-content`.
    return `(Html.details [ prop.className "collapse collapse-arrow border border-base-300 bg-base-200"; prop.children [ Html.summary [ ${summaryTid}prop.className "collapse-title font-medium"; prop.text "${label}" ]; Html.div [ prop.className "collapse-content"; prop.children [ ${form} ] ] ] ])`;
  },

  defaultInitFor: (type) => fsZeroValue(type),

  // --- Extern component seam (extern-component-escape-hatch.md) -----------
  // An extern `component X(…) extern from "…"` is a hand-written Feliz
  // component FUNCTION the user owns.  It is referenced BARE (`OrderChart {|
  // … |}`); the `App.fs` head `open`s its module (derived from the `from`
  // path), so a fully-qualified reference isn't needed and a missing module
  // fails `dotnet fable` — the fail-fast, matching the JSX frontends' `tsc`.
  // Props pass as an anonymous record; a prop-less component takes unit.
  renderUserComponent: (call, ctx, _depth) => {
    if (call.kind !== "call") return null;
    const params = ctx.userComponents.get(call.name) ?? [];
    ctx.usedUserComponents.add(call.name);
    const argNames = call.argNames ?? [];
    const filledByName = new Set(argNames.filter((n): n is string => n !== undefined));
    const fields: string[] = [];
    let cursor = 0;
    for (let i = 0; i < call.args.length; i++) {
      const arg = call.args[i]!;
      const named = argNames[i];
      let paramName: string | undefined;
      if (named !== undefined) {
        paramName = named;
      } else {
        while (cursor < params.length && filledByName.has(params[cursor]!.name)) cursor += 1;
        paramName = params[cursor]?.name;
        if (paramName !== undefined) cursor += 1;
      }
      if (paramName === undefined) continue;
      fields.push(`${paramName} = ${emitExpr(arg, ctx)}`);
    }
    return fields.length > 0 ? `${call.name} {| ${fields.join("; ")} |}` : `${call.name} ()`;
  },

  // --- Markup seams — F# flavoured ---------------------------------------
  renderComment: (text: string) => `(* ${text} *)`,
  // Child-position interpolation → a text node.  `Html.text` takes a `string`,
  // so a non-string value is coerced with F#'s `string` function; a value the
  // call site knows is already a `string` (a string literal, a Yes/No ternary
  // of string literals) skips the redundant wrap.  A field read keeps the cast
  // until scaffold accessors carry real types (see `provableStringType`).
  renderInterpolation: (js: string, exprType?: TypeIR) =>
    isStringType(exprType) ? `Html.text (${js})` : `Html.text (string (${js}))`,
  renderAttrBinding: (name: string, js: string) => `prop.custom("${name}", ${js})`,
  // An F# string literal — how a user-visible string reaching the pack as a
  // VALUE (`localizedNamedValue`, D-I18N-ATTR) is spelled with i18n off.
  // Same escaping as `escapeText`; both land in an F# `"…"` body.
  renderStringLiteral: (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,

  // A holed message as one F# string expression — `+` over `"…"` literals,
  // paren-wrapped for the `prop.ariaLabel (…)` argument positions it lands in.
  // Hole expressions arrive already string-typed (the seam concatenates, it does
  // not coerce), which is what keeps `("Filter by " + loomText (…))` byte-
  // identical to the sentence this pack spelled by hand.
  renderStringConcat: (parts) =>
    `(${parts.map((p) => ("expr" in p ? p.expr : fsString(p.text))).join(" + ")})`,

  // A call into the generated F# translation runtime (M-T1.11).  The JS
  // frontends' `t(key, default, values)` is not F#, so Feliz spells the same
  // call its own way — the key, the source default and the ICU hole values are
  // shared verbatim, so the catalog entry is identical.  Paren-wrapped: these
  // land inside `Html.text (…)` / `prop.custom(…, …)` argument positions where a
  // bare curried application would bind wrongly.
  renderTranslate: ({ key, message, values }) =>
    values && values.length > 0
      ? `(I18n.tf ${fsString(key)} ${fsString(message)} [ ${values
          .map((v) => `${fsString(v.name)}, box (${v.expr})`)
          .join("; ")} ])`
      : `(I18n.t ${fsString(key)} ${fsString(message)})`,
  renderStyleAttr: () => "",
  // Raw text for markup TEXT position — F# string-body escaping (the pack
  // wraps it in `Html.text "…"` or `prop.text "…"`).
  escapeText: (text: string) => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"'),

  /** F# member SPELLING for a plain read.  The walker's default is the JS
   *  `<recv>.<member>`, which Fable rejects for the handful of members F#
   *  capitalises: an F# `list`/`array`/`string` exposes `.Length`, not
   *  `.length`.  Everything else falls through unchanged (a wire record's
   *  fields keep their DSL casing, so `row.name` is already correct).
   *
   *  This mirrors the method-call mapping `fs-expr.ts` applies on the update
   *  path — the same members, reached from the view side. */
  renderMemberRead: ({ receiver, member }) => {
    switch (member) {
      case "length":
        return `(${receiver}.Length)`;
      default:
        return undefined;
    }
  },

  // --- DataGrid seam (M-T1.1 slice 10e) ----------------------------------
  //
  // Feliz hosts the REAL TanStack row model — `@tanstack/table-core` through
  // Fable interop — so the grid behaves identically to the four JSX frontends
  // rather than being re-implemented.  The child is a `[<ReactComponent>]`
  // declaration spliced into `App.fs` (React's `moduleDecl` shape: an F# module
  // holds many declarations, unlike a Vue SFC or a `.svelte` file).  See
  // `data-grid-child.ts` for the whole rationale.
  dataGridRowVar: FELIZ_GRID_ROW_VAR,
  renderDataGridChild: (spec, ctx) => renderFelizDataGridChild(spec, ctx),

  // --- Table control seams (M-T1.1) --------------------------------------
  //
  // Every write here dispatches a `Set<Field>` Msg rather than assigning: the
  // Feliz `renderStateWrite` is a no-op because Elmish state lives in `update`.
  // Those Msg cases exist because `Table` is registered in `wire.ts`'s
  // `BOUND_INPUT_PRIMITIVES` — its `sortKey`/`sortDir`/`page`/`filter` refs are
  // collected exactly like a `Field`'s `bind:`, so `boundSetMsg`/`boundSetArm`
  // generate the case and the arm (including the string→int parse `page` needs).
  //
  // Everything below stays on ONE line: these render INSIDE an enclosing
  // `prop.children [ … ]`, and F# is offside-sensitive (§24).

  /** Clickable column header driving `sortKey`/`sortDir`.  Re-clicking the
   *  ACTIVE column flips the direction; clicking a new one selects it and
   *  resets to ascending — which needs two Msgs, so that branch dispatches
   *  twice (Elmish folds each in turn; no combined Msg case required). */
  renderSortableHeader(spec) {
    const { header, field } = spec;
    const k = `model.${upperFirst(spec.sortKey.name)}`;
    const d = `model.${upperFirst(spec.sortDir.name)}`;
    const setK = `Set${upperFirst(spec.sortKey.name)}`;
    const setD = `Set${upperFirst(spec.sortDir.name)}`;
    const q = `"${field}"`;
    const onClick =
      `fun _ -> if ${k} = ${q} then dispatch (${setD} (if ${d} = "asc" then "desc" else "asc")) ` +
      `else (dispatch (${setK} ${q}); dispatch (${setD} "asc"))`;
    const indicator = `(if ${k} = ${q} then (if ${d} = "asc" then " ↑" else " ↓") else "")`;
    // A real `<button>`, like the JSX targets emit — keyboard-focusable, with
    // the implicit ARIA role the a11y gate wants.  `btn-ghost` keeps the header
    // reading as a header rather than a control.
    return (
      `Html.button [ prop.className "btn btn-ghost btn-xs px-1 font-bold"; prop.type'.button; ` +
      `prop.onClick (${onClick}); prop.text ("${header}" + ${indicator}) ]`
    );
  },

  /** Client-side sort.  The sort key is a runtime string but an F# record can't
   *  be indexed by one, so this matches the key against the sortable columns and
   *  compares the FIELD — which also types each comparison correctly (F#
   *  `compare` orders ints numerically, strings lexicographically), matching
   *  JS's relational `<` instead of stringifying everything. */
  renderSortedRows({ rowsExpr, sortKey, sortDir, columns }) {
    const k = `model.${upperFirst(sortKey.name)}`;
    const d = `model.${upperFirst(sortDir.name)}`;
    const arms = columns.map((f) => `| "${f}" -> compare a.${f} b.${f}`).join(" ");
    // No sortable column resolved a field → nothing to sort by; leave the rows
    // alone rather than emitting a `match` whose only arm is the wildcard.
    if (arms === "") return rowsExpr;
    return (
      `(${rowsExpr} |> List.sortWith (fun a b -> ` +
      `let c = (match ${k} with ${arms} | _ -> 0) in if ${d} = "desc" then -c else c))`
    );
  },

  /** Client-side page window.  `List.skip` raises when the count exceeds the
   *  list length, so this filters on the index instead — total-safe, and it
   *  mentions the rows expression once. */
  renderClientPaging({ rowsExpr, page, pageSize }) {
    const p = `model.${upperFirst(page.name)}`;
    const lo = `((${p} - 1) * ${pageSize})`;
    return {
      rowsExpr:
        `(${rowsExpr} |> List.indexed |> List.filter ` +
        `(fun (i, _) -> i >= ${lo} && i < ${p} * ${pageSize}) |> List.map snd)`,
      // Ceiling division on ints — F# has no `Math.ceil` over an int quotient.
      totalPagesExpr: `(max 1 ((List.length (${rowsExpr}) + ${pageSize} - 1) / ${pageSize}))`,
    };
  },

  renderServerTotalPages: (totalPagesExpr: string) => `(max 1 (${totalPagesExpr}))`,

  // Server-paged mode is ON as of the M-T2.6 Feliz leg: a controlled `.all`
  // read decodes the envelope's `totalPages` into a sibling Model field, and
  // the page/sort `Set<Field>` arms refetch, so both halves the pager needs are
  // in place.

  /** Prev / "Page N of M" / Next.  `page` is an int state field, but the shared
   *  `Set<Field>` arm parses from a string (that is how every bound input
   *  dispatches), so the new page number is stringified on the way in. */
  renderPager({ page, totalPagesExpr, chrome }) {
    const p = `model.${upperFirst(page.name)}`;
    const setP = `Set${upperFirst(page.name)}`;
    // The page count is read four times (label, Next's disabled, Next's target
    // clamp) and in client mode it carries the whole filter+sort chain, so bind
    // it ONCE.  `let … in …` keeps that on one line, which the offside rule
    // needs here (§24).
    const tp = "__tp";
    const go = (v: string) => `prop.onClick (fun _ -> dispatch (${setP} (string ${v})))`;
    const prev =
      `Html.button [ prop.className "btn btn-sm"; prop.type'.button; ` +
      `prop.disabled (${p} <= 1); ${go(`(max 1 (${p} - 1))`)}; prop.text ${chrome.prevValue} ]`;
    // Under i18n the counter is an `I18n.tf` call over `chrome.pageOf`, whose
    // locale may reorder the two numbers; with i18n off it is `undefined` and
    // this `sprintf` — the sentence this target has always emitted — stands.
    const counter = chrome.pageOfValue(p, tp) ?? `(sprintf "Page %d of %d" ${p} ${tp})`;
    const label = `Html.span [ prop.text ${counter} ]`;
    const next =
      `Html.button [ prop.className "btn btn-sm"; prop.type'.button; ` +
      `prop.disabled (${p} >= ${tp}); ${go(`(min ${tp} (${p} + 1))`)}; prop.text ${chrome.nextValue} ]`;
    return (
      `(let ${tp} = ${totalPagesExpr} in ` +
      `Html.div [ prop.className "flex items-center justify-end gap-2 mt-3"; ` +
      `prop.custom("data-testid", "pager"); prop.children [ ${prev}; ${label}; ${next} ] ])`
    );
  },

  /** The search box above a filterable table — the same controlled-input idiom
   *  the pack's `Field` uses (`prop.value` + `onChange` dispatching `Set…`). */
  renderFilterInput(filter) {
    const v = `model.${upperFirst(filter.name)}`;
    const set = `Set${upperFirst(filter.name)}`;
    return (
      `Html.input [ prop.className "input input-bordered input-sm w-full max-w-xs mb-3"; ` +
      `prop.type'.search; prop.placeholder "Filter…"; prop.ariaLabel "Filter table"; ` +
      `prop.custom("data-testid", "table-filter"); prop.value ${v}; ` +
      `prop.onChange (fun (s: string) -> dispatch (${set} s)) ]`
    );
  },

  /** Case-insensitive substring filter.  The JSX targets search `Object.values
   *  (row)`; Fable has no reliable runtime value enumeration for an F# record,
   *  so this searches the fields the table DISPLAYS — narrower than every row
   *  value, and named as such in `docs/new-plan/T1-ui-frontend.md` rather than
   *  left to be discovered. */
  renderFilteredRows({ rowsExpr, filter, columns }) {
    const q = `model.${upperFirst(filter.name)}`;
    if (columns.length === 0) return rowsExpr;
    const vals = columns.map((f) => `string r.${f}`).join("; ");
    return (
      `(${rowsExpr} |> List.filter (fun r -> let __q = (${q}).Trim().ToLower() in ` +
      `__q = "" || ([ ${vals} ] |> List.exists (fun v -> v.ToLower().Contains(__q)))))`
    );
  },

  /** F# has no adjacent-sibling concatenation — `a\nb` sequences and discards
   *  `a` — so a table with a filter box and/or a pager becomes a real flex
   *  column.  A plain table never reaches here. */
  joinRoots: (parts: readonly string[]) =>
    `Html.div [ prop.className "flex flex-col"; prop.children [ ${parts.join("; ")} ] ]`,

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

  // Scalar intrinsics — the SAME F# table the MVU update path uses
  // (`renderFsMethodCall`), so `s.replace(a, b)` cannot mean one thing in a
  // page body and another in an action body.  Before this seam was supplied
  // the view path had no intrinsic arm at all and emitted Loom's own spelling
  // verbatim (`(model.Name.toUpper())`), which is not F#.
  renderIntrinsic: (receiverType, member, recv, args) =>
    renderFsIntrinsic(receiverType, member, recv, args),
};

export { fsString };
