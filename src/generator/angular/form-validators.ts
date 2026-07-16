import type { InvariantIR } from "../../ir/types/loom-ir.js";
import type { SingleFieldPattern } from "../../ir/validate/invariant-classify.js";
import { takeSingleFieldChain } from "../zod-refine.js";

// ---------------------------------------------------------------------------
// Angular Reactive-Forms validator derivation.
//
// The JSX/markup frontends (React/Vue/Svelte) fold an aggregate's
// wire-translatable `invariant`s into the `Create<Agg>Request` zod schema as
// native chains (`z.number().min(N)`, `z.string().regex(/…/)`, …) so the form
// validates client-side without a server round-trip.  Angular's typed
// Reactive Forms carry validation as `ValidatorFn[]` on each `FormControl`
// instead of a schema — so this module maps the SAME recognised single-field
// shapes onto `Validators.*` calls, keyed by field name.
//
// Fidelity is guaranteed by reuse, not re-implementation: the classification +
// single-field detection go through the shared `takeSingleFieldChain` gate
// (the exact one `emitObjectWithRefines` uses for zod), so Angular admits a
// constraint iff the other frontends do.  Money / `now()` / conversions /
// cross-field rules stay server-only here too (they never pass the gate).
// ---------------------------------------------------------------------------

/** Build the per-field `Validators.*` map an aggregate's invariants imply,
 *  over the fields the form actually carries (`available`).  Returns an empty
 *  map when no invariant translates — callers then emit byte-identical
 *  validator-free `FormControl`s. */
export function angularValidatorMap(
  invariants: readonly InvariantIR[],
  available: ReadonlySet<string>,
): Map<string, string[]> {
  const patternsByField = new Map<string, SingleFieldPattern[]>();
  const ctx = { available };
  for (const inv of invariants) {
    const taken = takeSingleFieldChain(inv, ctx);
    if (!taken) continue;
    const list = patternsByField.get(taken.field) ?? [];
    list.push(taken.pattern);
    patternsByField.set(taken.field, list);
  }
  const out = new Map<string, string[]>();
  for (const [field, patterns] of patternsByField) {
    const calls = patterns.flatMap(validatorsForPattern);
    if (calls.length > 0) out.set(field, calls);
  }
  return out;
}

/** Map one recognised single-field pattern onto its Angular `Validators.*`
 *  call(s) — the direct twin of `chainSingleFieldNative` (zod).  A `between` /
 *  length range expands to a `min`+`max` pair, mirroring the two chained zod
 *  calls. */
function validatorsForPattern(p: SingleFieldPattern): string[] {
  switch (p.kind) {
    case "min":
      // Angular has no exclusive numeric validator; an exclusive bound
      // (`weight > 0.5` on a decimal) falls back to the inclusive `min`, the
      // closest built-in.  The server floor still enforces the strict bound.
      return [`Validators.min(${p.n})`];
    case "max":
      return [`Validators.max(${p.n})`];
    case "between":
      return [`Validators.min(${p.lo})`, `Validators.max(${p.hi})`];
    case "len-min":
      return [`Validators.minLength(${p.n})`];
    case "len-max":
      return [`Validators.maxLength(${p.n})`];
    case "len-eq":
      return [`Validators.minLength(${p.n})`, `Validators.maxLength(${p.n})`];
    case "len-range":
      return [`Validators.minLength(${p.lo})`, `Validators.maxLength(${p.hi})`];
    case "regex":
      // The pattern is a JS-compatible regex source (parse-time validated via
      // `new RegExp`).  Render as a `/…/` literal, escaping forward slashes —
      // identical to the zod `.regex(/…/)` chain.
      return [`Validators.pattern(/${p.pattern.replace(/\//g, "\\/")}/)`];
  }
}
