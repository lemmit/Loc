import type { TypeIR, ValueObjectIR } from "../../../ir/types/loom-ir.js";
import {
  type SingleFieldPattern,
  singleFieldConstraints,
} from "../../../ir/validate/invariant-classify.js";
import { elixirRegexBody, snake } from "../../../util/naming.js";

// ---------------------------------------------------------------------------
// Shared Ecto-changeset validator rendering — the
// leaf both `changeset-emit.ts` (aggregate field invariants) and
// `valueobject-emit.ts` (value-object invariants) import, so the two never form
// a cycle.  Translates the same `singleFieldConstraints` patterns the Zod /
// FluentValidation / Java validators consume into `validate_number` /
// `validate_length` / `validate_format` pipe lines.
// ---------------------------------------------------------------------------

/** Map a recognised single-field invariant pattern to the idiomatic Ecto
 *  changeset validator pipe line (4-space-indented, ready for a `|>` pipe). */
export function ectoValidator(field: string, p: SingleFieldPattern): string {
  switch (p.kind) {
    case "min":
      // Exclusive (`weight > 0.5` on a decimal/money field) → Ecto's strict
      // `greater_than:`; inclusive keeps `greater_than_or_equal_to:`.
      return p.exclusive
        ? `    |> validate_number(:${field}, greater_than: ${p.n})`
        : `    |> validate_number(:${field}, greater_than_or_equal_to: ${p.n})`;
    case "max":
      return p.exclusive
        ? `    |> validate_number(:${field}, less_than: ${p.n})`
        : `    |> validate_number(:${field}, less_than_or_equal_to: ${p.n})`;
    case "between":
      return `    |> validate_number(:${field}, greater_than_or_equal_to: ${p.lo}, less_than_or_equal_to: ${p.hi})`;
    case "len-min":
      return `    |> validate_length(:${field}, min: ${p.n})`;
    case "len-max":
      return `    |> validate_length(:${field}, max: ${p.n})`;
    case "len-eq":
      return `    |> validate_length(:${field}, is: ${p.n})`;
    case "len-range":
      return `    |> validate_length(:${field}, min: ${p.lo}, max: ${p.hi})`;
    case "regex":
      return `    |> validate_format(:${field}, ~r/${elixirRegexBody(p.pattern)}/)`;
  }
}

/** The single-field constraint validator lines for a value object's invariants
 *  (only those whose pattern targets one of the VO's own fields). */
export function voConstraintLines(vo: ValueObjectIR): string[] {
  const fieldNames = new Set(vo.fields.map((f) => snake(f.name)));
  return (vo.invariants ?? [])
    .flatMap((inv) => singleFieldConstraints(inv) ?? [])
    .filter((c) => fieldNames.has(snake(c.field)))
    .map((c) => ectoValidator(snake(c.field), c.pattern));
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
