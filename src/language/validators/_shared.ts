// Helpers shared by two or more themed validator modules.  Anything
// used by only one module lives there directly.
//
// Categories:
//   * Env builders (`envForAggregate` / `envForPart` / `envForValueObject`) —
//     shared by `structural.ts` (aggregate / part / value-object walks),
//     `statements.ts` (operation body walk), and `types.ts`.
//   * `warnSensitivityDrop` — shared by `types.ts` (derived / function)
//     and `statements.ts` (assign / emit).
//   * Literal-promotion gates (`canPromoteLiteralTo` / `canPromoteAstLitTo`
//     / `literalPromotionAnchor`) — shared by `types.ts`
//     (`checkDerived`, `checkSingleBinaryOperands`) and `statements.ts`
//     (`checkAssignOrCall`).
//   * `isInfallibleConversion` — used by `types.ts` only today, but
//     conceptually a type-system helper so kept here for visibility.
//   * `pathString` — used by `statements.ts` only; kept here because it
//     reads LValue and is a generic AST-formatting concern.
//   * Page / api walking helpers used by `ui.ts`.

import type { AstNode } from "langium";
import {
  type Aggregate,
  type DerivedProp,
  type EntityPart,
  type FunctionDecl,
  isContainment,
  isDecLit,
  isDerivedProp,
  isIntLit,
  isProperty,
  type LValue,
  type Subdomain,
  type ValueObject,
} from "../generated/ast.js";
import {
  type DddType,
  type Env,
  makeEnv,
  paramType,
  propertySensitivity,
  resolveTypeRef,
  sensitivityNarrows,
  T,
  typeToString,
  withTags,
} from "../type-system.js";

// ---------------------------------------------------------------------------
// Env builders
// ---------------------------------------------------------------------------

export function envForAggregate(agg: Aggregate, fn?: FunctionDecl): Env {
  const bindings = new Map<string, { type: DddType; origin: AstNode }>();
  // Aggregate properties / derived / contains are in scope as bare
  // identifiers — same as if we accessed them via `this`.  Property
  // bindings attach the declared sensitivity tags so propagation
  // inside operation bodies sees them.
  for (const m of agg.members) {
    if (isProperty(m))
      bindings.set(m.name, {
        type: withTags(resolveTypeRef(m.type), propertySensitivity(m)),
        origin: m,
      });
    else if (isDerivedProp(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
    else if (isContainment(m)) {
      const part = m.partType?.ref;
      if (part) {
        const t: DddType = { kind: "entity", ref: part };
        bindings.set(m.name, { type: m.collection ? T.array(t) : t, origin: m });
      }
    }
  }
  if (fn) for (const p of fn.params) bindings.set(p.name, { type: paramType(p), origin: p });
  return makeEnv(undefined, bindings, { aggregate: agg });
}

export function envForPart(agg: Aggregate, part: EntityPart, fn?: FunctionDecl): Env {
  const bindings = new Map<string, { type: DddType; origin: AstNode }>();
  for (const m of part.members) {
    if (isProperty(m))
      bindings.set(m.name, {
        type: withTags(resolveTypeRef(m.type), propertySensitivity(m)),
        origin: m,
      });
    else if (isDerivedProp(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
    else if (isContainment(m)) {
      const partType = m.partType?.ref;
      if (partType) {
        const t: DddType = { kind: "entity", ref: partType };
        bindings.set(m.name, { type: m.collection ? T.array(t) : t, origin: m });
      }
    }
  }
  if (fn) for (const p of fn.params) bindings.set(p.name, { type: paramType(p), origin: p });
  return makeEnv(undefined, bindings, { aggregate: agg, part });
}

export function envForValueObject(vo: ValueObject): Env {
  const bindings = new Map<string, { type: DddType; origin: AstNode }>();
  for (const m of vo.members) {
    if (isProperty(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
    else if (isDerivedProp(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
  }
  return makeEnv(undefined, bindings, { valueObject: vo });
}

// ---------------------------------------------------------------------------
// Sensitivity-narrowing warning
// ---------------------------------------------------------------------------

/** Emit a warning when a value's sensitivity tags would be silently
 *  dropped flowing into a less-sensitive target.  Implicit conversion
 *  is permitted by `isAssignable`; this surfaces it. */
export function warnSensitivityDrop(
  actual: DddType,
  expected: DddType,
  accept: import("langium").ValidationAcceptor,
  info: { node: AstNode; property?: string },
): void {
  if (actual.kind === "unknown" || expected.kind === "unknown") return;
  const dropped = sensitivityNarrows(actual, expected);
  if (!dropped) return;
  accept(
    "warning",
    `Implicit conversion drops sensitivity tag(s) {${dropped.join(", ")}}: '${typeToString(actual)}' flows into '${typeToString(expected)}'.`,
    info,
  );
}

// ---------------------------------------------------------------------------
// Literal-promotion gates
// ---------------------------------------------------------------------------

/**
 * Literal-promotion gate.  A bare numeric literal (IntLit or DecLit)
 * may flow into a typed numeric / money target context — the
 * lowering layer elaborates the literal to the matching IR literal
 * kind so backends emit the right form (`new Decimal("373.34")` for
 * money, `5L` for large long literals in C#, `5m` for decimal
 * literals in C#).  Mirrors `lowerExprInContext` in
 * `lower-expr.ts`; the validator MUST stay in lockstep so the
 * strict gates (`isAssignable`, comparable, arithmeticResult) don't
 * reject what the lowering happily elaborates.
 *
 * The promotion is one-sided.  A typed VALUE (e.g. a `taxRate:
 * decimal` field used opposite money, or a `count: int` field used
 * opposite long) still rejects — the rule fires only on AST forms
 * that are bare numeric literals, not on typed expressions that
 * happen to resolve to a numeric type.  Keeps strict-mode
 * guarantees intact while letting ergonomic source forms typecheck.
 *
 * Promotions admitted:
 *   IntLit / DecLit → money   (the original #508 case)
 *   IntLit          → long    (C# `L` suffix — without elaboration,
 *                              long literals > Int32.MaxValue
 *                              silently overflow at .NET compile time)
 *   IntLit          → decimal (C# `m` suffix; IR type-honesty)
 * DecLit → long / int is intentionally NOT admitted — a fractional
 * literal in an integer context is almost certainly a typo and the
 * strict gate should surface it.
 */
export function canPromoteLiteralTo(
  expr: import("../generated/ast.js").Expression | undefined,
  target: DddType,
): boolean {
  if (!expr) return false;
  if (target.kind !== "primitive") return false;
  return canPromoteAstLitTo(expr, target.name);
}

/** Inner gate used by both `canPromoteLiteralTo` (top-level checks)
 *  and `checkSingleBinaryOperands` (per-operand checks).  Takes a
 *  bare target name (not a wrapped `DddType`) so the caller doesn't
 *  have to box the type they already have in hand. */
export function canPromoteAstLitTo(
  expr: import("../generated/ast.js").Expression | undefined,
  target: string,
): boolean {
  if (!expr) return false;
  if (target === "money") return isIntLit(expr) || isDecLit(expr);
  if (target === "long" || target === "decimal") return isIntLit(expr);
  return false;
}

/** Mirror of `lower-expr.ts`'s `literalPromotionAnchor`: when one
 *  side of a binary expression is typed as long / decimal / money,
 *  that type is the "anchor" a bare numeric literal on the other
 *  side promotes against.  int isn't an anchor — every IntLit
 *  already types as int. */
export function literalPromotionAnchor(t: DddType): "long" | "decimal" | "money" | null {
  if (t.kind !== "primitive") return null;
  if (t.name === "long" || t.name === "decimal" || t.name === "money") return t.name;
  return null;
}

// ---------------------------------------------------------------------------
// Primitive-conversion admissibility table
// ---------------------------------------------------------------------------

/**
 * Allowed (source, target) primitive-conversion pairs.  Each pair is
 * infallible at runtime — no parse failures, no precision overflow.
 * Identity (source === target) is admitted separately by the caller
 * as a no-op.
 *
 * Pairs:
 *   string ← int | long | decimal | money | bool
 *   long   ← int                              (widening)
 *   decimal ← int | long                      (widening)
 *   decimal ← money                           (lossy projection)
 *   money  ← int | long | decimal             (widening)
 *
 * Notably absent:
 *   - string → anything else (parse-fallible; needs `T?`/throw design)
 *   - narrowing (long→int, decimal→long, money→{int,long})
 *   - datetime / guid / enum conversions (separate design — backend-
 *     specific format choices)
 */
export function isInfallibleConversion(source: string, target: string): boolean {
  if (target === "string") {
    return (
      source === "int" ||
      source === "long" ||
      source === "decimal" ||
      source === "money" ||
      source === "bool"
    );
  }
  if (target === "long") return source === "int";
  if (target === "decimal") {
    return source === "int" || source === "long" || source === "money";
  }
  if (target === "money") {
    return source === "int" || source === "long" || source === "decimal";
  }
  return false;
}

// ---------------------------------------------------------------------------
// LValue formatter
// ---------------------------------------------------------------------------

export function pathString(lv: LValue): string {
  return [lv.head, ...lv.tail].join(".");
}

// ---------------------------------------------------------------------------
// Page / api helpers used by ui.ts
// ---------------------------------------------------------------------------

/** Find an Aggregate by name across the contexts of a Subdomain. */
export function findAggregateInModule(mod: Subdomain, name: string): Aggregate | undefined {
  for (const ctx of mod.contexts ?? []) {
    for (const am of ctx.members ?? []) {
      if (am.$type === "Aggregate" && am.name === name) return am;
    }
  }
  return undefined;
}

/** Standard CRUD operation names that the api auto-derives for
 *  every aggregate, plus the aggregate's repository finds.
 *  Repositories live at the BoundedContext level (peer to
 *  aggregates), declared as `repository <Name> for <Aggregate>`,
 *  so we walk the aggregate's container context to find ones
 *  pointing at this aggregate. */
export function listValidApiOperations(agg: Aggregate): string[] {
  const ops = new Set<string>(["all", "byId", "create", "update", "delete"]);
  // Public `operation`s declared on the aggregate are exposed as api routes
  // (each gets a `use<Op><Agg>` frontend hook) — so a UI body may call them
  // off the api handle (`Sales.Order.placeOrder()`), including as the awaited
  // subject of a variant-`match` (async-actions-and-effects.md Stage 2).
  for (const m of agg.members ?? []) {
    if (m.$type === "Operation" && !m.private) ops.add(m.name);
  }
  const ctx = agg.$container;
  if (ctx?.$type === "BoundedContext") {
    for (const m of ctx.members ?? []) {
      if (m.$type !== "Repository") continue;
      if (m.aggregate?.ref !== agg) continue;
      for (const f of m.finds ?? []) ops.add(f.name);
    }
  }
  return [...ops].sort();
}

export function isValidApiOperation(agg: Aggregate, op: string): boolean {
  return listValidApiOperations(agg).includes(op);
}

/** Map of PageProp $type names back to the source-side property
 *  name for diagnostics.  Used by `checkPage`'s duplicate-property
 *  message. */
export function pagePropDisplayName(typeName: string): string {
  switch (typeName) {
    case "RouteProp":
      return "route";
    case "TitleProp":
      return "title";
    case "RequiresProp":
      return "requires";
    case "BodyProp":
      return "body";
    case "PageMenuMeta":
      return "menu";
    case "LayoutProp":
      return "layout";
    case "DescriptionProp":
      return "description";
    case "OgImageProp":
      return "ogImage";
    case "CanonicalProp":
      return "canonical";
    default:
      return typeName;
  }
}

/** `loom.blank-message` — reject an empty or whitespace-only `message "..."`
 *  clause on an `invariant` / property `check` / `precondition`.  A blank
 *  message renders an empty user-facing error string, which is useless and
 *  almost always a typo (`message ""`).  (It also feeds the per-error wire
 *  `code`, which is content-hashed from the message text per D-I18N-KEY, so a
 *  blank message degenerates that key too — but the empty display string is
 *  the real problem.)  `STRING` strips its delimiters, so `message ""` reaches
 *  here as `""`.  Shared by `types.ts` (invariant / property check) and
 *  `statements.ts` (precondition). */
export function checkBlankMessage(
  node: AstNode,
  message: string | undefined,
  accept: import("langium").ValidationAcceptor,
): void {
  if (message !== undefined && message.trim() === "") {
    accept("error", "A 'message' clause must not be blank.", {
      node,
      property: "message",
      code: "loom.blank-message",
    });
  }
}

// Used by derived-prop check on aggregates / value objects to test
// the lvalue path's final segment.
export type { DerivedProp };
