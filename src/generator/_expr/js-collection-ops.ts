// Shared JavaScript collection-op renderer table — the JS half of the
// `isCollectionOp` seam, consumed by BOTH the Hono/TypeScript backend
// (`typescript/render-expr.ts`) and the four JS-embedding frontend walkers
// (React / Vue / Svelte / Angular, through `_walker/js-expr-leaves.ts`).
//
// It lives here for the same reason `js-intrinsics.ts` does: those five
// surfaces emit the SAME language, so one table is what makes
// `orders.where(o => o.open).count` mean the same thing in an aggregate
// `derived` as it does in a page body.  It also means the money and
// value-object special-cases below — which took several audit findings to get
// right (A14, F2-EXPR-4) — are not re-derived, and re-broken, per frontend.
//
// The table was previously `TS_COLLECTION_RENDERERS` inside
// `typescript/render-expr.ts`, which still re-exports it under that name.
// Moved verbatim: the frontends' first emission of every op is byte-identical
// to what the backend has been emitting.
//
// NOTE the arms are keyed by catalogue op name, and the completeness pin
// (`test/generator/collection-op-completeness.test.ts`) asserts every
// catalogue op has a key — so a future op is a compile-time-caught omission
// rather than a silent fall-through to a verbatim `.member(...)`.

import type { ExprIR } from "../../ir/types/loom-ir.js";
import { isDescendingSort } from "../../ir/util/collection-op-site.js";
import { bodyTypeOf } from "../../util/expr-body-type.js";

// Re-exported under the path `typescript/render-expr.ts` has always used.
export { isDescendingSort };

/** Keyed renderer table — one entry per collection op.  The completeness pin
 *  (`test/generator/collection-op-completeness.test.ts`) asserts every catalogue
 *  op has a key here, so a future op is a compile-time-caught omission rather
 *  than a silent fall-through. */
export const JS_COLLECTION_RENDERERS: Record<
  string,
  (recv: string, args: string[], e?: Extract<ExprIR, { kind: "method-call" }>) => string
> = {
  count: (recv) => `${recv}.length`,
  // `sum` over MONEY (decimal.js `Decimal`) must fold with `.plus` from a
  // `new Decimal(0)` seed — a native `0 + Decimal` coerces to a string.  int/
  // long/decimal are plain `number` on this backend, so they keep the native
  // `+`/`0`-seed form.  Numeric type is the λ-body type (lambda form) or the
  // receiver's element type (no-arg `money[]` sum).
  sum: (recv, args, e) =>
    sumBodyIsMoney(e)
      ? args.length === 1
        ? `${recv}.reduce((acc, x) => acc.plus((${args[0]})(x)), new Decimal(0))`
        : `${recv}.reduce((acc, x) => acc.plus(x), new Decimal(0))`
      : args.length === 1
        ? `${recv}.reduce((acc, x) => acc + (${args[0]})(x), 0)`
        : `${recv}.reduce((acc, x) => acc + x, 0)`,
  all: (recv, args) => `${recv}.every(${args[0] ?? "() => true"})`,
  any: (recv, args) => `${recv}.some(${args[0] ?? "() => true"})`,
  // Array membership.  For value types this is JS's `.includes(value)` (===).
  // For an OBJECT element — money (decimal.js `Decimal`) or a value object —
  // `===` is reference identity and two value-equal elements never match, so
  // the membership test dispatches to a value-equality scan through the
  // element's own equality method (`.eq` / `.equals`), the same reason min/max/
  // sum special-case money.
  contains: (recv, args, e) => {
    const eqm = receiverElementEqMethod(e);
    return eqm
      ? `${recv}.some((__x) => __x.${eqm}(${args[0] ?? "undefined"}))`
      : `${recv}.includes(${args[0] ?? "undefined"})`;
  },
  where: (recv, args) => `${recv}.filter(${args[0] ?? "() => true"})`,
  first: (recv) => `${recv}[0]`,
  firstOrNull: (recv) => `(${recv}[0] ?? null)`,
  map: (recv, args) => `${recv}.map(${args[0]})`,
  sortBy: (recv, args, e) => {
    // Money keys are decimal.js `Decimal`s, whose `<`/`>` coerce via `valueOf()`
    // (a string) → LEXICOGRAPHIC order (Decimal(10) < Decimal(9)).  Compare them
    // with `.lt`/`.gt` instead, the same money special-case as min/max.
    const desc = e ? isDescendingSort(e) : false;
    const money = projectionBodyIsMoney(e);
    const cmp = money
      ? desc
        ? "kb.lt(ka) ? -1 : kb.gt(ka) ? 1 : 0"
        : "ka.lt(kb) ? -1 : ka.gt(kb) ? 1 : 0"
      : desc
        ? "kb < ka ? -1 : kb > ka ? 1 : 0"
        : "ka < kb ? -1 : ka > kb ? 1 : 0";
    return `[...${recv}].sort((__a, __b) => { const ka = (${args[0]})(__a), kb = (${args[0]})(__b); return ${cmp}; })`;
  },
  // `new Set` dedupes by SameValueZero — reference identity for objects — so a
  // `money[]` (decimal.js `Decimal` instances) or a value-object collection
  // never dedupes at all: two value-equal elements are distinct references.
  // Fall back to an equality-keyed first-occurrence filter for both, the same
  // object-element special-case the `contains`/`sum`/`sortBy`/`min`/`max` rows
  // already carry (audit A14; F2-EXPR-4 for the value-object half).
  distinct: (recv, _args, e) => {
    const eqm = receiverElementEqMethod(e);
    return eqm
      ? `${recv}.filter((__x, __i, __a) => __a.findIndex((__y) => __y.${eqm}(__x)) === __i)`
      : `[...new Set(${recv})]`;
  },
  take: (recv, args) => `${recv}.slice(0, ${args[0]})`,
  skip: (recv, args) => `${recv}.slice(${args[0]})`,
  join: (recv, args) => `${recv}.join(${args[0]})`,
  // min/max return the PROJECTED value, empty → null.  Uniform comparator-
  // reduce works for number/string/Date via `<`/`>`.  Money is decimal.js
  // `Decimal` — its `<`/`>` operators don't compare, so a money projection
  // dispatches to the `.lt`/`.gt` method form (bodyTypeOf on the lambda body).
  min: (recv, args, e) =>
    projectionBodyIsMoney(e)
      ? `(${recv}.length ? ${recv}.map(${args[0]}).reduce((__a, __b) => (__b.lt(__a) ? __b : __a)) : null)`
      : `(${recv}.length ? ${recv}.map(${args[0]}).reduce((__a, __b) => (__b < __a ? __b : __a)) : null)`,
  max: (recv, args, e) =>
    projectionBodyIsMoney(e)
      ? `(${recv}.length ? ${recv}.map(${args[0]}).reduce((__a, __b) => (__b.gt(__a) ? __b : __a)) : null)`
      : `(${recv}.length ? ${recv}.map(${args[0]}).reduce((__a, __b) => (__b > __a ? __b : __a)) : null)`,
};

/** True iff a `min`/`max` reduction's lambda body types as `money` — its
 *  projected values are decimal.js `Decimal`s, which need `.lt`/`.gt` rather
 *  than the native `<`/`>` comparators. */
export function projectionBodyIsMoney(e?: Extract<ExprIR, { kind: "method-call" }>): boolean {
  const lam = e?.args[0];
  const bodyT = lam?.kind === "lambda" && lam.body ? bodyTypeOf(lam.body) : undefined;
  return bodyT?.kind === "primitive" && bodyT.name === "money";
}

/** The VALUE-equality method a collection op's element type carries, or null
 *  when the element compares correctly with JS identity (`===`).
 *
 *  Both element kinds here are OBJECTS on this backend, so `.includes` /
 *  `new Set` compare references and silently answer wrong: `money` elements are
 *  decimal.js `Decimal`s (`.eq`), and a `valueobject` element is a generated
 *  class carrying the field-wise `equals` every VO emits (emit/value-objects.ts
 *  — a VO's defining property).  The validator ADMITS both element types on
 *  `distinct`/`contains` (`loom.distinct-non-scalar` reads "requires a scalar or
 *  value-object element"), and every other backend is structural by
 *  construction — python frozen dataclass, .NET/java records, elixir maps —
 *  so node was alone in returning duplicates from a dedupe and `false` from a
 *  membership test (F2-EXPR-4). */
function receiverElementEqMethod(
  e?: Extract<ExprIR, { kind: "method-call" }>,
): "eq" | "equals" | null {
  const rt = e?.receiverType;
  if (!rt) return null;
  const unwrapped = rt.kind === "optional" ? rt.inner : rt;
  const elem = unwrapped.kind === "array" ? unwrapped.element : undefined;
  if (elem?.kind === "primitive" && elem.name === "money") return "eq";
  if (elem?.kind === "valueobject") return "equals";
  return null;
}

/** True iff a `sum` reduction's numeric type is `money` — the λ-body type for
 *  `sum(λ)`, the receiver's element type for a no-arg `money[]` sum.  A money
 *  sum folds decimal.js `Decimal`s (`.plus` from a `new Decimal(0)` seed); a
 *  numeric sum stays native `+`/`0`. */
function sumBodyIsMoney(e?: Extract<ExprIR, { kind: "method-call" }>): boolean {
  if (!e) return false;
  const lam = e.args[0];
  if (lam?.kind === "lambda" && lam.body) {
    const bodyT = bodyTypeOf(lam.body);
    return bodyT?.kind === "primitive" && bodyT.name === "money";
  }
  const rt = e.receiverType;
  const unwrapped = rt.kind === "optional" ? rt.inner : rt;
  const elem = unwrapped.kind === "array" ? unwrapped.element : undefined;
  return elem?.kind === "primitive" && elem.name === "money";
}
