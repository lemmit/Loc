// Temporal checks (A5, docs/plans/stdlib.md) — the duration-constructor
// builtins `days(n)` / `hours(n)` / `minutes(n)` / `months(n)`.
//
// The constructors are NOT grammar keywords: they parse as ordinary free
// calls and become `duration` ExprIR nodes at lowering, but ONLY when the
// name resolves to no user declaration (`isDurationBuiltinCall` — a user
// `function days(...)` shadows the builtin, and these checks then stay
// silent).  Two gates:
//
//   loom.duration-arity          — exactly one positional argument
//   loom.duration-arg-type       — the amount must be int-typed
//   loom.duration-months-position — `months(n)` may ONLY stand as a direct
//       (paren-transparent) operand of a binary `+`/`-` whose OTHER operand
//       types as datetime.  Calendar months have no fixed width, so they
//       cannot unify with the absolute-duration runtime representation
//       (.NET TimeSpan / TS milliseconds cannot hold "a month"); each
//       backend's binary renderer takes a native calendar path
//       (`setMonth` / `AddMonths` / `Period` / `relativedelta`) that only
//       exists in datetime ± position.  days/hours/minutes are absolute
//       and unrestricted.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import { durationUnitOf } from "../../util/temporal.js";
import type { BinaryChain, Expression, Model, PostfixChain } from "../generated/ast.js";
import {
  isBinaryChain,
  isCallSuffix,
  isNameRef,
  isParenExpr,
  isPostfixChain,
} from "../generated/ast.js";
import {
  arithmeticResult,
  type DddType,
  type Env,
  envForNode,
  isAssignable,
  isDurationBuiltinCall,
  T,
  typeOf,
  typeToString,
} from "../type-system.js";
import { canPromoteLiteralTo } from "./_shared.js";

export function checkDurationConstructors(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isPostfixChain(node)) continue;
    const chain = node as PostfixChain;
    if (!isNameRef(chain.head)) continue;
    const first = chain.suffixes[0];
    if (!first || !isCallSuffix(first)) continue;
    const unit = durationUnitOf(chain.head.name);
    if (!unit) continue;
    const env = envForNode(chain);
    // A user declaration named `days`/... shadows the builtin — the call
    // lowers as an ordinary function / VO-ctor / criterion call and its
    // own arity rules apply, not these.
    if (!isDurationBuiltinCall(chain.head.name, env)) continue;

    // Arity: exactly one positional argument.
    if (first.args.length !== 1 || first.args[0]!.name) {
      accept("error", `'${unit}' takes exactly 1 argument — write '${unit}(<int>)'.`, {
        node: first.args.length > 0 ? first.args[first.args.length === 1 ? 0 : 1]! : chain,
        code: "loom.duration-arity",
      });
      continue;
    }
    // Argument type: int (mirrors the intrinsic arg checks — fail open on
    // `unknown`, which is already reported upstream).
    const arg = first.args[0]!;
    const actual = typeOf(arg.value, env);
    const expected = T.prim("int");
    if (
      actual.kind !== "unknown" &&
      !isAssignable(actual, expected) &&
      !canPromoteLiteralTo(arg.value, expected)
    ) {
      accept(
        "error",
        `'${unit}' takes an 'int' amount, got '${typeToString(actual)}'. ` +
          `Fractional spans are written in the finer unit ('hours(36)', not 'days(1.5)').`,
        { node: arg, property: "value", code: "loom.duration-arg-type" },
      );
      continue;
    }
    if (unit === "months" && !isMonthsInDatetimeShiftPosition(chain, env)) {
      accept(
        "error",
        `'months(...)' may only appear directly in 'datetime + months(n)' / ` +
          `'datetime - months(n)' position — calendar months have no fixed length, ` +
          `so a standalone months value cannot mix with absolute durations ` +
          `(use 'days(...)' for a fixed span).`,
        { node: chain, code: "loom.duration-months-position" },
      );
    }
  }
}

/** True iff the `months(...)` chain stands (paren-transparently) as a direct
 *  operand of a binary `+`/`-` whose OTHER operand types as datetime. */
function isMonthsInDatetimeShiftPosition(chain: PostfixChain, env: Env): boolean {
  // Climb out of any wrapping parens: `due + (months(1))` is fine.
  let cur: AstNode = chain;
  let parent = cur.$container;
  while (parent && isParenExpr(parent)) {
    cur = parent;
    parent = parent.$container;
  }
  if (!parent || !isBinaryChain(parent)) return false;
  const bin = parent as BinaryChain;
  if (bin.head === cur) {
    // `months(n) + <dt>` — only the FIRST fold step touches the head.
    const op = bin.ops[0];
    if (op !== "+" && op !== "-") return false;
    const other = bin.rest[0];
    return other !== undefined && isDatetimeType(typeOf(other, env));
  }
  const idx = (bin.rest as Expression[]).indexOf(cur as Expression);
  if (idx < 0) return false;
  const op = bin.ops[idx];
  if (op !== "+" && op !== "-") return false;
  // The other operand is the chain's ACCUMULATED left side at this fold
  // step: fold the head through the preceding ops (mirrors typeOf /
  // checkSingleBinaryOperands).
  let acc: DddType = typeOf(bin.head, env);
  for (let i = 0; i < idx; i++) {
    acc = arithmeticResult(acc, typeOf(bin.rest[i], env), bin.ops[i]!);
  }
  return isDatetimeType(acc);
}

function isDatetimeType(t: DddType): boolean {
  return t.kind === "primitive" && t.name === "datetime";
}
