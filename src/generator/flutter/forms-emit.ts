// Flutter FORM projector — the Track B whole-primitive form overrides
// (`CreateForm` / `OperationForm` / `DestroyForm`).  The Dart analogue of
// Feliz's `wire.ts` form projection, but SELF-CONTAINED: instead of threading
// a Model/Msg/update/Api quadruple through the page shell, each form becomes a
// stand-alone `StatefulWidget` (its own `TextEditingController`s + a
// `GlobalKey<FormState>`) that POSTs/DELETEs over `package:http` and pops the
// route on success.  The view seam (`flutter-target.ts`) only names the widget
// (`CreateProductForm()` / `DiscountProductForm(id: id)` / `DeleteProductForm(id:
// id)`); this module emits the widget CLASS the reference resolves to, into one
// shared `lib/forms.dart`.
//
// Field introspection reuses the framework-neutral create-input contract
// (`createInputFields` off the enriched aggregate — the same set every backend's
// create surface consumes) and the op's declared params; the widget kind is
// derived purely from the wire `TypeIR` (mirroring Feliz's `inputKindFor`):
//   - string / guid / json        → `TextFormField`
//   - int / long                  → `TextFormField` (numeric keyboard, int parse)
//   - decimal / money             → `TextFormField` (numeric keyboard, double parse)
//   - bool                        → `SwitchListTile`
//   - enum (values resolvable)    → `DropdownButtonFormField`
//   - datetime                    → a `showDatePicker` field
//   - value object (resolvable)   → flattened into its scalar sub-fields
//   - id (foreign key)            → `DropdownButtonFormField` loaded at runtime
//                                   from `GET /<target-collection>` when the
//                                   target aggregate has a derived `display`
//                                   field (the option label); otherwise a raw id
//                                   `TextFormField` (matches the cross-frontend
//                                   `display`-gated id-select/id-text split).
//
// A SCALAR array (`tags: string[]` / `scores: int[]`) renders as a repeatable
// add/remove row list (one `TextEditingController` per row); an OBJECT array
// (`items: LineItem[]`) renders each row as a group of `TextFormField`s over the
// value object's scalar sub-fields (a `List<List<TextEditingController>>` in
// state), submitting a `{sub: value, …}` map per row.
// DEFERRED: a VO-array whose sub-fields aren't all text/numeric (bool / enum /
// datetime / nested), and enum/bool/datetime scalar element arrays, are dropped —
// but LOUDLY (M-A): each drop emits a `// TODO(flutter form-field): …` marker on
// the widget class (`FlutterFormSpec.dropped`) so the omission is visible in the
// Dart and counted by the parity lint, never silent.

import { createInputFields, isConstructible } from "../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  FieldIR,
  OperationIR,
  TypeIR,
  UiIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { humanize, lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Widget-name helpers — the ONE place the view seam and the class emitter agree
// on the generated widget class name.  A collision here (seam emits `X`, emitter
// emits `Y`) would be an unresolved-reference compile error, never silent.
// ---------------------------------------------------------------------------

/** `Product` → `CreateProductForm` (the create-form widget class). */
export function createFormWidgetName(aggregate: string): string {
  return `Create${upperFirst(aggregate)}Form`;
}

/** `Product` + `discount` → `DiscountProductForm` (the op-form widget class). */
export function operationFormWidgetName(aggregate: string, op: string): string {
  return `${upperFirst(op)}${upperFirst(aggregate)}Form`;
}

/** `Product` → `DeleteProductForm` (the destroy-form widget class). */
export function destroyFormWidgetName(aggregate: string): string {
  return `Delete${upperFirst(aggregate)}Form`;
}

/** `placeOrder` → `PlaceOrderWorkflowForm` (the workflow-run-form widget class). */
export function workflowFormWidgetName(workflow: string): string {
  return `${upperFirst(workflow)}WorkflowForm`;
}

// ---------------------------------------------------------------------------
// Field preparation
// ---------------------------------------------------------------------------

/** The Flutter input widget a form field renders as — derived purely from the
 *  wire `TypeIR`.  The form widget keeps text/number values in
 *  `TextEditingController`s and bool/enum/datetime in plain state fields. */
export type FlutterInputKind =
  | "text"
  | "number-int"
  | "number-double"
  | "bool"
  | "enum"
  | "datetime"
  | "fk-select"
  | "scalar-array"
  | "object-array";

/** One prepared form field — a scalar input the widget renders + submits. */
export interface FlutterFormField {
  /** Base field name (the aggregate/param field, or `<field><Sub>` for a
   *  flattened value-object sub-field) — drives the Dart state identifier. */
  wireName: string;
  /** JSON key this field encodes to — its own name, or the VO sub-field name
   *  (`amount`) inside its `objectKey` group. */
  jsonKey: string;
  /** Human label shown on the input's `InputDecoration.labelText`. */
  label: string;
  /** The widget kind derived from the type. */
  kind: FlutterInputKind;
  /** Whether the client MUST supply this field (required → validated). */
  required: boolean;
  /** For an `enum` field, the allowed values (rendered as dropdown items). */
  enumValues?: string[];
  /** When flattened from a value object, the JSON object key it nests under
   *  (`cost` for a `cost: Money` VO expanded to `costAmount`/`costCurrency`). */
  objectKey?: string;
  /** For an `fk-select` field, the snake-plural collection path (`categories`)
   *  its option list loads from (`GET /<collection>`); the option label is the
   *  target's derived `display` field (falling back to the row's `id`). */
  fkCollection?: string;
  /** For a `scalar-array` field, the scalar kind of each element — drives the
   *  per-row keyboard + parse (a `string[]` submits the raw list; a numeric array
   *  parses each row). */
  elementKind?: "text" | "number-int" | "number-double";
  /** For an `object-array` field (`items: LineItem[]`), the value object's
   *  scalar sub-fields in order — each row is a group of `TextFormField`s, one
   *  per sub-field, and submits a `{sub: value, …}` map per row. */
  objectFields?: {
    jsonKey: string;
    label: string;
    kind: "text" | "number-int" | "number-double";
  }[];
}

/** A fully prepared form → everything `renderFormWidget` needs. */
export interface FlutterFormSpec {
  /** The generated widget class name (matches the view seam's reference). */
  widgetName: string;
  kind: "create" | "operation" | "destroy";
  /** The aggregate operated on (`Product`). */
  aggregate: string;
  /** Whether the widget takes a `required String id` ctor arg (op / destroy). */
  needsId: boolean;
  /** Fully-built request path (a Dart string-literal body, e.g. `/products` or
   *  `/products/${widget.id}/discount`). */
  pathExpr: string;
  /** The submit button's label (`Create Product` / `Discount` / `Delete
   *  Product`). */
  submitLabel: string;
  /** The prepared input fields (empty for a destroy form). */
  fields: FlutterFormField[];
  /** LOUD form-field drop markers (M-A).  One `// TODO(flutter form-field): …`
   *  comment line per input `prepareFields` could not render (nested-VO
   *  sub-field, mixed value-object array, enum/bool/datetime/id element array,
   *  unresolved value-object field).  Emitted into the widget class so the drop
   *  is visible in the generated Dart AND counted by the parity lint's
   *  `TODO_LINE` regex — the drop is no longer silent.  Empty for a fully
   *  rendered form. */
  dropped: string[];
  /** Whether this form styles its submit as a destructive (error-coloured)
   *  action (destroy forms). */
  destructive: boolean;
}

/** Build one LOUD form-field drop marker (M-A) — a Dart line comment shaped so
 *  the parity lint's `TODO_LINE` regex (`/\/\/\s*(TODO\(flutter[^)]*\):[^\n]*)/`)
 *  counts it.  The paren group stays colon-free (`flutter form-field`); the colon
 *  comes right after it, and the human reason follows.  Naming the owning
 *  follow-up mission (M-B) keeps the deferral a reviewed decision, not a silent
 *  gap. */
function droppedMarker(field: string, reason: string): string {
  return `// TODO(flutter form-field): ${field} — ${reason} dropped (deferred, M-B)`;
}

/** Peel a single `optional` layer. */
function peel(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

/** The Flutter input kind for a scalar wire type, or `undefined` when the type
 *  isn't a flat scalar the string/number/bool/enum/datetime form renders. */
function scalarInputKind(
  t: TypeIR,
  enumsByName: ReadonlyMap<string, string[]>,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
): FlutterInputKind | undefined {
  const base = peel(t);
  if (base.kind === "enum") return enumsByName.has(base.name) ? "enum" : "text";
  // A foreign-key id → a runtime-loaded dropdown when the target has a derived
  // `display` field (the option label); otherwise a raw id text field (the same
  // `display`-gated split every other frontend makes).
  if (base.kind === "id")
    return aggregatesByName.get(base.targetName)?.displayDerived ? "fk-select" : "text";
  if (base.kind === "primitive") {
    switch (base.name) {
      case "int":
      case "long":
        return "number-int";
      case "decimal":
      case "money":
        return "number-double";
      case "bool":
        return "bool";
      case "datetime":
        return "datetime";
      default:
        return "text"; // string, guid, json
    }
  }
  return undefined;
}

/** Build one flat `FlutterFormField`. */
function buildField(
  wireName: string,
  jsonKey: string,
  type: TypeIR,
  optional: boolean,
  kind: FlutterInputKind,
  enumsByName: ReadonlyMap<string, string[]>,
  objectKey?: string,
): FlutterFormField {
  const base = peel(type);
  const enumValues =
    kind === "enum" && base.kind === "enum" ? enumsByName.get(base.name) : undefined;
  const fkCollection =
    kind === "fk-select" && base.kind === "id" ? snake(plural(base.targetName)) : undefined;
  return {
    wireName,
    jsonKey,
    label: objectKey ? `${objectKey} ${jsonKey}` : humanize(wireName),
    kind,
    required: !optional,
    enumValues,
    objectKey,
    fkCollection,
  };
}

/** Prepare the form fields from a `{name, type, optional?}` input list.  A
 *  value-object field is FLATTENED into one field per scalar sub-field
 *  (`cost: Money` → `costAmount` / `costCurrency`); a scalar renders directly.
 *  Non-scalar / array / unresolvable-VO inputs are dropped (deferred) — but no
 *  longer SILENTLY: each drop pushes a LOUD `// TODO(flutter form-field): …`
 *  marker (M-A) alongside the rendered fields, so the omission is visible in the
 *  Dart and caught by the parity lint. */
function prepareFields(
  inputs: readonly { name: string; type: TypeIR; optional?: boolean }[],
  enumsByName: ReadonlyMap<string, string[]>,
  vosByName: ReadonlyMap<string, readonly FieldIR[]>,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
): { fields: FlutterFormField[]; dropped: string[] } {
  const out: FlutterFormField[] = [];
  const dropped: string[] = [];
  for (const f of inputs) {
    const base = peel(f.type);
    const fieldOptional = f.optional === true || f.type.kind === "optional";
    const voFields = base.kind === "valueobject" ? vosByName.get(base.name) : undefined;
    if (voFields) {
      for (const sub of voFields) {
        const subKind = scalarInputKind(sub.type, enumsByName, aggregatesByName);
        if (!subKind) {
          // nested VO / array sub-field — one level of flattening only.
          const subBase = peel(sub.type);
          const label = subBase.kind === "array" ? "nested array" : "nested value-object";
          dropped.push(droppedMarker(`${f.name}.${sub.name}`, `${label} sub-field`));
          continue;
        }
        const subOptional = fieldOptional || sub.optional === true || sub.type.kind === "optional";
        out.push(
          buildField(
            `${f.name}${upperFirst(sub.name)}`,
            sub.name,
            sub.type,
            subOptional,
            subKind,
            enumsByName,
            f.name,
          ),
        );
      }
      continue;
    }
    // An array field (`tags: string[]` / `items: LineItem[]`) → a repeatable
    // add/remove row list.
    if (base.kind === "array") {
      const elemBase = peel(base.element);
      const voFieldsOfElem =
        elemBase.kind === "valueobject" ? vosByName.get(elemBase.name) : undefined;
      if (voFieldsOfElem) {
        // Array of value objects → each row is a group of the VO's scalar
        // sub-fields.  Only when EVERY sub-field is a plain text / numeric input
        // (a mini-form of controllers); a bool/enum/datetime/nested sub-field
        // defers the whole array (dropped, never broken Dart).
        const objectFields: NonNullable<FlutterFormField["objectFields"]> = [];
        let allScalar = true;
        for (const sub of voFieldsOfElem) {
          const k = scalarInputKind(sub.type, enumsByName, aggregatesByName);
          if (k === "text" || k === "number-int" || k === "number-double") {
            objectFields.push({ jsonKey: sub.name, label: humanize(sub.name), kind: k });
          } else {
            allScalar = false;
            break;
          }
        }
        if (allScalar && objectFields.length > 0) {
          out.push({
            wireName: f.name,
            jsonKey: f.name,
            label: humanize(f.name),
            kind: "object-array",
            required: !fieldOptional,
            objectFields,
          });
        } else {
          // A value-object array whose sub-fields aren't all text/numeric
          // (bool / enum / datetime / nested) — the whole array defers.
          dropped.push(droppedMarker(f.name, "value-object array with a non-scalar sub-field"));
        }
        continue;
      }
      // Scalar array — plain text / numeric elements only; enum / bool / datetime
      // / id-collection element arrays stay deferred.
      const elemKind = scalarInputKind(base.element, enumsByName, aggregatesByName);
      if (elemKind === "text" || elemKind === "number-int" || elemKind === "number-double") {
        out.push({
          wireName: f.name,
          jsonKey: f.name,
          label: humanize(f.name),
          kind: "scalar-array",
          required: !fieldOptional,
          elementKind: elemKind,
        });
      } else {
        const eb = peel(base.element);
        const elemLabel =
          eb.kind === "enum"
            ? "enum"
            : eb.kind === "id"
              ? "id"
              : eb.kind === "primitive"
                ? eb.name
                : eb.kind;
        dropped.push(droppedMarker(f.name, `${elemLabel} element array`));
      }
      continue;
    }
    const kind = scalarInputKind(f.type, enumsByName, aggregatesByName);
    if (!kind) {
      // nested / unresolved value-object / otherwise-unsupported scalar — deferred.
      const b = peel(f.type);
      const label = b.kind === "valueobject" ? `unresolved value-object ${b.name}` : b.kind;
      dropped.push(droppedMarker(f.name, `${label} field`));
      continue;
    }
    out.push(buildField(f.name, f.name, f.type, fieldOptional, kind, enumsByName));
  }
  return { fields: out, dropped };
}

/** Enum name → values from a bounded context. */
function enumsFromBc(bc: EnrichedBoundedContextIR | undefined): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (bc) for (const e of bc.enums) m.set(e.name, e.values);
  return m;
}

/** Value-object name → its fields from a bounded context. */
function vosFromBc(bc: EnrichedBoundedContextIR | undefined): Map<string, readonly FieldIR[]> {
  const m = new Map<string, readonly FieldIR[]>();
  if (bc) for (const vo of bc.valueObjects) m.set(vo.name, vo.fields);
  return m;
}

// ---------------------------------------------------------------------------
// Spec builders
// ---------------------------------------------------------------------------

/** Build the `FlutterFormSpec` for a `CreateForm(of: agg)`. */
export function flutterCreateForm(
  agg: EnrichedAggregateIR,
  bc: EnrichedBoundedContextIR | undefined,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
): FlutterFormSpec {
  const { fields, dropped } = prepareFields(
    createInputFields(agg),
    enumsFromBc(bc),
    vosFromBc(bc),
    aggregatesByName,
  );
  return {
    widgetName: createFormWidgetName(agg.name),
    kind: "create",
    aggregate: agg.name,
    needsId: false,
    pathExpr: `/${snake(plural(agg.name))}`,
    submitLabel: `Create ${humanize(agg.name)}`,
    fields,
    dropped,
    destructive: false,
  };
}

/** Build the `FlutterFormSpec` for an `OperationForm(of: agg, op: op)`. */
export function flutterOperationForm(
  aggName: string,
  op: OperationIR,
  bc: EnrichedBoundedContextIR | undefined,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
): FlutterFormSpec {
  const { fields, dropped } = prepareFields(
    op.params,
    enumsFromBc(bc),
    vosFromBc(bc),
    aggregatesByName,
  );
  const opPath = snake(op.routeSlug ?? op.name);
  return {
    widgetName: operationFormWidgetName(aggName, op.name),
    kind: "operation",
    aggregate: aggName,
    needsId: true,
    pathExpr: `/${snake(plural(aggName))}/\${widget.id}/${opPath}`,
    submitLabel: humanize(op.name),
    fields,
    dropped,
    destructive: false,
  };
}

/** Build the `FlutterFormSpec` for a `DestroyForm(of: agg)`. */
export function flutterDestroyForm(aggName: string): FlutterFormSpec {
  return {
    widgetName: destroyFormWidgetName(aggName),
    kind: "destroy",
    aggregate: aggName,
    needsId: true,
    pathExpr: `/${snake(plural(aggName))}/\${widget.id}`,
    submitLabel: `Delete ${humanize(aggName)}`,
    fields: [],
    dropped: [],
    destructive: true,
  };
}

/** Build the `FlutterFormSpec` for a `WorkflowForm(runs: wf)`.  Structurally a
 *  create form — a plain POST of the workflow params as a JSON body — but the
 *  endpoint is the command route `/workflows/<wf>` (matching every backend's
 *  workflow-command emit).  Reuses the `"create"` widget shape (POST + body +
 *  `GlobalKey<FormState>`, no route id). */
export function flutterWorkflowForm(
  wf: WorkflowIR,
  bc: EnrichedBoundedContextIR | undefined,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
): FlutterFormSpec {
  const { fields, dropped } = prepareFields(
    wf.params,
    enumsFromBc(bc),
    vosFromBc(bc),
    aggregatesByName,
  );
  return {
    widgetName: workflowFormWidgetName(wf.name),
    kind: "create",
    aggregate: wf.name,
    needsId: false,
    pathExpr: `/workflows/${snake(wf.name)}`,
    submitLabel: `Run ${humanize(wf.name)}`,
    fields,
    dropped,
    destructive: false,
  };
}

// ---------------------------------------------------------------------------
// Collection — scan a ui's pages for the form primitives they host
// ---------------------------------------------------------------------------

/** Direct child expressions of `e` (expression positions only). */
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

/** The named-arg value of a call, or undefined. */
function namedArg(e: Extract<ExprIR, { kind: "call" }>, name: string): ExprIR | undefined {
  const names = e.argNames ?? [];
  const idx = names.indexOf(name);
  return idx >= 0 ? e.args[idx] : undefined;
}

/** Walk a page body, building a form spec for each hosted form primitive,
 *  deduped by widget name.  A form whose aggregate/op can't be resolved (or a
 *  non-constructible create) is skipped — the seam then emits a comment. */
function collectBodyForms(
  body: ExprIR,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
  bcByAggregate: ReadonlyMap<string, EnrichedBoundedContextIR>,
  out: FlutterFormSpec[],
  seen: Set<string>,
): void {
  const push = (spec: FlutterFormSpec): void => {
    if (seen.has(spec.widgetName)) return;
    seen.add(spec.widgetName);
    out.push(spec);
  };
  const walk = (e: ExprIR): void => {
    if (e.kind === "call") {
      if (e.name === "CreateForm") {
        const ofArg = namedArg(e, "of");
        const agg = ofArg?.kind === "ref" ? aggregatesByName.get(ofArg.name) : undefined;
        if (agg && isConstructible(agg))
          push(flutterCreateForm(agg, bcByAggregate.get(agg.name), aggregatesByName));
      } else if (e.name === "OperationForm") {
        const ofArg = namedArg(e, "of");
        const opArg = namedArg(e, "op");
        const agg = ofArg?.kind === "ref" ? aggregatesByName.get(ofArg.name) : undefined;
        if (agg && opArg?.kind === "ref") {
          const op = agg.operations.find((o) => o.name === opArg.name && o.visibility === "public");
          if (op)
            push(flutterOperationForm(agg.name, op, bcByAggregate.get(agg.name), aggregatesByName));
        }
      } else if (e.name === "DestroyForm") {
        const ofArg = namedArg(e, "of");
        const agg = ofArg?.kind === "ref" ? aggregatesByName.get(ofArg.name) : undefined;
        if (agg) push(flutterDestroyForm(agg.name));
      }
    }
    for (const c of exprChildren(e)) walk(c);
  };
  walk(body);
}

/** Collect every form a single page hosts (drives the page's forms import). */
export function collectPageForms(
  body: ExprIR | undefined,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
  bcByAggregate: ReadonlyMap<string, EnrichedBoundedContextIR>,
): FlutterFormSpec[] {
  if (!body) return [];
  const out: FlutterFormSpec[] = [];
  collectBodyForms(body, aggregatesByName, bcByAggregate, out, new Set());
  return out;
}

/** Collect every distinct form a ui's pages host — deduped by widget name
 *  across the whole ui (the set emitted into `lib/forms.dart`). */
export function collectFlutterForms(
  ui: UiIR | undefined,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
  bcByAggregate: ReadonlyMap<string, EnrichedBoundedContextIR>,
): FlutterFormSpec[] {
  if (!ui) return [];
  const out: FlutterFormSpec[] = [];
  const seen = new Set<string>();
  for (const page of ui.pages ?? []) {
    if (!page.body) continue;
    collectBodyForms(page.body, aggregatesByName, bcByAggregate, out, seen);
  }
  return out;
}

/** Walk a page body building a workflow-form spec per `WorkflowForm(runs: <wf>)`
 *  it hosts, deduped by widget name.  A `runs:` that doesn't resolve to a
 *  reachable workflow is skipped (the seam then emits a comment). */
function collectBodyWorkflowForms(
  body: ExprIR,
  workflowsByName: ReadonlyMap<string, WorkflowIR>,
  bcByWorkflow: ReadonlyMap<string, EnrichedBoundedContextIR>,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
  out: FlutterFormSpec[],
  seen: Set<string>,
): void {
  const walk = (e: ExprIR): void => {
    if (e.kind === "call" && e.name === "WorkflowForm") {
      const runsArg = namedArg(e, "runs");
      const wf = runsArg?.kind === "ref" ? workflowsByName.get(runsArg.name) : undefined;
      if (wf && !seen.has(workflowFormWidgetName(wf.name))) {
        seen.add(workflowFormWidgetName(wf.name));
        out.push(flutterWorkflowForm(wf, bcByWorkflow.get(wf.name), aggregatesByName));
      }
    }
    for (const c of exprChildren(e)) walk(c);
  };
  walk(body);
}

/** Collect every workflow-run form a single page hosts (drives the page's forms
 *  import alongside the aggregate forms). */
export function collectPageWorkflowForms(
  body: ExprIR | undefined,
  workflowsByName: ReadonlyMap<string, WorkflowIR>,
  bcByWorkflow: ReadonlyMap<string, EnrichedBoundedContextIR>,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
): FlutterFormSpec[] {
  if (!body) return [];
  const out: FlutterFormSpec[] = [];
  collectBodyWorkflowForms(body, workflowsByName, bcByWorkflow, aggregatesByName, out, new Set());
  return out;
}

/** Collect every distinct workflow-run form a ui's pages host — deduped by
 *  widget name across the whole ui (appended to the `lib/forms.dart` set). */
export function collectFlutterWorkflowForms(
  ui: UiIR | undefined,
  workflowsByName: ReadonlyMap<string, WorkflowIR>,
  bcByWorkflow: ReadonlyMap<string, EnrichedBoundedContextIR>,
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
): FlutterFormSpec[] {
  if (!ui) return [];
  const out: FlutterFormSpec[] = [];
  const seen = new Set<string>();
  for (const page of ui.pages ?? []) {
    if (!page.body) continue;
    collectBodyWorkflowForms(page.body, workflowsByName, bcByWorkflow, aggregatesByName, out, seen);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dart widget emission
// ---------------------------------------------------------------------------

/** The private Dart state identifier for a field (`name` → `_name`). */
function stateId(wireName: string): string {
  return `_${lowerFirst(wireName)}`;
}

/** The `TextEditingController` field name (`price` → `_priceController`). */
function ctrlId(wireName: string): string {
  return `${stateId(wireName)}Controller`;
}

/** The controller-list field name for a scalar-array field
 *  (`tags` → `_tagsControllers`) — one `TextEditingController` per row. */
function arrayCtrlsId(wireName: string): string {
  return `${stateId(wireName)}Controllers`;
}

/** The row-list field name for an object-array field (`items` → `_itemsRows`) —
 *  each row is a `List<TextEditingController>`, one per VO sub-field. */
function rowsId(wireName: string): string {
  return `${stateId(wireName)}Rows`;
}

/** True when the field is backed by a `TextEditingController`. */
function isTextBacked(f: FlutterFormField): boolean {
  return f.kind === "text" || f.kind === "number-int" || f.kind === "number-double";
}

/** Escape a bare label for a single-quoted Dart string literal. */
function dartStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\$/g, "\\$");
}

/** The state field declarations for a form's non-text-backed inputs. */
function stateDecls(fields: readonly FlutterFormField[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    if (isTextBacked(f)) {
      out.push(`  final ${ctrlId(f.wireName)} = TextEditingController();`);
    } else if (f.kind === "bool") {
      out.push(`  bool ${stateId(f.wireName)} = false;`);
    } else if (f.kind === "enum") {
      const first =
        f.required && f.enumValues && f.enumValues.length > 0 ? f.enumValues[0] : undefined;
      out.push(`  String? ${stateId(f.wireName)}${first ? ` = '${dartStr(first)}'` : ""};`);
    } else if (f.kind === "datetime") {
      out.push(`  DateTime? ${stateId(f.wireName)};`);
    } else if (f.kind === "fk-select") {
      out.push(`  String? ${stateId(f.wireName)};`);
      out.push(`  List<Map<String, dynamic>> ${optionsId(f.wireName)} = const [];`);
    } else if (f.kind === "scalar-array") {
      out.push(`  final List<TextEditingController> ${arrayCtrlsId(f.wireName)} = [];`);
    } else if (f.kind === "object-array") {
      out.push(`  final List<List<TextEditingController>> ${rowsId(f.wireName)} = [];`);
    }
  }
  return out;
}

/** The options-list state identifier for an fk-select field
 *  (`category` → `_categoryOptions`). */
function optionsId(wireName: string): string {
  return `${stateId(wireName)}Options`;
}

/** The async loader-method name for an fk-select field
 *  (`category` → `_loadCategoryOptions`). */
function loaderId(wireName: string): string {
  return `_load${upperFirst(wireName)}Options`;
}

/** The `initState` + per-field loader methods for a form's fk-select inputs
 *  (empty when the form hosts none).  Each loader GETs `/<collection>`, unwraps
 *  the paged `{items}` envelope, and stores the rows as the dropdown options. */
function fkLoaders(fields: readonly FlutterFormField[]): string[] {
  const fks = fields.filter((f) => f.kind === "fk-select");
  if (fks.length === 0) return [];
  const out: string[] = [
    "  @override",
    "  void initState() {",
    "    super.initState();",
    ...fks.map((f) => `    ${loaderId(f.wireName)}();`),
    "  }",
  ];
  for (const f of fks) {
    out.push(
      "",
      `  Future<void> ${loaderId(f.wireName)}() async {`,
      "    try {",
      `      final res = await http.get(apiUri('/${f.fkCollection}'));`,
      "      if (res.statusCode < 200 || res.statusCode >= 300) return;",
      "      final decoded = jsonDecode(res.body);",
      "      final raw = decoded is Map<String, dynamic> ? decoded['items'] : decoded;",
      "      if (raw is! List || !mounted) return;",
      "      setState(() {",
      `        ${optionsId(f.wireName)} = raw.whereType<Map<String, dynamic>>().toList();`,
      "      });",
      "    } catch (_) {",
      "      // A failed option load leaves the dropdown empty — never crashes the form.",
      "    }",
      "  }",
    );
  }
  return out;
}

/** The `dispose` overrides for text-backed controllers + scalar-array
 *  controller lists. */
function disposeBody(fields: readonly FlutterFormField[]): string[] {
  const out = fields.filter(isTextBacked).map((f) => `    ${ctrlId(f.wireName)}.dispose();`);
  for (const f of fields) {
    if (f.kind === "scalar-array") {
      out.push(`    for (final c in ${arrayCtrlsId(f.wireName)}) c.dispose();`);
    } else if (f.kind === "object-array") {
      out.push(
        `    for (final row in ${rowsId(f.wireName)}) { for (final c in row) c.dispose(); }`,
      );
    }
  }
  return out;
}

/** The Dart expression producing one field's submit value. */
function fieldValueExpr(f: FlutterFormField): string {
  const ctrl = `${ctrlId(f.wireName)}.text`;
  switch (f.kind) {
    case "text":
      return f.required ? ctrl : `${ctrl}.isEmpty ? null : ${ctrl}`;
    case "number-int":
      return f.required
        ? `int.tryParse(${ctrl})`
        : `${ctrl}.isEmpty ? null : int.tryParse(${ctrl})`;
    case "number-double":
      return f.required
        ? `double.tryParse(${ctrl})`
        : `${ctrl}.isEmpty ? null : double.tryParse(${ctrl})`;
    case "bool":
      return stateId(f.wireName);
    case "enum":
      return stateId(f.wireName);
    case "fk-select":
      return stateId(f.wireName);
    case "datetime":
      return `${stateId(f.wireName)}?.toIso8601String()`;
    case "scalar-array": {
      const ctrls = arrayCtrlsId(f.wireName);
      if (f.elementKind === "number-int") {
        return `${ctrls}.map((c) => int.tryParse(c.text)).whereType<int>().toList()`;
      }
      if (f.elementKind === "number-double") {
        return `${ctrls}.map((c) => double.tryParse(c.text)).whereType<double>().toList()`;
      }
      return `${ctrls}.map((c) => c.text).toList()`;
    }
    case "object-array": {
      const rows = rowsId(f.wireName);
      const entries = (f.objectFields ?? [])
        .map((sf, i) => {
          const cell = `row[${i}].text`;
          const val =
            sf.kind === "number-int"
              ? `int.tryParse(${cell})`
              : sf.kind === "number-double"
                ? `double.tryParse(${cell})`
                : cell;
          return `'${dartStr(sf.jsonKey)}': ${val}`;
        })
        .join(", ");
      return `${rows}.map((row) => <String, dynamic>{${entries}}).toList()`;
    }
  }
}

/** The request-body assembly (`final body = <String, dynamic>{ … };`), grouping
 *  flattened value-object sub-fields under their JSON object key. */
function bodyAssembly(fields: readonly FlutterFormField[]): string[] {
  const topLevel: FlutterFormField[] = [];
  const groups = new Map<string, FlutterFormField[]>();
  const groupOrder: string[] = [];
  for (const f of fields) {
    if (f.objectKey) {
      if (!groups.has(f.objectKey)) {
        groups.set(f.objectKey, []);
        groupOrder.push(f.objectKey);
      }
      groups.get(f.objectKey)!.push(f);
    } else {
      topLevel.push(f);
    }
  }
  const out: string[] = ["    final body = <String, dynamic>{"];
  for (const f of topLevel) {
    out.push(`      '${dartStr(f.jsonKey)}': ${fieldValueExpr(f)},`);
  }
  for (const key of groupOrder) {
    out.push(`      '${dartStr(key)}': <String, dynamic>{`);
    for (const f of groups.get(key)!) {
      out.push(`        '${dartStr(f.jsonKey)}': ${fieldValueExpr(f)},`);
    }
    out.push("      },");
  }
  out.push("    };");
  return out;
}

/** The `validator:` argument fragment for a text/number input (or "" when the
 *  field needs no validation). */
function validatorArg(f: FlutterFormField): string {
  if (f.kind === "text") {
    return f.required
      ? ", validator: (v) => (v == null || v.trim().isEmpty) ? 'Required' : null"
      : "";
  }
  const parse = f.kind === "number-int" ? "int.tryParse" : "double.tryParse";
  if (f.required) {
    return `, validator: (v) => (v == null || v.trim().isEmpty) ? 'Required' : (${parse}(v) == null ? 'Enter a number' : null)`;
  }
  return `, validator: (v) => (v == null || v.trim().isEmpty) ? null : (${parse}(v) == null ? 'Enter a number' : null)`;
}

/** The Flutter input widget for one field (a single build-children element). */
function fieldWidget(f: FlutterFormField): string {
  const label = `'${dartStr(f.label)}'`;
  const decoration = `const InputDecoration(labelText: ${label})`;
  switch (f.kind) {
    case "text":
      return `TextFormField(controller: ${ctrlId(f.wireName)}, decoration: ${decoration}${validatorArg(f)})`;
    case "number-int":
    case "number-double":
      return `TextFormField(controller: ${ctrlId(f.wireName)}, keyboardType: TextInputType.number, decoration: ${decoration}${validatorArg(f)})`;
    case "bool":
      return `SwitchListTile(title: const Text(${label}), value: ${stateId(f.wireName)}, onChanged: (v) => setState(() => ${stateId(f.wireName)} = v))`;
    case "enum": {
      const items = (f.enumValues ?? [])
        .map((v) => `DropdownMenuItem(value: '${dartStr(v)}', child: Text('${dartStr(v)}'))`)
        .join(", ");
      const validator = f.required ? ", validator: (v) => v == null ? 'Required' : null" : "";
      return `DropdownButtonFormField<String>(initialValue: ${stateId(f.wireName)}, decoration: ${decoration}, items: const [${items}], onChanged: (v) => setState(() => ${stateId(f.wireName)} = v)${validator})`;
    }
    case "fk-select": {
      // Options load at runtime (`_<name>Options`); the label is the target's
      // derived `display` field, falling back to the row id.
      const items = `${optionsId(f.wireName)}.map((o) => DropdownMenuItem(value: o['id'] as String?, child: Text((o['display'] ?? o['id'] ?? '').toString()))).toList()`;
      const validator = f.required ? ", validator: (v) => v == null ? 'Required' : null" : "";
      return `DropdownButtonFormField<String>(initialValue: ${stateId(f.wireName)}, decoration: ${decoration}, isExpanded: true, items: ${items}, onChanged: (v) => setState(() => ${stateId(f.wireName)} = v)${validator})`;
    }
    case "datetime":
      return `InkWell(onTap: () async { final picked = await showDatePicker(context: context, initialDate: ${stateId(f.wireName)} ?? DateTime.now(), firstDate: DateTime(2000), lastDate: DateTime(2100)); if (picked != null) setState(() => ${stateId(f.wireName)} = picked); }, child: InputDecorator(decoration: ${decoration}, child: Text(${stateId(f.wireName)}?.toIso8601String() ?? 'Select date')))`;
    case "scalar-array": {
      const ctrls = arrayCtrlsId(f.wireName);
      const kbd =
        f.elementKind === "number-int" || f.elementKind === "number-double"
          ? "keyboardType: TextInputType.number, "
          : "";
      // A labelled column of add/remove rows — one TextFormField per controller,
      // a trailing "Add" button that appends a fresh controller.
      return (
        `Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[` +
        `Padding(padding: const EdgeInsets.only(top: 8, bottom: 4), child: Text(${label}, style: Theme.of(context).textTheme.labelLarge)), ` +
        `...${ctrls}.asMap().entries.map((entry) => Padding(padding: const EdgeInsets.only(bottom: 4), child: Row(children: <Widget>[` +
        `Expanded(child: TextFormField(controller: entry.value, ${kbd}decoration: const InputDecoration(isDense: true))), ` +
        `IconButton(icon: const Icon(Icons.remove_circle_outline), onPressed: () => setState(() => ${ctrls}.removeAt(entry.key).dispose())), ` +
        `]))), ` +
        `Align(alignment: Alignment.centerLeft, child: TextButton.icon(icon: const Icon(Icons.add), label: const Text('Add'), onPressed: () => setState(() => ${ctrls}.add(TextEditingController())))), ` +
        `])`
      );
    }
    case "object-array": {
      const rows = rowsId(f.wireName);
      const subs = f.objectFields ?? [];
      // One cell (TextFormField over `row[i]`) per VO sub-field.
      const cells = subs
        .map((sf, i) => {
          const kbd =
            sf.kind === "number-int" || sf.kind === "number-double"
              ? "keyboardType: TextInputType.number, "
              : "";
          return `Expanded(child: Padding(padding: const EdgeInsets.only(right: 4), child: TextFormField(controller: row[${i}], ${kbd}decoration: InputDecoration(isDense: true, labelText: '${dartStr(sf.label)}'))))`;
        })
        .join(", ");
      const newRow = subs.map(() => "TextEditingController()").join(", ");
      return (
        `Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[` +
        `Padding(padding: const EdgeInsets.only(top: 8, bottom: 4), child: Text(${label}, style: Theme.of(context).textTheme.labelLarge)), ` +
        `...${rows}.asMap().entries.map((entry) { final row = entry.value; return Padding(padding: const EdgeInsets.only(bottom: 4), child: Row(children: <Widget>[` +
        `${cells}, ` +
        `IconButton(icon: const Icon(Icons.remove_circle_outline), onPressed: () => setState(() { final removed = ${rows}.removeAt(entry.key); for (final c in removed) c.dispose(); })), ` +
        `])); }), ` +
        `Align(alignment: Alignment.centerLeft, child: TextButton.icon(icon: const Icon(Icons.add), label: const Text('Add'), onPressed: () => setState(() => ${rows}.add([${newRow}])))), ` +
        `])`
      );
    }
  }
}

/** The `_submit` method for a fields-bearing (create / operation) form. */
function submitMethod(spec: FlutterFormSpec): string[] {
  const gate =
    spec.fields.length > 0 ? "    if (!(_formKey.currentState?.validate() ?? false)) return;" : "";
  return [
    "  Future<void> _submit() async {",
    ...(gate ? [gate] : []),
    "    setState(() {",
    "      _submitting = true;",
    "      _error = null;",
    "    });",
    ...bodyAssembly(spec.fields),
    "    try {",
    `      final res = await http.post(apiUri('${spec.pathExpr}'),`,
    "          headers: const {'Content-Type': 'application/json'},",
    "          body: jsonEncode(body));",
    "      if (res.statusCode >= 200 && res.statusCode < 300) {",
    "        if (!mounted) return;",
    "        Navigator.of(context).pop();",
    "        return;",
    "      }",
    // Emitted Dart string interpolation — an escaped template literal keeps the
    // `${res.statusCode}` in the generated Dart (not a TS template interp).
    `      setState(() => _error = 'Request failed (\${res.statusCode})');`,
    "    } catch (e) {",
    "      setState(() => _error = '$e');",
    "    } finally {",
    "      if (mounted) setState(() => _submitting = false);",
    "    }",
    "  }",
  ];
}

/** The `_submit` method for a destroy form (no fields, a DELETE). */
function destroySubmitMethod(spec: FlutterFormSpec): string[] {
  return [
    "  Future<void> _submit() async {",
    "    setState(() {",
    "      _submitting = true;",
    "      _error = null;",
    "    });",
    "    try {",
    `      final res = await http.delete(apiUri('${spec.pathExpr}'));`,
    "      if (res.statusCode >= 200 && res.statusCode < 300) {",
    "        if (!mounted) return;",
    "        Navigator.of(context).pop();",
    "        return;",
    "      }",
    // Emitted Dart string interpolation (escaped template literal — see above).
    `      setState(() => _error = 'Delete failed (\${res.statusCode})');`,
    "    } catch (e) {",
    "      setState(() => _error = '$e');",
    "    } finally {",
    "      if (mounted) setState(() => _submitting = false);",
    "    }",
    "  }",
  ];
}

/** The submit button element for a form's build children. */
function submitButton(spec: FlutterFormSpec): string {
  const label = `'${dartStr(spec.submitLabel)}'`;
  const style = spec.destructive
    ? "style: ElevatedButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error, foregroundColor: Theme.of(context).colorScheme.onError), "
    : "";
  // The button itself can't be const (its `onPressed` closes over `_submit`), but
  // its literal-text child can.
  return `ElevatedButton(${style}onPressed: _submitting ? null : _submit, child: const Text(${label}))`;
}

/** Emit one form widget class (a `StatefulWidget` + its `State`). */
export function renderFormWidget(spec: FlutterFormSpec): string {
  const w = spec.widgetName;
  const ctorArgs = spec.needsId ? "{super.key, required this.id}" : "{super.key}";
  const idField = spec.needsId ? ["  final String id;"] : [];

  const errorBanner =
    "        if (_error != null)\n" +
    "          Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),";
  const inputChildren = spec.fields.map((f) => `        ${fieldWidget(f)},`);
  const submitChild = `        ${submitButton(spec)},`;

  let buildBody: string[];
  if (spec.kind === "destroy") {
    buildBody = [
      "    return Column(",
      "      crossAxisAlignment: CrossAxisAlignment.start,",
      "      mainAxisSize: MainAxisSize.min,",
      "      children: <Widget>[",
      errorBanner,
      submitChild,
      "      ],",
      "    );",
    ];
  } else {
    buildBody = [
      "    return Form(",
      "      key: _formKey,",
      "      child: Column(",
      "        crossAxisAlignment: CrossAxisAlignment.start,",
      "        mainAxisSize: MainAxisSize.min,",
      "        children: <Widget>[",
      ...inputChildren.map((c) => `  ${c}`),
      `  ${errorBanner}`,
      `  ${submitChild}`,
      "        ],",
      "      ),",
      "    );",
    ];
  }

  const stateMembers: string[] = [];
  if (spec.kind !== "destroy") stateMembers.push("  final _formKey = GlobalKey<FormState>();");
  stateMembers.push(...stateDecls(spec.fields));
  stateMembers.push("  bool _submitting = false;");
  stateMembers.push("  String? _error;");

  const initState = fkLoaders(spec.fields);
  const initStateBlock = initState.length > 0 ? ["", ...initState] : [];

  const dispose = disposeBody(spec.fields);
  const disposeOverride =
    dispose.length > 0
      ? ["", "  @override", "  void dispose() {", ...dispose, "    super.dispose();", "  }"]
      : [];

  const submit = spec.kind === "destroy" ? destroySubmitMethod(spec) : submitMethod(spec);

  return lines(
    // LOUD form-field drop markers (M-A) — Dart line comments, zero compile risk,
    // parseable by the parity lint.  Precede the class so the omission is visible
    // at the widget it belongs to.
    ...spec.dropped,
    `class ${w} extends StatefulWidget {`,
    ...idField,
    `  const ${w}(${ctorArgs});`,
    "",
    "  @override",
    `  State<${w}> createState() => _${w}State();`,
    "}",
    "",
    `class _${w}State extends State<${w}> {`,
    ...stateMembers,
    ...initStateBlock,
    ...disposeOverride,
    "",
    ...submit,
    "",
    "  @override",
    "  Widget build(BuildContext context) {",
    ...buildBody,
    "  }",
    "}",
  );
}

/** Emit `lib/forms.dart` — every form widget a ui hosts.  Returns "" when the
 *  ui hosts no forms (the caller then emits no file). */
export function renderFormsFile(forms: readonly FlutterFormSpec[]): string {
  if (forms.length === 0) return "";
  const blocks = forms.map(renderFormWidget);
  return `${lines(
    "// Form widgets — one self-contained StatefulWidget per CreateForm /",
    "// OperationForm / DestroyForm a ui hosts.  Each POSTs/DELETEs over",
    "// package:http and pops the route on success.  Generated by the Loom",
    "// Flutter target; do not edit.",
    "",
    "import 'dart:convert';",
    "",
    "import 'package:flutter/material.dart';",
    "import 'package:http/http.dart' as http;",
    "",
    "import 'config.dart';",
    "",
    ...blocks.flatMap((b, i) => (i === 0 ? [b] : ["", b])),
  )}\n`;
}
