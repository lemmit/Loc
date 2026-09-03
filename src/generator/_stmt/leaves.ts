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
//
// `provTempNames` + `wrapProvCapture` below are the second half of the same
// convergence: the four backends' provenance wraps agree on the `__prov_<i>` /
// `__lin_<i>` temp names and on the ORDER — snapshot the leaf inputs BEFORE the
// write, build the lineage and route it to both sinks AFTER — and diverge only
// in the four rendered lines and in their entry guards.  The order is the
// load-bearing part (a self-referential `x := x + n` must record the PRE-write
// value), so it lives here rather than being restated four times.
// ---------------------------------------------------------------------------

import type { ExprIR } from "../../ir/types/loom-ir.js";
import { walkExprChildren } from "../../ir/util/walk.js";

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
    // --- The leaf-selection rule (unchanged) -------------------------------
    case "ref":
      if (e.refKind === "this-prop" || e.refKind === "param" || e.refKind === "let") {
        out.push({ path: e.name, value: render(e) });
      }
      break;
    case "member":
      // Recorded WHOLE (`line.price`), never descended into.
      out.push({ path: leafPath(e), value: render(e) });
      break;

    // --- Slots that INTRODUCE A BINDING — deliberately not descended -------
    //
    // The snapshot line is emitted BEFORE the write, in the enclosing scope.
    // A leaf lifted out of a lambda body or a variant arm would name a
    // variable that does not exist there, so the wrap would render source
    // that does not compile.  `sum(l => l.price)` therefore records `lines`
    // (its receiver) and nothing from inside the lambda — the same set the
    // hand-copied switch produced, kept on purpose rather than by omission.
    case "lambda":
      break;
    case "match":
      if (e.subject) collectLeaves(e.subject, render, out);
      for (const arm of e.arms) {
        collectLeaves(arm.cond, render, out);
        collectLeaves(arm.value, render, out);
      }
      // `variantArms[].binding` is exactly such a binding — skipped.
      if (e.otherwise) collectLeaves(e.otherwise, render, out);
      break;

    // --- Everything else: the ONE exhaustive child walk --------------------
    //
    // The hand-written switch this replaces listed nine kinds and silently
    // dropped the rest, so a provenanced `total := money(subtotal) * factor`
    // recorded NO leaf for `subtotal` — the `convert` arm was missing, and
    // with it `duration`, `list`, `i18nFormat` and `match`'s variant arms.
    // Delegating to `walkExprChildren` (which is `never`-checked over every
    // `ExprIR.kind`) means a newly added kind fails the build there instead
    // of quietly losing lineage here.
    default:
      walkExprChildren(e, {
        expr: (child) => {
          collectLeaves(child, render, out);
        },
      });
      break;
  }
  return out;
}

/** The temp names a provenanced write binds at statement index `i` — the
 *  snapshot array (`__prov_<i>`) and the built lineage (`__lin_<i>`).  Shared so
 *  the convention has one home; the `<i>` itself comes from the backend's
 *  `StmtIndex.prov` (see `StmtIndexing` — node/.NET/java number positionally,
 *  python per-kind). */
export function provTempNames(index: number): { tmp: string; lin: string } {
  return { tmp: `__prov_${index}`, lin: `__lin_${index}` };
}

/** The four backend-rendered lines a provenance wrap splices around the write. */
export interface ProvCaptureLines {
  /** Binds `__prov_<i>` to the snapshotted leaf inputs — emitted BEFORE the write. */
  snapshot: string;
  /** Binds `__lin_<i>` to the built `ProvLineage` — AFTER the write, so
   *  `computedValue` reads the post-write value. */
  lineage: string;
  /** Writes `__lin_<i>` to the co-located per-field lineage slot on the root. */
  colocated: string;
  /** Pushes `__lin_<i>` onto the per-instance / per-request history buffer. */
  sink: string;
}

/** Splice a provenance capture around an already-rendered write statement.
 *  Owns only the ORDER (snapshot → write → lineage → both sinks); the entry
 *  guards stay per-backend because they genuinely differ — see the
 *  `withTrace` / `withProvCapture` / `withProv` call sites. */
export function wrapProvCapture(base: string, l: ProvCaptureLines): string {
  return [l.snapshot, base, l.lineage, l.colocated, l.sink].join("\n");
}
