// ---------------------------------------------------------------------------
// M-T9.29 — the pairwise-combination corpus: AXES.
//
// The curated corpus (`test/fixtures/corpus/`) is one-fixture-per-FEATURE by
// design.  The recurring "generated code fails to compile" bug class does not
// live inside a feature — it lives at feature×feature and feature×adapter
// INTERSECTIONS no single-feature fixture crosses:
//
//   #2412  `mask unless` × `audited`        → .NET CS0128 + Python F821
//   #2387  `audited` × dapper × document    → uncompilable .NET
//   #2391  `audited` × dapper × eventLog    → same shape, other truth kind
//   #2321  `versioned` × user-declared col  → DDL Postgres refuses (the G2 door)
//   #2451  `deny`  (nothing built it)       → Python import bug
//   #2492  `policy { deny }` × dapper       → codegen CRASH
//
// Every one of those is a pair (or a triple) over the four axes below.  So the
// axes are not "all the language features" — they are the features that have
// HISTORICALLY interacted badly, and the matrix is generated rather than
// hand-written because ~100 crossings is not a set of files anyone maintains.
//
// Slice 1 deliberately stops at capabilities × shape × authz × persistence.
// Inheritance / unions / part-in-part are named follow-ups, not this slice.
//
// ---------------------------------------------------------------------------
// SLICE 2 (W3) — WHY THE AXES HAD TO GROW.
//
// All three waiver registers went empty, and a 522-crossing single-feature
// sweep (58 corpus fixtures × 5 backends × both node/dotnet adapters) found
// zero new gaps.  That is not "the compiler is correct" — it is the corpus
// having exhausted what its four axes can express.  Three findings out of a
// young corpus is a DISCOVERY RATE, and a discovery rate that has fallen to
// zero is a statement about the instrument, not the subject.
//
// Two axes are added here.  Each is justified the same way the original four
// were: by a bug class that no crossing of the existing axes can produce.
//
//   inheritance (`none` / `tph` / `tpc`)
//     Nothing in the corpus declares a base type at all.  Every value of the
//     CAPABILITY axis stamps something onto the aggregate's row — an
//     `audit_records` write, a `version` column, `deleted_at`, `tenant_id` —
//     and inheritance is the axis that decides WHICH TABLE that something
//     lands on: `sharedTable` (TPH) folds the whole hierarchy into one
//     kind-discriminated table, `ownTable` (TPC) gives each concrete its own
//     and emits no base table.  A stamp emitted per-concrete against a shared
//     table is the #2321 shape (DDL Postgres refuses); a repository/read path
//     written against a concrete's own table while the row lives in the base's
//     is the #2412 shape (does not compile).  Wave 1 found TPH × `tenantOwned`
//     does not compile on .NET AT ALL, and no corpus fixture crossed it.
//     The axis also probes an honest-gate BOUNDARY the language already
//     declares: a `shape: document` / `persistedAs: eventLog` concrete of a
//     `sharedTable` base is forced to `ownTable` — so inheritance × shape must
//     answer with a named `loom.*` diagnostic, and a crash there is a finding.
//
//   read (`plain` / `paged`)
//     The declared repository find returns `Thing[]` or `Thing paged`.  Every
//     existing axis leaves the wire shape BARE; `paged` is the only value in
//     the corpus that wraps it in a CARRIER, and a carrier is where read-side
//     concerns get dropped: the scope filter has to reach both the page query
//     and the COUNT query (a filter on one but not the other reports a total
//     the caller cannot page to), and `mask unless` has to reach each item
//     INSIDE the envelope rather than the envelope itself.  Non-relational
//     shapes have no rows to count in the first place.  `paged.ddd` exists as
//     a single-feature fixture — no capability, no authz, no non-relational
//     shape — so every one of those crossings is currently unreached.
//
// COMBINATORICS.  Both are cheap where it matters.  The all-pairs cover is
// bounded below by the largest PAIR product, which stays 5×5 (capability ×
// authz) — so the compile/schema-load covers grow from ~25 rows to ~30, not
// to 150.  The generation sweep takes the full cross product and does grow
// 6× (100 → 600 source systems, 700 → 4200 crossings), which is ~90s of
// pipeline runs on a job budgeted at 15 minutes.  That trade is the whole
// point: the generation leg is the one that costs nothing per case, so it is
// the one that should carry the width.
// ---------------------------------------------------------------------------

/** Capability mixed into the subject aggregate (`src/macros/prelude.ts`). */
export const CAPABILITIES = [
  "none",
  "audited",
  "versioned",
  "softDeletable",
  "tenantOwned",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** How the aggregate's truth is stored — the `shape:` / `persistedAs:` header
 *  modifiers.  This is the axis dapper broke on twice (#2387/#2391). */
export const SHAPES = ["relational", "document", "embedded", "eventLog"] as const;
export type Shape = (typeof SHAPES)[number];

/** Which authorization surface the system declares.  `none` is a real value —
 *  it is the control that says a failure belongs to the other axis. */
export const AUTHZ = ["none", "requires", "policyAllow", "mask", "deny"] as const;
export type Authz = (typeof AUTHZ)[number];

/** Whether the subject aggregate participates in an inheritance hierarchy, and
 *  under which table layout (`inheritanceUsing:` — `docs/inheritance.md`).
 *
 *  `tph` = `sharedTable`: an `abstract` base plus the subject `extends`ing it,
 *  the whole hierarchy in one kind-discriminated table.  `tpc` = `ownTable`:
 *  one table per concrete, no base table.  The two differ in exactly the thing
 *  every capability on the CAPABILITY axis cares about — where the stamped
 *  column lives — which is why this is an axis and not a fixture. */
export const INHERITANCE = ["none", "tph", "tpc"] as const;
export type Inheritance = (typeof INHERITANCE)[number];

/** Whether the declared repository find returns the bare wire shape or the
 *  `paged` CARRIER (`docs/payloads.md`).  The carrier is the only construct in
 *  the corpus that puts something between the read path and the wire shape, and
 *  therefore the only one that can drop a scope filter or a read mask on the
 *  way through. */
export const READS = ["plain", "paged"] as const;
export type Read = (typeof READS)[number];

/** Persistence adapter, as a `platform:` clause override.  `default` means the
 *  backend's own default (drizzle on node, efcore on .NET); the non-defaults
 *  are per-backend, so this axis is FILTERED by backend at case-expansion time
 *  rather than being a free cross product. */
export const PERSISTENCE = ["default", "mikroorm", "dapper"] as const;
export type Persistence = (typeof PERSISTENCE)[number];

/** Which backends each non-default persistence adapter exists on
 *  (`src/platform/adapter-metadata.ts`). */
export const PERSISTENCE_BACKEND: Record<Persistence, string | null> = {
  default: null,
  mikroorm: "node",
  dapper: "dotnet",
};

/** One cell of the matrix. */
export interface PairwiseCase {
  readonly capability: Capability;
  readonly shape: Shape;
  readonly authz: Authz;
  readonly inheritance: Inheritance;
  readonly read: Read;
  readonly persistence: Persistence;
}

/** The source-text axes of a case — everything except the `platform:` clause
 *  override, which is applied per backend at expansion time. */
export type SourceCase = Omit<PairwiseCase, "persistence">;

/** The axis values that mean "this axis is not in play".  A case id OMITS them,
 *  so widening the matrix does not rename every pre-existing case: the ids the
 *  findings register already cites (`none-document-policyAllow-default`) still
 *  name the same crossing after two axes were added.  A register whose ids are
 *  invalidated by the next slice is a register nobody can cite.
 *
 *  Uniqueness is NOT self-evident under omission (three axes have a value
 *  spelled `none`), so it is asserted rather than assumed — see
 *  `test/pairwise/axes.test.ts`. */
const OMITTED_FROM_ID: Readonly<Record<string, string>> = {
  inheritance: "none",
  read: "plain",
};

/** Stable, filesystem- and database-safe id for a case. */
export function caseId(c: PairwiseCase): string {
  return [
    c.capability,
    c.shape,
    c.authz,
    c.inheritance === OMITTED_FROM_ID.inheritance ? undefined : c.inheritance,
    c.read === OMITTED_FROM_ID.read ? undefined : c.read,
    c.persistence,
  ]
    .filter((s): s is string => s !== undefined)
    .join("-");
}

/** The full cross product of the SOURCE-TEXT axes (persistence is a
 *  platform-clause override, not source text, so it is applied separately).
 *  5 × 4 × 5 × 3 × 2 = 600 systems — still cheap enough for the generation
 *  oracle, which is an in-memory pipeline run with no compiler and no
 *  database (~21ms a case, so ~90s across all five backends).
 *
 *  The compile and schema-load oracles do NOT take this set — they pay an
 *  `npm install` or a Postgres round-trip per case and take the all-pairs
 *  cover from `cases.ts` instead. */
export function allSourceCases(): SourceCase[] {
  const out: SourceCase[] = [];
  for (const capability of CAPABILITIES) {
    for (const shape of SHAPES) {
      for (const authz of AUTHZ) {
        for (const inheritance of INHERITANCE) {
          for (const read of READS) out.push({ capability, shape, authz, inheritance, read });
        }
      }
    }
  }
  return out;
}
