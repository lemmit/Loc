// Type-system checks — binary operand compatibility, primitive
// conversions, and the leaf type-gates for property checks,
// invariants, derived fields, and function bodies.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import { intrinsicMatcherSig, isIntrinsicMatcher } from "../../util/intrinsic-matchers.js";
import { intrinsicFor, intrinsicMinArity, intrinsicsForReceiver } from "../../util/intrinsics.js";
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
  Parameter,
  PostfixChain,
  PrimitiveConversion,
  Property,
  TernaryExpr,
} from "../generated/ast.js";
import {
  isBinaryChain,
  isDerivedProp,
  isLambda,
  isLetStmt,
  isMemberSuffix,
  isPostfixChain,
  isPreconditionStmt,
  isRequiresStmt,
  isReturnStmt,
  isTernaryExpr,
  isUi,
} from "../generated/ast.js";
import {
  absentRecordMember,
  arithmeticResult,
  comparable,
  type DddType,
  type Env,
  envForNode,
  isAssignable,
  makeEnv,
  resolveTypeRef,
  T,
  ternaryJoin,
  typeAfterSuffix,
  typeOf,
  typeToString,
} from "../type-system.js";
import {
  canPromoteAstLitTo,
  canPromoteLiteralTo,
  checkBlankMessage,
  envForAggregate,
  envForPart,
  isInfallibleConversion,
  literalPromotionAnchor,
  warnSensitivityDrop,
} from "./_shared.js";
import { checkConstructionArgTypes, checkExprCallArgs } from "./statements.js";

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

/** Reject access to a member that doesn't exist on a fully-resolved record
 *  receiver — `order.totl`, `paid.amont`, `this.noSuchField`.  Without this
 *  an undefined-field access cascades silently to `T.unknown`, and because
 *  the operand validators suppress on `unknown` (anti-double-reporting), the
 *  typo produces *no* diagnostic anywhere.  Fail-open by construction
 *  (`absentRecordMember`): fires only when the receiver is a record we can
 *  fully enumerate (aggregate / entity / value object / event / payload, or
 *  an `X id` resolving to one) and the member is definitively absent — never
 *  on arrays (collection ops), primitives (`.length`), magic identifiers, or
 *  any receiver that already typed as `unknown`. */
/** Collection aggregations that fold the collection through a lambda and have
 *  NO renderable bare form — `prices.sum` types as a value but emits a
 *  non-existent `.sum` property on every backend.  The documented form is
 *  `xs.sum(x => …)`.  `count` (→ `.length`) is the only bare collection
 *  accessor any backend renders, so it stays legal (C11). */
const BARE_REJECTED_COLLECTION_ACCESSORS: ReadonlySet<string> = new Set([
  "sum",
  "avg",
  "min",
  "max",
]);

export function checkUnknownMemberAccess(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isPostfixChain(node)) continue;
    const chain = node as PostfixChain;
    const env = envForNode(chain);
    let recvType = typeOf(chain.head, env);
    for (const suffix of chain.suffixes) {
      if (isMemberSuffix(suffix)) {
        const ms = suffix as MemberSuffix;
        // Test-assertion matchers (`expect(x).toThrow()` / `.toBe(…)`) are an
        // intrinsic surface, not domain members — they may sit on any receiver
        // type (a value-object `expect(Money{…}).toThrow()` included), so the
        // matcher terminates the chain rather than reporting an unknown member.
        if (intrinsicMatcherSig(ms.member)) break;
        // Bare collection aggregation (`prices.sum`, no lambda call) — admitted
        // by the type system but unrenderable.  Reject with the lambda form (C11).
        if (
          recvType.kind === "array" &&
          !ms.call &&
          BARE_REJECTED_COLLECTION_ACCESSORS.has(ms.member)
        ) {
          accept(
            "error",
            `'${ms.member}' over a collection needs a lambda — write '<collection>.${ms.member}(x => …)'. A bare '.${ms.member}' has no renderable form.`,
            { node: ms, property: "member", code: "loom.bare-collection-accessor" },
          );
          break;
        }
        const record = absentRecordMember(recvType, ms.member);
        if (record) {
          accept("error", `'${ms.member}' is not a member of '${record}'.`, {
            node: ms,
            property: "member",
            code: "loom.unknown-member",
          });
          // Stop walking this chain — the receiver is now indeterminate and
          // any further suffix would cascade off the unresolved access.
          break;
        }
      }
      recvType = typeAfterSuffix(recvType, suffix, env);
    }
  }
}

/** Numeric primitives an `avg(λ)` projection may average over. */
const AVG_NUMERIC_PRIMITIVES: ReadonlySet<string> = new Set(["int", "long", "decimal", "money"]);

/** AST-level gate for `avg(λ)`.  Unlike `min`/`max`, `avg` DESUGARS during
 *  lowering to `count == 0 ? null : sum(λ) / count` — so the IR validator
 *  (which runs post-lowering) never sees an `avg` node.  The two checks it
 *  would otherwise carry must therefore fire here, at the AST level:
 *   • `loom.avg-non-numeric` — the λ-body must be int/long/decimal/money;
 *     an average of anything else is meaningless.
 *   • `loom.collection-op-in-ui` — like the other reducing collection ops
 *     (`min`/`max`/`sortBy`/…), `avg` has no renderable page-body form.
 *  Fail-open on an `unknown` λ-body (an upstream checker already reported it). */
export function checkAvgProjection(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isPostfixChain(node)) continue;
    const chain = node as PostfixChain;
    const env = envForNode(chain);
    let recvType = typeOf(chain.head, env);
    for (const suffix of chain.suffixes) {
      if (isMemberSuffix(suffix) && suffix.member === "avg" && recvType.kind === "array") {
        const ms = suffix as MemberSuffix;
        const elem = recvType.element;
        // UI page-body position — no renderable frontend form (parity with the
        // IR-level `loom.collection-op-in-ui` gate the desugar bypasses).
        if (AstUtils.getContainerOfType(ms, isUi)) {
          accept(
            "error",
            "collection op '.avg' isn't available in a page body — only 'map' and 'join' render on the frontend; do the transformation in a view or derived property instead.",
            { node: ms, property: "member", code: "loom.collection-op-in-ui" },
          );
        }
        // λ-body must be a numeric primitive.
        const lambdaArg = ms.args[0]?.value;
        if (lambdaArg && isLambda(lambdaArg) && lambdaArg.body) {
          const lambdaEnv = makeEnv(
            env,
            new Map([[lambdaArg.param, { type: elem, origin: lambdaArg }]]),
          );
          const bodyT = typeOf(lambdaArg.body, lambdaEnv);
          if (
            bodyT.kind !== "unknown" &&
            !(bodyT.kind === "primitive" && AVG_NUMERIC_PRIMITIVES.has(bodyT.name))
          ) {
            accept(
              "error",
              "`.avg` requires a numeric projection (int, long, decimal, or money).",
              { node: ms, property: "member", code: "loom.avg-non-numeric" },
            );
          }
        }
      }
      recvType = typeAfterSuffix(recvType, suffix, env);
    }
  }
}

/** Validate scalar-intrinsic calls (src/util/intrinsics.ts) against their
 *  catalogue signature — call form, arity, no named args, and argument
 *  primitive types.  Fail-open everywhere the receiver or an argument
 *  types as `unknown` (anti-double-reporting, like the operand checks). */
export function checkIntrinsicCalls(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isPostfixChain(node)) continue;
    const chain = node as PostfixChain;
    const env = envForNode(chain);
    let recvType = typeOf(chain.head, env);
    for (const suffix of chain.suffixes) {
      if (isMemberSuffix(suffix) && recvType.kind === "primitive") {
        const ms = suffix as MemberSuffix;
        const sig = intrinsicFor(recvType.name, ms.member);
        if (sig) {
          if (!ms.call) {
            accept(
              "error",
              `'${ms.member}' is an intrinsic operation and needs a call — write '.${ms.member}${sig.signature.split("):")[0]})'.`,
              { node: ms, property: "member", code: "loom.intrinsic-bare" },
            );
            break;
          }
          const min = intrinsicMinArity(sig);
          if (ms.args.length < min || ms.args.length > sig.params.length) {
            const expected = min === sig.params.length ? `${min}` : `${min}–${sig.params.length}`;
            accept(
              "error",
              `'${ms.member}' takes ${expected} argument(s) — signature: ${ms.member}${sig.signature}.`,
              { node: ms, property: "args", code: "loom.intrinsic-arity" },
            );
            break;
          }
          for (let i = 0; i < ms.args.length; i++) {
            const argWrap = ms.args[i]!;
            if (argWrap.name) {
              accept("error", `'${ms.member}' takes positional arguments only.`, {
                node: argWrap,
                property: "name",
                code: "loom.intrinsic-named-arg",
              });
              break;
            }
            const expected = T.prim(sig.params[i]!.replace("?", "") as never);
            const actual = typeOf(argWrap.value, env);
            if (
              actual.kind !== "unknown" &&
              !isAssignable(actual, expected) &&
              !canPromoteLiteralTo(argWrap.value, expected)
            ) {
              accept(
                "error",
                `'${ms.member}' argument ${i + 1} is '${typeToString(actual)}' but the signature ${ms.member}${sig.signature} expects '${typeToString(expected)}'.`,
                { node: argWrap, property: "value", code: "loom.intrinsic-arg-type" },
              );
            }
          }
        } else if (
          ms.call &&
          !isIntrinsicMatcher(ms.member) &&
          !(recvType.name === "string" && ms.member === "matches")
        ) {
          // Strict unknown-intrinsic gate: a CALL on a known primitive
          // receiver that matches no catalogue row (and is neither the
          // string regex `matches` nor a test matcher) used to fail open —
          // rendering garbage per backend.  Bare member ACCESS stays
          // un-gated (string `.length` is legal; future field-style members
          // shouldn't need a catalogue change to parse).
          const known = intrinsicsForReceiver(recvType.name)
            .map((s) => s.name)
            .join(", ");
          accept(
            "error",
            `'${recvType.name}' has no intrinsic '.${ms.member}()'${known ? ` — available: ${known}` : ""}.`,
            { node: ms, property: "member", code: "loom.intrinsic-unknown" },
          );
          break;
        }
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
// Ternary expression check (`cond ? a : b`).
//
// `typeOf(TernaryExpr)` returns the JOIN of the two branches, but — like the
// binary-operand class above — it can't *reject* an ill-formed ternary on its
// own: a non-bool condition and two branches that share no supertype both
// produce a type silently (the then-branch), and every downstream gate then
// suppresses on `unknown` or accepts the fallback.  This pass makes both
// illegal shapes explicit:
//
//   • Condition — must be `bool` (`s ? 1 : 2` with a `string` `s` is a bug).
//   • Branches  — must join: one branch's type assignable to the other, or a
//     shared numeric / optional / null supertype (`ternaryJoin`).  `f ? 1 :
//     "oops"` (int vs string) has no join and is rejected.
//
// Cascade suppression: skips the condition report when the condition already
// typed `unknown`, and the branch report when either branch did — an upstream
// checker (unknown name / member) has already reported those.
// ---------------------------------------------------------------------------
export function checkTernaryExprs(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isTernaryExpr(node)) continue;
    checkSingleTernary(node as TernaryExpr, accept);
  }
}

export function checkSingleTernary(node: TernaryExpr, accept: ValidationAcceptor): void {
  const env = envForNode(node);
  const condT = typeOf(node.cond, env);
  if (condT.kind !== "unknown" && !(condT.kind === "primitive" && condT.name === "bool")) {
    accept("error", `Ternary condition must be of type 'bool', got '${typeToString(condT)}'.`, {
      node,
      property: "cond",
      code: "loom.ternary-condition",
    });
  }
  const thenT = typeOf(node.thenExpr, env);
  const elseT = typeOf(node.elseExpr, env);
  // Cascade suppression — a branch that failed to resolve is already reported.
  if (thenT.kind === "unknown" || elseT.kind === "unknown") return;
  if (ternaryJoin(thenT, elseT) === undefined) {
    accept(
      "error",
      `Ternary branches have incompatible types: then-branch is '${typeToString(thenT)}', ` +
        `else-branch is '${typeToString(elseT)}'.  One branch's type must be assignable to ` +
        `the other (both numeric, an optional and its inner, or a null literal against an optional).`,
      { node, property: "elseExpr", code: "loom.ternary-branches" },
    );
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
  checkBlankMessage(p, p.message, accept);
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
  // A record construction / free function call in the default
  // (`price: Coin = Coin { … }`, `n: int = compute(2)`) gets its entry values /
  // args type-checked here — the non-body-site companion to the statement-walk
  // coverage (M-T6.18).
  checkConstructionArgTypes(p.default, env, accept);
  checkExprCallArgs(p.default, env, accept);
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

/** Type-check a parameter default (`operation cancel(reason: string = "x")`) —
 *  the param analogue of {@link checkPropertyDefault}, so a mistyped default is
 *  rejected at the source instead of silently seeding a wrong-typed form value.
 *  `env` binds `this` (the enclosing aggregate) so a this-relative default
 *  (`reschedule(to: datetime = this.eta)`) resolves. */
export function checkParameterDefault(p: Parameter, env: Env, accept: ValidationAcceptor): void {
  if (!p.default) return;
  checkConstructionArgTypes(p.default, env, accept);
  checkExprCallArgs(p.default, env, accept);
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
      `Default for parameter '${p.name}' has type '${typeToString(actual)}' but the parameter is declared '${typeToString(declared)}'.`,
      { node: p, property: "default" },
    );
  }
}

export function checkInvariant(inv: Invariant, env: Env, accept: ValidationAcceptor): void {
  checkConstructionArgTypes(inv.expr, env, accept);
  checkExprCallArgs(inv.expr, env, accept);
  checkBlankMessage(inv, inv.message, accept);
  if (inv.guard) {
    checkConstructionArgTypes(inv.guard, env, accept);
    checkExprCallArgs(inv.guard, env, accept);
  }
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
  checkConstructionArgTypes(d.expr, env, accept);
  checkExprCallArgs(d.expr, env, accept);
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

  // Expression form (`= Expression`) — the single, inlinable body.  Admit
  // literal promotion (`function fee(): money = 0`) as defaults / `:=` do (C1).
  if (fn.body) {
    checkConstructionArgTypes(fn.body, env, accept);
    checkExprCallArgs(fn.body, env, accept);
    const actual = typeOf(fn.body, env);
    if (
      declared.kind !== "unknown" &&
      actual.kind !== "unknown" &&
      !isAssignable(actual, declared) &&
      !canPromoteLiteralTo(fn.body, declared)
    ) {
      accept(
        "error",
        `Function '${fn.name}' returns '${typeToString(actual)}' but is declared to return '${typeToString(declared)}'.`,
        { node: fn, property: "body" },
      );
    }
    warnSensitivityDrop(actual, declared, accept, { node: fn, property: "body" });
    return;
  }

  // Block form (`{ Statement* }`, domain-services.md rev. 4) — a pure helper
  // with `let`-bindings + `return`/bug-regime statements.  Type-check the
  // pure statement subset (env threading for lets) and validate each
  // `return`'s value against the declared return type.  Side-effecting
  // statements (`assign`/`+=`/`emit`/op-calls) are caught by the IR-layer
  // purity gate (`loom.function-block-impure`); here we only need the
  // expression/return typing so an ill-typed pure body is rejected early.
  let blockEnv: Env = env;
  let sawReturn = false;
  for (const stmt of fn.block) {
    // Type-check any construction / free function call in this statement under
    // the current block env (a `let`'s own value can't reference the binding it
    // introduces, and the env is extended only after — matching the
    // statement-walk discipline).
    checkConstructionArgTypes(stmt, blockEnv, accept);
    checkExprCallArgs(stmt, blockEnv, accept);
    if (isLetStmt(stmt)) {
      const t = typeOf(stmt.expr, blockEnv);
      const next = new Map<string, { type: DddType; origin: AstNode }>();
      next.set(stmt.name, { type: t, origin: stmt });
      blockEnv = makeEnv(blockEnv, next);
      continue;
    }
    if (isPreconditionStmt(stmt) || isRequiresStmt(stmt)) {
      const t = typeOf(stmt.expr, blockEnv);
      if (t.kind !== "primitive" || t.name !== "bool") {
        accept(
          "error",
          `'${isRequiresStmt(stmt) ? "requires" : "precondition"}' must be of type 'bool', got '${typeToString(t)}'.`,
          { node: stmt, property: "expr" },
        );
      }
      continue;
    }
    if (isReturnStmt(stmt)) {
      sawReturn = true;
      const actual = typeOf(stmt.value, blockEnv);
      if (
        declared.kind !== "unknown" &&
        actual.kind !== "unknown" &&
        !isAssignable(actual, declared) &&
        !canPromoteLiteralTo(stmt.value, declared)
      ) {
        accept(
          "error",
          `Function '${fn.name}' returns '${typeToString(actual)}' but is declared to return '${typeToString(declared)}'.`,
          { node: stmt, property: "value" },
        );
      }
      warnSensitivityDrop(actual, declared, accept, { node: stmt, property: "value" });
    }
  }
  if (!sawReturn) {
    accept(
      "error",
      `Block-body function '${fn.name}' must 'return' a value of type '${typeToString(declared)}'.`,
      { node: fn, property: "name", code: "loom.function-block-no-return" },
    );
  }
}

// Re-export DddType so consumers don't have to chase the type-system
// import surface.
export type { AstNode, DddType, Env };
