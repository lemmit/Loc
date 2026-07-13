// Temporal checks (A5, docs/old/plans/stdlib.md) — the duration-constructor
// builtins `days(n)` / `hours(n)` / `minutes(n)`.
//
// The constructors are NOT grammar keywords: they parse as ordinary free
// calls and become `duration` ExprIR nodes at lowering, but ONLY when the
// name resolves to no user declaration (`isDurationBuiltinCall` — a user
// `function days(...)` shadows the builtin, and these checks then stay
// silent).  `duration` is an ABSOLUTE span (fixed millisecond width per
// unit), which is what keeps it uniformly translatable across every backend;
// calendar-relative offsets (`months`/`years`) are deliberately excluded.
// Two gates:
//
//   loom.duration-arity          — exactly one positional argument
//   loom.duration-arg-type       — the amount must be int-typed

import { AstUtils, type ValidationAcceptor } from "langium";
import { durationUnitOf } from "../../util/temporal.js";
import type { Model, PostfixChain } from "../generated/ast.js";
import { isCallSuffix, isNameRef, isPostfixChain } from "../generated/ast.js";
import {
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
    }
  }
}
