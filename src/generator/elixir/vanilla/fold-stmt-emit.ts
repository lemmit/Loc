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
// A value-object collection mutation (`charges += Money{…}`) folds cleanly: the
// VO lowers to an `object` expression that renders as a plain map (`%{amount:
// …}`) the ES controller's `serialize_<vo>/1` reads by either key.  A CONTAINED
// ENTITY PART construction (`boxes += Box{…}`, a `new` expression) also folds:
// an ES aggregate has no `%Ctx.Box{}` Ecto schema (the schema emitters skip ES
// aggregates), so the fold builds a PLAIN MAP over the part's wire shape — a
// freshly generated `id`, the provided fields, and `[]` for any of the part's
// own containments — matching what `serialize_<part>/1` projects.  This mirrors
// the other backends' ES folds (node: `Box._create({ id: Ids.newBoxId(), … })`),
// which likewise mint the contained-part identity in the fold.
//
// KNOWN CROSS-BACKEND CAVEAT: minting the part id in the fold makes the fold
// non-deterministic across replays (the same event stream re-folds to different
// part ids) — a shared limitation of the ES contained-part model on EVERY
// backend, not elixir-specific.  A deterministic identity would have to be
// carried on the creating event; tracked as a cross-backend follow-up.
// ---------------------------------------------------------------------------

import { wireFieldsForPart } from "../../../ir/enrich/wire-projection.js";
import type { EntityPartIR, ExprIR, StmtIR } from "../../../ir/types/loom-ir.js";
import { escapeElixirIdent, snake } from "../../../util/naming.js";
import type { NewExpr } from "../../_expr/target.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";

/** Resolve a contained entity part by name — supplied by the aggregate fold so
 *  a `Box{…}` construction can project the part's wire shape into a map.  The
 *  workflow fold passes none (workflow state has no contained entity parts). */
export type PartResolver = (partName: string) => EntityPartIR | undefined;

export interface FoldOpts {
  resolvePart?: PartResolver;
}

/** Render one applier fold statement.  `ctx.thisName` is the threaded state
 *  variable (`"state"` on both fold sites); a mutation rebinds it so the next
 *  clause and the trailing bare `state` see the folded value. */
export function renderFoldStatement(s: StmtIR, ctx: RenderCtx, opts: FoldOpts = {}): string {
  const state = ctx.thisName;
  switch (s.kind) {
    case "assign":
      return `    ${state} = %{${state} | ${snake(s.target.segments[0] ?? "")}: ${renderFoldValue(s.value, ctx, opts)}}`;
    case "add": {
      // `xs += v` (collection) appends to the folded list; a scalar `n += v`
      // (`collection: false`) is arithmetic on the folded field.  A fold is
      // in-memory (no relational child table / `put_assoc` — that path is
      // persistence-only), so both are plain struct-update rebinds.
      const field = snake(s.target.segments[0] ?? "");
      const value = renderFoldValue(s.value, ctx, opts);
      return s.collection
        ? `    ${state} = %{${state} | ${field}: (${state}.${field} || []) ++ [${value}]}`
        : `    ${state} = %{${state} | ${field}: ${state}.${field} + ${value}}`;
    }
    case "remove": {
      // `xs -= v` drops the first matching element; scalar `n -= v` subtracts.
      const field = snake(s.target.segments[0] ?? "");
      const value = renderFoldValue(s.value, ctx, opts);
      return s.collection
        ? `    ${state} = %{${state} | ${field}: List.delete(${state}.${field} || [], ${value})}`
        : `    ${state} = %{${state} | ${field}: ${state}.${field} - ${value}}`;
    }
    case "let":
      return `    ${escapeElixirIdent(snake(s.name))} = ${renderFoldValue(s.expr, ctx, opts)}`;
    case "expression":
      return `    _ = ${renderFoldValue(s.expr, ctx, opts)}`;
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

/** Render a fold value expression.  A contained entity-part construction
 *  (`Box{…}`, an ExprIR `new`) has no emitted `%Ctx.Box{}` struct on the ES
 *  path, so build a plain map over the part's wire shape instead of delegating
 *  to `renderExpr` (which would emit the missing struct).  Every other
 *  expression — scalars, members, value-object `object`s (which fold as maps),
 *  arithmetic — goes straight through `renderExpr`. */
function renderFoldValue(e: ExprIR, ctx: RenderCtx, opts: FoldOpts): string {
  if (e.kind === "new") return renderFoldNewMap(e, ctx, opts);
  return renderExpr(e, ctx);
}

/** Project a contained entity-part construction into a plain map over the
 *  part's wire shape: a freshly minted `id`, each declared field (the provided
 *  value or `nil`), and `[]` for any of the part's OWN containments (so a
 *  part-in-part serializes without a `KeyError`).  Derived fields are computed
 *  by `serialize_<part>/1`, not stored, so they are omitted. */
function renderFoldNewMap(e: NewExpr, ctx: RenderCtx, opts: FoldOpts): string {
  const part = opts.resolvePart?.(e.partName);
  if (!part) {
    // A `new` in a fold with no resolvable part (e.g. a workflow fold, which
    // has no contained entity parts) is an internal invariant violation — the
    // validator should never let one through.
    throw new Error(
      `elixir vanilla fold: cannot construct '${e.partName}' — no contained entity part ` +
        `resolves in this fold's scope (workflow folds have no entity parts).`,
    );
  }
  const provided = new Map(e.fields.map((f) => [f.name, f.value]));
  const entries: string[] = ["id: Ecto.UUID.generate()"];
  for (const wf of wireFieldsForPart(part)) {
    if (wf.source === "id" || wf.source === "derived") continue;
    const key = snake(wf.name);
    const val = provided.get(wf.name);
    if (val !== undefined) {
      entries.push(`${key}: ${renderFoldValue(val, ctx, opts)}`);
    } else if (wf.source === "containment" && wf.type.kind === "array") {
      // A part's own collection containment defaults to an empty list so its
      // `serialize_<part>/1` `Enum.map(record.<field> || [], …)` is safe.
      entries.push(`${key}: []`);
    } else {
      entries.push(`${key}: nil`);
    }
  }
  return `%{${entries.join(", ")}}`;
}

/** True when any fold statement's value/right-hand expression references the
 *  bound event param — decides whether the `apply_event` head binds it or
 *  `_param`s it (an unused bind fails `--warnings-as-errors`).  Must scan the
 *  SAME statement kinds `renderFoldStatement` reads a value from (assign / add
 *  / remove / let / expression) so a body whose only param use is inside a
 *  `+=` still binds the param. */
export function foldStmtsUseParam(
  stmts: StmtIR[],
  param: string,
  ctx: RenderCtx,
  opts: FoldOpts = {},
): boolean {
  const token = new RegExp(`\\b${snake(param)}\\b`);
  return stmts.some((s) => {
    const rhs =
      s.kind === "assign" || s.kind === "add" || s.kind === "remove"
        ? renderFoldValue(s.value, ctx, opts)
        : s.kind === "let" || s.kind === "expression"
          ? renderFoldValue(s.expr, ctx, opts)
          : "";
    return token.test(rhs);
  });
}
