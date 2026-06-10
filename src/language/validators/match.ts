// Match-expression structural checks + test-matcher arity + the
// `string.matches(regex)` literal-pattern gate.

import { AstUtils, type ValidationAcceptor } from "langium";
import { intrinsicMatcherSig } from "../../util/intrinsic-matchers.js";
import {
  type ExpectStmt,
  type Expression,
  isExpectStmt,
  isIntLit,
  isMemberSuffix,
  isPostfixChain,
  isTestE2E,
  type MatchExpr,
  type MemberSuffix,
  type Model,
  type StringLit,
} from "../generated/ast.js";

export function checkMatchExpressions(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "MatchExpr") continue;
    const m = node as MatchExpr;
    // Empty match (no arms, no else) is structurally meaningless —
    // grammar permits it, validator rejects.
    if (m.arms.length === 0 && !m.elseExpr) {
      accept("error", `Empty 'match { }' — must declare at least one arm or an 'else' branch.`, {
        node: m,
      });
      continue;
    }
    // Warn on non-exhaustive matches (no `else`).  An expression
    // without `else` returns undefined when no arm matches, which
    // is rarely intentional — for state-machine page bodies it
    // means "render nothing" which is usually a bug.  Promoted
    // from error to warning to keep the surface friendly while
    // the user iterates.
    if (!m.elseExpr) {
      accept(
        "warning",
        `'match' expression has no 'else' arm — when no arm matches, the expression is undefined.  Add 'else => …' for exhaustive coverage.`,
        { node: m },
      );
    }
  }
}

/** The compiler knows the intrinsic test-matcher surface, so it can
 *  enforce it: each matcher takes a fixed number of positional args.
 *  Walks every MemberSuffix in the model (post-grammar-flatten, calls
 *  on a receiver are MemberSuffix nodes with `call: true`). */
export function checkMatcherArity(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isMemberSuffix(node)) continue;
    const ms = node as MemberSuffix;
    if (!ms.call) continue;
    const sig = intrinsicMatcherSig(ms.member);
    if (!sig) continue;
    // `toThrow` has variable arity (0 = any throw, 1 = pinned HTTP status);
    // `checkExpectMatcher` enforces its argument rules.
    if (ms.member === "toThrow") continue;
    if (ms.args.length !== sig.arity) {
      accept(
        "error",
        `matcher '${ms.member}' takes ${sig.arity} argument(s), got ${ms.args.length}.`,
        { node: ms, property: "args" },
      );
    }
  }
}

/** If `expr` is a method-matcher call (`expect(<actual>).toBe(<x>)`, possibly
 *  with a `.not.` before it), return its trailing matcher suffix.  This is how
 *  the validator distinguishes a method-based assertion from a bare-boolean
 *  `expect <x>` / `expect(<x>)`. */
function trailingMatcher(expr: Expression): MemberSuffix | undefined {
  if (!isPostfixChain(expr)) return undefined;
  const last = expr.suffixes.at(-1);
  if (last && isMemberSuffix(last) && last.call && intrinsicMatcherSig(last.member)) return last;
  return undefined;
}

/** Assertions are method-based: every `expect(...)` must end in an intrinsic
 *  matcher.  Reject the bare-boolean form, and enforce the `toThrow` argument
 *  rules — at most one argument, which (when present) pins an HTTP status and
 *  is therefore valid only in a `test e2e` block and must be an integer
 *  literal so the e2e renderer can translate it into a `/→ N\b/` matcher. */
export function checkExpectMatcher(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isExpectStmt(node)) continue;
    const stmt = node as ExpectStmt;
    const matcher = trailingMatcher(stmt.expr);
    if (!matcher) {
      accept(
        "error",
        `'expect' requires a matcher — write 'expect(<actual>).toBe(<expected>)' (or .toThrow(), .toHaveText(…), …), not a bare expression.`,
        { node: stmt, property: "expr" },
      );
      continue;
    }
    if (matcher.member !== "toThrow") continue;
    if (matcher.args.length > 1) {
      accept(
        "error",
        `'toThrow' takes at most one argument (an HTTP status), got ${matcher.args.length}.`,
        { node: matcher, property: "args" },
      );
    } else if (matcher.args.length === 1) {
      if (!isTestE2E(stmt.$container)) {
        accept(
          "error",
          `'toThrow(<status>)' pins an HTTP status and is only valid in a 'test e2e' block; use a bare 'toThrow()' in an in-process test.`,
          { node: matcher, property: "args" },
        );
      } else if (!isIntLit(matcher.args[0]!.value)) {
        accept(
          "error",
          `'toThrow(<status>)' requires an integer HTTP status literal, e.g. toThrow(404).`,
          { node: matcher, property: "args" },
        );
      }
    }
  }
}

export function checkMatchesCalls(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isMemberSuffix(node)) continue;
    const ms = node as MemberSuffix;
    if (ms.member !== "matches" || !ms.call) continue;
    // `matches` always takes exactly one string-literal argument.
    if (ms.args.length !== 1) {
      accept("error", `'matches' takes exactly one argument (a string-literal regex pattern).`, {
        node: ms,
        property: "args",
      });
      continue;
    }
    const argWrap = ms.args[0]!;
    const arg = argWrap.value;
    if (argWrap.name) {
      accept(
        "error",
        `'matches' takes a single positional argument; named arguments are not supported.`,
        { node: argWrap, property: "name" },
      );
      continue;
    }
    if (arg.$type !== "StringLit") {
      accept(
        "error",
        `'matches' argument must be a string literal — patterns must be known at codegen time.`,
        { node: ms, property: "args" },
      );
      continue;
    }
    const raw = (arg as StringLit).value as string;
    // The grammar's STRING terminal carries the surrounding quotes.
    const pattern = raw.startsWith('"') ? JSON.parse(raw) : raw;
    try {
      new RegExp(pattern);
    } catch (err) {
      accept(
        "error",
        `'matches' pattern is not a valid regular expression: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { node: ms, property: "args" },
      );
    }
  }
}
