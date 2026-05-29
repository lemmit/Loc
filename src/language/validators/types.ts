// Type-system checks — binary operand compatibility, primitive
// conversions, and the leaf type-gates for property checks,
// invariants, derived fields, and function bodies.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import type {
  Aggregate,
  BinaryChain,
  DerivedProp,
  EntityPart,
  Expression,
  FunctionDecl,
  Invariant,
  MemberSuffix,
  Model,
  PostfixChain,
  PrimitiveConversion,
  Property,
} from "../generated/ast.js";
import { isBinaryChain, isDerivedProp, isMemberSuffix, isPostfixChain } from "../generated/ast.js";
import {
  arithmeticResult,
  comparable,
  type DddType,
  type Env,
  envForNode,
  isAssignable,
  resolveTypeRef,
  T,
  typeAfterSuffix,
  typeOf,
  typeToString,
} from "../type-system.js";
import {
  canPromoteAstLitTo,
  canPromoteLiteralTo,
  envForAggregate,
  envForPart,
  isInfallibleConversion,
  literalPromotionAnchor,
  warnSensitivityDrop,
} from "./_shared.js";

// ---------------------------------------------------------------------------
// Binary operand-compatibility check.
//
// Loom's type-system layer (`typeOf`) already detects invalid
// binary expressions — `arithmeticResult` returns `T.unknown` for
// mixes like `string + int`, `bool + decimal`, `money + decimal` —
// but every downstream gate that consumes a typed expression
// (`checkDerived`, `checkAssignOrCall`, etc.) suppresses errors
// when `actual.kind === "unknown"` to avoid cascading from upstream
// resolution failures.  That suppression is correct for the
// "couldn't figure it out" case (broken ref, missing member) but
// silently swallows the "this expression IS invalid" case — the
// exact bug the type-system is meant to catch.
//
// This pass walks every binary node in the model and emits an
// explicit diagnostic for operand combinations the type-system
// rejects (rather than letting the unknown propagate into the
// suppression).  Three classes:
//
//   • Arithmetic (`+ - * / %`)  — `arithmeticResult(l, r, op)` is
//     unknown.  Covers numeric / string mismatches, money / non-
//     money mixes outside the closed rules, etc.
//   • Comparison (`== != < <= > >=`) — operand types aren't
//     `comparable`.  typeOf always returns bool for these (no
//     "unknown" signal); without this rule, `string == int` would
//     silently typecheck.
//   • Logical (`&& ||`) — both operands must be bool.
//
// Cascade prevention: skips when either operand type is already
// unknown (an upstream checker has reported it; the second
// diagnostic here would duplicate the noise).
//
// Audit confirms zero impact on the existing example / fixture
// corpus (see `scripts/audit-binary-operands.mts`); pre-#506
// every silent-invalid expression had to be hand-fixed via a
// per-feature validator pass (e.g. the money rule that this
// function replaces).
// ---------------------------------------------------------------------------
export function checkBinaryOperands(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isBinaryChain(node)) continue;
    checkSingleBinaryOperands(node, accept);
  }
}

/** Reject member access on a `slot`-typed receiver — slots are
 *  opaque JSX values with no addressable fields.  Without this
 *  check, `heading.foo` on a `(heading: slot)` param silently
 *  cascades to `T.unknown` and produces either a generic
 *  "unknown member" error or no error at all (depending on the
 *  surrounding type-aware suppression).  Emits a precise
 *  diagnostic at the member position pointing the author at the
 *  type mistake. */
export function checkSlotMemberAccess(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isPostfixChain(node)) continue;
    const chain = node as PostfixChain;
    const env = envForNode(chain);
    let recvType = typeOf(chain.head, env);
    let flagged = false;
    for (const suffix of chain.suffixes) {
      if (!flagged && recvType.kind === "slot" && isMemberSuffix(suffix)) {
        const ms = suffix as MemberSuffix;
        accept(
          "error",
          `'${ms.member}' is not accessible on a slot value — slots are opaque JSX and have no addressable members.  Use a primitive- or aggregate-typed param if the body needs to read fields off this value.`,
          { node: ms, property: "member", code: "loom.slot-member-access" },
        );
        flagged = true;
        // Cascade suppression for the rest of this chain — one
        // diagnostic per offending access is enough.
      }
      recvType = typeAfterSuffix(recvType, suffix, env);
    }
  }
}

/** Validate each fold-step of a binary chain (`a + b + c` → `(a+b)+c`).
 *  Diagnostics attach with `property: "rest"` and the rhs index so
 *  the editor underlines the offending right-hand operand. */
export function checkSingleBinaryOperands(chain: BinaryChain, accept: ValidationAcceptor): void {
  const env = envForNode(chain);
  // Track the left-side type as we fold; the lhs starts as the head's
  // type, then becomes the result of the previous step.  When a
  // boolean-result op fires the chain's result is bool — that
  // doesn't change downstream validity (a chain at this precedence
  // band stays homogeneous-op).
  let lt = typeOf(chain.head, env);
  let leftExprForPromotion: Expression | undefined = chain.head;
  for (let i = 0; i < chain.ops.length; i++) {
    const op = chain.ops[i]!;
    const rhsExpr = chain.rest[i]!;
    let rt = typeOf(rhsExpr, env);
    // Cascade suppression — broken upstream already reports.
    if (lt.kind === "unknown" || rt.kind === "unknown") {
      // Update lt for next step using best-effort arithmeticResult.
      lt = arithmeticResult(lt, rt, op);
      leftExprForPromotion = undefined;
      continue;
    }
    // Literal promotion at this fold-step — mirrors lowerExpr.
    const lAnchor = literalPromotionAnchor(lt);
    const rAnchor = literalPromotionAnchor(rt);
    if (lAnchor && canPromoteAstLitTo(rhsExpr, lAnchor)) {
      rt = T.prim(lAnchor);
    }
    if (rAnchor && leftExprForPromotion && canPromoteAstLitTo(leftExprForPromotion, rAnchor)) {
      lt = T.prim(rAnchor);
    }
    const info = { node: chain, property: "rest" as const, index: i };
    if (op === "&&" || op === "||") {
      const lBool = lt.kind === "primitive" && lt.name === "bool";
      const rBool = rt.kind === "primitive" && rt.name === "bool";
      if (!lBool || !rBool) {
        accept(
          "error",
          `Operator '${op}' requires boolean operands; got '${typeToString(lt)}' and '${typeToString(rt)}'.`,
          info,
        );
      }
      lt = T.prim("bool");
      leftExprForPromotion = undefined;
      continue;
    }
    if (op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
      if (!comparable(lt, rt)) {
        accept(
          "error",
          `Operator '${op}' cannot compare '${typeToString(lt)}' with '${typeToString(rt)}'. ` +
            `Operands must be the same type, both numeric (int / long / decimal), both money, ` +
            `or one a null literal against an optional.`,
          info,
        );
      }
      lt = T.prim("bool");
      leftExprForPromotion = undefined;
      continue;
    }
    // Arithmetic: arithmeticResult returns unknown for invalid combos.
    const result = arithmeticResult(lt, rt, op);
    if (result.kind === "unknown") {
      const isMoney = (t: typeof lt) => t.kind === "primitive" && t.name === "money";
      const moneyHint =
        isMoney(lt) || isMoney(rt)
          ? ` Allowed for money: money ± money, money × {int|long|decimal}, money ÷ {int|long|decimal}.`
          : op === "+"
            ? ` Numeric arithmetic requires both operands in the int / long / decimal chain; ` +
              `string concatenation requires both operands 'string'.`
            : ` Numeric arithmetic requires both operands in the int / long / decimal chain.`;
      accept(
        "error",
        `Operator '${op}' has incompatible operand types: ` +
          `left is '${typeToString(lt)}', right is '${typeToString(rt)}'.${moneyHint}`,
        info,
      );
    }
    lt = result;
    leftExprForPromotion = undefined;
  }
}

// ---------------------------------------------------------------------------
// Primitive conversion compatibility check.
//
// Walks every `PrimitiveConversion` AST node and rejects (source,
// target) pairs that aren't in the infallible vocabulary.  See
// `docs/language.md` (conversions section) for the full table.
//
// Infallible, admitted:
//   string ← int | long | decimal | money | bool
//   long   ← int
//   decimal ← int | long | money
//   money  ← int | long | decimal
// Anything else (string → numeric / datetime / bool; narrowing
// long→int / decimal→long; etc.) errors with "not supported yet"
// pointing at the source position.
//
// The same-type identity case (`string(stringValue)`, `money(
// moneyValue)`) is admitted as a no-op — useful as an explicit
// annotation when reading code.
// ---------------------------------------------------------------------------
export function checkPrimitiveConversions(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "PrimitiveConversion") continue;
    checkSinglePrimitiveConversion(node as PrimitiveConversion, accept);
  }
}

export function checkSinglePrimitiveConversion(
  node: PrimitiveConversion,
  accept: ValidationAcceptor,
): void {
  const env = envForNode(node);
  const valueType = typeOf(node.value, env);
  // Cascade suppression: upstream resolution failure already
  // reported elsewhere.
  if (valueType.kind === "unknown") return;
  // Grammar guarantees `target` is one of the admitted strings;
  // null-guard for the langium AST's optional-prop typing.
  const target = node.target;
  if (!target) return;
  // `string(x)` admits enum + `X id` in addition to primitives —
  // every backend stringifies enum values to their case name and
  // `X id` to its underlying primitive form.  The conversion
  // vocabulary calls these "implicitly stringifiable" sources;
  // they're also the set the `string + X` implicit-concat rule
  // admits (see `arithmeticResult.isImplicitlyStringifiable`).
  if (target === "string" && (valueType.kind === "enum" || valueType.kind === "id")) {
    return;
  }
  // Aggregates with a `derived display: string` declared participate
  // in `string(x)` — lowers to a member access on the display derived.
  // Without one, the aggregate has no canonical string form and we
  // reject (forces an explicit `derived display` decision).
  if (target === "string" && valueType.kind === "aggregate") {
    if (valueType.ref.members.some((m) => isDerivedProp(m) && m.name === "display")) {
      return;
    }
    accept(
      "error",
      `Aggregate '${valueType.ref.name}' has no display form — ` +
        `declare \`derived display: string = ...\` on '${valueType.ref.name}' ` +
        `to enable \`string(${valueType.ref.name.toLowerCase()})\` and implicit ` +
        `string concatenation.`,
      { node, property: "value" },
    );
    return;
  }
  // Other domain-shaped sources (VO / entity / array) need a separate
  // design — VO/entity stringification is deferred.
  if (valueType.kind !== "primitive") {
    accept(
      "error",
      `Cannot convert '${typeToString(valueType)}' to '${target}': ` +
        `value objects, entities, and collections have no canonical string ` +
        `form.  Reference a specific field (e.g. \`string(value.<field>)\`) ` +
        `or wait for a future toString derivation.`,
      { node, property: "value" },
    );
    return;
  }
  const source = valueType.name;
  if (source === target) return; // identity no-op
  if (isInfallibleConversion(source, target)) return;
  accept(
    "error",
    `Cannot convert '${source}' to '${target}': not supported.  ` +
      `Today's conversion vocabulary admits: string ← any primitive | enum | X id; ` +
      `long ← int; decimal ← int | long | money; money ← int | long | decimal.  ` +
      `Fallible parses (string → numeric / datetime / bool) and narrowing ` +
      `(long → int, decimal → long) are deferred pending a failure-model decision.`,
    { node },
  );
}

// ---------------------------------------------------------------------------
// Leaf checks on properties / invariants / derived fields / functions.
// ---------------------------------------------------------------------------

export function checkPropertyCheck(p: Property, env: Env, accept: ValidationAcceptor): void {
  if (!p.check) return;
  const t = typeOf(p.check, env);
  if (t.kind !== "primitive" || t.name !== "bool") {
    accept(
      "error",
      `Property check on '${p.name}' must be of type 'bool', got '${typeToString(t)}'.`,
      { node: p, property: "check" },
    );
  }
}

/** Type-check a field default (`field: T = <expr>`) against the field's
 * declared type.  Mirrors `checkDerived` — literal promotion (e.g. an int
 * literal defaulting a `money` / `decimal` field) is allowed. */
export function checkPropertyDefault(p: Property, env: Env, accept: ValidationAcceptor): void {
  if (!p.default) return;
  const declared = resolveTypeRef(p.type);
  const actual = typeOf(p.default, env);
  if (
    declared.kind !== "unknown" &&
    actual.kind !== "unknown" &&
    !isAssignable(actual, declared) &&
    !canPromoteLiteralTo(p.default, declared)
  ) {
    accept(
      "error",
      `Default for '${p.name}' has type '${typeToString(actual)}' but the field is declared '${typeToString(declared)}'.`,
      { node: p, property: "default" },
    );
  }
  warnSensitivityDrop(actual, declared, accept, { node: p, property: "default" });
}

export function checkInvariant(inv: Invariant, env: Env, accept: ValidationAcceptor): void {
  const t = typeOf(inv.expr, env);
  if (t.kind !== "primitive" || t.name !== "bool") {
    accept("error", `Invariant must be of type 'bool', got '${typeToString(t)}'.`, {
      node: inv,
      property: "expr",
    });
  }
  if (inv.guard) {
    const g = typeOf(inv.guard, env);
    if (g.kind !== "primitive" || g.name !== "bool") {
      accept(
        "error",
        `Invariant guard ('when ...') must be of type 'bool', got '${typeToString(g)}'.`,
        { node: inv, property: "guard" },
      );
    }
  }
}

export function checkDerived(d: DerivedProp, env: Env, accept: ValidationAcceptor): void {
  const declared = resolveTypeRef(d.type);
  const actual = typeOf(d.expr, env);
  if (
    declared.kind !== "unknown" &&
    actual.kind !== "unknown" &&
    !isAssignable(actual, declared) &&
    !canPromoteLiteralTo(d.expr, declared)
  ) {
    accept(
      "error",
      `Derived '${d.name}' has expression of type '${typeToString(actual)}' but declared type is '${typeToString(declared)}'.`,
      { node: d, property: "expr" },
    );
  }
  warnSensitivityDrop(actual, declared, accept, { node: d, property: "expr" });
}

export function checkFunction(
  fn: FunctionDecl,
  agg: Aggregate,
  part: EntityPart | undefined,
  accept: ValidationAcceptor,
): void {
  const env = part ? envForPart(agg, part, fn) : envForAggregate(agg, fn);
  const declared = resolveTypeRef(fn.returnType);
  const actual = typeOf(fn.body, env);
  if (declared.kind !== "unknown" && actual.kind !== "unknown" && !isAssignable(actual, declared)) {
    accept(
      "error",
      `Function '${fn.name}' returns '${typeToString(actual)}' but is declared to return '${typeToString(declared)}'.`,
      { node: fn, property: "body" },
    );
  }
  warnSensitivityDrop(actual, declared, accept, { node: fn, property: "body" });
}

// Re-export DddType so consumers don't have to chase the type-system
// import surface.
export type { AstNode, DddType, Env };
