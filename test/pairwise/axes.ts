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
  readonly persistence: Persistence;
}

/** Stable, filesystem- and database-safe id for a case. */
export function caseId(c: PairwiseCase): string {
  return `${c.capability}-${c.shape}-${c.authz}-${c.persistence}`;
}

/** The full cross product of the three SOURCE-TEXT axes (persistence is a
 *  platform-clause override, not source text, so it is applied separately).
 *  5 × 4 × 5 = 100 systems — cheap enough for the generation oracle, which is
 *  an in-memory pipeline run with no compiler and no database. */
export function allSourceCases(): { capability: Capability; shape: Shape; authz: Authz }[] {
  const out: { capability: Capability; shape: Shape; authz: Authz }[] = [];
  for (const capability of CAPABILITIES) {
    for (const shape of SHAPES) {
      for (const authz of AUTHZ) out.push({ capability, shape, authz });
    }
  }
  return out;
}
