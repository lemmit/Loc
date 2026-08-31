// Where an `ignoring` capability-filter bypass may be WRITTEN (M-T5.25).
//
// The clause has three legal homes, each its own grammar position, each read by
// its own lowerer:
//
//   1. a repository `find … ignoring …`        (`FindDecl`, lower.ts)
//   2. a query-time projection's `where` slot  (`ProjectionQueryClauses`,
//      `from <Agg> [where …] ignoring … join … group by … select …`,
//      lower-projection.ts)
//   3. an inline read bound by a `let`         (`let xs = Repo.findAll(…) /
//      Repo.run(…) ignoring …`, lower-workflow.ts)
//
// (3) is the one that needs a gate.  It rides `PostfixExpr`, which admits a
// trailing `IgnoringClause` on ANY postfix chain — and a postfix chain is
// admissible anywhere an `Expression` is.  So `group by o.status ignoring
// softDeletable` parses clean, binds the clause to the GROUPING expression, and
// nothing ever reads it back: the author asked to see soft-deleted rows and
// silently keeps getting the filtered count.  Same model, same intent, opposite
// data — decided by where in the clause list the word sits:
//
//   group by o.status ignoring softDeletable  → …and(eq(status,…), not(eq(isDeleted,true)))
//   ignoring softDeletable / group by o.status → …eq(status,…)
//
// Refusing it is the right shape rather than hoisting the grammar: `ignoring`
// means "bypass the SOURCE's capability filters", which has no per-expression
// reading.  The gate lives here, in phase ④, because the CST still carries the
// offending span — by lowering the clause is already gone.
//
// The rule mirrors the ONE consuming site exactly (`lower-workflow.ts`'s
// `isLetStmt` arm, whose `repo-run` arms spread `resolveBypass`): a chain-borne
// `ignoring` is legal only as a `let` binding's own expression, over a
// `.findAll(…)` / `.run(…)` read.  Every other position drops it.

import { AstUtils, type ValidationAcceptor } from "langium";
import { diagMessage } from "../../diagnostics/messages.js";
import {
  isLetStmt,
  isMemberSuffix,
  isPostfixChain,
  type Model,
  type PostfixChain,
} from "../generated/ast.js";

/** The member names whose call form consumes a chain-borne `ignoring` —
 *  `matchRunCall` / `matchFindAllCall` in `src/ir/lower/lower-workflow.ts`. */
const BYPASS_CONSUMING_READS: ReadonlySet<string> = new Set(["findAll", "run"]);

/** Does this chain carry an `ignoring` clause?  The fragment sets `bypassAll`
 *  for `ignoring *` and fills `bypass` for `ignoring A, B`. */
function carriesIgnoring(chain: PostfixChain): boolean {
  return chain.bypassAll === true || (chain.bypass?.length ?? 0) > 0;
}

/** The chain's trailing member name, when its last suffix is a `.member(...)`
 *  call — the shape the two consuming matchers key on. */
function trailingCallMember(chain: PostfixChain): string | undefined {
  const last = chain.suffixes.at(-1);
  if (!last || !isMemberSuffix(last) || !last.call) return undefined;
  return last.member;
}

/** How the author spelled it, for the message: `ignoring *` or `ignoring A, B`. */
function spelling(chain: PostfixChain): string {
  return chain.bypassAll ? "ignoring *" : `ignoring ${(chain.bypass ?? []).join(", ")}`;
}

export function checkBypassPlacement(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isPostfixChain(node) || !carriesIgnoring(node)) continue;

    // Legal: the direct expression of a `let` binding, over a repository read.
    const parent = node.$container;
    if (
      isLetStmt(parent) &&
      node.$containerProperty === "expr" &&
      BYPASS_CONSUMING_READS.has(trailingCallMember(node) ?? "")
    ) {
      continue;
    }

    accept("error", diagMessage("loom.ignoring-clause-placement", { clause: spelling(node) }), {
      node,
      code: "loom.ignoring-clause-placement",
    });
  }
}
