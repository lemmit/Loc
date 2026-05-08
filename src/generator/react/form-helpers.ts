import type {
  AggregateIR,
  BoundedContextIR,
  TypeIR,
} from "../../ir/loom-ir.js";
import { camel, humanize, plural } from "../../util/naming.js";

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
//     `<NumberInput>`, `<Select>`, `<Switch>`, eventually `<DateTimePicker>`.
//     Wrapped in `<Controller … render={({ field, fieldState }) => …}/>`.
//   - Fieldset: value-object aggregation — emits nested register/Controller
//     calls with dot-paths (`register("price.amount")`).
// ---------------------------------------------------------------------------

/**
 * Walk each field type and return the set of Mantine + RHF imports the
 * form will need.  Drives a precise import line so generated pages don't
 * pull in unused components.  Always includes `TextInput` (used by the
 * fallback path) and `Controller` (used by every non-trivial input).
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
      // datetime uses native `<input type="datetime-local">` (a
      // styled `<TextInput>` from Mantine + the type attribute) —
      // already covered by the default-set's TextInput.  See
      // `formInput` for the rationale (Mantine's `<DateTimePicker>`
      // doesn't render an `<input>` child and resists Playwright's
      // `.fill()`).
      return;
    }
    if (inner.kind === "id") {
      // Phase 3: `Id<X>` → `<Select>` populated by `useAll<X>()`.
      // Falls back to `<TextInput>` (already in set) when the target
      // aggregate is unknown — pages-builder emits a generation-time
      // error in that case.
      out.add("Select");
      return;
    }
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

/** Whether the given field set requires `Controller` (anything that's
 * not a plain TextInput).  Drives the import line for `react-hook-form`. */
export function needsController(
  fields: { type: TypeIR }[],
  ctx: BoundedContextIR,
): boolean {
  const probe = (t: TypeIR): boolean => {
    const inner = unwrapOpt(t);
    if (inner.kind === "primitive") {
      return (
        inner.name === "int" ||
        inner.name === "long" ||
        inner.name === "decimal" ||
        inner.name === "bool"
      );
    }
    if (inner.kind === "enum") return true;
    if (inner.kind === "valueobject") {
      const vo = ctx.valueObjects.find((v) => v.name === inner.name);
      return !!vo && vo.fields.some((f) => probe(f.type));
    }
    if (inner.kind === "array") return probe(inner.element);
    return false;
  };
  return fields.some((f) => probe(f.type));
}

/** Collect every aggregate referenced by an `Id<X>` field anywhere in
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
  return `__${camel(plural(target.name))}`;
}

// (Removed `usesDateTimePicker` — datetime fields render as native
// `<TextInput type="datetime-local">`, no separate import needed.)

/**
 * Render a single form input.  `path` is the RHF field path
 * (`"customerId"`, `"price.amount"` for nested value-object fields).
 * `testId` is the DOM testid for Playwright drivers.
 *
 * Returned strings are JSX fragments meant to slot into a parent
 * `<Stack>` block.  Indented with two leading spaces so the page
 * builder's `.join("\n        ")` produces consistent column.
 */
export function formInput(
  path: string,
  t: TypeIR,
  ctx: BoundedContextIR,
  testId: string,
  aggregatesByName: Map<string, AggregateIR>,
): string {
  const inner = unwrapOpt(t);
  const tid = `data-testid="${testId}"`;
  const errExpr = errorAccess(path);
  // Label = humanized leaf segment of the dotted path so nested
  // value-object fields render as "Amount" / "Currency" rather
  // than "price.amount" / "price.currency".
  const leaf = path.split(".").pop()!;
  const label = humanize(leaf);

  if (inner.kind === "primitive") {
    if (inner.name === "int" || inner.name === "long") {
      return `<Controller
          control={control}
          name="${path}"
          render={({ field, fieldState }) => (
            <NumberInput label="${label}" ${tid} allowDecimal={false} value={field.value as number | "" | undefined} onChange={(v) => field.onChange(typeof v === "number" ? v : Number(v) || 0)} error={fieldState.error?.message} />
          )}
        />`;
    }
    if (inner.name === "decimal") {
      return `<Controller
          control={control}
          name="${path}"
          render={({ field, fieldState }) => (
            <NumberInput label="${label}" ${tid} decimalScale={2} fixedDecimalScale value={field.value as number | "" | undefined} onChange={(v) => field.onChange(typeof v === "number" ? v : Number(v) || 0)} error={fieldState.error?.message} />
          )}
        />`;
    }
    if (inner.name === "bool") {
      return `<Controller
          control={control}
          name="${path}"
          render={({ field, fieldState }) => (
            <Switch label="${label}" ${tid} checked={!!field.value} onChange={(e) => field.onChange(e.currentTarget.checked)} error={fieldState.error?.message} />
          )}
        />`;
    }
    if (inner.name === "datetime") {
      // Native `<input type="datetime-local">` via RHF `register`.
      // Mantine's `<DateTimePicker>` renders as a button (no
      // `<input>` child) and opens a popover with calendar + time
      // spinners; driving it from Playwright requires elaborate
      // popover navigation (click trigger → click day cell → fill
      // hour/minute/second spinners → press Escape).  The native
      // input is `.fill()`-able and round-trips through the wire as
      // UTC: backend parsers (.NET / Drizzle) treat the
      // timezone-less `YYYY-MM-DDTHH:mm:ss` value as universal time.
      //
      // Trade-off: the user sees a browser-native picker instead of
      // a Mantine-styled one.  When richer UX is needed, pin the
      // generated form via .loomignore and swap in Mantine's
      // DateTimePicker by hand.
      return `<TextInput label="${label}" {...register("${path}")} ${tid} type="datetime-local" error={${errExpr}} />`;
    }
    return `<TextInput label="${label}" {...register("${path}")} ${tid} error={${errExpr}} />`;
  }

  if (inner.kind === "id") {
    // Phase 3: dropdown populated by `useAll<TargetAggregate>()` with
    // the target's `display`-marked field as the option label.  The
    // hook is called at the form-component scope (not here) and bound
    // to a known variable name (`__<plural target>`); we just
    // reference its data.  Each option carries
    // `data-testid="<input-tid>-option-<id>"` via `renderOption` so
    // the Playwright page object can pick by id without scraping
    // labels.
    const target = aggregatesByName.get(inner.targetName);
    const display = target?.fields.find((f) => f.display);
    if (!target || !display) {
      // Generation-time: produce code that compiles but yells at the
      // user about the missing display field.  pages-builder emits a
      // matching console.error so the issue surfaces at codegen time
      // too.
      const reason = !target
        ? `Id<${inner.targetName}>: target aggregate not found`
        : `Aggregate '${inner.targetName}' has no 'display' field — declare one (e.g. 'sku: string display') to enable a Select picker for Id<${inner.targetName}>.`;
      return `<TextInput label="${label}" {...register("${path}")} ${tid} placeholder=${JSON.stringify(`<id> — ${reason}`)} error={${errExpr}} />`;
    }
    const hookVar = idTargetHookVar(target);
    return `<Controller
          control={control}
          name="${path}"
          render={({ field, fieldState }) => (
            <Select label="${label}" ${tid} placeholder="Select…" searchable data={(${hookVar}.data ?? []).map((__o) => ({ value: __o.id, label: __o.${display.name} }))} renderOption={({ option }) => <div data-testid={\`${testId}-option-\${option.value}\`}>{option.label}</div>} allowDeselect={false} value={field.value as string} onChange={(v) => field.onChange(v ?? "")} error={fieldState.error?.message} />
          )}
        />`;
  }

  if (inner.kind === "enum") {
    const en = ctx.enums.find((e) => e.name === inner.name);
    if (en) {
      const data = JSON.stringify(en.values);
      return `<Controller
          control={control}
          name="${path}"
          render={({ field, fieldState }) => (
            <Select label="${label}" ${tid} data={${data}} allowDeselect={false} value={field.value as string} onChange={(v) => field.onChange(v)} error={fieldState.error?.message} />
          )}
        />`;
    }
    return `<TextInput label="${label}" {...register("${path}")} ${tid} error={${errExpr}} />`;
  }

  if (inner.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === inner.name);
    if (vo) {
      const sub = vo.fields
        .map((vf) =>
          formInput(
            `${path}.${vf.name}`,
            vf.type,
            ctx,
            `${testId}-${vf.name}`,
            aggregatesByName,
          ),
        )
        .join("\n            ");
      // variant="filled" + radius="md" reads as a grouped sub-form
      // section instead of the bare browser-default fieldset.  The
      // legend renders as a small heading so nested value-object
      // forms (e.g. Money { amount, currency }) feel like one
      // composite input rather than a stack of unrelated rows.
      return `<Fieldset legend="${label}" variant="filled" radius="md" data-testid="${testId}">\n          <Stack gap="sm">\n            ${sub}\n          </Stack>\n        </Fieldset>`;
    }
    return `<TextInput label="${label}" {...register("${path}")} ${tid} error={${errExpr}} />`;
  }

  if (inner.kind === "array") {
    return `<TextInput label="${label}" {...register("${path}")} ${tid} placeholder="(arrays not yet supported in forms)" disabled error={${errExpr}} />`;
  }

  return `<TextInput label="${label}" {...register("${path}")} ${tid} error={${errExpr}} />`;
}

/** RHF errors live at `errors.foo.bar.baz?.message` — translate a dot-
 * path into the matching access expression. */
function errorAccess(path: string): string {
  const parts = path.split(".");
  return `errors.${parts.join("?.")}?.message`;
}

/**
 * Render a TS object literal with sensible defaults for each field —
 * passed to `useForm({ defaultValues: … })`.  RHF requires every
 * registered field to have a default to avoid uncontrolled-input
 * warnings.
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
