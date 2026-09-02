import type { TypeIR, ValueObjectIR } from "../../../ir/types/loom-ir.js";
import {
  type SingleFieldPattern,
  singleFieldConstraints,
} from "../../../ir/validate/invariant-classify.js";
import { elixirRegexBody, elixirString, snake } from "../../../util/naming.js";

// ---------------------------------------------------------------------------
// Shared Ecto-changeset validator rendering — the
// leaf both `changeset-emit.ts` (aggregate field invariants) and
// `valueobject-emit.ts` (value-object invariants) import, so the two never form
// a cycle.  Translates the same `singleFieldConstraints` patterns the Zod /
// FluentValidation / Java validators consume into `validate_number` /
// `validate_length` / `validate_format` pipe lines.
// ---------------------------------------------------------------------------

/** Ecto's own default message for each `validate_length/3` failure kind — kept
 *  verbatim (interpolation placeholder included) so a hand-rolled length error
 *  renders exactly like the native one through the app's error translator. */
const LENGTH_MESSAGE: Readonly<Record<"min" | "max" | "is", string>> = {
  min: "should be at least %{count} character(s)",
  max: "should be at most %{count} character(s)",
  is: "should be %{count} character(s)",
};

type LengthArm = { cmp: "<" | ">" | "!="; bound: number; kind: "min" | "max" | "is" };

/** A CODE-POINT length rule as an Ecto `validate_change/3` closure.
 *
 *  `validate_change/3` has the same nil/absent-change skip as `validate_length/3`
 *  (Ecto returns `[]` for a nil change), so only the counting unit differs.  The
 *  returned error tuple is Ecto's own — same message text, same `count` /
 *  `validation: :length` / `kind` / `type: :string` metadata — so ProblemDetails
 *  and any Gettext translator see no difference. */
function lengthValidator(field: string, arms: readonly LengthArm[], message?: string): string {
  const error = (a: LengthArm): string =>
    // Through the shared escaping funnel: the author's `message "…"` is `.ddd`
    // text, and a raw `#{` in it would INTERPOLATE when the closure runs.
    `[{:${field}, {${elixirString(message ?? LENGTH_MESSAGE[a.kind])}, count: ${a.bound}, validation: :length, kind: :${a.kind}, type: :string}}]`;
  const count = "length(String.to_charlist(value))";
  if (arms.length === 1) {
    const a = arms[0] as LengthArm;
    // Single bound — the negated comparison inline, no intermediate binding.
    const ok = a.cmp === "<" ? `>= ${a.bound}` : a.cmp === ">" ? `<= ${a.bound}` : `== ${a.bound}`;
    return `    |> validate_change(:${field}, fn _, value ->
      if ${count} ${ok},
        do: [],
        else: ${error(a)}
    end)`;
  }
  // A range binds the count once and picks the first failing bound, exactly as
  // `validate_length(min:, max:)` does (min checked before max).
  const branches = arms.map((a) => `        len ${a.cmp} ${a.bound} -> ${error(a)}`).join("\n");
  return `    |> validate_change(:${field}, fn _, value ->
      len = ${count}

      cond do
${branches}
        true -> []
      end
    end)`;
}

/** Map a recognised single-field invariant pattern to the idiomatic Ecto
 *  changeset validator pipe line (4-space-indented, ready for a `|>` pipe). */
export function ectoValidator(field: string, p: SingleFieldPattern, message?: string): string {
  // An author `message "..."` rides along as Ecto's own `message:` option, so a
  // messaged single-field rule keeps its native `validate_*` enforcement AND
  // surfaces the author text (VOs have no residual carrier to route to). A
  // message-less rule is byte-identical.
  // Same funnel as the length arm above — author text, never spliced raw.
  const m = message ? `, message: ${elixirString(message)}` : "";
  switch (p.kind) {
    case "min":
      // Exclusive (`weight > 0.5` on a decimal/money field) → Ecto's strict
      // `greater_than:`; inclusive keeps `greater_than_or_equal_to:`.
      return p.exclusive
        ? `    |> validate_number(:${field}, greater_than: ${p.n}${m})`
        : `    |> validate_number(:${field}, greater_than_or_equal_to: ${p.n}${m})`;
    case "max":
      return p.exclusive
        ? `    |> validate_number(:${field}, less_than: ${p.n}${m})`
        : `    |> validate_number(:${field}, less_than_or_equal_to: ${p.n}${m})`;
    case "between":
      return `    |> validate_number(:${field}, greater_than_or_equal_to: ${p.lo}, less_than_or_equal_to: ${p.hi}${m})`;
    // `.length` counts CODE POINTS on every backend (RS-31 /
    // src/generator/_expr/code-point.ts) — the unit the emitted `minLength` /
    // `maxLength` publish in this server's own /openapi.json.  Ecto's
    // `validate_length/3` counts GRAPHEMES and has no `:codepoints` option, so
    // the length rules are hand-rolled as `validate_change/3` closures over the
    // shared code-point snippet, carrying Ecto's own error tuples (message
    // text, `count`, `validation: :length`, `kind`, `type`) so the 422 body and
    // the changeset error metadata stay byte-identical to the native validator.
    case "len-min":
      return lengthValidator(field, [{ cmp: "<", bound: p.n, kind: "min" }], message);
    case "len-max":
      return lengthValidator(field, [{ cmp: ">", bound: p.n, kind: "max" }], message);
    case "len-eq":
      return lengthValidator(field, [{ cmp: "!=", bound: p.n, kind: "is" }], message);
    case "len-range":
      return lengthValidator(
        field,
        [
          { cmp: "<", bound: p.lo, kind: "min" },
          { cmp: ">", bound: p.hi, kind: "max" },
        ],
        message,
      );
    case "regex":
      return `    |> validate_format(:${field}, ~r/${elixirRegexBody(p.pattern)}/${m})`;
  }
}

/** The single-field constraint validator lines for a value object's invariants
 *  (only those whose pattern targets one of the VO's own fields). */
export function voConstraintLines(vo: ValueObjectIR): string[] {
  const fieldNames = new Set(vo.fields.map((f) => snake(f.name)));
  return (vo.invariants ?? []).flatMap((inv) =>
    (singleFieldConstraints(inv) ?? [])
      .filter((c) => fieldNames.has(snake(c.field)))
      .map((c) => ectoValidator(snake(c.field), c.pattern, inv.message?.text)),
  );
}

/** True iff the value object declares at least one single-field-constraint
 *  invariant — i.e. it gets a validating constructor module (`<VO>.new/1`) and
 *  aggregate fields of this type get a `validate_vo` line.  A VO with no such
 *  invariant is left as a plain `:map` with no module (status quo). */
export function voHasConstraints(vo: ValueObjectIR): boolean {
  return voConstraintLines(vo).length > 0;
}

/** Schemaless Ecto type atom for a value-object field — used in the VO module's
 *  `@types` cast map.  Mirrors `schema-emit.ts:mapTypeToEcto` but flattens to
 *  cast-compatible types (an enum has no schema here, so it casts as a string). */
export function voEctoType(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return ":integer";
        case "decimal":
        case "money":
          return ":decimal";
        case "bool":
          return ":boolean";
        case "datetime":
          return ":utc_datetime";
        case "guid":
          return "Ecto.UUID";
        case "json":
          return ":map";
        default:
          return ":string";
      }
    case "id":
      return ":binary_id";
    case "enum":
      return ":string";
    case "valueobject":
      return ":map";
    case "array":
      return `{:array, ${voEctoType(t.element)}}`;
    case "optional":
      return voEctoType(t.inner);
    default:
      return ":string";
  }
}
