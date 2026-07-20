import type { InvariantIR, TypeIR } from "../../../ir/types/loom-ir.js";
import {
  type ClassifyContext,
  classifyForWire,
  type SingleFieldPattern,
  singleFieldConstraints,
} from "../../../ir/validate/invariant-classify.js";

// ---------------------------------------------------------------------------
// Jakarta Bean Validation annotations for the wire-boundary single-field
// constraints — the idiomatic Spring analog of .NET's FluentValidation native
// chains (`.MinimumLength(N)`, `.InclusiveBetween(...)`) and Pydantic's
// `Field(min_length=, pattern=)`.  A message-LESS single-field invariant that
// became a native chain on .NET / a bare Zod chain on Hono becomes a built-in
// constraint annotation on the request DTO here (`@Size`, `@Pattern`, `@Min`,
// `@DecimalMin`, …), enforced by Hibernate Validator at the `@Valid` seam.
//
// This is the exact split .NET draws (validator-emit.ts): a MESSAGED invariant
// is kept OUT of the native path — its authored text + content-hash wire `code`
// ride the residual programmatic validator (`<Agg>Validators`, WireValidation-
// Exception), which validates PARSED domain values at the service floor.  Only
// message-less single-field shapes move to annotations, because they map to a
// built-in constraint whose default violation carries no `code`.
//
// Type note: the request DTO carries WIRE types (money / datetime as `String`,
// counts as `int`), so `@Size` lands on the string body, `@DecimalMin` on the
// money string (it accepts `CharSequence`), and `@Min`/`@Max` on the numeric
// body.  Cross-field predicates need PARSED values to type-check, so they never
// reach this layer — they stay in the residual validator.
// ---------------------------------------------------------------------------

export interface DtoConstraints {
  /** field name → the annotation strings that decorate its record component. */
  byField: Map<string, string[]>;
  /** `jakarta.validation.constraints.*` imports the annotations need. */
  imports: Set<string>;
}

/** True when an invariant is fully covered by built-in constraint annotations
 *  on the request DTO — i.e. message-less and every conjunct is a single-field
 *  shape over an available field.  These are REMOVED from the programmatic
 *  validator (they'd be dead code behind the `@Valid` short-circuit). */
export function annotationEligible(inv: InvariantIR, available: ReadonlySet<string>): boolean {
  if (inv.message) return false; // messaged → residual (carries text + code)
  const constraints = singleFieldConstraints(inv);
  if (!constraints) return false; // cross-field / non-single-field → residual
  return constraints.every((c) => available.has(c.field));
}

/** Build the per-field annotation map for one request shape from its invariants
 *  and its (name, wire-type) parameter list. */
export function dtoConstraintsFor(
  invariants: InvariantIR[],
  params: { name: string; type: TypeIR }[],
  available: ReadonlySet<string>,
): DtoConstraints {
  const ctx: ClassifyContext = { available };
  const byField = new Map<string, string[]>();
  const imports = new Set<string>();
  const typeOf = (field: string): TypeIR | undefined => params.find((p) => p.name === field)?.type;

  for (const inv of invariants) {
    if (!classifyForWire(inv, ctx)) continue;
    if (!annotationEligible(inv, available)) continue;
    const constraints = singleFieldConstraints(inv);
    if (!constraints) continue;
    const message = `Invariant violated: ${inv.source}`;
    for (const { field, pattern } of constraints) {
      const list = byField.get(field) ?? [];
      list.push(...annotationsForPattern(pattern, typeOf(field), message, imports));
      byField.set(field, list);
    }
  }
  return { byField, imports };
}

function isDecimalLike(type: TypeIR | undefined): boolean {
  return type?.kind === "primitive" && (type.name === "money" || type.name === "decimal");
}

function annotationsForPattern(
  pattern: SingleFieldPattern,
  type: TypeIR | undefined,
  message: string,
  imports: Set<string>,
): string[] {
  const add = (name: string): void => {
    imports.add(`jakarta.validation.constraints.${name}`);
  };
  const msg = `, message = ${javaMessageLiteral(message)}`;
  const decimal = isDecimalLike(type);
  switch (pattern.kind) {
    case "len-min":
      add("Size");
      return [`@Size(min = ${pattern.n}${msg})`];
    case "len-max":
      add("Size");
      return [`@Size(max = ${pattern.n}${msg})`];
    case "len-eq":
      add("Size");
      return [`@Size(min = ${pattern.n}, max = ${pattern.n}${msg})`];
    case "len-range":
      add("Size");
      return [`@Size(min = ${pattern.lo}, max = ${pattern.hi}${msg})`];
    case "regex":
      add("Pattern");
      return [`@Pattern(regexp = ${javaStringLiteral(pattern.pattern)}${msg})`];
    case "min":
      if (decimal) {
        add("DecimalMin");
        const inclusive = pattern.exclusive ? ", inclusive = false" : "";
        return [`@DecimalMin(value = "${pattern.n}"${inclusive}${msg})`];
      }
      // Integral fields never carry an exclusive flag — the classifier folds
      // `> n` to `>= n+1` for them, so `@Min` (inclusive) is exact.
      add("Min");
      return [`@Min(value = ${pattern.n}${msg})`];
    case "max":
      if (decimal) {
        add("DecimalMax");
        const inclusive = pattern.exclusive ? ", inclusive = false" : "";
        return [`@DecimalMax(value = "${pattern.n}"${inclusive}${msg})`];
      }
      add("Max");
      return [`@Max(value = ${pattern.n}${msg})`];
    case "between":
      if (decimal) {
        add("DecimalMin");
        add("DecimalMax");
        return [
          `@DecimalMin(value = "${pattern.lo}"${msg})`,
          `@DecimalMax(value = "${pattern.hi}"${msg})`,
        ];
      }
      add("Min");
      add("Max");
      return [`@Min(value = ${pattern.lo}${msg})`, `@Max(value = ${pattern.hi}${msg})`];
  }
}

/** A Java string literal (double-quoted, `\` + `"` escaped) — JSON.stringify
 *  produces the same shape. */
function javaStringLiteral(s: string): string {
  return JSON.stringify(s);
}

/** A Bean Validation message literal: EL-escape `{ } \ $` (Hibernate Validator
 *  interpolates `{...}` / `${...}` templates) so the text is emitted verbatim,
 *  then wrap as a Java string literal. */
function javaMessageLiteral(s: string): string {
  const elEscaped = s.replace(/[\\{}$]/g, "\\$&");
  return javaStringLiteral(elEscaped);
}
