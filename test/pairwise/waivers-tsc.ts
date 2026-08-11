// ---------------------------------------------------------------------------
// M-T9.29 — COMPILE-tier waivers for the pairwise corpus (Hono/node, strict tsc).
//
// Same ratchet as `waivers.ts`: an entry here means "this crossing GENERATES
// but the emitted TypeScript does not type-check, and that is a recorded
// finding".  The gate fails when an unwaived case fails to compile AND when a
// waived case starts compiling (fix landed → the entry goes, in the same PR).
//
// Empty is the goal state and, on node, the CURRENT state — every crossing the
// all-pairs cover reaches type-checks today.  The register is kept (rather
// than deleted as dead code) because the follow-up slice that adds the
// dotnet / java / elixir compile legs is where the recorded instances of this
// class actually live (#2412 was .NET CS0128 + Python F821; node compiled it
// fine), and those legs need this exact seam on day one.
// ---------------------------------------------------------------------------

import type { Waiver } from "./waivers.js";

export const TSC_WAIVERS: readonly Waiver[] = [];
