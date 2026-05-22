import type { ExprIR, InvariantIR } from "./loom-ir.js";

// ---------------------------------------------------------------------------
// Invariant classification + single-field pattern detection.
//
// Wire-boundary validation: invariants declared on aggregates /
// value-objects / operation preconditions flow down to the frontend
// (Zod refines on RHF schemas) and the Hono routes (Zod refines on
// per-route schemas) so users see field-level errors without a
// server round-trip.  The same classification drives the .NET side,
// emitting `AbstractValidator<TRequest>` rules for FluentValidation.
//
// Two pure functions live here:
//
//  - `classifyForWire`  — does this invariant translate to a wire
//    validator at all?  Decided by walking the expression and checking
//    every reference is satisfied by the request body alone (no
//    `currentUser`, no aggregate state for op requests, etc.).
//
//  - `singleFieldShape` — when an invariant has a single recognised
//    shape (`f >= N`, `f.length <= M`, etc.) we render it as an
//    idiomatic native chain (`z.number().min(N)`) instead of a generic
//    refine.  Returns null for anything outside the recognised set;
//    callers fall back to a refine.
//
// Both functions take an `available` set — the field names the
// validator can read off the request body.  For a Create<Agg>Request,
// that's the aggregate's required fields.  For an <Op>Request, it's
// the operation's parameter names.  For a value-object schema, it's
// the value-object's fields.  Refs to anything outside that set make
// the invariant non-translatable.
// ---------------------------------------------------------------------------

export interface ClassifyContext {
  /** Field / param names that the request body carries — the only
   *  identifiers a wire validator can read.  Includes lambda
   *  parameters introduced inside the expression, which we track
   *  separately to allow collection ops with predicate lambdas. */
  available: ReadonlySet<string>;
}

/** Returns true iff the invariant can run at the wire boundary
 *  (Zod refine on the frontend / Hono route, FluentValidation rule
 *  on .NET) for the given context.  Server-only invariants always
 *  return false. */
export function classifyForWire(inv: InvariantIR, ctx: ClassifyContext): boolean {
  if (inv.scope === "server-only") return false;
  if (!exprIsTranslatable(inv.expr, ctx)) return false;
  if (inv.guard && !exprIsTranslatable(inv.guard, ctx)) return false;
  return true;
}

function exprIsTranslatable(
  e: ExprIR,
  ctx: ClassifyContext,
  scope: ReadonlySet<string> = ctx.available,
): boolean {
  switch (e.kind) {
    case "literal":
      // `now()` is server-side — every other literal is fine.
      return e.lit !== "now";
    case "this":
      // A bare `this` reference is always server-side state.
      return false;
    case "id":
      return false;
    case "ref":
      switch (e.refKind) {
        case "param":
        case "let":
        case "lambda":
          return scope.has(e.name);
        case "this-prop":
        case "this-vo-prop":
          return scope.has(e.name);
        case "this-derived":
          // Derived getters traverse aggregate state at runtime —
          // can't run in the browser.
          return false;
        case "helper-fn":
          // Helper functions on aggregates / VOs read state.
          return false;
        case "enum-value":
          return true;
        case "current-user":
          return false;
        case "unknown":
          return false;
      }
      return false;
    case "member":
      // Member access on a translatable receiver is fine when it's
      // a property the wire shape carries (`.length`, `.count`, named
      // value-object fields).  We treat it as translatable iff the
      // receiver itself is — JS/Zod can dot-walk anything the
      // request body shape carries.
      return exprIsTranslatable(e.receiver, ctx, scope);
    case "method-call": {
      if (!exprIsTranslatable(e.receiver, ctx, scope)) return false;
      // `String.matches(literal)` etc. and collection ops (`all`/`any`/…)
      // are translatable when every arg is. A collection op's predicate is
      // a lambda — the "lambda" case below adds its parameter to `scope`.
      return e.args.every((a) => exprIsTranslatable(a, ctx, scope));
    }
    case "call":
      // Free / function / private-operation / VO-ctor calls:
      //   - VO ctors are translatable when every arg is (used in
      //     refine bodies that reconstruct the VO inside JS — but
      //     we currently only emit refines on already-typed
      //     fields, so leave VO ctors as non-translatable for
      //     21.A; can be lifted later).
      //   - The others read aggregate state.
      return false;
    case "lambda": {
      const inner = new Set(scope);
      inner.add(e.param);
      // Lambda body is now optional (block-body lambdas land
      // for page event handlers).  Block bodies are always
      // server-side (mutate state, navigate, call mutations) — never
      // wire-translatable.  Single-expression lambdas keep their
      // existing translatability rule.
      if (!e.body) return false;
      return exprIsTranslatable(e.body, ctx, inner);
    }
    case "new":
    case "object":
      return e.fields.every((f) => exprIsTranslatable(f.value, ctx, scope));
    case "paren":
      return exprIsTranslatable(e.inner, ctx, scope);
    case "unary":
      return exprIsTranslatable(e.operand, ctx, scope);
    case "binary":
      return exprIsTranslatable(e.left, ctx, scope) && exprIsTranslatable(e.right, ctx, scope);
    case "ternary":
      return (
        exprIsTranslatable(e.cond, ctx, scope) &&
        exprIsTranslatable(e.then, ctx, scope) &&
        exprIsTranslatable(e.otherwise, ctx, scope)
      );
    case "match":
      // A match expression is wire-translatable iff every arm
      // condition + value plus the `else` branch is.  Same posture
      // as ternary — all sub-expressions must be translatable.
      return (
        e.arms.every(
          (arm) =>
            exprIsTranslatable(arm.cond, ctx, scope) && exprIsTranslatable(arm.value, ctx, scope),
        ) &&
        (e.otherwise === undefined || exprIsTranslatable(e.otherwise, ctx, scope))
      );
  }
}

// ---------------------------------------------------------------------------
// Single-field pattern detection
// ---------------------------------------------------------------------------

export type SingleFieldPattern =
  | { kind: "min"; n: number } // f >= N (numeric)
  | { kind: "max"; n: number } // f <= N (numeric)
  | { kind: "between"; lo: number; hi: number } // f >= N && f <= M
  | { kind: "len-min"; n: number } // f.length >= N
  | { kind: "len-max"; n: number } // f.length <= N
  | { kind: "len-eq"; n: number } // f.length == N
  | { kind: "len-range"; lo: number; hi: number } // f.length >= N && f.length <= M
  | { kind: "regex"; pattern: string }; // f.matches("…")

/** Detect the recognised "single-field" invariant shapes that map to
 *  idiomatic native chain calls (`z.number().min(N)`,
 *  `RuleFor(...).MaximumLength(N)`, etc.).  Returns the field name +
 *  pattern when matched, otherwise null — callers then emit a
 *  generic refine / Must predicate. */
export function singleFieldShape(
  inv: InvariantIR,
): { field: string; pattern: SingleFieldPattern } | null {
  if (inv.guard) return null; // guarded shapes always fall through to refine
  return matchSingleField(inv.expr);
}

function matchSingleField(e: ExprIR): { field: string; pattern: SingleFieldPattern } | null {
  if (e.kind === "paren") return matchSingleField(e.inner);

  // `<field>.matches("literal")` → regex pattern.
  const regex = matchesCall(e);
  if (regex) return regex;

  // Compound on a single field — recognised pairs are absorbed
  // into idiomatic native chains (between for numeric, two
  // chained `min/max` calls for string length).  The classifier
  // returns one of the recognised compound shapes; anything
  // outside this set falls through to a generic refine.
  if (e.kind === "binary" && e.op === "&&") {
    const lo = matchSingleField(e.left);
    const hi = matchSingleField(e.right);
    if (lo && hi && lo.field === hi.field) {
      // Numeric `f >= N && f <= M`.
      if (lo.pattern.kind === "min" && hi.pattern.kind === "max") {
        return {
          field: lo.field,
          pattern: { kind: "between", lo: lo.pattern.n, hi: hi.pattern.n },
        };
      }
      // String `f.length >= N && f.length <= M` — uses `len-range`
      // to chain `.min(N).max(M)` on a `z.string()` base / `.Length(N, M)`
      // on a FluentValidation rule.
      if (lo.pattern.kind === "len-min" && hi.pattern.kind === "len-max") {
        return {
          field: lo.field,
          pattern: { kind: "len-range", lo: lo.pattern.n, hi: hi.pattern.n },
        };
      }
    }
    return null;
  }

  if (e.kind !== "binary") return null;

  // Each comparison: left = field-or-length-of-field, right = numeric literal
  const left = e.left;
  const right = e.right;

  const numLit = numericLiteral(right);
  if (numLit === null) return null;

  // Field reference (string `len-*` patterns rely on `.length` on a
  // string-typed field, numeric `min/max` rely on a bare numeric
  // field reference).
  const lenField = lengthFieldRef(left);
  if (lenField !== null) {
    switch (e.op) {
      case ">=":
        return { field: lenField, pattern: { kind: "len-min", n: numLit } };
      case ">":
        return {
          field: lenField,
          pattern: { kind: "len-min", n: numLit + 1 },
        };
      case "<=":
        return { field: lenField, pattern: { kind: "len-max", n: numLit } };
      case "<":
        return {
          field: lenField,
          pattern: { kind: "len-max", n: numLit - 1 },
        };
      case "==":
        return { field: lenField, pattern: { kind: "len-eq", n: numLit } };
      default:
        return null;
    }
  }

  const numField = numericFieldRef(left);
  if (numField !== null) {
    switch (e.op) {
      case ">=":
        return { field: numField, pattern: { kind: "min", n: numLit } };
      case ">":
        return { field: numField, pattern: { kind: "min", n: numLit + 1 } };
      case "<=":
        return { field: numField, pattern: { kind: "max", n: numLit } };
      case "<":
        return { field: numField, pattern: { kind: "max", n: numLit - 1 } };
      default:
        return null;
    }
  }

  return null;
}

function numericLiteral(e: ExprIR): number | null {
  if (e.kind !== "literal") return null;
  if (e.lit !== "int" && e.lit !== "decimal") return null;
  const n = Number(e.value);
  return Number.isFinite(n) ? n : null;
}

/** Returns the field name when `e` is `<field>.length` rooted in a
 *  this-prop / this-vo-prop / param ref; otherwise null. */
function lengthFieldRef(e: ExprIR): string | null {
  if (e.kind !== "member" || e.member !== "length") return null;
  const recv = e.receiver;
  if (recv.kind !== "ref") return null;
  if (recv.refKind === "this-prop" || recv.refKind === "this-vo-prop" || recv.refKind === "param") {
    return recv.name;
  }
  return null;
}

/** Recognises `<field>.matches("literal")` as the `regex` single-field
 *  pattern.  String-typed receiver only; argument must be a string
 *  literal (the parser-time validator already enforces the latter
 *  for the `matches` operator). */
function matchesCall(e: ExprIR): { field: string; pattern: SingleFieldPattern } | null {
  if (e.kind !== "method-call" || e.member !== "matches") return null;
  if (e.args.length !== 1) return null;
  const arg = e.args[0]!;
  if (arg.kind !== "literal" || arg.lit !== "string") return null;
  const recv = e.receiver;
  if (recv.kind !== "ref") return null;
  if (recv.refKind !== "this-prop" && recv.refKind !== "this-vo-prop" && recv.refKind !== "param") {
    return null;
  }
  return { field: recv.name, pattern: { kind: "regex", pattern: arg.value } };
}

/** Returns the field name when `e` is a bare reference to a request-
 *  body field (this-prop, this-vo-prop, or operation param). */
function numericFieldRef(e: ExprIR): string | null {
  if (e.kind !== "ref") return null;
  if (e.refKind === "this-prop" || e.refKind === "this-vo-prop" || e.refKind === "param") {
    return e.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Error-path attribution — for `.refine(..., { path: [field] })`.
// ---------------------------------------------------------------------------

/** Pick the field name to attribute a refine's error to.  When the
 *  invariant is single-field-shaped, that field is the path.
 *  Otherwise we walk the expression and return the FIRST field-name
 *  ref we encounter — heuristic, but matches user expectation
 *  (cross-field rules tend to mention the "primary" field first).
 *  Returns null if no field reference is in scope; callers omit
 *  `path` and the error attaches to the form root. */
export function pickErrorPath(inv: InvariantIR): string | null {
  const single = singleFieldShape(inv);
  if (single) return single.field;
  return firstFieldRef(inv.expr);
}

function firstFieldRef(e: ExprIR): string | null {
  switch (e.kind) {
    case "ref":
      if (e.refKind === "this-prop" || e.refKind === "this-vo-prop" || e.refKind === "param") {
        return e.name;
      }
      return null;
    case "member":
      return firstFieldRef(e.receiver);
    case "method-call":
      return (
        firstFieldRef(e.receiver) ??
        e.args.reduce<string | null>((acc, a) => acc ?? firstFieldRef(a), null)
      );
    case "binary":
      return firstFieldRef(e.left) ?? firstFieldRef(e.right);
    case "unary":
      return firstFieldRef(e.operand);
    case "paren":
      return firstFieldRef(e.inner);
    case "ternary":
      return firstFieldRef(e.cond) ?? firstFieldRef(e.then) ?? firstFieldRef(e.otherwise);
    case "call":
      return e.args.reduce<string | null>((acc, a) => acc ?? firstFieldRef(a), null);
    case "lambda":
      // Lambda body is now optional.  Block-body lambdas
      // appear only in event handlers (page metamodel), never in
      // wire-validating predicate bodies — fall through to null.
      if (e.body) return firstFieldRef(e.body);
      return null;
    case "new":
    case "object":
      return e.fields.reduce<string | null>((acc, f) => acc ?? firstFieldRef(f.value), null);
    case "match":
      // First arm (cond, then value), then the `else` branch — same
      // left-to-right walk semantics as `ternary`.
      for (const arm of e.arms) {
        const fromCond = firstFieldRef(arm.cond);
        if (fromCond) return fromCond;
        const fromValue = firstFieldRef(arm.value);
        if (fromValue) return fromValue;
      }
      return e.otherwise ? firstFieldRef(e.otherwise) : null;
    case "literal":
    case "this":
    case "id":
      return null;
  }
}
