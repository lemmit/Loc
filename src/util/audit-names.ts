// -------------------------------------------------------------------------
// Shared audit-facility NAMES — the spellings more than one pipeline layer has
// to agree on (docs/audit.md).
//
// Home is `util/` for the reason the layering gate enforces: the entity-history
// read is DERIVED at phase ⑥ (`src/ir/util/audit-history.ts`) and CONSUMED by
// the backends at phase ⑧, but the scaffold macro at phase ② also has to name
// it — and `macros/` may not value-import `ir/` (that would invert the
// pipeline; `test/platform/pipeline-layering.test.ts`).  A helper consumed
// across layers belongs at the layer its consumers share, which is `util/` —
// the same move `walker-primitive-names.ts` made for the walker stdlib.
//
// `ir/util/audit-history.ts` re-exports what it needs from here, so its public
// surface is unchanged and there is still exactly one spelling.
// -------------------------------------------------------------------------

/** Name of the derived per-entity history read.  A repository find of this
 *  name is compiler-synthesized onto every audited aggregate (the auto-`findAll`
 *  analog); an author-declared find of the same name wins, exactly as with
 *  `all`. */
export const AUDIT_HISTORY_FIND = "history";
