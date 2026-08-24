// ---------------------------------------------------------------------------
// Shared Pydantic wire-constraint carriers.  Both the aggregate command DTOs
// (`routes-builder.ts`) and the value-object wire models (`http-models.ts`)
// build the SAME two carriers from a set of invariants: a `Field(...)`
// constraint for single-field shapes, and a `@model_validator` refine for the
// cross-field / guarded / messaged rest.  A violation of either surfaces as a
// FastAPI 422 (not the domain's `DomainError` → 400), so a malformed value is
// rejected at the wire with the validation status.  Kept here (not in
// routes-builder) so http-models can reuse it without a `routes-builder ↔
// http-models` import cycle.
// ---------------------------------------------------------------------------

import type { InvariantIR } from "../../../ir/types/loom-ir.js";
import {
  classifyForWire,
  pickErrorPath,
  type SingleFieldPattern,
  singleFieldConstraints,
} from "../../../ir/validate/invariant-classify.js";
import { lines } from "../../../util/code-builder.js";
import { messageCode } from "../../../util/message-code.js";
import { renderPyExpr, renderPyNegatedGuard } from "../render-expr.js";

/** Map of `field → Field(...)` constraint string for every single-field,
 *  message-less invariant over one of `available`.  Multiple constraints
 *  on one field (e.g. `email.matches(r) && email.length <= 120`) become a
 *  single `Field(pattern=, max_length=)`. */
export function createFieldConstraints(
  invariants: InvariantIR[],
  available: ReadonlySet<string>,
): Map<string, string> {
  const byField = new Map<string, SingleFieldPattern[]>();
  for (const inv of invariants) {
    if (!classifyForWire(inv, { available })) continue;
    // A messaged rule carries author text, so it routes through the
    // `@model_validator` refine carrier (which has a message slot) rather
    // than a native `Field(...)` constraint (whose message is Pydantic's
    // default) — mirroring the .NET/Hono carriers.
    if (inv.message) continue;
    const cons = singleFieldConstraints(inv);
    if (!cons) continue;
    for (const { field, pattern } of cons) {
      if (!available.has(field)) continue;
      byField.set(field, [...(byField.get(field) ?? []), pattern]);
    }
  }
  const out = new Map<string, string>();
  for (const [field, patterns] of byField) {
    const kwargs: string[] = [];
    const seen = new Set<string>();
    for (const p of patterns) {
      for (const kw of pydanticKwargs(p)) {
        const key = kw.slice(0, kw.indexOf("="));
        if (seen.has(key)) continue; // first constraint wins on a duplicate key
        seen.add(key);
        kwargs.push(kw);
      }
    }
    if (kwargs.length > 0) out.set(field, `Field(${kwargs.join(", ")})`);
  }
  return out;
}

function pydanticKwargs(p: SingleFieldPattern): string[] {
  switch (p.kind) {
    case "min":
      // Exclusive (`weight > 0.5` on a decimal/money field) → pydantic's `gt=`;
      // inclusive keeps `ge=`.
      return [p.exclusive ? `gt=${p.n}` : `ge=${p.n}`];
    case "max":
      return [p.exclusive ? `lt=${p.n}` : `le=${p.n}`];
    case "between":
      return [`ge=${p.lo}`, `le=${p.hi}`];
    case "len-min":
      return [`min_length=${p.n}`];
    case "len-max":
      return [`max_length=${p.n}`];
    case "len-eq":
      return [`min_length=${p.n}`, `max_length=${p.n}`];
    case "len-range":
      return [`min_length=${p.lo}`, `max_length=${p.hi}`];
    case "regex":
      return [`pattern=${pyRawRegex(p.pattern)}`];
  }
}

/** Render a regex source as a Python raw-string literal (backslashes are
 *  regex escapes, not string escapes).  Falls back to a JSON string only if
 *  the source contains both quote kinds (regexes effectively never do). */
function pyRawRegex(src: string): string {
  if (!src.includes('"')) return `r"${src}"`;
  if (!src.includes("'")) return `r'${src}'`;
  return JSON.stringify(src);
}

/** Splice a derived `Field(...)` onto a request-field declaration, folding any
 *  existing default (`= None` / `= False`) into `Field(default=…, …)` so the
 *  field's optionality is preserved. */
export function withFieldConstraint(
  name: string,
  decl: string,
  fieldExpr: string | undefined,
): string {
  if (!fieldExpr) return `    ${name}: ${decl}`;
  const eq = decl.indexOf(" = ");
  if (eq === -1) return `    ${name}: ${decl} = ${fieldExpr}`;
  const type = decl.slice(0, eq);
  const dflt = decl.slice(eq + 3);
  const inner = fieldExpr.slice("Field(".length, -1);
  return `    ${name}: ${type} = Field(default=${dflt}, ${inner})`;
}

/** A Pydantic `@model_validator(mode="after")` enforcing the wire-scoped
 *  invariants that are NOT single-field shapes (cross-field comparisons like
 *  `handle != email`, or guarded predicates) — the refine fallback the other
 *  backends emit (Hono's `.refine`, Phoenix's `validate fn`).  Single-field
 *  invariants are handled by `Field(...)` constraints; this raises ValueError
 *  → FastAPI 422 for the rest, so a violation surfaces as 422 (not the
 *  domain's DomainError → 400).  Predicates render against the request DTO's
 *  verbatim camelCase fields (`self.handle`). */
export function createModelValidator(
  invariants: InvariantIR[],
  available: ReadonlySet<string>,
  cls: string,
): string | null {
  const refines = invariants.filter(
    (inv) =>
      classifyForWire(inv, { available }) && (inv.message != null || !singleFieldConstraints(inv)),
  );
  if (refines.length === 0) return null;
  const checks = refines.map((inv) => {
    const pred = renderPyExpr(inv.expr, { thisName: "self", wireField: true });
    // The FAILING condition.  A guarded rule keeps the `not (<guard-neg> or
    // <pred>)` shape; an unguarded one negates the predicate directly through
    // `renderPyNegatedGuard`, so a `.contains(...)` rule emits `x not in y`
    // rather than the ruff-E713 `not (x in y)`.
    const fails = inv.guard
      ? `not (${renderPyNegatedGuard(inv.guard, { thisName: "self", wireField: true })} or (${pred}))`
      : renderPyNegatedGuard(inv.expr, { thisName: "self", wireField: true });
    // A messaged rule raises PydanticCustomError so the wire error carries a
    // stable content-hash `type` (surfaced as `errors[].code`, the i18n key) —
    // and cleanly drops the "Value error, " prefix a bare ValueError adds. A
    // message-less rule keeps `raise ValueError(...)`, byte-identical.
    //
    // The FIELD the error points at is the other half of that contract, and an
    // error raised from a `model_validator` carries NO `loc` — so `errors[]`
    // answered `pointer: ""` where Hono's refine (which passes `path`) answered
    // `/amount`. `ValidationError.from_exception_data` is the one Pydantic API
    // that lets a raise name its own `loc`, so a single-field messaged rule now
    // points at its field on python too. A rule with no derivable field (a
    // genuine cross-field comparison) keeps the bare raise, which is also what
    // Hono does — it omits `path` in exactly the same case.
    const path = inv.message ? pickErrorPath(inv) : null;
    // `input` is a REQUIRED key of the `InitErrorDetails` TypedDict (mypy
    // --strict says so), and the offending value is the honest thing to put
    // there — it never reaches the wire (the 422 handler projects only
    // pointer/message/code), but it is what shows up in a raw pydantic error in
    // the logs.  `None` when the path isn't a field this request body carries.
    const input = path && available.has(path) ? `self.${path}` : "None";
    const raise = inv.message
      ? path
        ? `raise ValidationError.from_exception_data(\n                ${JSON.stringify(cls)},\n                [\n                    InitErrorDetails(\n                        type=PydanticCustomError(${JSON.stringify(messageCode(inv.message.text))}, ${JSON.stringify(inv.message.text)}),\n                        loc=(${JSON.stringify(path)},),\n                        input=${input},\n                    )\n                ],\n            )`
        : `raise PydanticCustomError(${JSON.stringify(messageCode(inv.message.text))}, ${JSON.stringify(inv.message.text)})`
      : `raise ValueError(${JSON.stringify(`Invariant violated: ${inv.source}`)})`;
    return lines(`        if ${fails}:`, `            ${raise}`);
  });
  return lines(
    "",
    '    @model_validator(mode="after")',
    `    def _check_invariants(self) -> "${cls}":`,
    ...checks,
    "        return self",
  );
}
