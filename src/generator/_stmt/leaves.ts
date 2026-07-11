// ---------------------------------------------------------------------------
// Shared provenance leaf-collection for the statement renderers.
//
// A `provenanced` field write (provenance.md) snapshots the leaf inputs of
// its RHS *before* the write fires, so the recorded `ProvLineage` captures the
// values that produced the result.  `collectLeaves` walks the RHS expression
// tree and returns the `{ path, value }` pairs to snapshot; `leafPath` renders
// the dotted source-side path of a member-access chain.
//
// Both were hand-copied verbatim across the four imperative backends'
// `render-stmt.ts` (`typescript` / `dotnet` / `java` / `python`) — `leafPath`
// byte-identical, `collectLeaves` identical apart from the inner
// expression-render call.  That call is the only per-backend divergence, so it
// is lifted to a `render` parameter: each backend passes its own
// `renderXExpr` (closing over its render context where one is threaded).  The
// walk + the leaf-selection rule (`this-prop` / `param` / `let` refs and every
// member access) now live once.
//
// Elixir keeps its own `collectVanillaLeaves` (a deliberately narrower switch)
// but shares `leafPath`.
// ---------------------------------------------------------------------------

import type { ExprIR } from "../../ir/types/loom-ir.js";

/** One snapshotted leaf input of a provenanced write's RHS. */
export interface ProvLeaf {
  /** Dotted source-side path (`line.price`) recorded in the lineage. */
  path: string;
  /** The leaf value rendered as target-language source. */
  value: string;
}

/** Dotted source-side path for a member-access chain (e.g. `line.price`). */
export function leafPath(e: ExprIR): string {
  if (e.kind === "ref") return e.name;
  if (e.kind === "this") return "this";
  if (e.kind === "member") return `${leafPath(e.receiver)}.${e.member}`;
  return "<expr>";
}

/**
 * Collect the leaf inputs of an expression tree — the `{ path, value }` pairs a
 * provenanced write snapshots before it fires.  `render` renders a leaf
 * expression as target-language source (the sole per-backend divergence); the
 * traversal and leaf-selection rule are shared.
 */
export function collectLeaves(
  e: ExprIR,
  render: (e: ExprIR) => string,
  out: ProvLeaf[] = [],
): ProvLeaf[] {
  switch (e.kind) {
    case "ref":
      if (e.refKind === "this-prop" || e.refKind === "param" || e.refKind === "let") {
        out.push({ path: e.name, value: render(e) });
      }
      break;
    case "member":
      out.push({ path: leafPath(e), value: render(e) });
      break;
    case "method-call":
      collectLeaves(e.receiver, render, out);
      for (const a of e.args) collectLeaves(a, render, out);
      break;
    case "call":
      for (const a of e.args) collectLeaves(a, render, out);
      break;
    case "paren":
      collectLeaves(e.inner, render, out);
      break;
    case "unary":
      collectLeaves(e.operand, render, out);
      break;
    case "binary":
      collectLeaves(e.left, render, out);
      collectLeaves(e.right, render, out);
      break;
    case "ternary":
      collectLeaves(e.cond, render, out);
      collectLeaves(e.then, render, out);
      collectLeaves(e.otherwise, render, out);
      break;
    case "match":
      for (const arm of e.arms) {
        collectLeaves(arm.cond, render, out);
        collectLeaves(arm.value, render, out);
      }
      if (e.otherwise) collectLeaves(e.otherwise, render, out);
      break;
    case "new":
    case "object":
      for (const f of e.fields) collectLeaves(f.value, render, out);
      break;
  }
  return out;
}
