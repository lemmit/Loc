// ---------------------------------------------------------------------------
// Shared applier-fold statement emitter — the pure `apply(e: E) { … }` fold
// body for BOTH the aggregate event-store (`eventsourced-emit.ts`) and the
// event-sourced workflow (`workflow-eventsourced-emit.ts`).  A fold rebinds
// the threaded state struct (`state = %{state | field: …}`) rather than
// mutating a database row — an ES aggregate/workflow has no state table; its
// truth is the stream and state is the in-memory reduction of it.
//
// The applier-body discipline validator (structural-checks.ts Rule 4) rejects
// `emit` / side-effecting `call` / `precondition` / `requires` inside an
// applier BEFORE codegen, so only the pure fold statements below can reach
// here: assignments, collection/scalar mutations (`+=` / `-=`), `let`
// bindings, and a bare `expression`.  Any other kind is an internal invariant
// violation, so the dispatch THROWS rather than emitting a silent
// `# unsupported` comment (which drops the transition at runtime while
// compiling green — the exact silent-fallthrough this module removes).
//
// A value-object collection mutation (`charges += Money{…}`) folds cleanly:
// the VO lowers to an `object` expression, which renders as a plain map
// (`%{amount: …, currency: …}`) the ES controller's `serialize_<vo>/1` already
// reads by either key — no struct module needed.  The ONE shape the fold can't
// build is a mutation that constructs a contained ENTITY PART (`boxes += Box{…}`,
// a `new` expression → `%Ctx.Box{}`): its struct module is never emitted (the
// schema emitters skip ES aggregates), so it is gated honestly up front by
// `validateVanillaEsApplierSupport` (`loom.vanilla-es-applier-unsupported`) and
// never reaches this renderer.
// ---------------------------------------------------------------------------

import type { StmtIR } from "../../../ir/types/loom-ir.js";
import { escapeElixirIdent, snake } from "../../../util/naming.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";

/** Render one applier fold statement.  `ctx.thisName` is the threaded state
 *  variable (`"state"` on both fold sites); a mutation rebinds it so the next
 *  clause and the trailing bare `state` see the folded value. */
export function renderFoldStatement(s: StmtIR, ctx: RenderCtx): string {
  const state = ctx.thisName;
  switch (s.kind) {
    case "assign":
      return `    ${state} = %{${state} | ${snake(s.target.segments[0] ?? "")}: ${renderExpr(s.value, ctx)}}`;
    case "add": {
      // `xs += v` (collection) appends to the folded list; a scalar `n += v`
      // (`collection: false`) is arithmetic on the folded field.  A fold is
      // in-memory (no relational child table / `put_assoc` — that path is
      // persistence-only), so both are plain struct-update rebinds.
      const field = snake(s.target.segments[0] ?? "");
      const value = renderExpr(s.value, ctx);
      return s.collection
        ? `    ${state} = %{${state} | ${field}: (${state}.${field} || []) ++ [${value}]}`
        : `    ${state} = %{${state} | ${field}: ${state}.${field} + ${value}}`;
    }
    case "remove": {
      // `xs -= v` drops the first matching element; scalar `n -= v` subtracts.
      const field = snake(s.target.segments[0] ?? "");
      const value = renderExpr(s.value, ctx);
      return s.collection
        ? `    ${state} = %{${state} | ${field}: List.delete(${state}.${field} || [], ${value})}`
        : `    ${state} = %{${state} | ${field}: ${state}.${field} - ${value}}`;
    }
    case "let":
      return `    ${escapeElixirIdent(snake(s.name))} = ${renderExpr(s.expr, ctx)}`;
    case "expression":
      return `    _ = ${renderExpr(s.expr, ctx)}`;
    default:
      // The ES applier-body discipline validator rejects every other statement
      // kind (`loom.applier-emits` / `loom.applier-impure-call` /
      // `loom.applier-guard`), so reaching this arm is an internal invariant
      // violation — fail loudly instead of emitting a silent comment.
      throw new Error(
        `elixir vanilla fold: unsupported applier statement '${(s as StmtIR).kind}' — ` +
          `an applier folds pure assignments / collection mutations / let bindings only; ` +
          `the event-sourcing discipline validator should have rejected this.`,
      );
  }
}

/** True when any fold statement's value/right-hand expression references the
 *  bound event param — decides whether the `apply_event` head binds it or
 *  `_param`s it (an unused bind fails `--warnings-as-errors`).  Must scan the
 *  SAME statement kinds `renderFoldStatement` reads a value from (assign / add
 *  / remove / let / expression) so a body whose only param use is inside a
 *  `+=` still binds the param. */
export function foldStmtsUseParam(stmts: StmtIR[], param: string, ctx: RenderCtx): boolean {
  const token = new RegExp(`\\b${snake(param)}\\b`);
  return stmts.some((s) => {
    const rhs =
      s.kind === "assign" || s.kind === "add" || s.kind === "remove"
        ? renderExpr(s.value, ctx)
        : s.kind === "let" || s.kind === "expression"
          ? renderExpr(s.expr, ctx)
          : "";
    return token.test(rhs);
  });
}
