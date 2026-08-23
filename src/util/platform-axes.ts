// Platform realization-axes vocabulary — pure lookups over the `Platform`
// / `SavingShape` IR vocabulary, shared by IR lowering, the IR validator,
// the language validators, and the generator persistence adapters.
//
// Lives at `util/` altitude (a foundational layer every pipeline phase
// may depend on) rather than inside `ir/types/loom-ir.ts`: the language
// validators (`platform-rules.ts`) consume these maps too, and a
// `language → ir` value import would be a backward pipeline edge.  Only
// the IR *types* are imported (type-only), which carries no runtime edge.

import type { Platform, SavingShape } from "../ir/types/loom-ir.js";

/** Saving shapes (D-DOCUMENT-AXIS `shape: …`) each backend platform can
 *  EMIT today — the single source of truth for the saving-shape capability
 *  check.  A `shape: …` not listed for the target platform is a hard error
 *  (the backend has no emitter for it yet).  Keyed by the bareword family
 *  (a `family@version` pin resolves via `platformFamily` in the validator).
 *  Frontend platforms (`react`/`static`) own no persistence and are omitted.
 *
 *  The check is keyed by PLATFORM, not by adapter.  This header used to
 *  add "and the generator persistence adapters
 *  (`PersistenceAdapter.supportedShapes`)" as a second consumer; that field
 *  was read by nothing and has been removed, so the sole consumer is
 *  `validateSavingShapeSupport`. */
export const PLATFORM_SAVING_SHAPES: Partial<Record<Platform, readonly SavingShape[]>> = {
  dotnet: ["relational", "embedded", "document"],
  node: ["relational", "embedded", "document"],
  // ⚠️  THIS ROW IS NOT ELIXIR'S EFFECTIVE SET.  elixir emits all THREE
  // shapes: `document` too (the `(id, data, version)` jsonb table + a
  // schemaless-changeset validated fold — DEBT-07).  The sole consumer,
  // `validateSavingShapeSupport` (`src/ir/validate/checks/system-checks.ts`,
  // the elixir branch), unconditionally widens this row with `"document"`
  // before checking, so a `shape: document` aggregate on elixir is ACCEPTED —
  // reading this row alone would tell you the opposite.
  //
  // Kept split (rather than folded in) because the widening is where the
  // partial-emit scope note lives: the vanilla document path emits CRUD +
  // scalar finds/ops but gates a residue (`loom.vanilla-document-unsupported`),
  // so "elixir supports document" is true at the SHAPE tier and qualified at
  // the FEATURE tier.  If that residue ever drains, fold `"document"` into
  // this array and delete the branch — behaviour is identical either way,
  // since nothing else reads this table.
  elixir: ["relational", "embedded"],
  // Python emits all three: relational (table-per-entity + join tables),
  // document (shape: document: one jsonb (id, data, version) blob), and
  // embedded (queryable root row + one jsonb column per containment).
  python: ["relational", "document", "embedded"],
  java: ["relational", "embedded", "document"],
};
