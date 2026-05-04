import type { BoundedContextIR, TypeIR } from "../../ir/loom-ir.js";

// ---------------------------------------------------------------------------
// React form helpers — Mantine input rendering, import-set computation,
// and initial-value generation.  Shared by every page-level builder.
//
// Kept procedural (raw strings) deliberately: the JSX shape varies per
// type (NumberInput vs Select vs Fieldset of nested inputs) and gets
// composed differently per page.  A template engine would either
// duplicate the branches or hide them in helper soup.
// ---------------------------------------------------------------------------

/**
 * Walk each field type and return the set of Mantine components the
 * form will need.  Drives a precise import line so generated pages
 * don't pull in unused components.  Always includes `TextInput`
 * because the fallback path uses it.
 */
export function componentsForFields(
  fields: { type: TypeIR }[],
  ctx: BoundedContextIR,
): Set<string> {
  const out = new Set<string>(["TextInput"]);
  const visit = (t: TypeIR) => {
    const inner = unwrapOpt(t);
    if (inner.kind === "primitive") {
      if (
        inner.name === "int" ||
        inner.name === "long" ||
        inner.name === "decimal"
      ) {
        out.add("NumberInput");
      }
      if (inner.name === "bool") out.add("Switch");
      // datetime uses TextInput (already in set) with type="datetime-local"
      return;
    }
    if (inner.kind === "id") return; // TextInput
    if (inner.kind === "enum") {
      out.add("Select");
      return;
    }
    if (inner.kind === "valueobject") {
      out.add("Fieldset");
      const vo = ctx.valueObjects.find((v) => v.name === inner.name);
      if (vo) for (const f of vo.fields) visit(f.type);
      return;
    }
    if (inner.kind === "array") visit(inner.element);
  };
  for (const f of fields) visit(f.type);
  return out;
}

export function formInput(
  name: string,
  t: TypeIR,
  ctx: BoundedContextIR,
  testId: string,
): string {
  const inner = unwrapOpt(t);
  const props = `label="${name}" {...form.getInputProps("${name}")}`;
  const tid = `data-testid="${testId}"`;
  if (inner.kind === "primitive") {
    if (inner.name === "int" || inner.name === "long") {
      return `<NumberInput ${props} ${tid} allowDecimal={false} />`;
    }
    if (inner.name === "decimal") {
      return `<NumberInput ${props} ${tid} decimalScale={2} fixedDecimalScale />`;
    }
    if (inner.name === "bool") {
      return `<Switch label="${name}" ${tid} checked={!!form.values.${name}} onChange={(e) => form.setFieldValue("${name}", e.currentTarget.checked)} />`;
    }
    if (inner.name === "datetime") {
      // Native datetime-local — Mantine's DateTimePicker isn't a plain
      // input and resists Playwright's `.fill()`.  Native input keeps
      // the form bulletproof for tests; users can swap to Mantine via
      // .loomignore for a richer UX.
      return `<TextInput ${props} ${tid} type="datetime-local" />`;
    }
    return `<TextInput ${props} ${tid} />`;
  }
  if (inner.kind === "id") {
    return `<TextInput ${props} ${tid} placeholder="<id>" />`;
  }
  if (inner.kind === "enum") {
    const en = ctx.enums.find((e) => e.name === inner.name);
    if (en) {
      // Mantine <Select> calls onChange with (value, option) rather
      // than a DOM event, so getInputProps' event-based onChange never
      // fires.  Bind value/onChange/error explicitly — the pattern
      // @mantine/form recommends for components without event-based
      // onChange.  `allowDeselect={false}` keeps a click on the already-
      // selected option from clearing the field, which matters for
      // required fields and makes Playwright tests deterministic.
      const data = JSON.stringify(en.values);
      return `<Select label="${name}" ${tid} data={${data}} allowDeselect={false} value={(form.values as Record<string, unknown>)["${name}"] as string | null ?? null} onChange={(v) => form.setFieldValue("${name}", (v ?? "") as never)} error={form.errors["${name}"]} />`;
    }
    return `<TextInput ${props} ${tid} />`;
  }
  if (inner.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === inner.name);
    if (vo) {
      const sub = vo.fields
        .map((vf) =>
          formInput(`${name}.${vf.name}`, vf.type, ctx, `${testId}-${vf.name}`),
        )
        .join("\n          ");
      return `<Fieldset legend="${name}" data-testid="${testId}">\n          ${sub}\n        </Fieldset>`;
    }
    return `<TextInput ${props} ${tid} />`;
  }
  if (inner.kind === "array") {
    return `<TextInput ${props} ${tid} placeholder="(arrays not yet supported in forms)" disabled />`;
  }
  return `<TextInput ${props} ${tid} />`;
}

/**
 * Render a TS object literal with sensible defaults for each field.
 * Uses an empty string for datetimes (the form's
 * `<input type="datetime-local">` accepts strings) and zeros / falses
 * / empty strings for the other primitives.
 */
export function initialValuesTs(
  fields: { name: string; type: TypeIR; optional: boolean }[],
  ctx: BoundedContextIR,
): string {
  const entries = fields.map(
    (f) => `${f.name}: ${initialValueTs(f.type, ctx, f.optional)}`,
  );
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
  return (
    inner.kind === "primitive" || inner.kind === "id" || inner.kind === "enum"
  );
}
