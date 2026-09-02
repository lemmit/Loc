// -------------------------------------------------------------------------
// AST-level audit predicates — the phase-② / phase-④ mirror of the derived
// entity-history read (docs/audit.md).
//
// The `history(id)` read is SYNTHESIZED at phase ⑥ enrichment (`ensureHistoryFind`
// over `aggServesHistory`, `src/ir/util/audit-history.ts`).  Two earlier phases
// nevertheless have to know whether an aggregate will end up carrying it:
//
//   - phase ② the scaffold macro, which grows the Detail page a History
//     section only for an aggregate that will serve one;
//   - phase ④ the AST validator, whose `listValidApiOperations` allowlist
//     decides which `<apiHandle>.<Agg>.<op>(…)` spellings a hand-written page
//     body may use.  Omitting `history` there made the SCAFFOLD-EMITTED call
//     un-writable by hand: `Product.history(id)` validated (bare aggregate
//     path) while `api.Product.history(id)` did not.
//
// Neither may value-import `ir/` (that inverts the pipeline;
// `test/platform/pipeline-layering.test.ts`), so the predicate lives in `util/`
// — the layer both consumers share, exactly like `audit-names.ts` beside it.
// One copy, so the macro's "emit the section" and the validator's "accept the
// call" can never disagree about whether the read exists.
//
// The AST types are imported TYPE-ONLY, so this carries no runtime edge into
// `language/`.
// -------------------------------------------------------------------------

import type { Aggregate, Property } from "../language/generated/ast.js";
import { AUDIT_HISTORY_FIND } from "./audit-names.js";

/** Whether this aggregate carries the DERIVED `history(id)` read — the
 *  macro-/validator-time (AST) mirror of the enrichment's `aggServesHistory`
 *  (`src/ir/util/audit-history.ts`), which neither caller can invoke because
 *  both run over the Langium AST, before there is an `AggregateIR` to ask.
 *
 *  It must not over-approximate: an aggregate whose repository ends up WITHOUT
 *  a `historyFind` gets no `history()` client method, so a History section over
 *  it would call a hook that was never emitted and fail `tsc`.  Every clause
 *  below therefore mirrors one clause of the IR rule, and each errs toward
 *  emitting nothing:
 *
 *    - abstract bases own no repository and emit no table (`ensureHistoryFind`
 *      skips them);
 *    - the audit target — the same "at least one audited public command"
 *      question `aggHasAuditedTarget` asks, read off the AST flags the lowerer
 *      resolves (`aggregate X audited` marks every public command; a `private
 *      operation` is never audited — the opt-out);
 *    - at least one diffable field, so the timeline could say something.  The
 *      declared non-`internal`/`secret`/`managed`/`token` properties are a
 *      SUBSET of the IR's `historyDiffFields` (which also counts derived +
 *      containments), so a false here is a safe under-emit;
 *    - an author-declared `find history(...)` WINS over the derived read
 *      (`ensureHistoryFind` bails), and it keeps its own generic route + object-
 *      shaped client hook — so the scaffold must not claim the derived one.
 *      (The validator allowlist still accepts `history` for that aggregate: it
 *      picks the declared find up through the repository walk instead.) */
export function aggregateServesHistory(agg: Aggregate): boolean {
  if (agg.isAbstract) return false;
  if (!aggregateHasAuditedCommand(agg)) return false;
  if (!agg.members.some(isHistoryDiffProperty)) return false;
  if (aggregateHasDeclaredHistoryFind(agg)) return false;
  return true;
}

/** AST mirror of `aggHasAuditedTarget` — at least one audited PUBLIC command
 *  action (`operation` / `create` / `destroy`).  The aggregate-header `audited`
 *  is the aggregate-wide form the lowerer resolves into the per-command flags
 *  (`lowerAggregate`), so it counts only when such a command exists. */
function aggregateHasAuditedCommand(agg: Aggregate): boolean {
  return agg.members.some((m) => {
    if (m.$type === "Operation") return !m.private && (m.audited || agg.audited);
    if (m.$type === "Create" || m.$type === "Destroy") return m.audited || agg.audited;
    return false;
  });
}

/** A declared property that could carry a per-entry field change: the API-read
 *  set (`forApiRead`) minus the server-lifecycle stamp churn `forHistoryDiff`
 *  drops (`managed` / `token`). */
function isHistoryDiffProperty(m: { $type: string }): boolean {
  if (m.$type !== "Property") return false;
  const access = (m as Property).access;
  return access !== "internal" && access !== "secret" && access !== "managed" && access !== "token";
}

/** An author-declared `find history(...)` on this aggregate's repository — the
 *  one that WINS over the synthesized read (same rule as `all`). */
function aggregateHasDeclaredHistoryFind(agg: Aggregate): boolean {
  for (const m of agg.$container.members) {
    if (m.$type !== "Repository") continue;
    if (m.aggregate.ref?.name !== agg.name && m.aggregate.$refText !== agg.name) continue;
    if (m.finds.some((f) => f.name === AUDIT_HISTORY_FIND)) return true;
  }
  return false;
}
