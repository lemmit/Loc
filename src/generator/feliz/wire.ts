// F# wire layer for the Feliz frontend — the parallel of
// `src/generator/_frontend/` (zod + TanStack), rendered as F# instead of TS.
//
// Three pieces, all derived from the ENRICHED IR (never recomputed):
//   1. Domain records — one F# record per aggregate / part / value-object
//      wire shape (`agg.wireShape`, the canonical ordered field list).
//   2. Thoth.Json decoders — one `Decode.object` per record, field-by-field
//      off the same wire shape, so decode order == wire order.
//   3. Reads — the `<param>.<agg>.all` query sites a page's `view` issues,
//      projected to the MVU quadruple (Model field + init `Cmd` + `Loaded`
//      `Msg` + `update` arm).  The api module fetches over `Fable.SimpleHttp`
//      + decodes with (2), returning `Result<'T, string>`.
//
// F# record fields keep the EXACT wire-shape names (lowercase as written), so
// a page-body member access (`p.name`, rendered verbatim by the shared walker)
// lands on the record field with no casing seam, and Thoth's `Decode.field
// "name"` maps the JSON key straight onto it.

import { createInputFields, forApiRead } from "../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  FieldIR,
  OperationIR,
  PageIR,
  TypeIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { API_BASE_PATH } from "../../util/api-base.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import { tryDetectApiHook } from "../_walker/api-hook-detector.js";
import { typeToFs } from "./type-fs.js";

/** A read the page view issues, projected to everything the MVU wiring + api
 *  module need.  Two shapes:
 *   - LIST (`<param>.<agg>.all`) — a `Remote<'T list>` fired at `init`.
 *   - SINGLE / byId (`<param>.<agg>.byId(id)` on a `:id`-param route) — a
 *     `Remote<'T option>` fired on PAGE ENTRY (init + every `UrlChanged`) via
 *     `pageCmd`, keyed off the route `id`. */
export interface FelizRead {
  /** Pascal Model field holding the remote data (`AllOrders` / `OrderById`). */
  field: string;
  /** `Msg` case carrying the decoded `Result` (`AllOrdersLoaded`). */
  msgCase: string;
  /** F# api function name (`allOrders` / `orderById`). */
  apiFn: string;
  /** The aggregate read (`Order`). */
  aggregate: string;
  /** F# type of the loaded value (`Order list` / `Order option`). */
  resultType: string;
  /** Thoth decoder expression for the loaded value
   *  (`(Decode.list Decoders.order)` / `(Decode.option Decoders.order)`). */
  decoderExpr: string;
  /** Collection base fetch route (`/api/orders`).  A byId read appends `/%s`. */
  route: string;
  /** The match-arm binding the `data:` lambda param resolves to
   *  (`allOrders` / `orderById` — camelCase of `field`). */
  binding: string;
  /** True for a byId (single-record) read — fired on page entry, not init. */
  single: boolean;
  /** For a byId read, the `Page` union case hosting it (`ProductDetail`) — the
   *  arm `pageCmd` fires the fetch from.  Undefined for list reads. */
  pageCase?: string;
}

/** The Model field name for an aggregate list read (`Order` → `AllOrders`). */
export function readFieldName(aggregate: string): string {
  return `All${plural(upperFirst(aggregate))}`;
}

/** The Model field name for an aggregate byId read (`Order` → `OrderById`). */
export function byIdFieldName(aggregate: string): string {
  return `${upperFirst(aggregate)}ById`;
}

/** Build the `FelizRead` for a `.all` read of `aggregate`. */
export function felizAllRead(aggregate: string): FelizRead {
  const field = readFieldName(aggregate);
  return {
    field,
    msgCase: `${field}Loaded`,
    apiFn: lowerFirst(field),
    aggregate,
    resultType: `${upperFirst(aggregate)} list`,
    decoderExpr: `(Decode.list Decoders.${lowerFirst(aggregate)})`,
    route: `${API_BASE_PATH}/${snake(plural(aggregate))}`,
    binding: lowerFirst(field),
    single: false,
  };
}

/** Build the `FelizRead` for a `byId(id)` read of `aggregate`, hosted by the
 *  `Page` case `pageCase`.  The loaded value is `'T option` (`None` when the
 *  record isn't found) and the fetch fires on page entry keyed off the id. */
export function felizByIdRead(aggregate: string, pageCase: string): FelizRead {
  const field = byIdFieldName(aggregate);
  return {
    field,
    msgCase: `${field}Loaded`,
    apiFn: lowerFirst(field),
    aggregate,
    resultType: `${upperFirst(aggregate)} option`,
    decoderExpr: `(Decode.option Decoders.${lowerFirst(aggregate)})`,
    route: `${API_BASE_PATH}/${snake(plural(aggregate))}`,
    binding: lowerFirst(field),
    single: true,
    pageCase,
  };
}

/** A write a page issues, projected to its MVU wiring.  v1 covers `delete` (a
 *  `DestroyForm(of: X)` on a detail page): a `Delete<Agg> id` dispatch fires a
 *  `DELETE /api/<agg>/<id>` `Cmd`; on success the app navigates to the
 *  aggregate's list route (create/update — which need form state + Thoth
 *  ENCODERS — are the next mutation slices). */
export interface FelizMutation {
  /** The aggregate written (`Product`). */
  aggregate: string;
  /** `Msg` the trigger dispatches, carrying the target id (`DeleteProduct`). */
  dispatchCase: string;
  /** `Msg` carrying the mutation's `Result<unit, string>` (`ProductDeleted`). */
  resultCase: string;
  /** F# api function name (`deleteProduct`). */
  apiFn: string;
  /** Collection base route (`/api/products`) — the api fn appends `/%s`. */
  route: string;
  /** `Router.navigate` segments to land on after success (`["products"]`). */
  navigateSegs: string[];
}

/** Build the delete `FelizMutation` for `aggregate`. */
export function felizDeleteMutation(aggregate: string): FelizMutation {
  return {
    aggregate,
    dispatchCase: `Delete${upperFirst(aggregate)}`,
    resultCase: `${upperFirst(aggregate)}Deleted`,
    apiFn: `delete${upperFirst(aggregate)}`,
    route: `${API_BASE_PATH}/${snake(plural(aggregate))}`,
    navigateSegs: snake(plural(aggregate)).split("/"),
  };
}

/** The HTML input widget a form field renders as — derived from its wire type so
 *  the browser enforces the shape at entry (`number` for numerics, a `checkbox`
 *  for bools, a `select` for enums, `text` otherwise).  The form record itself
 *  stays all-string (raw input is a string; the encoder lifts it back at submit). */
export type FelizInputKind = "text" | "number" | "checkbox" | "select";

/** One field of a create form — an F# form-record field (string-typed, bound to
 *  an `Html.input`), its `Set<Form><Field>` update `Msg`, the Thoth encoder
 *  expression that lifts the string back to its wire type at submit, and the
 *  input widget kind the type maps to. */
export interface FelizFormField {
  /** Exact wire field name — the F# form-record field, input binding, and JSON
   *  key (`name` / `price`). */
  wireName: string;
  /** `Msg` an input's `onChange` dispatches (`SetProductFormName`). */
  setMsg: string;
  /** Thoth encoder for the field, lifting `form.<wireName>` to its wire type
   *  (`Encode.string form.name` / `Encode.decimal (decimal form.price)`).  An
   *  optional field's empty string encodes to `Encode.nil` (JSON `null`). */
  encodeExpr: string;
  /** HTML input widget (`number` / `checkbox` / `select` / `text`) from the type. */
  inputKind: FelizInputKind;
  /** Whether the client MUST supply this field — a required, non-optional input.
   *  Required text/number fields guard the submit (non-empty); optional fields
   *  (and checkboxes) don't. */
  required: boolean;
  /** For a `select` field, the enum's allowed values (rendered as `<option>`s). */
  enumValues?: string[];
  /** The empty-form initial value for this field — `""` for most, but a REQUIRED
   *  enum defaults to its first value (a `<select>` always has a selection, and
   *  it keeps the required-enum form valid from the start, mirroring React). */
  emptyValue: string;
}

/** The record-shaped aspects a form (create OR operation) shares — the F#
 *  form-record type + its `empty<Form>` value + Thoth encoder + fields.  The
 *  type/encoder/Model-field/init renderers consume this; only the Msg/update/Api
 *  wiring differs between create and operation forms. */
export interface FormRecord {
  /** F# form-record type name (`ProductForm` / `RenameProductForm`). */
  formType: string;
  /** Model field holding the in-progress form (same as `formType`). */
  formField: string;
  /** The empty-form value binding (`emptyProductForm`). */
  emptyBinding: string;
  /** Thoth encoder fn name (`Encoders.<encoderFn>`). */
  encoderFn: string;
  /** Client-side validity predicate fn name (`Validation.<validFn>`), true when
   *  every required field is non-empty — the submit guard. */
  validFn: string;
  /** The form's fields. */
  fields: FelizFormField[];
}

/** A create form a page hosts (`CreateForm(of: X)`), projected to its full MVU
 *  wiring: a string-typed `<Agg>Form` record in the Model, one `Set` `Msg` per
 *  field, a `Submit<Agg>Form` trigger that POSTs the Thoth-encoded body, and a
 *  `<Agg>Created` result that navigates to the list on success.  v1 renders the
 *  REQUIRED scalar create-input fields (`createInputFields` minus optionals and
 *  non-scalars — nested/collection inputs are a follow-up). */
export interface FelizForm extends FormRecord {
  /** The aggregate created (`Product`). */
  aggregate: string;
  /** F# api fn name (`createProduct`). */
  apiFn: string;
  /** `Msg` the submit button dispatches (`SubmitProductForm`). */
  submitMsg: string;
  /** `Msg` carrying the created record `Result` (`ProductCreated`). */
  resultMsg: string;
  /** Collection POST route (`/api/products`). */
  route: string;
  /** `Router.navigate` segments after a successful create (`["products"]`). */
  navigateSegs: string[];
  /** Thoth decoder for the created record (`Decoders.product`). */
  decoderExpr: string;
  /** The created record's F# type (`Product`). */
  resultType: string;
}

/** An operation form a page hosts (`OperationForm(of: X, op: Y)`), projected to
 *  its MVU wiring: a string-typed `<Op><Agg>Form` record, one `Set` `Msg` per
 *  op param, a `Submit<Op><Agg>Form of string` trigger (carrying the route id)
 *  that POSTs to `/api/<agg>/<id>/<op>`, and a `<Op><Agg>Done` result (204, no
 *  body → `unit`) that navigates to the list.  v1 renders the scalar op params;
 *  the form lives on a detail page (route `id`). */
export interface FelizOperationForm extends FormRecord {
  /** The aggregate operated on (`Product`). */
  aggregate: string;
  /** The operation name (`rename`). */
  op: string;
  /** F# api fn name (`renameProduct`) — CURRIED `(id) (form)`. */
  apiFn: string;
  /** `Msg` the submit button dispatches, carrying the route id
   *  (`SubmitRenameProductForm`). */
  submitMsg: string;
  /** `Msg` carrying the op's `Result<unit, string>` (`RenameProductDone`). */
  doneMsg: string;
  /** Collection base route (`/api/products`) — the api fn appends `/<id>/<op>`. */
  route: string;
  /** The op's URL path segment (`rename` — `snake(routeSlug ?? name)`). */
  opPath: string;
  /** `Router.navigate` segments after success (`["products"]`). */
  navigateSegs: string[];
}

/** The scalar base of a type, peeling `optional` — an optional field renders
 *  the same widget + encodes as the same wire type as its required twin (the
 *  optionality only changes the empty→null encoding + validation exemption). */
function scalarBase(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

/** The HTML input widget a field type maps to — numerics render `type: number`,
 *  bools a `checkbox`, an enum (whose values we can resolve) a `select`,
 *  everything else a plain text input.  Purely derived from the wire type (no
 *  stamped field); the form record stays all-string. */
function inputKindFor(t: TypeIR, enumsByName: ReadonlyMap<string, string[]>): FelizInputKind {
  const base = scalarBase(t);
  if (base.kind === "enum" && enumsByName.has(base.name)) return "select";
  if (base.kind === "primitive") {
    switch (base.name) {
      case "int":
      case "long":
      case "decimal":
      case "money":
        return "number";
      case "bool":
        return "checkbox";
      default:
        return "text";
    }
  }
  return "text"; // id / unresolved enum (string name) / everything else
}

/** Build the shared form fields (`Set` Msg + encoder + input kind + required-
 *  ness + enum options) for a form of `formType` from a `{name, type, optional?}`
 *  field/param list.  Reused by create + operation + workflow forms.  A field is
 *  optional when flagged so (a create `FieldIR.optional`) OR its type is
 *  `optional` (an `x?: T` op/workflow param).  `enumsByName` resolves an enum
 *  field's allowed values (→ a `<select>`); empty for the callers that don't
 *  thread it (the field just renders as text, byte-identical to before). */
function formFieldsFrom(
  formType: string,
  fields: readonly { name: string; type: TypeIR; optional?: boolean }[],
  enumsByName: ReadonlyMap<string, string[]> = new Map(),
): FelizFormField[] {
  return fields.map((f) => {
    const optional = f.optional === true || f.type.kind === "optional";
    const base = scalarBase(f.type);
    const inputKind = inputKindFor(f.type, enumsByName);
    const enumValues =
      inputKind === "select" && base.kind === "enum" ? enumsByName.get(base.name) : undefined;
    // A REQUIRED enum defaults to its first value so the select and the string
    // state agree from the start (and the required guard passes); everything
    // else — text/number/checkbox, and an OPTIONAL enum (empty = null) — is "".
    const emptyValue =
      inputKind === "select" && !optional && enumValues && enumValues.length > 0
        ? enumValues[0]!
        : "";
    return {
      wireName: f.name,
      setMsg: `Set${formType}${upperFirst(f.name)}`,
      encodeExpr: encodeExprFor(f.type, `form.${f.name}`, optional),
      inputKind,
      required: !optional,
      enumValues,
      emptyValue,
    };
  });
}

/** Thoth encoder expression that lifts a string-typed form field `access`
 *  (`form.price`) back to its wire type.  An `optional` field's empty string
 *  encodes to `Encode.nil` (JSON `null`) — the client omitted it — while a
 *  filled value encodes as its base type; a bool is never wrapped (unchecked is
 *  a legitimate `false`, never absent). */
function encodeExprFor(t: TypeIR, access: string, optional = false): string {
  const base = scalarBase(t);
  const encodeBase = (): string => {
    if (base.kind === "primitive") {
      switch (base.name) {
        case "int":
        case "long":
          return `Encode.int (int ${access})`;
        case "decimal":
        case "money":
          return `Encode.decimal (decimal ${access})`;
        case "bool":
          return `Encode.bool (${access} = "true")`;
        default:
          return `Encode.string ${access}`; // string, json, datetime (ISO)
      }
    }
    // id / enum (string name) / everything else → the string verbatim.
    return `Encode.string ${access}`;
  };
  const encoded = encodeBase();
  // A bool always has a value; only text/number optionals fold empty → null.
  if (optional && !(base.kind === "primitive" && base.name === "bool")) {
    return `(if ${access} = "" then Encode.nil else ${encoded})`;
  }
  return encoded;
}

/** Whether a create-input field is a SCALAR the string form can render (peeling
 *  `optional`) — a nested part / value object / collection needs a sub-form
 *  (follow-up). */
function isScalarInput(t: TypeIR): boolean {
  const base = scalarBase(t);
  return base.kind === "primitive" || base.kind === "id" || base.kind === "enum";
}

/** Build the `FelizForm` for a `CreateForm(of: agg)` from the aggregate's
 *  create-input contract.  v1 keeps the REQUIRED scalar fields (mirroring the
 *  React create form's `!optional` filter); non-scalar / optional inputs are a
 *  follow-up. */
export function felizCreateForm(
  agg: AggregateIR,
  enumsByName: ReadonlyMap<string, string[]> = new Map(),
): FelizForm {
  const name = agg.name;
  const formType = `${upperFirst(name)}Form`;
  const fields = formFieldsFrom(
    formType,
    // All SCALAR create inputs — required AND optional (an optional field is
    // rendered, exempt from the submit guard, and encodes empty → null).  Nested
    // part / value object / collection inputs still need a sub-form (follow-up).
    createInputFields(agg).filter((f: FieldIR) => isScalarInput(f.type)),
    enumsByName,
  );
  return {
    aggregate: name,
    formType,
    formField: formType,
    emptyBinding: `empty${formType}`,
    encoderFn: lowerFirst(formType),
    validFn: `${lowerFirst(formType)}Valid`,
    apiFn: `create${upperFirst(name)}`,
    submitMsg: `Submit${formType}`,
    resultMsg: `${upperFirst(name)}Created`,
    route: `${API_BASE_PATH}/${snake(plural(name))}`,
    navigateSegs: snake(plural(name)).split("/"),
    decoderExpr: `Decoders.${lowerFirst(name)}`,
    resultType: upperFirst(name),
    fields,
  };
}

/** Build the `FelizOperationForm` for an `OperationForm(of: agg, op: op)`.  The
 *  form fields are the op's scalar params; the endpoint is
 *  `/api/<agg>/<id>/<opPath>` (the op's route slug).  Returns undefined when the
 *  op has no renderable scalar params (nothing to submit). */
export function felizOperationForm(
  agg: AggregateIR,
  op: OperationIR,
  enumsByName: ReadonlyMap<string, string[]> = new Map(),
): FelizOperationForm {
  const name = agg.name;
  const opCap = `${upperFirst(op.name)}${upperFirst(name)}`;
  const formType = `${opCap}Form`;
  const fields = formFieldsFrom(
    formType,
    op.params.filter((p) => isScalarInput(p.type)),
    enumsByName,
  );
  return {
    aggregate: name,
    op: op.name,
    formType,
    formField: formType,
    emptyBinding: `empty${formType}`,
    encoderFn: lowerFirst(formType),
    validFn: `${lowerFirst(formType)}Valid`,
    apiFn: `${op.name}${upperFirst(name)}`,
    submitMsg: `Submit${formType}`,
    doneMsg: `${opCap}Done`,
    route: `${API_BASE_PATH}/${snake(plural(name))}`,
    opPath: snake(op.routeSlug ?? op.name),
    navigateSegs: snake(plural(name)).split("/"),
    fields,
  };
}

/** A workflow form a page hosts (`WorkflowForm(runs: Y)`), projected to its MVU
 *  wiring: a string-typed `<Wf>Form` record, one `Set` `Msg` per workflow param,
 *  a paramless `Submit<Wf>Form` trigger that POSTs to `/api/workflows/<wf>`, and
 *  a `<Wf>Done` result (204, no body → `unit`) that resets + navigates home.
 *  The create form's POST (no id) with the operation form's 204 result. */
export interface FelizWorkflowForm extends FormRecord {
  /** The workflow run (`openAccount`). */
  workflow: string;
  /** F# api fn name (`runOpenAccount`). */
  apiFn: string;
  /** `Msg` the submit button dispatches (`SubmitOpenAccountForm`). */
  submitMsg: string;
  /** `Msg` carrying the workflow's `Result<unit, string>` (`OpenAccountDone`). */
  doneMsg: string;
  /** Full POST route (`/api/workflows/open_account`). */
  route: string;
  /** `Router.navigate` segments after success (`[""]` → home). */
  navigateSegs: string[];
}

/** Build the `FelizWorkflowForm` for a `WorkflowForm(runs: wf)`.  Fields are the
 *  workflow's scalar params; the endpoint is `/api/workflows/<snake wf>`. */
export function felizWorkflowForm(
  wf: WorkflowIR,
  enumsByName: ReadonlyMap<string, string[]> = new Map(),
): FelizWorkflowForm {
  const wfCap = upperFirst(wf.name);
  const formType = `${wfCap}Form`;
  const fields = formFieldsFrom(
    formType,
    wf.params.filter((p) => isScalarInput(p.type)),
    enumsByName,
  );
  return {
    workflow: wf.name,
    formType,
    formField: formType,
    emptyBinding: `empty${formType}`,
    encoderFn: lowerFirst(formType),
    validFn: `${lowerFirst(formType)}Valid`,
    apiFn: `run${wfCap}`,
    submitMsg: `Submit${formType}`,
    doneMsg: `${wfCap}Done`,
    route: `${API_BASE_PATH}/workflows/${snake(wf.name)}`,
    navigateSegs: [""], // home
    fields,
  };
}

// ---------------------------------------------------------------------------
// Read collection — scan a page body for the `.all` query sites its view issues
// ---------------------------------------------------------------------------

/** Direct child expressions of `e` (expression positions only — lambda-block
 *  statements are action bodies, never a `QueryView` host, so they're skipped). */
function exprChildren(e: ExprIR): ExprIR[] {
  switch (e.kind) {
    case "member":
      return [e.receiver];
    case "method-call":
      return [e.receiver, ...e.args];
    case "call":
      return e.args;
    case "lambda":
      return e.body ? [e.body] : [];
    case "object":
    case "new":
      return e.fields.map((f) => f.value);
    case "list":
      return e.elements;
    case "paren":
      return [e.inner];
    case "unary":
      return [e.operand];
    case "binary":
      return [e.left, e.right];
    case "ternary":
      return [e.cond, e.then, e.otherwise];
    case "convert":
      return [e.value];
    default:
      return [];
  }
}

/** Every `QueryView(of: <expr>)` `of:` argument in a page body, in tree order. */
function queryViewOfArgs(body: ExprIR): ExprIR[] {
  const out: ExprIR[] = [];
  const walk = (e: ExprIR): void => {
    if (e.kind === "call" && e.name === "QueryView") {
      const names = e.argNames ?? [];
      const idx = names.indexOf("of");
      if (idx >= 0 && e.args[idx]) out.push(e.args[idx]);
    }
    for (const c of exprChildren(e)) walk(c);
  };
  walk(body);
  return out;
}

/** Collect the `.all` reads a page issues — deduped by Model field.  Detection
 *  reuses the shared `tryDetectApiHook`, so the reads collected here name the
 *  same aggregates the view walk resolves through the `buildHookUse` seam. */
export function collectPageReads(
  page: PageIR,
  apiParamNames: ReadonlySet<string>,
  aggregatesByName: ReadonlySet<string>,
): FelizRead[] {
  if (!page.body) return [];
  const detCtx = { apiParamNames, aggregatesByName };
  const pageCase = upperFirst(page.name);
  const out: FelizRead[] = [];
  const seen = new Set<string>();
  for (const ofArg of queryViewOfArgs(page.body)) {
    const detected = tryDetectApiHook(ofArg, detCtx);
    if (detected?.kind !== "aggregate") continue;
    // List (`.all`) or single (`byId`) reads.  A byId read is keyed to the
    // hosting page's `Page` case so `pageCmd` can fire it on entry.
    let read: FelizRead | undefined;
    if (detected.operation === "all") read = felizAllRead(detected.aggregateName);
    else if (detected.operation === "byId") read = felizByIdRead(detected.aggregateName, pageCase);
    if (!read || seen.has(read.field)) continue;
    seen.add(read.field);
    out.push(read);
  }
  return out;
}

/** Every `<PrimitiveName>(of: <Agg>)` aggregate a page body hosts, in tree order
 *  (the `of:` arg is a bare aggregate ref).  Shared by the form primitives —
 *  `DestroyForm` (delete) and `CreateForm` (create). */
function formOfAggs(
  body: ExprIR,
  primitive: string,
  aggregatesByName: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const walk = (e: ExprIR): void => {
    if (e.kind === "call" && e.name === primitive) {
      const names = e.argNames ?? [];
      const idx = names.indexOf("of");
      const ofArg = idx >= 0 ? e.args[idx] : undefined;
      if (ofArg?.kind === "ref" && aggregatesByName.has(ofArg.name)) out.push(ofArg.name);
    }
    for (const c of exprChildren(e)) walk(c);
  };
  walk(body);
  return out;
}

/** Collect the mutations a page issues — v1 detects `DestroyForm(of: X)` (a
 *  delete), deduped by aggregate.  Keyed only by aggregate (a page deletes an
 *  aggregate once); the wiring names derive from it, matching the
 *  `renderDestroyForm` seam's button dispatch. */
export function collectPageMutations(
  page: PageIR,
  aggregatesByName: ReadonlySet<string>,
): FelizMutation[] {
  if (!page.body) return [];
  const out: FelizMutation[] = [];
  const seen = new Set<string>();
  for (const agg of formOfAggs(page.body, "DestroyForm", aggregatesByName)) {
    if (seen.has(agg)) continue;
    seen.add(agg);
    out.push(felizDeleteMutation(agg));
  }
  return out;
}

/** Collect the create forms a page hosts (`CreateForm(of: X)`), deduped by
 *  aggregate.  Built from the enriched aggregate (needs its create-input
 *  contract), so the caller passes a name→aggregate map. */
export function collectPageForms(
  page: PageIR,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
  enumsByName: ReadonlyMap<string, string[]> = new Map(),
): FelizForm[] {
  if (!page.body) return [];
  const nameSet = new Set(aggregatesByName.keys());
  const out: FelizForm[] = [];
  const seen = new Set<string>();
  for (const aggName of formOfAggs(page.body, "CreateForm", nameSet)) {
    const agg = aggregatesByName.get(aggName);
    if (!agg || seen.has(aggName)) continue;
    seen.add(aggName);
    out.push(felizCreateForm(agg, enumsByName));
  }
  return out;
}

/** Every `OperationForm(of: <Agg>, op: <opName>)` spec a page body hosts, in
 *  tree order (both args are bare refs; `op` names a public operation). */
function operationFormSpecs(
  body: ExprIR,
  aggregatesByName: ReadonlySet<string>,
): { agg: string; op: string }[] {
  const out: { agg: string; op: string }[] = [];
  const walk = (e: ExprIR): void => {
    if (e.kind === "call" && e.name === "OperationForm") {
      const names = e.argNames ?? [];
      const ofArg = names.indexOf("of") >= 0 ? e.args[names.indexOf("of")] : undefined;
      const opArg = names.indexOf("op") >= 0 ? e.args[names.indexOf("op")] : undefined;
      if (ofArg?.kind === "ref" && opArg?.kind === "ref" && aggregatesByName.has(ofArg.name)) {
        out.push({ agg: ofArg.name, op: opArg.name });
      }
    }
    for (const c of exprChildren(e)) walk(c);
  };
  walk(body);
  return out;
}

/** Collect the operation forms a page hosts (`OperationForm(of: X, op: Y)`),
 *  deduped by (aggregate, op).  Skips ops that are missing / non-public / have
 *  no renderable scalar params (nothing to submit). */
export function collectPageOperationForms(
  page: PageIR,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
  enumsByName: ReadonlyMap<string, string[]> = new Map(),
): FelizOperationForm[] {
  if (!page.body) return [];
  const nameSet = new Set(aggregatesByName.keys());
  const out: FelizOperationForm[] = [];
  const seen = new Set<string>();
  for (const { agg: aggName, op: opName } of operationFormSpecs(page.body, nameSet)) {
    const agg = aggregatesByName.get(aggName);
    if (!agg) continue;
    const op = agg.operations.find((o) => o.name === opName && o.visibility === "public");
    if (!op) continue;
    const form = felizOperationForm(agg, op, enumsByName);
    const key = form.formType;
    if (form.fields.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(form);
  }
  return out;
}

/** Every `WorkflowForm(runs: <wf>)` workflow name a page body hosts, in tree
 *  order (the `runs:` arg is a bare ref to a workflow). */
function workflowFormRuns(body: ExprIR, workflowNames: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (e: ExprIR): void => {
    if (e.kind === "call" && e.name === "WorkflowForm") {
      const names = e.argNames ?? [];
      const idx = names.indexOf("runs");
      const runsArg = idx >= 0 ? e.args[idx] : undefined;
      if (runsArg?.kind === "ref" && workflowNames.has(runsArg.name)) out.push(runsArg.name);
    }
    for (const c of exprChildren(e)) walk(c);
  };
  walk(body);
  return out;
}

/** Collect the workflow forms a page hosts (`WorkflowForm(runs: X)`), deduped by
 *  workflow.  Skips workflows with no renderable scalar params. */
export function collectPageWorkflowForms(
  page: PageIR,
  workflowsByName: ReadonlyMap<string, WorkflowIR>,
  enumsByName: ReadonlyMap<string, string[]> = new Map(),
): FelizWorkflowForm[] {
  if (!page.body) return [];
  const nameSet = new Set(workflowsByName.keys());
  const out: FelizWorkflowForm[] = [];
  const seen = new Set<string>();
  for (const wfName of workflowFormRuns(page.body, nameSet)) {
    const wf = workflowsByName.get(wfName);
    if (!wf) continue;
    const form = felizWorkflowForm(wf, enumsByName);
    if (form.fields.length === 0 || seen.has(form.formType)) continue;
    seen.add(form.formType);
    out.push(form);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Domain records + Thoth decoders (off wireShape)
// ---------------------------------------------------------------------------

/** F# type spelling of a wire field's declared type, honouring the wire
 *  contract: an enum value arrives as its string name, so it decodes to a
 *  plain `string` (a proper DU decoder is a follow-up). */
function wireFieldType(t: TypeIR): string {
  switch (t.kind) {
    case "enum":
      return "string";
    case "array":
      return `${wireFieldType(t.element)} list`;
    case "optional":
      return `${wireFieldType(t.inner)} option`;
    default:
      return typeToFs(t);
  }
}

/** Thoth decoder expression for a wire field's declared type. */
function decoderExprFor(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "Decode.int";
        case "decimal":
        case "money":
          return "Decode.decimal";
        case "bool":
          return "Decode.bool";
        case "datetime":
          return "Decode.datetimeUtc";
        default:
          return "Decode.string"; // string, json
      }
    case "id":
      return "Decode.string";
    case "enum":
      return "Decode.string"; // wire carries the enum's string name
    case "valueobject":
    case "entity":
      return `Decoders.${lowerFirst(t.name)}`;
    case "array":
      return `(Decode.list ${decoderExprFor(t.element)})`;
    case "optional":
      return decoderExprFor(t.inner); // handled at the field via get.Optional
    default:
      return "Decode.string";
  }
}

/** A record + decoder the emitted wire layer needs — an aggregate, one of its
 *  entity parts, or a value object, keyed by its F# type name. */
interface WireRecord {
  typeName: string;
  decoderName: string;
  fields: { name: string; type: TypeIR; optional: boolean }[];
}

/** The F# type name a wire field references (an entity part / value object),
 *  peeling arrays + optionals; undefined for scalar/enum leaves. */
function namedRecord(t: TypeIR): string | undefined {
  if (t.kind === "valueobject" || t.kind === "entity") return t.name;
  if (t.kind === "array") return namedRecord(t.element);
  if (t.kind === "optional") return namedRecord(t.inner);
  return undefined;
}

/** Collect every record the read aggregates transitively need — the
 *  aggregate itself plus any entity part / value object referenced through a
 *  wire field (containments, VO-typed properties). */
function collectRecords(
  aggregates: EnrichedAggregateIR[],
  contexts: EnrichedBoundedContextIR[],
): WireRecord[] {
  const out: WireRecord[] = [];
  const seen = new Set<string>();

  const partByName = new Map<string, EnrichedAggregateIR["parts"][number]>();
  const voWireByName = new Map<string, { name: TypeIR; fields: WireRecord["fields"] }>();
  for (const c of contexts) {
    for (const a of c.aggregates) for (const p of a.parts) partByName.set(p.name, p);
    for (const vo of c.valueObjects) {
      voWireByName.set(vo.name, {
        name: { kind: "valueobject", name: vo.name },
        fields: (vo.wireShape ?? []).map((w) => ({
          name: w.name,
          type: w.type,
          optional: w.optional,
        })),
      });
    }
  }

  const emit = (typeName: string, wire: WireRecord["fields"]): void => {
    if (seen.has(typeName)) return;
    seen.add(typeName);
    out.push({ typeName: upperFirst(typeName), decoderName: lowerFirst(typeName), fields: wire });
    for (const f of wire) {
      const n = namedRecord(f.type);
      if (!n || seen.has(n)) continue;
      const part = partByName.get(n);
      if (part) {
        emit(
          n,
          forApiRead(part.wireShape ?? []).map((w) => ({
            name: w.name,
            type: w.type,
            optional: w.optional,
          })),
        );
        continue;
      }
      const vo = voWireByName.get(n);
      if (vo) emit(n, vo.fields);
    }
  };

  for (const agg of aggregates) {
    emit(
      agg.name,
      forApiRead(agg.wireShape).map((w) => ({ name: w.name, type: w.type, optional: w.optional })),
    );
  }
  return out;
}

/** Emit the `Domain` record types + `Decoders` module for the given read
 *  aggregates.  Returns the two F# blocks (records first, then decoders —
 *  F# is order-sensitive, and a decoder references its record). */
export function renderWireTypes(
  reads: FelizRead[],
  contexts: EnrichedBoundedContextIR[],
): { domain: string; decoders: string } {
  const byName = new Map<string, EnrichedAggregateIR>();
  for (const c of contexts) for (const a of c.aggregates) byName.set(a.name, a);
  const readAggs = [...new Set(reads.map((r) => r.aggregate))]
    .map((n) => byName.get(n))
    .filter((a): a is EnrichedAggregateIR => !!a);

  const records = collectRecords(readAggs, contexts);
  if (records.length === 0) return { domain: "", decoders: "" };

  // A field is optional from EITHER signal — the wire-shape `optional` flag or
  // an `optional`-kind type — and its option lives in ONE place.  Peel the type
  // to its base so the record spells exactly one ` option` and the decoder pairs
  // `get.Optional.Field` with the base decoder (`get.Optional` already yields
  // `'T option`), instead of double-wrapping `string option option`.
  const fieldOptional = (f: WireRecord["fields"][number]): boolean =>
    f.optional || f.type.kind === "optional";
  const fieldBase = (f: WireRecord["fields"][number]): TypeIR =>
    f.type.kind === "optional" ? f.type.inner : f.type;

  const domain = lines(
    "// Domain records — one per aggregate / part / value-object wire shape.",
    ...records.flatMap((rec) => [
      `type ${rec.typeName} =`,
      "  {",
      ...rec.fields.map((f) => {
        const base = wireFieldType(fieldBase(f));
        return `    ${f.name}: ${fieldOptional(f) ? `${base} option` : base}`;
      }),
      "  }",
    ]),
  );

  const decoders = lines(
    "// Thoth.Json decoders — decode order mirrors the wire shape.",
    "module Decoders =",
    ...records.flatMap((rec, i) => [
      i > 0 ? "" : undefined,
      `  let ${rec.decoderName} : Decoder<${rec.typeName}> =`,
      "    Decode.object (fun get ->",
      "      {",
      ...rec.fields.map((f) => {
        const dec = decoderExprFor(fieldBase(f));
        return `        ${f.name} = ${
          fieldOptional(f)
            ? `get.Optional.Field "${f.name}" ${dec}`
            : `get.Required.Field "${f.name}" ${dec}`
        }`;
      }),
      "      })",
    ]),
  );

  return { domain, decoders };
}

/** One async read function.  A list read is paramless (`GET /api/orders`); a
 *  byId read takes `(id: string)`, fetches `GET /api/orders/<id>`, and folds a
 *  `404` to `Ok None` (the record is legitimately absent, not an error). */
function renderApiFn(r: FelizRead): (string | undefined)[] {
  if (r.single) {
    return [
      `  let ${r.apiFn} (id: string) : Async<Result<${r.resultType}, string>> =`,
      "    async {",
      `      let! (status, body) = Http.get (sprintf "${r.route}/%s" id)`,
      "      if status = 200 then",
      `        match Decode.fromString ${r.decoderExpr} body with`,
      "        | Ok data -> return Ok data",
      "        | Error e -> return Error e",
      "      elif status = 404 then",
      "        return Ok None",
      "      else",
      '        return Error (sprintf "HTTP %d" status)',
      "    }",
    ];
  }
  return [
    `  let ${r.apiFn} () : Async<Result<${r.resultType}, string>> =`,
    "    async {",
    `      let! (status, body) = Http.get "${r.route}"`,
    "      if status = 200 then",
    `        match Decode.fromString ${r.decoderExpr} body with`,
    "        | Ok data -> return Ok data",
    "        | Error e -> return Error e",
    "      else",
    '        return Error (sprintf "HTTP %d" status)',
    "    }",
  ];
}

/** One async mutation function.  v1: `delete` — a `DELETE /api/<agg>/<id>`
 *  returning `Result<unit, string>` (2xx → `Ok ()`).  Uses `Http.request` (not
 *  `Http.get`) so the verb can be set. */
function renderMutationFn(m: FelizMutation): (string | undefined)[] {
  return [
    `  let ${m.apiFn} (id: string) : Async<Result<unit, string>> =`,
    "    async {",
    "      let! response =",
    `        Http.request (sprintf "${m.route}/%s" id)`,
    "        |> Http.method DELETE",
    "        |> Http.send",
    "      if response.statusCode = 200 || response.statusCode = 204 then",
    "        return Ok ()",
    "      else",
    '        return Error (sprintf "HTTP %d" response.statusCode)',
    "    }",
  ];
}

/** One async create function — `POST /api/<agg>` with the Thoth-encoded form
 *  body; a 2xx decodes the created record, anything else is an error. */
function renderCreateFn(f: FelizForm): (string | undefined)[] {
  return [
    `  let ${f.apiFn} (form: ${f.formType}) : Async<Result<${f.resultType}, string>> =`,
    "    async {",
    `      let body = Encode.toString 0 (Encoders.${f.encoderFn} form)`,
    "      let! response =",
    `        Http.request "${f.route}"`,
    "        |> Http.method POST",
    "        |> Http.content (BodyContent.Text body)",
    '        |> Http.header (Headers.contentType "application/json")',
    "        |> Http.send",
    "      if response.statusCode = 200 || response.statusCode = 201 then",
    `        match Decode.fromString ${f.decoderExpr} response.responseText with`,
    "        | Ok created -> return Ok created",
    "        | Error e -> return Error e",
    "      else",
    '        return Error (sprintf "HTTP %d" response.statusCode)',
    "    }",
  ];
}

/** One async operation function — CURRIED `(id) (form)`, POSTs the encoded body
 *  to `/api/<agg>/<id>/<opPath>`; a 2xx is `Ok ()` (the op returns 204, no body). */
function renderOperationFn(f: FelizOperationForm): (string | undefined)[] {
  return [
    `  let ${f.apiFn} (id: string) (form: ${f.formType}) : Async<Result<unit, string>> =`,
    "    async {",
    `      let body = Encode.toString 0 (Encoders.${f.encoderFn} form)`,
    "      let! response =",
    `        Http.request (sprintf "${f.route}/%s/${f.opPath}" id)`,
    "        |> Http.method POST",
    "        |> Http.content (BodyContent.Text body)",
    '        |> Http.header (Headers.contentType "application/json")',
    "        |> Http.send",
    "      if response.statusCode = 200 || response.statusCode = 204 then",
    "        return Ok ()",
    "      else",
    '        return Error (sprintf "HTTP %d" response.statusCode)',
    "    }",
  ];
}

/** One async workflow function — a PARAMLESS `POST /api/workflows/<wf>` with the
 *  Thoth-encoded form body; a 2xx is `Ok ()` (the workflow returns 204). */
function renderWorkflowFn(f: FelizWorkflowForm): (string | undefined)[] {
  return [
    `  let ${f.apiFn} (form: ${f.formType}) : Async<Result<unit, string>> =`,
    "    async {",
    `      let body = Encode.toString 0 (Encoders.${f.encoderFn} form)`,
    "      let! response =",
    `        Http.request "${f.route}"`,
    "        |> Http.method POST",
    "        |> Http.content (BodyContent.Text body)",
    '        |> Http.header (Headers.contentType "application/json")',
    "        |> Http.send",
    "      if response.statusCode = 200 || response.statusCode = 204 then",
    "        return Ok ()",
    "      else",
    '        return Error (sprintf "HTTP %d" response.statusCode)',
    "    }",
  ];
}

/** Emit the `Api` module — one `Cmd`-issuing async function per read (fetch +
 *  Thoth decode → `Result`), per mutation (verb request → `Result`), per create
 *  form (encode + POST → decoded record), per operation form (encode + POST to
 *  `/<id>/<op>` → `unit`), and per workflow form (encode + POST to
 *  `/workflows/<wf>` → `unit`), all over `Fable.SimpleHttp`. */
export function renderApiModule(
  reads: FelizRead[],
  mutations: FelizMutation[] = [],
  forms: FelizForm[] = [],
  operationForms: FelizOperationForm[] = [],
  workflowForms: FelizWorkflowForm[] = [],
): string {
  if (
    reads.length === 0 &&
    mutations.length === 0 &&
    forms.length === 0 &&
    operationForms.length === 0 &&
    workflowForms.length === 0
  ) {
    return "";
  }
  const fns = [
    ...reads.map((r) => renderApiFn(r)),
    ...mutations.map((m) => renderMutationFn(m)),
    ...forms.map((f) => renderCreateFn(f)),
    ...operationForms.map((f) => renderOperationFn(f)),
    ...workflowForms.map((f) => renderWorkflowFn(f)),
  ];
  return lines(
    "// Api — Cmd-based reads + mutations (Fable.SimpleHttp + Thoth → Result).",
    "module Api =",
    ...fns.flatMap((fn, i) => [i > 0 ? "" : undefined, ...fn]),
  );
}

/** Emit the form record types + their `empty<Form>` values — every field is a
 *  `string` (bound to an `Html.input`, encoded at submit).  Shared by create +
 *  operation forms (both `FormRecord`). */
export function renderFormTypes(forms: FormRecord[]): string {
  if (forms.length === 0) return "";
  return lines(
    "// Form state — each field a string (bound to Html.input).",
    ...forms.flatMap((f, i) => [
      i > 0 ? "" : undefined,
      `type ${f.formType} =`,
      "  {",
      ...f.fields.map((fld) => `    ${fld.wireName}: string`),
      "  }",
      "",
      `let ${f.emptyBinding} : ${f.formType} =`,
      "  {",
      // Most fields start empty; a required enum starts at its first value (its
      // `<select>` always has a selection).
      ...f.fields.map((fld) => `    ${fld.wireName} = ${JSON.stringify(fld.emptyValue)}`),
      "  }",
    ]),
  );
}

/** Emit the `Encoders` module — one `Encode.object` per form, lifting its
 *  string fields back to their wire types (the write-direction sibling of the
 *  `Decoders`).  Shared by create + operation forms. */
export function renderEncoders(forms: FormRecord[]): string {
  if (forms.length === 0) return "";
  return lines(
    "// Thoth.Json encoders — the write direction of the decoders.",
    "module Encoders =",
    ...forms.flatMap((f, i) => [
      i > 0 ? "" : undefined,
      `  let ${f.encoderFn} (form: ${f.formType}) : JsonValue =`,
      "    Encode.object [",
      ...f.fields.map((fld) => `      "${fld.wireName}", ${fld.encodeExpr}`),
      "    ]",
    ]),
  );
}

/** Emit the `Validation` module — one `<form>Valid` predicate per form, true
 *  when every REQUIRED text/number field is non-empty.  Optional fields and
 *  checkbox (bool) fields are excluded: an optional field left empty encodes to
 *  `null` (a legitimate omission), and an unchecked box is a legitimate `false`,
 *  never "unfilled" — so a form of only optional/bool fields is always valid.
 *  The submit button's `prop.disabled` reads this, so an incomplete form can't
 *  POST (the zod-`.min(1)`-parity guard). */
export function renderValidation(forms: FormRecord[]): string {
  const withFields = forms.filter((f) => f.fields.length > 0);
  if (withFields.length === 0) return "";
  return lines(
    "// Client-side validation — required text/number fields must be non-empty.",
    "module Validation =",
    ...withFields.flatMap((f, i) => {
      const required = f.fields.filter((fld) => fld.required && fld.inputKind !== "checkbox");
      const body =
        required.length > 0
          ? required
              .map((fld) => `not (System.String.IsNullOrWhiteSpace form.${fld.wireName})`)
              .join(" && ")
          : "true"; // nothing required (all optional / bool) → always submittable
      return [
        i > 0 ? "" : undefined,
        `  let ${f.validFn} (form: ${f.formType}) : bool =`,
        `    ${body}`,
      ];
    }),
  );
}

/** The `View` helper module — the `Remote<'T>` → element matchers the QueryView
 *  pack renderer calls (a helper CALL is offside-safe inside a Feliz `[ … ]`
 *  list where a raw multi-line `match` is not).  `remoteList` is emitted when
 *  any list read exists, `remoteOne` when any byId read exists. */
export function renderViewModule(reads: FelizRead[]): string {
  const hasList = reads.some((r) => !r.single);
  const hasSingle = reads.some((r) => r.single);
  const list = [
    "  let remoteList (r: Remote<'T list>) (loading: ReactElement) (error: ReactElement) (empty: ReactElement) (render: 'T list -> ReactElement) : ReactElement =",
    "    match r with",
    "    | Loading -> loading",
    "    | LoadError _ -> error",
    "    | Loaded [] -> empty",
    "    | Loaded items -> render items",
  ];
  const one = [
    "  let remoteOne (r: Remote<'T option>) (loading: ReactElement) (error: ReactElement) (empty: ReactElement) (render: 'T -> ReactElement) : ReactElement =",
    "    match r with",
    "    | Loading -> loading",
    "    | LoadError _ -> error",
    "    | Loaded None -> empty",
    "    | Loaded (Some item) -> render item",
  ];
  return lines(
    "module View =",
    ...(hasList ? list : []),
    hasList && hasSingle ? "" : undefined,
    ...(hasSingle ? one : []),
  );
}
