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

import {
  createInputFields,
  forApiRead,
  wireFieldsForAggregate,
  wireFieldsForPart,
  wireFieldsForValueObject,
} from "../../ir/enrich/wire-projection.js";
import { variantTag } from "../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  FieldIR,
  OperationIR,
  PageIR,
  PayloadIR,
  StmtIR,
  TypeIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import {
  classifyFelizAsyncEffect,
  type FelizAsyncEffectShape,
} from "../../ir/util/feliz-async-effect.js";
import { type PageNameCtx, pageEmitName } from "../../ir/util/page-kind.js";
import { API_BASE_PATH } from "../../util/api-base.js";
import { lines } from "../../util/code-builder.js";
import { errorTypeUri } from "../../util/error-defaults.js";
import { humanize, lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
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
    // The auto-`findAll` is paged-by-default (M-T2.6): `GET /<aggs>` returns the
    // `{items, page, …}` wire envelope, so the list read decodes the `items`
    // field out of it (the Model still holds a plain `'T list` — page 1, no
    // pager/sort UI, matching the M-T1.1 Feliz "attempt / fail-fast" disposition).
    decoderExpr: `(Decode.field "items" (Decode.list Decoders.${lowerFirst(aggregate)}))`,
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
 *  for bools, a `select` for enums, an `idselect` for a foreign-key `X id`
 *  populated from the target's runtime list, `text` otherwise).  The form record
 *  itself stays all-string (raw input is a string; the encoder lifts it at submit). */
export type FelizInputKind = "text" | "number" | "checkbox" | "select" | "idselect";

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
  /** For an `idselect` field, the foreign-key target aggregate (`Customer`) —
   *  its `.all` list populates the `<select>` (via the `All<Targets>` Model
   *  field), and each option's value is a target `id`. */
  idTarget?: string;
  /** For an `idselect` field, the target record field labelling each option —
   *  its `display` derived field when it has one, else `id`. */
  idLabelField?: string;
  /** When this field is a FLATTENED value-object sub-field, the wire object key
   *  it nests under (`address` for a VO field `address: Address` expanded to flat
   *  `addressStreet`/`addressCity` form fields).  The encoder groups every field
   *  sharing an `objectKey` into `"<objectKey>", Encode.object [ … ]`. */
  objectKey?: string;
  /** The JSON key this field encodes to — its own `wireName` for a normal field,
   *  or the VO sub-field name (`street`) inside its `objectKey` group. */
  jsonKey: string;
  /** True for a scalar-array (`X[]`) field — rendered as a comma-separated text
   *  input, encoded to a JSON array (the encoder splits/trims/encodes each item). */
  isArray?: boolean;
  /** The empty-form initial value for this field — `""` for most, but a REQUIRED
   *  enum defaults to its first value (a `<select>` always has a selection, and
   *  it keeps the required-enum form valid from the start, mirroring React). */
  emptyValue: string;
}

/** One scalar sub-field of a dynamic-row group (`sku` / `qty` of a `LineItem`
 *  row) — the F# row-record field (bound to an input), its indexed `Set` `Msg`
 *  (`Set<Form><Array><Sub> of int * string`, carrying the row index + new value),
 *  and the Thoth encoder lifting `row.<wireName>` back to its wire type. */
export interface FelizRowField {
  /** Row-record field name / input binding (`sku`). */
  wireName: string;
  /** Indexed setter `Msg` (`SetOrderFormItemsSku`), dispatched `(index, value)`. */
  setMsg: string;
  /** HTML input widget from the sub-field type. */
  inputKind: FelizInputKind;
  /** Thoth encoder lifting `row.<wireName>` to its wire type. */
  encodeExpr: string;
  /** JSON key this sub-field encodes to (`sku`). */
  jsonKey: string;
  /** For a `select` sub-field, the enum's allowed values. */
  enumValues?: string[];
  /** Whether the sub-field is required (non-optional) — informational for v1
   *  (row validity does not gate submit yet). */
  required: boolean;
}

/** A dynamic-row form field — an `X[]` create/param input whose element is a
 *  value object (`items: LineItem[]`).  Unlike a flat `FelizFormField` (one
 *  string), it holds a `<Row> list` in the form record and drives a repeatable
 *  sub-form: an Add trigger, a per-row Remove, and one indexed setter per row
 *  sub-field.  The F# sibling of the React `useFieldArray` row group. */
export interface FelizFieldArray {
  /** Form-record field holding the list (`items`). */
  fieldName: string;
  /** JSON key the array encodes to (`items`). */
  jsonKey: string;
  /** F# row-record type name (`LineItemRow`). */
  rowType: string;
  /** The empty-row value binding (`emptyLineItemRow`). */
  emptyRowBinding: string;
  /** Humanized element label for the Add button (`Line Item`). */
  elementLabel: string;
  /** Humanized field label shown above the rows (`Items`). */
  label: string;
  /** `Msg` appending an empty row (`AddOrderFormItems`). */
  addMsg: string;
  /** `Msg` removing a row by index (`RemoveOrderFormItems of int`). */
  removeMsg: string;
  /** The row's scalar sub-fields. */
  rowFields: FelizRowField[];
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
  /** The form's flat (string) fields. */
  fields: FelizFormField[];
  /** Dynamic-row fields — one per `X[]`-of-value-object input.  Empty for a
   *  scalar-only form; each drives a repeatable sub-form (Add / Remove / indexed
   *  setters) alongside the flat `fields`. */
  fieldArrays: FelizFieldArray[];
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

/** A one-click operation action a page hosts — `Action { <instance>.<op> }` on a
 *  single-record (byId) detail page.  The instance-form sibling of
 *  `FelizOperationForm`: NO form fields (a parameterless op), a plain button that
 *  dispatches a trigger `Msg` carrying the route id → a `POST /<id>/<op>` (empty
 *  body) → a `Done` result.  On success it refetches the detail read so the UI
 *  reflects the mutation (the MVU analogue of React's query invalidation). */
export interface FelizAction {
  /** The aggregate operated on (`Product`). */
  aggregate: string;
  /** The operation name (`activate`). */
  op: string;
  /** F# api fn name (`activateProduct`) — takes `(id: string)`. */
  apiFn: string;
  /** `Msg` the button dispatches, carrying the route id (`ActivateProduct`). */
  triggerMsg: string;
  /** `Msg` carrying the op's `Result<unit, string>` (`ActivateProductDone`). */
  doneMsg: string;
  /** Collection base route (`/api/products`) — the api fn appends `/<id>/<op>`. */
  route: string;
  /** The op's URL path segment (`activate` — `snake(routeSlug ?? name)`). */
  opPath: string;
  /** Button label (`Activate` — `humanize(op)`). */
  label: string;
}

/** Build the `FelizAction` for an `Action { <instance>.<op> }` — the MVU wiring
 *  for a fieldless operation button (trigger/done `Msg`s + the id-qualified POST
 *  route), keyed off the aggregate + op.  Naming mirrors `felizOperationForm`
 *  (the with-fields sibling) so the two never collide. */
export function felizAction(aggregate: string, op: OperationIR): FelizAction {
  const opCap = `${upperFirst(op.name)}${upperFirst(aggregate)}`;
  return {
    aggregate,
    op: op.name,
    apiFn: `${op.name}${upperFirst(aggregate)}`,
    triggerMsg: opCap,
    doneMsg: `${opCap}Done`,
    route: `${API_BASE_PATH}/${snake(plural(aggregate))}`,
    opPath: snake(op.routeSlug ?? op.name),
    label: humanize(op.name),
  };
}

/** The scalar base of a type, peeling `optional` — an optional field renders
 *  the same widget + encodes as the same wire type as its required twin (the
 *  optionality only changes the empty→null encoding + validation exemption). */
function scalarBase(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

/** The HTML input widget a field type maps to — numerics render `type: number`,
 *  bools a `checkbox`, an enum (whose values we can resolve) a `select`, a
 *  foreign-key `X id` (whose target we can resolve) an `idselect`, everything
 *  else a plain text input.  Purely derived from the wire type (no stamped
 *  field); the form record stays all-string. */
function inputKindFor(
  t: TypeIR,
  enumsByName: ReadonlyMap<string, string[]>,
  idLabels: ReadonlyMap<string, string>,
): FelizInputKind {
  const base = scalarBase(t);
  if (base.kind === "enum" && enumsByName.has(base.name)) return "select";
  if (base.kind === "id" && idLabels.has(base.targetName)) return "idselect";
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

/** Build one flat `FelizFormField` — the record field `wireName` (bound to an
 *  input), encoding to `jsonKey` (inside `objectKey`'s group when set). */
function buildField(
  formType: string,
  wireName: string,
  jsonKey: string,
  type: TypeIR,
  optional: boolean,
  enumsByName: ReadonlyMap<string, string[]>,
  idLabels: ReadonlyMap<string, string>,
  objectKey?: string,
): FelizFormField {
  const base = scalarBase(type);
  const inputKind = inputKindFor(type, enumsByName, idLabels);
  const enumValues =
    inputKind === "select" && base.kind === "enum" ? enumsByName.get(base.name) : undefined;
  const idTarget = inputKind === "idselect" && base.kind === "id" ? base.targetName : undefined;
  const idLabelField = idTarget ? (idLabels.get(idTarget) ?? "id") : undefined;
  // A REQUIRED enum defaults to its first value so the select and the string
  // state agree from the start (and the required guard passes); everything else
  // — text/number/checkbox, an idselect (its list loads at runtime), a VO
  // sub-field, and an OPTIONAL enum (empty = null) — is "".
  const emptyValue =
    inputKind === "select" && !optional && enumValues && enumValues.length > 0
      ? enumValues[0]!
      : "";
  return {
    wireName,
    setMsg: `Set${formType}${upperFirst(wireName)}`,
    encodeExpr: encodeExprFor(type, `form.${wireName}`, optional),
    inputKind,
    required: !optional,
    enumValues,
    idTarget,
    idLabelField,
    objectKey,
    jsonKey,
    isArray: base.kind === "array",
    emptyValue,
  };
}

/** Build the shared form fields for a form of `formType` from a `{name, type,
 *  optional?}` field/param list.  A value-object field (`address: Address`) is
 *  FLATTENED into one field per scalar VO sub-field (`addressStreet`,
 *  `addressCity`) — the form record stays flat/all-string, and the encoder
 *  re-nests them under the object key (`vosByName` resolves the VO's fields).
 *  Reused by create + operation + workflow forms. */
function formFieldsFrom(
  formType: string,
  fields: readonly { name: string; type: TypeIR; optional?: boolean }[],
  enumsByName: ReadonlyMap<string, string[]> = new Map(),
  idLabels: ReadonlyMap<string, string> = new Map(),
  vosByName: ReadonlyMap<string, readonly FieldIR[]> = new Map(),
): FelizFormField[] {
  return fields.flatMap((f) => {
    const base = scalarBase(f.type);
    const voFields = base.kind === "valueobject" ? vosByName.get(base.name) : undefined;
    if (voFields) {
      // A VO field: flatten each SCALAR sub-field to `<field><Sub>`.  The VO
      // field's own optionality relaxes every sub-field (an absent VO → absent
      // sub-values); nested VO / collection sub-fields are skipped (one level).
      const voOptional = f.optional === true || f.type.kind === "optional";
      return voFields
        .filter((sub) => isScalarInput(sub.type))
        .map((sub) => {
          const subOptional = voOptional || sub.optional === true || sub.type.kind === "optional";
          return buildField(
            formType,
            `${f.name}${upperFirst(sub.name)}`,
            sub.name,
            sub.type,
            subOptional,
            enumsByName,
            idLabels,
            f.name,
          );
        });
    }
    const optional = f.optional === true || f.type.kind === "optional";
    return [buildField(formType, f.name, f.name, f.type, optional, enumsByName, idLabels)];
  });
}

/** The point-free / lambda encoder for ONE array element of scalar type `base`
 *  (already peeled), applied to a trimmed string item. */
function elemEncoderFn(base: TypeIR): string {
  if (base.kind === "primitive") {
    switch (base.name) {
      case "int":
      case "long":
        return "(fun s -> Encode.int (int s))";
      case "decimal":
      case "money":
        return "(fun s -> Encode.decimal (decimal s))";
      case "bool":
        return '(fun s -> Encode.bool (s = "true"))';
      default:
        return "Encode.string";
    }
  }
  return "Encode.string"; // id / enum / string
}

/** Thoth encoder expression that lifts a string-typed form field `access`
 *  (`form.price`) back to its wire type.  A scalar-array field splits the
 *  comma-separated string into a JSON array; an `optional` scalar field's empty
 *  string encodes to `Encode.nil` (JSON `null`) — the client omitted it — while a
 *  filled value encodes as its base type; a bool is never wrapped (unchecked is
 *  a legitimate `false`, never absent). */
function encodeExprFor(t: TypeIR, access: string, optional = false): string {
  const base = scalarBase(t);
  // A scalar array → split the comma-separated input, trim/drop blanks, encode
  // each element.  An empty input yields `[]` (never null), so it needs no
  // optional-null wrapping.
  if (base.kind === "array") {
    const elemFn = elemEncoderFn(scalarBase(base.element));
    return `Encode.list (${access}.Split(',') |> Array.toList |> List.map (fun s -> s.Trim()) |> List.filter (fun s -> s <> "") |> List.map ${elemFn})`;
  }
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
 *  `optional`) — a nested part / value object / collection needs a sub-form. */
function isScalarInput(t: TypeIR): boolean {
  const base = scalarBase(t);
  return base.kind === "primitive" || base.kind === "id" || base.kind === "enum";
}

/** Whether a create-input field is one the form can render as a FLAT field — a
 *  scalar, a value object we can FLATTEN into its scalar sub-fields (`vosByName`),
 *  or a SCALAR ARRAY (`X[]`, rendered as a comma-separated text input).  An
 *  array-OF-value-object is handled separately as a dynamic-row `FelizFieldArray`
 *  (see `buildFieldArray`); a nested part / array-of-part is still a follow-up. */
function isExpandableInput(t: TypeIR, vosByName: ReadonlyMap<string, readonly FieldIR[]>): boolean {
  const base = scalarBase(t);
  return (
    isScalarInput(t) ||
    (base.kind === "valueobject" && vosByName.has(base.name)) ||
    (base.kind === "array" && isScalarInput(base.element))
  );
}

/** Build a dynamic-row `FelizFieldArray` from an `X[]`-of-value-object input, or
 *  null when the field isn't an array-of-VO (or the VO isn't resolvable).  Only
 *  SCALAR sub-fields render in v1 — a nested VO / array inside the row element is
 *  dropped (mirrors the flat-form scalar limit).  An `id` sub-field degrades to a
 *  plain text input (the raw id string) since a per-row FK `<select>` would need
 *  the target list threaded into every row. */
function buildFieldArray(
  formType: string,
  field: { name: string; type: TypeIR },
  vosByName: ReadonlyMap<string, readonly FieldIR[]>,
  enumsByName: ReadonlyMap<string, string[]>,
  idLabels: ReadonlyMap<string, string>,
): FelizFieldArray | null {
  const base = scalarBase(field.type);
  if (base.kind !== "array") return null;
  const elem = scalarBase(base.element);
  if (elem.kind !== "valueobject") return null;
  const voFields = vosByName.get(elem.name);
  if (!voFields) return null;
  const rowFields: FelizRowField[] = voFields
    .filter((vf) => isScalarInput(vf.type))
    .map((vf) => {
      const optional = vf.type.kind === "optional";
      const kind = inputKindFor(vf.type, enumsByName, idLabels);
      const eb = scalarBase(vf.type);
      return {
        wireName: vf.name,
        setMsg: `Set${formType}${upperFirst(field.name)}${upperFirst(vf.name)}`,
        // A per-row FK select would need the target list in every row; v1 renders
        // the id as plain text instead.
        inputKind: kind === "idselect" ? "text" : kind,
        encodeExpr: encodeExprFor(vf.type, `row.${vf.name}`, optional),
        jsonKey: vf.name,
        enumValues: kind === "select" && eb.kind === "enum" ? enumsByName.get(eb.name) : undefined,
        required: !optional,
      };
    });
  const rowType = `${upperFirst(elem.name)}Row`;
  return {
    fieldName: field.name,
    jsonKey: field.name,
    rowType,
    emptyRowBinding: `empty${rowType}`,
    elementLabel: humanize(elem.name),
    label: humanize(field.name),
    addMsg: `Add${formType}${upperFirst(field.name)}`,
    removeMsg: `Remove${formType}${upperFirst(field.name)}`,
    rowFields,
  };
}

/** Collect every array-of-value-object input from a field/param list into its
 *  dynamic-row `FelizFieldArray` (the complement of the flat `isExpandableInput`
 *  filter). */
function buildFieldArrays(
  formType: string,
  inputs: readonly { name: string; type: TypeIR }[],
  vosByName: ReadonlyMap<string, readonly FieldIR[]>,
  enumsByName: ReadonlyMap<string, string[]>,
  idLabels: ReadonlyMap<string, string>,
): FelizFieldArray[] {
  return inputs
    .map((f) => buildFieldArray(formType, f, vosByName, enumsByName, idLabels))
    .filter((a): a is FelizFieldArray => a !== null);
}

/** Build the `FelizForm` for a `CreateForm(of: agg)` from the aggregate's
 *  create-input contract.  v1 keeps the REQUIRED scalar fields (mirroring the
 *  React create form's `!optional` filter); non-scalar / optional inputs are a
 *  follow-up. */
export function felizCreateForm(
  agg: AggregateIR,
  enumsByName: ReadonlyMap<string, string[]> = new Map(),
  idLabels: ReadonlyMap<string, string> = new Map(),
  vosByName: ReadonlyMap<string, readonly FieldIR[]> = new Map(),
): FelizForm {
  const name = agg.name;
  const formType = `${upperFirst(name)}Form`;
  const fields = formFieldsFrom(
    formType,
    // Scalar create inputs (required + optional) AND value-object fields (each
    // flattened into its scalar sub-fields).  Nested part / collection (`array`)
    // inputs still need a sub-form (follow-up).
    createInputFields(agg).filter((f: FieldIR) => isExpandableInput(f.type, vosByName)),
    enumsByName,
    idLabels,
    vosByName,
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
    // The create endpoint returns the new record's identity envelope (`{ id }`),
    // NOT the full aggregate — decode the id so the success handler can route to
    // the new record's detail page (`/<coll>/<id>`).  (Decoding the whole
    // aggregate would fail at runtime — the response has only `id`.)
    decoderExpr: `(Decode.field "id" Decode.string)`,
    resultType: "string",
    fields,
    fieldArrays: buildFieldArrays(
      formType,
      createInputFields(agg),
      vosByName,
      enumsByName,
      idLabels,
    ),
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
  idLabels: ReadonlyMap<string, string> = new Map(),
  vosByName: ReadonlyMap<string, readonly FieldIR[]> = new Map(),
): FelizOperationForm {
  const name = agg.name;
  const opCap = `${upperFirst(op.name)}${upperFirst(name)}`;
  const formType = `${opCap}Form`;
  const fields = formFieldsFrom(
    formType,
    op.params.filter((p) => isExpandableInput(p.type, vosByName)),
    enumsByName,
    idLabels,
    vosByName,
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
    fieldArrays: buildFieldArrays(formType, op.params, vosByName, enumsByName, idLabels),
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
  idLabels: ReadonlyMap<string, string> = new Map(),
  vosByName: ReadonlyMap<string, readonly FieldIR[]> = new Map(),
): FelizWorkflowForm {
  const wfCap = upperFirst(wf.name);
  const formType = `${wfCap}Form`;
  const fields = formFieldsFrom(
    formType,
    wf.params.filter((p) => isExpandableInput(p.type, vosByName)),
    enumsByName,
    idLabels,
    vosByName,
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
    fieldArrays: buildFieldArrays(formType, wf.params, vosByName, enumsByName, idLabels),
  };
}

/** Aggregate name → the record field labelling its `idselect` options — the
 *  target's `display` derived field when it declares one, else `id`.  Built from
 *  every reachable aggregate (so an `X id` field's target is always resolvable),
 *  consumed by the form builders (via `idLabels`) on both the MVU-assembly and
 *  the view-seam sides so the field set agrees. */
export function idLabelsFrom(aggregates: Iterable<AggregateIR>): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of aggregates) m.set(a.name, a.displayDerived?.name ?? "id");
  return m;
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
  nameCtx: PageNameCtx,
): FelizRead[] {
  if (!page.body) return [];
  const detCtx = { apiParamNames, aggregatesByName };
  // The byId read is keyed to the hosting page's `Page` case, which is the
  // aggregate-qualified emit name (`OrderDetail`) — NOT the bare scaffold page
  // name (`Detail`), which collides across aggregates (Fable error 37/39).
  const pageCase = upperFirst(pageEmitName(page, nameCtx));
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
  idLabels: ReadonlyMap<string, string> = new Map(),
  vosByName: ReadonlyMap<string, readonly FieldIR[]> = new Map(),
): FelizForm[] {
  if (!page.body) return [];
  const nameSet = new Set(aggregatesByName.keys());
  const out: FelizForm[] = [];
  const seen = new Set<string>();
  for (const aggName of formOfAggs(page.body, "CreateForm", nameSet)) {
    const agg = aggregatesByName.get(aggName);
    if (!agg || seen.has(aggName)) continue;
    seen.add(aggName);
    out.push(felizCreateForm(agg, enumsByName, idLabels, vosByName));
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
  idLabels: ReadonlyMap<string, string> = new Map(),
  vosByName: ReadonlyMap<string, readonly FieldIR[]> = new Map(),
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
    const form = felizOperationForm(agg, op, enumsByName, idLabels, vosByName);
    const key = form.formType;
    // Param-less ops (`confirm()`) ARE collected now — they wire a trigger +
    // submit + empty-`{}` POST (no form record); `opHasForm` gates the record.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(form);
  }
  return out;
}

/** The aggregate a single-record QueryView yields, from its `of:` query
 *  expression (`<handle>.<Agg>.byId(id)` → `Agg`, or `<Agg>.byId`).  Mirrors the
 *  walker's `singleAggregateOfQuery` so the collector's binding map agrees with
 *  the render-time `ctx.paramTypes`.  Returns the aggregate name when known. */
function singleQueryAggregate(ofArg: ExprIR, aggNames: ReadonlySet<string>): string | undefined {
  const recv = ofArg.kind === "method-call" ? ofArg.receiver : ofArg;
  const name = recv.kind === "member" ? recv.member : recv.kind === "ref" ? recv.name : undefined;
  return name && aggNames.has(name) ? name : undefined;
}

/** Collect the one-click actions a page hosts (`Action { <instance>.<op> }`),
 *  deduped by trigger `Msg`.  Resolution is bounded to the shape the walker can
 *  type: an `Action` inside the `data:` lambda of a single-record (byId)
 *  `QueryView`, whose param binds to the queried aggregate.  A parameterless
 *  public op qualifies; anything else (unresolved instance, missing/non-public
 *  op, or an op with params — that's an `OperationForm`) is skipped. */
export function collectPageActions(
  page: PageIR,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
): FelizAction[] {
  if (!page.body) return [];
  const aggNames = new Set(aggregatesByName.keys());
  const out: FelizAction[] = [];
  const seen = new Set<string>();
  // Walk carrying `binding`: single-QueryView data-lambda param → aggregate name
  // (the render-time `ctx.paramTypes` twin).
  const walk = (e: ExprIR, binding: ReadonlyMap<string, string>): void => {
    if (e.kind === "call" && e.name === "QueryView") {
      const names = e.argNames ?? [];
      const ofArg = names.indexOf("of") >= 0 ? e.args[names.indexOf("of")] : undefined;
      const single = isSingleQueryView(e);
      const dataArg = names.indexOf("data") >= 0 ? e.args[names.indexOf("data")] : undefined;
      const agg = single && ofArg ? singleQueryAggregate(ofArg, aggNames) : undefined;
      // The data lambda's param binds to the queried aggregate; other args walk
      // under the ambient binding.
      for (let i = 0; i < e.args.length; i++) {
        const arg = e.args[i]!;
        if (arg === dataArg && arg.kind === "lambda" && arg.body && agg) {
          walk(arg.body, new Map([...binding, [arg.param, agg]]));
        } else {
          walk(arg, binding);
        }
      }
      return;
    }
    if (e.kind === "call" && e.name === "Action") {
      const opRef = (e.args ?? []).find((a) => !(e.argNames ?? [])[e.args.indexOf(a)]);
      if (opRef?.kind === "member" && opRef.receiver.kind === "ref") {
        const aggName = binding.get(opRef.receiver.name);
        const agg = aggName ? aggregatesByName.get(aggName) : undefined;
        const op = agg?.operations.find(
          (o) => o.name === opRef.member && o.visibility === "public" && o.params.length === 0,
        );
        if (agg && op) {
          const action = felizAction(agg.name, op);
          if (!seen.has(action.triggerMsg)) {
            seen.add(action.triggerMsg);
            out.push(action);
          }
        }
      }
      return;
    }
    for (const c of exprChildren(e)) walk(c, binding);
  };
  walk(page.body, new Map());
  return out;
}

/** A page `state` field two-way-bound by a controlled input primitive (`Field`
 *  / `NumberField` / … via `bind:`, or `Modal` via `open:`) — the MVU projection
 *  needs a `Set<Field>` Msg + update arm for each, so the input's `onChange` can
 *  dispatch it (the setter the React `useState` gives for free). */
export interface FelizBoundState {
  name: string;
  type: TypeIR;
}

/** The `bind:`-carrying input primitives (name → the arg holding the state ref).
 *  `Modal`'s visibility ref is `open:`; the rest bind a value via `bind:`. */
const BOUND_INPUT_PRIMITIVES: ReadonlyMap<string, string> = new Map([
  ["Field", "bind"],
  ["NumberField", "bind"],
  ["PasswordField", "bind"],
  ["MultilineField", "bind"],
  ["SelectField", "bind"],
  ["Toggle", "bind"],
  ["Modal", "open"],
]);

/** Collect the page `state` fields a controlled input primitive two-way-binds —
 *  deduped by name, in tree order.  Each needs a `Set<Field>` Msg + update arm
 *  (built by `renderMsg`/`renderUpdate`); the input's `onChange` dispatches it.
 *  A `bind:`/`open:` that isn't a ref to a declared `state` field is ignored (the
 *  pack renders an uncontrolled stub for it). */
export function collectPageBoundState(page: PageIR): FelizBoundState[] {
  if (!page.body) return [];
  const stateByName = new Map(page.state.map((s) => [s.name, s.type] as const));
  const seen = new Set<string>();
  const out: FelizBoundState[] = [];
  const walk = (e: ExprIR): void => {
    if (e.kind === "call") {
      const bindArg = BOUND_INPUT_PRIMITIVES.get(e.name);
      if (bindArg) {
        const names = e.argNames ?? [];
        const idx = names.indexOf(bindArg);
        const a = idx >= 0 ? e.args[idx] : undefined;
        const type = a && a.kind === "ref" ? stateByName.get(a.name) : undefined;
        if (a && a.kind === "ref" && type && !seen.has(a.name)) {
          seen.add(a.name);
          out.push({ name: a.name, type });
        }
      }
    }
    for (const c of exprChildren(e)) walk(c);
  };
  walk(page.body);
  return out;
}

/** True when a `QueryView` call is `single: true` (byId — one record, not a list). */
function isSingleQueryView(e: Extract<ExprIR, { kind: "call" }>): boolean {
  const names = e.argNames ?? [];
  const idx = names.indexOf("single");
  const arg = idx >= 0 ? e.args[idx] : undefined;
  return arg?.kind === "literal" && arg.lit === "bool" && arg.value === "true";
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
  idLabels: ReadonlyMap<string, string> = new Map(),
  vosByName: ReadonlyMap<string, readonly FieldIR[]> = new Map(),
): FelizWorkflowForm[] {
  if (!page.body) return [];
  const nameSet = new Set(workflowsByName.keys());
  const out: FelizWorkflowForm[] = [];
  const seen = new Set<string>();
  for (const wfName of workflowFormRuns(page.body, nameSet)) {
    const wf = workflowsByName.get(wfName);
    if (!wf) continue;
    const form = felizWorkflowForm(wf, enumsByName, idLabels, vosByName);
    if ((form.fields.length === 0 && form.fieldArrays.length === 0) || seen.has(form.formType))
      continue;
    seen.add(form.formType);
    out.push(form);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Async effects — `match await <api>.<Agg>.<op>()` (async-actions-and-effects.md
// Stage 2, M-T6.15).  A frontend action whose body is a `match await` over a
// union-returning aggregate INSTANCE op projects to the MVU as a TRIGGER →
// RESULT pair: a `<Trigger> of string` Msg (carries the route id) fires
// `Cmd.OfAsync.perform`, and a `<Trigger>Result of Result<<Succ> option, string>`
// Msg reduces the outcome — the success arm under `(Ok (Some p))`, the `else`
// under `(Ok None)` and `(Error _)`.  The api fn POSTs the op route and decodes
// the `type`-tagged 200 body (success tag → `Some`, anything else → `None`).
// The supported v1 shape is arbitrated by `classifyFelizAsyncEffect` (shared with
// the `loom.feliz-async-effect-unsupported` validator gate).
// ---------------------------------------------------------------------------

/** One resolved arm of an async effect's union — a named success (aggregate) or
 *  error variant, with everything the MVU projection needs: the wire tag, the F#
 *  record + Thoth decoder, the DU case (multi-variant only), the RFC-7807 `type`
 *  URI (error variants only), the arm binding + body. */
export interface FelizAsyncVariant {
  /** Wire `type` discriminator (`variantTag(varType)`) — the aggregate name for a
   *  success variant, the error name for an error variant (`Order` / `Rejected`). */
  tag: string;
  /** True when this is an `error` variant (reified from the non-2xx ProblemDetails
   *  `type` URI); false for the success aggregate (decoded off the 200 body). */
  isError: boolean;
  /** F# record type the arm decodes to (`Order` / `Rejected`). */
  recordType: string;
  /** Thoth decoder for the record (`Decoders.order` / `Decoders.rejected`). */
  decoder: string;
  /** DU case wrapping this variant in the multi-variant outcome DU
   *  (`ConfirmOrderOrder`) — unused when the effect is single-variant (bare option). */
  duCase: string;
  /** The RFC-7807 `type` URI the backend stamps for an error variant
   *  (`/errors/rejected`) — matched on the non-2xx branch.  Undefined for success. */
  uri?: string;
  /** The arm's binding local (`o`, `r`), if it binds one. */
  binding?: string;
  /** The arm body (rendered under this variant's update arm). */
  body: readonly StmtIR[];
}

/** One op-param of an async effect — the awaited call passed an arg for it.  The
 *  arg is rendered at dispatch time (view scope) and threaded through the trigger
 *  `Msg` tuple; the api fn takes it curried and Thoth-encodes it into the body. */
export interface FelizAsyncParam {
  /** The F# binder name for the value — the op param name itself (`note`), so the
   *  api fn signature + Msg-tuple destructure read like hand-written code, not
   *  `arg0`.  Guarded against colliding with the route `id` param. */
  name: string;
  /** F# type of the value on the wire + in the Msg tuple / api fn param
   *  (`string` / `int` — enums arrive as strings). */
  fsType: string;
  /** Thoth encoder function (`Encode.string` / `Encode.int`) applied to `name`
   *  in the api fn body. */
  encoder: string;
  /** JSON body key (the op param name). */
  jsonKey: string;
  /** Source arg expression — rendered in the dispatch wrapper's view scope. */
  argExpr: ExprIR;
}

export interface FelizAsyncEffect {
  /** The page action whose body is the `match await` (`reserveNow`). */
  action: string;
  /** Trigger `Msg` case, carrying the route id (+ any op args) (`ReserveNow`). */
  triggerMsg: string;
  /** Result `Msg` case (`ReserveNowResult`), carrying `Result<<outcome> option,
   *  string>` — `<outcome>` is the single variant's record type, or the DU. */
  resultMsg: string;
  /** Curried api fn `(id) (args…) () : Async<Result<<outcome> option, string>>`
   *  (`reserveOrderEffect`). */
  apiFn: string;
  /** Collection base route (`/api/orders`) — the api fn appends `/<id>/<opPath>`. */
  route: string;
  /** The op's URL path segment (`reserve` — `snake(routeSlug ?? name)`). */
  opPath: string;
  /** True when the outcome is a discriminated union (more than one named arm) —
   *  drives the DU type + per-case Msg/decode wrapping.  A single named arm stays
   *  a bare `<record> option` (byte-identical to the M-T6.15 v1 shape). */
  isMulti: boolean;
  /** The `Some`-payload F# type: the single variant's record type, or (multi) the
   *  outcome DU type name (`ConfirmOrderOutcome`). */
  outcomeType: string;
  /** The outcome DU type name to emit near the wire records (multi only). */
  duTypeName?: string;
  /** The named arms (success + error), in source order (≥1). */
  variants: FelizAsyncVariant[];
  /** The op's params, index-aligned with the awaited call's args (empty for a
   *  0-arg op — then the body is the byte-identical `"{}"`). */
  params: FelizAsyncParam[];
  /** The `else` body (rendered under `(Ok None)` and `(Error _)`), or undefined
   *  when the source had no `else` (then those arms reduce to a no-op). */
  elseBody?: readonly StmtIR[];
  /** Success-variant aggregate names to force-emit as records + decoders. */
  extraAggregates: string[];
  /** Error-variant payload names to force-emit as records + decoders. */
  extraErrorPayloads: string[];
}

/** Thoth encoder function for a scalar op-param type (peeling `optional`).  Non-
 *  scalar params fall back to `Encode.string`, which fails loud at the Fable
 *  compile (a type mismatch) rather than silently mis-encoding. */
function paramEncoder(t: TypeIR): string {
  const base = scalarBase(t);
  if (base.kind === "primitive") {
    switch (base.name) {
      case "int":
      case "long":
        return "Encode.int";
      case "decimal":
      case "money":
        return "Encode.decimal";
      case "bool":
        return "Encode.bool";
      default:
        return "Encode.string";
    }
  }
  return "Encode.string";
}

/** Build the `FelizAsyncEffect` for a supported `match await` shape on `action`.
 *  `errorPayloadNames` classifies an arm as an error variant (authoritative over
 *  the lowered `isError` hint, which a UI body can't always resolve). */
function felizAsyncEffect(
  action: string,
  shape: FelizAsyncEffectShape,
  op: OperationIR,
  errorPayloadNames: ReadonlySet<string>,
): FelizAsyncEffect {
  const trigger = upperFirst(action);
  const opCap = `${upperFirst(op.name)}${upperFirst(shape.opAggregate)}`;
  const isMulti = shape.arms.length > 1;
  const variants: FelizAsyncVariant[] = shape.arms.map((arm) => {
    const tag = variantTag(arm.varType);
    const isError = errorPayloadNames.has(tag) || arm.isError;
    return {
      tag,
      isError,
      recordType: upperFirst(tag),
      decoder: `Decoders.${lowerFirst(tag)}`,
      duCase: `${opCap}${upperFirst(tag)}`,
      uri: isError ? errorTypeUri(tag) : undefined,
      binding: arm.binding,
      body: arm.body,
    };
  });
  const params: FelizAsyncParam[] = op.params.map((p, i) => ({
    // The op param name reads best as the F# binder (`note`), except when it
    // collides with the route `id` param already curried into the api fn.
    name: p.name === "id" ? "idArg" : p.name,
    fsType: wireFieldType(p.type),
    encoder: paramEncoder(p.type),
    jsonKey: p.name,
    // The awaited call supplies one arg per param (validated upstream); fall back
    // to a null literal if a call under-applies (keeps the arity aligned).
    argExpr: shape.args[i] ?? { kind: "literal", lit: "null", value: "null" },
  }));
  return {
    action,
    triggerMsg: trigger,
    resultMsg: `${trigger}Result`,
    apiFn: `${op.name}${upperFirst(shape.opAggregate)}Effect`,
    route: `${API_BASE_PATH}/${snake(plural(shape.opAggregate))}`,
    opPath: snake(op.routeSlug ?? op.name),
    isMulti,
    outcomeType: isMulti ? `${opCap}Outcome` : variants[0]!.recordType,
    duTypeName: isMulti ? `${opCap}Outcome` : undefined,
    variants,
    params,
    elseBody: shape.elseBody,
    extraAggregates: variants.filter((v) => !v.isError).map((v) => v.tag),
    extraErrorPayloads: variants.filter((v) => v.isError).map((v) => v.tag),
  };
}

/** True when a page `route:` binds a `:param` — the detail-page `id` an
 *  instance-op async effect's trigger sources.  Mirrors `hasRouteParam`
 *  (index.ts) + `routeHasParam` (store-checks.ts). */
function routeHasParam(route: string | undefined): boolean {
  return (route ?? "/").split("/").some((s) => s.startsWith(":"));
}

/** Collect the supported `match await` async effects a page hosts, deduped by
 *  action name.  Only a `:id` detail page can source the trigger id, so a
 *  non-detail page yields none (its effects stay gated at validation). */
export function collectPageAsyncEffects(
  page: PageIR,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
  apiParamNames: ReadonlySet<string>,
  errorPayloadNames: ReadonlySet<string>,
): FelizAsyncEffect[] {
  if (!routeHasParam(page.route)) return [];
  const aggregateNames = new Set(aggregatesByName.keys());
  const out: FelizAsyncEffect[] = [];
  const seen = new Set<string>();
  for (const action of page.actions) {
    for (const s of action.body) {
      if (s.kind !== "variant-match") continue;
      const cls = classifyFelizAsyncEffect(s, apiParamNames, aggregateNames);
      if (!cls.supported) continue;
      const agg = aggregatesByName.get(cls.shape.opAggregate);
      const op = agg?.operations.find((o) => o.name === cls.shape.op && o.visibility === "public");
      if (!op || seen.has(action.name)) continue;
      seen.add(action.name);
      out.push(felizAsyncEffect(action.name, cls.shape, op, errorPayloadNames));
    }
  }
  return out;
}

/** One async-effect api fn — curried `(id) (args…) ()`, POSTs the Thoth-encoded
 *  op args to `/api/<agg>/<id>/<opPath>`.  At 200 it decodes the `type`-tagged
 *  SUCCESS body (the aggregate variant); on a non-2xx it reifies a named ERROR
 *  variant from the RFC-7807 ProblemDetails `type` URI (mirroring the JS
 *  frontends' catch-and-restamp).  A matched variant → `Some <outcome>`, anything
 *  else → `Ok None` (routed to the `else` arm) or `Error` (a genuine failure).
 *  For a single named success arm with no params (the M-T6.15 v1 shape) the
 *  output is byte-identical to the original. */
function renderAsyncEffectFn(e: FelizAsyncEffect): (string | undefined)[] {
  const successVariants = e.variants.filter((v) => !v.isError);
  const errorVariants = e.variants.filter((v) => v.isError);
  // Wrap a decoded record into the `Some` outcome payload: bare `Some` for a
  // single-variant effect, `<DuCase> >> Some` (compose into the DU) for a
  // multi-variant one.
  const wrap = (v: FelizAsyncVariant): string => (e.isMulti ? `(${v.duCase} >> Some)` : "Some");
  // Name each curried param after the op param itself (`note`), so the signature
  // reads like hand-written code rather than `arg0`.
  const paramSig = e.params.map((p) => `(${p.name}: ${p.fsType}) `).join("");
  const bodyDecl =
    e.params.length === 0
      ? []
      : [
          "      let body =",
          `        Encode.object [ ${e.params
            .map((p) => `"${p.jsonKey}", ${p.encoder} ${p.name}`)
            .join("; ")} ]`,
          "        |> Encode.toString 0",
        ];
  const bodyLine =
    e.params.length === 0
      ? '        |> Http.content (BodyContent.Text "{}")'
      : "        |> Http.content (BodyContent.Text body)";
  // A `type`-tagged decode chain over `variants`.  The 200 body tags by the wire
  // variant name (`binder = "tag"`); the non-2xx ProblemDetails tags by the error
  // `type` URI (`binder = "uri"`).  `keyOf` yields the string each variant matches.
  const decodeChain = (
    variants: FelizAsyncVariant[],
    keyOf: (v: FelizAsyncVariant) => string,
    binder: string,
  ) => {
    const out = [
      "        let decoder =",
      '          Decode.field "type" Decode.string',
      `          |> Decode.andThen (fun ${binder} ->`,
    ];
    variants.forEach((v, i) => {
      out.push(
        `              ${i === 0 ? "if" : "elif"} ${binder} = "${keyOf(v)}" then Decode.map ${wrap(v)} ${v.decoder}`,
      );
    });
    out.push("              else Decode.succeed None)");
    return out;
  };
  const successBranch =
    successVariants.length === 0
      ? ["        return Ok None"]
      : [
          ...decodeChain(successVariants, (v) => v.tag, "tag"),
          "        match Decode.fromString decoder response.responseText with",
          "        | Ok data -> return Ok data",
          "        | Error e -> return Error e",
        ];
  const errorBranch =
    errorVariants.length === 0
      ? ['        return Error (sprintf "HTTP %d" response.statusCode)']
      : [
          ...decodeChain(errorVariants, (v) => v.uri ?? "", "uri"),
          "        match Decode.fromString decoder response.responseText with",
          "        | Ok (Some v) -> return Ok (Some v)",
          '        | _ -> return Error (sprintf "HTTP %d" response.statusCode)',
        ];
  return [
    `  let ${e.apiFn} (id: string) ${paramSig}() : Async<Result<${e.outcomeType} option, string>> =`,
    "    async {",
    ...bodyDecl,
    "      let! response =",
    `        Http.request (sprintf "${e.route}/%s/${e.opPath}" id)`,
    "        |> Http.method POST",
    bodyLine,
    '        |> Http.header (Headers.contentType "application/json")',
    "        |> Http.send",
    "      if response.statusCode = 200 then",
    ...successBranch,
    "      else",
    ...errorBranch,
    "    }",
  ];
}

/** Emit the outcome discriminated unions for the MULTI-variant async effects —
 *  one `type <Op><Agg>Outcome = | <Case> of <Record> | …` per effect, placed
 *  after the domain records (the DU cases reference them).  Empty for a system
 *  with only single-variant (bare-option) effects. */
export function renderAsyncOutcomeTypes(effects: readonly FelizAsyncEffect[]): string {
  const multi = effects.filter((e) => e.isMulti);
  if (multi.length === 0) return "";
  return lines(
    "// Async-effect outcome unions — one case per matched `match await` variant.",
    ...multi.flatMap((e) => [
      `type ${e.duTypeName} =`,
      ...e.variants.map((v) => `  | ${v.duCase} of ${v.recordType}`),
    ]),
  );
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
export function decoderExprFor(t: TypeIR): string {
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
        fields: wireFieldsForValueObject(vo).map((w) => ({
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
          forApiRead(wireFieldsForPart(part)).map((w) => ({
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
      forApiRead(wireFieldsForAggregate(agg)).map((w) => ({
        name: w.name,
        type: w.type,
        optional: w.optional,
      })),
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
  /** Extra aggregate names whose record + decoder must be emitted even though no
   *  read references them — e.g. an async effect's success aggregate, decoded off
   *  the op's `type`-tagged 200 body without a `Remote` read. */
  extraAggregates: readonly string[] = [],
  /** Extra ERROR payload names whose record + decoder must be emitted — an async
   *  effect's named error variants, decoded off the non-2xx ProblemDetails body
   *  when reifying the error arm.  Resolved against the contexts' `error`
   *  payloads. */
  extraErrorPayloads: readonly string[] = [],
): { domain: string; decoders: string } {
  const byName = new Map<string, EnrichedAggregateIR>();
  for (const c of contexts) for (const a of c.aggregates) byName.set(a.name, a);
  const wanted = new Set<string>(reads.map((r) => r.aggregate));
  for (const n of extraAggregates) wanted.add(n);
  const readAggs = [...wanted]
    .map((n) => byName.get(n))
    .filter((a): a is EnrichedAggregateIR => !!a);

  const records = collectRecords(readAggs, contexts);

  // Error payloads named by an async effect's error arms — emitted as flat
  // records (errors are scalar payloads), deduped against the aggregate records.
  const errorByName = new Map<string, PayloadIR>();
  for (const c of contexts) {
    for (const p of c.payloads) if (p.kind === "error") errorByName.set(p.name, p);
  }
  const seenRecord = new Set(records.map((r) => r.typeName));
  for (const name of new Set(extraErrorPayloads)) {
    const p = errorByName.get(name);
    if (!p || seenRecord.has(upperFirst(name))) continue;
    seenRecord.add(upperFirst(name));
    records.push({
      typeName: upperFirst(name),
      decoderName: lowerFirst(name),
      fields: p.fields.map((f) => ({ name: f.name, type: f.type, optional: f.optional })),
    });
  }

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

  // A record that references another (a value object / entity part field) forms
  // a mutually-recursive group — F# is order-sensitive, so `type Order = { …
  // address: Address }` must be declared TOGETHER with `Address` (and the decoder
  // `order` referencing `Decoders.address` needs `let rec`).  A single record
  // (the common, scalar-only case) stays a plain `type` / `let`, byte-identical.
  const rec = records.length > 1;
  const domain = lines(
    "// Domain records — one per aggregate / part / value-object wire shape.",
    ...records.flatMap((r, i) => [
      `${rec && i > 0 ? "and" : "type"} ${r.typeName} =`,
      "  {",
      ...r.fields.map((f) => {
        const base = wireFieldType(fieldBase(f));
        return `    ${f.name}: ${fieldOptional(f) ? `${base} option` : base}`;
      }),
      "  }",
    ]),
  );

  const decoders = lines(
    "// Thoth.Json decoders — decode order mirrors the wire shape.",
    "module Decoders =",
    ...records.flatMap((r, i) => [
      i > 0 ? "" : undefined,
      `  ${i === 0 ? (rec ? "let rec" : "let") : "and"} ${r.decoderName} : Decoder<${r.typeName}> =`,
      "    Decode.object (fun get ->",
      "      {",
      ...r.fields.map((f) => {
        // A sibling record's decoder is referenced UNqualified inside the
        // `let rec … and` group (`Decoders.address` isn't in scope while the
        // module is being defined); `decoderExprFor` qualifies it for external
        // callers, so strip the self-module prefix here.
        const dec = decoderExprFor(fieldBase(f)).replaceAll("Decoders.", "");
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

/** Whether an operation form carries any input — a form record is emitted only
 *  for these.  A PARAM-LESS op (`confirm()`) has none: it is wired as a
 *  trigger + submit (empty `{}` body), with no form state / encoder / record. */
export function opHasForm(f: FelizOperationForm): boolean {
  return f.fields.length > 0 || f.fieldArrays.length > 0;
}

/** One async operation function — CURRIED `(id) (form)`, POSTs the encoded body
 *  to `/api/<agg>/<id>/<opPath>`; a 2xx is `Ok ()` (the op returns 204, no body).
 *  A PARAM-LESS op takes `(id) ()` and posts an empty `{}` body (no form). */
function renderOperationFn(f: FelizOperationForm): (string | undefined)[] {
  const hasForm = opHasForm(f);
  return [
    `  let ${f.apiFn} (id: string) ${hasForm ? `(form: ${f.formType})` : "()"} : Async<Result<unit, string>> =`,
    "    async {",
    hasForm
      ? `      let body = Encode.toString 0 (Encoders.${f.encoderFn} form)`
      : '      let body = "{}"',
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

/** One async action function — a fieldless operation.  POSTs an empty JSON body
 *  to `/api/<agg>/<id>/<opPath>`; a 2xx is `Ok ()` (the op returns 204, no body).
 *  The instance-form sibling of `renderOperationFn` (no encoder — no fields). */
function renderActionFn(a: FelizAction): (string | undefined)[] {
  return [
    `  let ${a.apiFn} (id: string) : Async<Result<unit, string>> =`,
    "    async {",
    "      let! response =",
    `        Http.request (sprintf "${a.route}/%s/${a.opPath}" id)`,
    "        |> Http.method POST",
    '        |> Http.content (BodyContent.Text "{}")',
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
 *  `/<id>/<op>` → `unit`), per one-click action (empty POST to `/<id>/<op>` →
 *  `unit`), and per workflow form (encode + POST to `/workflows/<wf>` → `unit`),
 *  all over `Fable.SimpleHttp`. */
export function renderApiModule(
  reads: FelizRead[],
  mutations: FelizMutation[] = [],
  forms: FelizForm[] = [],
  operationForms: FelizOperationForm[] = [],
  workflowForms: FelizWorkflowForm[] = [],
  asyncEffects: FelizAsyncEffect[] = [],
  opActions: FelizAction[] = [],
): string {
  if (
    reads.length === 0 &&
    mutations.length === 0 &&
    forms.length === 0 &&
    operationForms.length === 0 &&
    workflowForms.length === 0 &&
    asyncEffects.length === 0 &&
    opActions.length === 0
  ) {
    return "";
  }
  const fns = [
    ...reads.map((r) => renderApiFn(r)),
    ...mutations.map((m) => renderMutationFn(m)),
    ...forms.map((f) => renderCreateFn(f)),
    ...operationForms.map((f) => renderOperationFn(f)),
    ...workflowForms.map((f) => renderWorkflowFn(f)),
    ...asyncEffects.map((e) => renderAsyncEffectFn(e)),
    ...opActions.map((a) => renderActionFn(a)),
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
  // Dynamic-row element records (`type LineItemRow = { … }` + `emptyLineItemRow`),
  // deduped by name — a `LineItem[]` shared across forms emits ONE row type.  They
  // precede the form records that reference them (F# needs the type in scope).
  const rowTypesSeen = new Set<string>();
  const rowTypeDecls: (string | undefined)[] = [];
  for (const f of forms) {
    for (const fa of f.fieldArrays) {
      if (rowTypesSeen.has(fa.rowType)) continue;
      rowTypesSeen.add(fa.rowType);
      rowTypeDecls.push(
        rowTypeDecls.length > 0 ? "" : undefined,
        `type ${fa.rowType} =`,
        "  {",
        ...fa.rowFields.map((rf) => `    ${rf.wireName}: string`),
        "  }",
        "",
        `let ${fa.emptyRowBinding} : ${fa.rowType} =`,
        "  {",
        ...fa.rowFields.map((rf) => `    ${rf.wireName} = ""`),
        "  }",
      );
    }
  }
  return lines(
    "// Form state — each field a string (bound to Html.input); array-of-VO fields",
    "// hold a list of string-typed row records (a repeatable sub-form).",
    ...rowTypeDecls,
    ...forms.flatMap((f, i) => [
      i > 0 || rowTypeDecls.length > 0 ? "" : undefined,
      `type ${f.formType} =`,
      "  {",
      ...f.fields.map((fld) => `    ${fld.wireName}: string`),
      ...f.fieldArrays.map((fa) => `    ${fa.fieldName}: ${fa.rowType} list`),
      "  }",
      "",
      `let ${f.emptyBinding} : ${f.formType} =`,
      "  {",
      // Most fields start empty; a required enum starts at its first value (its
      // `<select>` always has a selection); an array field starts empty.
      ...f.fields.map((fld) => `    ${fld.wireName} = ${JSON.stringify(fld.emptyValue)}`),
      ...f.fieldArrays.map((fa) => `    ${fa.fieldName} = []`),
      "  }",
    ]),
  );
}

/** The `Encode.object` entry lines for a form's fields — a plain `"<jsonKey>",
 *  <encode>` per scalar field, and one nested `"<objectKey>", Encode.object [ …
 *  ]` per contiguous run of flattened value-object sub-fields (re-nesting the
 *  flat `addressStreet`/`addressCity` form fields back under `address`). */
function encoderEntries(fields: FelizFormField[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < fields.length) {
    const fld = fields[i]!;
    if (fld.objectKey) {
      const key = fld.objectKey;
      out.push(`      "${key}", Encode.object [`);
      while (i < fields.length && fields[i]!.objectKey === key) {
        out.push(`        "${fields[i]!.jsonKey}", ${fields[i]!.encodeExpr}`);
        i++;
      }
      out.push("      ]");
    } else {
      out.push(`      "${fld.jsonKey}", ${fld.encodeExpr}`);
      i++;
    }
  }
  return out;
}

/** The `Encode.object` entry lines for a form's dynamic-row fields — each an
 *  `"<jsonKey>", Encode.list (form.<field> |> List.map (fun row -> Encode.object
 *  [ … ]))` re-nesting every row's string sub-fields back to their wire types. */
function arrayEncoderEntries(fieldArrays: FelizFieldArray[]): string[] {
  return fieldArrays.flatMap((fa) => [
    `      "${fa.jsonKey}", Encode.list (form.${fa.fieldName} |> List.map (fun row -> Encode.object [`,
    ...fa.rowFields.map((rf) => `        "${rf.jsonKey}", ${rf.encodeExpr}`),
    "      ]))",
  ]);
}

/** Emit the `Encoders` module — one `Encode.object` per form, lifting its
 *  string fields back to their wire types (the write-direction sibling of the
 *  `Decoders`).  Value-object sub-fields re-nest under their object key; array-of-
 *  VO fields encode to a JSON array of row objects.  Shared by create + operation
 *  forms. */
export function renderEncoders(forms: FormRecord[]): string {
  if (forms.length === 0) return "";
  return lines(
    "// Thoth.Json encoders — the write direction of the decoders.",
    "module Encoders =",
    ...forms.flatMap((f, i) => [
      i > 0 ? "" : undefined,
      `  let ${f.encoderFn} (form: ${f.formType}) : JsonValue =`,
      "    Encode.object [",
      ...encoderEntries(f.fields),
      ...arrayEncoderEntries(f.fieldArrays),
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
    "// Alongside the whole-form <form>Valid guard (drives the submit button's",
    "// disabled state), a per-field <form><Field>Error : 'Form -> string option",
    "// feeds the inline message the view shows once a field is touched (blurred)",
    "// — the Elmish analogue of react-hook-form's per-field `errors.<f>.message`.",
    "module Validation =",
    ...withFields.flatMap((f, i) => {
      const required = requiredValidatedFields(f);
      const body =
        required.length > 0
          ? required
              .map((fld) => `not (System.String.IsNullOrWhiteSpace form.${fld.wireName})`)
              .join(" && ")
          : "true"; // nothing required (all optional / bool) → always submittable
      const errorFns = required.flatMap((fld) => [
        "",
        `  let ${fieldErrorFn(f.formType, fld.wireName)} (form: ${f.formType}) : string option =`,
        `    if System.String.IsNullOrWhiteSpace form.${fld.wireName} then Some "Required" else None`,
      ]);
      return [
        i > 0 ? "" : undefined,
        `  let ${f.validFn} (form: ${f.formType}) : bool =`,
        `    ${body}`,
        ...errorFns,
      ];
    }),
  );
}

/** A form's REQUIRED, message-bearing fields — the ones that carry an inline
 *  error + a touched onBlur (required, non-checkbox: an unchecked box is a
 *  legitimate `false`, never "unfilled").  Shared by the validation emitter, the
 *  Model/Msg/update touched wiring, and the view seam so all three agree. */
export function requiredValidatedFields(f: FormRecord): FelizFormField[] {
  return f.fields.filter((fld) => fld.required && fld.inputKind !== "checkbox");
}

/** True when a form has any field that shows an inline error — the gate for
 *  emitting its `<form>Touched` Model field + `Touch<form>` Msg. */
export function formHasFieldErrors(f: FormRecord): boolean {
  return requiredValidatedFields(f).length > 0;
}

/** The `Touch<Form>` Msg case (adds a blurred field's name to the touched set). */
export function formTouchMsg(formType: string): string {
  return `Touch${formType}`;
}

/** The `<Form>Touched: Set<string>` Model field holding the blurred field names. */
export function formTouchedField(formField: string): string {
  return `${formField}Touched`;
}

/** The `Validation.<form><Field>Error` fn name for a field's inline message. */
export function fieldErrorFn(formType: string, wireName: string): string {
  return `${lowerFirst(formType)}${upperFirst(wireName)}Error`;
}

/** The `View` helper module — the `Remote<'T>` → element matchers the QueryView
 *  pack renderer calls (a helper CALL is offside-safe inside a Feliz `[ … ]`
 *  list where a raw multi-line `match` is not).  `remoteList` is emitted when
 *  any list read exists, `remoteOne` when any byId read exists, and `idOptions`
 *  when any `idselect` form field exists (it maps a target's loaded `Remote<'T
 *  list>` to `<option>`s for a foreign-key select). */
export function renderViewModule(
  reads: FelizRead[],
  hasIdSelect = false,
  hasFieldErrors = false,
): string {
  const hasList = reads.some((r) => !r.single);
  const hasSingle = reads.some((r) => r.single);
  // The per-field form-error matcher — factored here beside the Remote matchers
  // (the codebase's convention for repeated view logic) instead of inlined at
  // every input.  Shows the message only for a touched field, else nothing.
  const fieldError = [
    "  let fieldError (touched: Set<string>) (name: string) (err: string option) : ReactElement =",
    "    match (Set.contains name touched, err) with",
    '    | true, Some e -> Html.p [ prop.className "text-error text-sm mt-1"; prop.text e ]',
    "    | _ -> Html.none",
  ];
  const idOptions = [
    "  let idOptions (r: Remote<'T list>) (idOf: 'T -> string) (labelOf: 'T -> string) : ReactElement list =",
    "    match r with",
    "    | Loaded items -> items |> List.map (fun x -> Html.option [ prop.value (idOf x); prop.text (labelOf x) ])",
    "    | _ -> []",
  ];
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
    (hasList || hasSingle) && hasIdSelect ? "" : undefined,
    ...(hasIdSelect ? idOptions : []),
    (hasList || hasSingle || hasIdSelect) && hasFieldErrors ? "" : undefined,
    ...(hasFieldErrors ? fieldError : []),
  );
}
