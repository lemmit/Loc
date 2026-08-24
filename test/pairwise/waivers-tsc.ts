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
  // EMPTY, and that is the target state — same rule as the wire-differential
  // register: a new divergence is a BUG to fix on the emitter first, and a
  // waiver only when fixing it is a mission of its own with a named exit.
  //
  // Both original entries were closed by #2528 and are deleted here:
  //
  //   F2 — `mask unless` × a NON-RELATIONAL saving shape (drizzle): the route
  //        builder called `repo.toWireMasked(...)` for any masked aggregate,
  //        but only the RELATIONAL repository builder emitted the method
  //        (TS2339).  The document / embedded / event-sourced builders now
  //        emit it too.
  //   F5 — a principal-referencing capability filter × `shape: document` ×
  //        `persistence: mikroorm`: the in-app document predicate read
  //        `currentUser` with no `requireCurrentUser()` bind (TS2304).  The
  //        MikroORM document repository now binds it, as drizzle's already did.
  //
  // Both outlived their fix because this leg had no CI workflow to run the
  // stale-waiver ratchet (see the note in `waivers.ts`).  `pairwise.yml` runs
  // it now.
];
