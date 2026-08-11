// ---------------------------------------------------------------------------
// M-T9.29 — COMPILE-tier waivers for the pairwise corpus (Hono/node, strict tsc).
//
// Same ratchet as `waivers.ts`: an entry here means "this crossing GENERATES
// but the emitted TypeScript does not type-check, and that is a recorded
// finding".  The gate fails when an unwaived case fails to compile AND when a
// waived case starts compiling (fix landed → the entry goes, in the same PR).
//
// Diagnoses live in `docs/audits/pairwise-corpus-findings-2026-08.md`.
// ---------------------------------------------------------------------------

import type { Waiver } from "./waivers.js";

export const TSC_WAIVERS: readonly Waiver[] = [
  {
    // F2 — `mask unless` × any NON-RELATIONAL saving shape, drizzle adapter.
    //
    // The route builder calls `repo.toWireMasked(row, __maskUser)`
    // unconditionally for a masked aggregate
    // (`src/platform/hono/v4/routes-builder.ts:238`), but only the RELATIONAL
    // repository builder emits that method —
    // `typescript/repository-builder.ts:196` gates it on `aggHasFieldMask`,
    // while `repository-document-builder.ts`, `repository-embedded-builder.ts`
    // and `repository-eventsourced-builder.ts` import `toWireMethod` alone and
    // never mention the mask.  Result: TS2339 "Property 'toWireMasked' does not
    // exist on type '<Agg>Repository'".
    //
    // Not fixed in this slice: emitting the method in three builders changes
    // each repository's PORT surface (the port members are derived FROM the
    // emitted source in `hono/v4/emit.ts`), so it needs its own per-shape tests
    // and the behavioral leg — an emitter change, not a harness change.
    platform: "node",
    persistence: "default",
    capability: "*",
    shape: "document|embedded|eventLog",
    authz: "mask",
    reason:
      "F2 — mask unless × non-relational shape (drizzle): routes call repo.toWireMasked but only the relational repository builder emits it (TS2339)",
  },
  {
    // F5 — a principal-referencing capability filter × `shape: document` ×
    // `persistence: mikroorm`.  The document read path evaluates the filter
    // IN-APP over the rehydrated record (`rec.tenantId === currentUser.tenantId`),
    // which needs `const currentUser = requireCurrentUser();` bound in each read.
    // The drizzle document builder binds it
    // (`repository-document-builder.ts:56` — `principalBind`); the MikroORM
    // document repository renders the same predicate and binds nothing, so
    // `currentUser` is a free name (TS2304).  MikroORM's relational and
    // embedded repositories are both correct, which is why only the document
    // crossing shows it.
    platform: "node",
    persistence: "mikroorm",
    capability: "tenantOwned",
    shape: "document",
    authz: "*",
    reason:
      "F5 — principal capability filter × shape: document × mikroorm: the in-app document predicate reads `currentUser` with no requireCurrentUser() bind (TS2304)",
  },
];
