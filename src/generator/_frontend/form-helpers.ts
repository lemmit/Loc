import type { AggregateIR, BoundedContextIR, ExprIR, TypeIR } from "../../ir/types/loom-ir.js";
import { lowerFirst, plural } from "../../util/naming.js";
import { renderDefaultSeed } from "./default-seed.js";

// ---------------------------------------------------------------------------
// React form helpers — Mantine input rendering on top of `react-hook-form`,
// import-set computation, and default-values generation.  Shared by every
// page-level builder.
//
// Why react-hook-form (not @mantine/form): Mantine's form library types
// `value` and `onChange` against the form generic but lets components like
// `<Select>` paper over typing mismatches with `(value, option)` callbacks
// that don't roundtrip through `getInputProps`.  RHF's `Controller`
// renders any component with `field.value` / `field.onChange` typed off
// the schema directly — no `as never` casts to bridge the mismatch.
// `register("name")` handles plain `<TextInput>`s natively.
//
// Three emission patterns:
//   - register: native HTML inputs that accept `onChange={(e) => …}` —
//     `<TextInput {...register("name")} error={errors.name?.message} />`.
//   - Controller: components whose `onChange` doesn't take a DOM event —
//     `<NumberInput>`, `<Select>`, `<Switch>`.  Wrapped in
//     `<Controller … render={({ field, fieldState }) => …}/>`.  (Datetime
//     fields use a native `<input type="datetime-local">` rather than a
//     pack DateTimePicker; see the `case "datetime"` dispatch below.)
//   - Fieldset: value-object aggregation — emits nested register/Controller
//     calls with dot-paths (`register("price.amount")`).
// ---------------------------------------------------------------------------

/** Whether the given field set requires `Controller` (anything that's
 * not a plain TextInput).  Drives the import line for `react-hook-form`.
 *
 * X id dispatches on the target's display field:
 *  - target with a `display`-marked field → field-input-id-select.hbs
 *    (renders inside a `<Controller>`).
 *  - target without one → field-input-id-text.hbs (plain TextInput via
 *    `register`, no Controller).
 *
 * `aggregatesByName` lets the probe resolve the target so the import
 * surface is precise — no unused `Controller` import when every Id
 * field falls back to the text variant. */
export function needsController(
  fields: { type: TypeIR }[],
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): boolean {
  const probe = (t: TypeIR): boolean => {
    const inner = unwrapOpt(t);
    if (inner.kind === "primitive") {
      return (
        inner.name === "int" ||
        inner.name === "long" ||
        inner.name === "decimal" ||
        inner.name === "money" ||
        inner.name === "bool"
      );
    }
    if (inner.kind === "enum") return true;
    if (inner.kind === "id") {
      const target = aggregatesByName.get(inner.targetName);
      return !!target?.displayDerived;
    }
    if (inner.kind === "valueobject") {
      const vo = ctx.valueObjects.find((v) => v.name === inner.name);
      return !!vo && vo.fields.some((f) => probe(f.type));
    }
    // An array field never needs `Controller` — an object array renders through
    // `useFieldArray` + `register` (dynamic rows), a scalar array through the
    // stub / comma input.  (It DOES need `control` for the useFieldArray hook,
    // but that's forced separately in `prepareFieldsAndImports`, without the
    // Controller import.)
    if (inner.kind === "array") return false;
    return false;
  };
  return fields.some((f) => probe(f.type));
}

/** Collect every aggregate referenced by an `X id` field anywhere in
 * the field set (recursing into value objects and arrays).  Drives
 * `useAll<X>()` hook calls + imports in the form component, plus
 * the option-label resolution (each target's `display`-marked field). */
export function idTargetsInFields(
  fields: { type: TypeIR }[],
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): AggregateIR[] {
  const seen = new Set<string>();
  const out: AggregateIR[] = [];
  const visit = (t: TypeIR): void => {
    const inner = unwrapOpt(t);
    if (inner.kind === "id") {
      if (seen.has(inner.targetName)) return;
      seen.add(inner.targetName);
      const agg = aggregatesByName.get(inner.targetName);
      if (agg) out.push(agg);
      return;
    }
    if (inner.kind === "valueobject") {
      const vo = ctx.valueObjects.find((v) => v.name === inner.name);
      if (vo) for (const f of vo.fields) visit(f.type);
      return;
    }
    if (inner.kind === "array") visit(inner.element);
  };
  for (const f of fields) visit(f.type);
  return out;
}

/** Local-variable name for the `useAll<X>()` query inside a form
 * component.  e.g. Product → `__products`. */
export function idTargetHookVar(target: AggregateIR): string {
  return `__${lowerFirst(plural(target.name))}`;
}

/**
 * Render a TS object literal with sensible defaults for each field —
 * passed to `useForm({ defaultValues: … })`.  RHF requires every
 * registered field to have a default to avoid uncontrolled-input
 * warnings.
 */
export function initialValuesTs(
  fields: { name: string; type: TypeIR; optional: boolean; default?: ExprIR }[],
  ctx: BoundedContextIR,
): string {
  const entries = fields.map((f) => {
    // A declared default (`field: T = <expr>`) seeds the input when the
    // frontend can evaluate it client-side; otherwise fall back to the
    // type-zero placeholder (RHF still needs a controlled value).
    const seed = f.default ? renderDefaultSeed(f.default) : null;
    return `${f.name}: ${seed ?? initialValueTs(f.type, ctx, f.optional)}`;
  });
  return `{ ${entries.join(", ")} }`;
}

function initialValueTs(t: TypeIR, ctx: BoundedContextIR, optional: boolean): string {
  const inner = unwrapOpt(t);
  if (optional && inner.kind === "primitive") {
    return "null";
  }
  if (inner.kind === "primitive") {
    switch (inner.name) {
      case "int":
      case "long":
      case "decimal":
        return "0";
      case "money":
        return `new Decimal("0")`;
      case "bool":
        return "false";
      case "datetime":
        return `""`;
      default:
        return `""`;
    }
  }
  if (inner.kind === "id") return `""`;
  if (inner.kind === "enum") {
    const en = ctx.enums.find((e) => e.name === inner.name);
    return en ? JSON.stringify(en.values[0]) : `""`;
  }
  if (inner.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === inner.name);
    if (!vo) return "{}";
    const inner2 = vo.fields
      .map((vf) => `${vf.name}: ${initialValueTs(vf.type, ctx, false)}`)
      .join(", ");
    return `{ ${inner2} }`;
  }
  if (inner.kind === "array") return "[]";
  return `""`;
}

// ---------------------------------------------------------------------------
// Type helpers — used by every page-level builder, lives here so the
// form-input subsystem owns its own utilities.
// ---------------------------------------------------------------------------

export function unwrapOpt(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

export function isPrimitiveLike(t: TypeIR): boolean {
  const inner = unwrapOpt(t);
  return inner.kind === "primitive" || inner.kind === "id" || inner.kind === "enum";
}
