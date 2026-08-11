// ---------------------------------------------------------------------------
// M-T9.29 — SCHEMA-LOAD waivers for the pairwise corpus.
//
// An entry here means "this crossing GENERATES, but Postgres refuses the DDL
// it emits" — the G2 class (#2316), where the generated stack compiles on all
// five backends and then never starts.  Same ratchet as the sibling registers:
// an unwaived refusal fails, and a waived crossing that starts loading fails
// until its entry is deleted.
// ---------------------------------------------------------------------------

import type { Waiver } from "./waivers.js";

export const SCHEMA_LOAD_WAIVERS: readonly Waiver[] = [];
