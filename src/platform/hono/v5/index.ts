// ---------------------------------------------------------------------------
// hono@v5 — the cross-major successor backend package (see ./pins.ts).
//
// Per the versioned-backend design (the hono@v4 sibling's header), a new
// version "reuses the stable emitter slices by ordinary import and
// overrides only what the major change touches".  The zod 3→4 / TS 5→6
// jump touches NO emitter logic — the single zod-3/4-divergent spot (the
// validation hook's issue-path typing) was widened in the shared emitter
// to satisfy both majors — so v5 is purely a new pin set fed through the
// shared `makeHonoPlatform` factory.  The previous v4 package stays
// registered and loadable (`platform: node@v4`).
// ---------------------------------------------------------------------------

import type { LoomBackendManifest } from "../../manifest.js";
import type { PlatformSurface } from "../../surface.js";
import { makeHonoPlatform } from "../v4/index.js";
import { BACKEND_PINS } from "./pins.js";

/** The descriptor the resolver discovers this package by.  `family:
 *  "node"` is shared with v4 (same JS-runtime platform); `loomVersion:
 *  "v5"` is the package's own version — driven here by the zod 4 / TS 6
 *  majors rather than a Hono major (Hono stays 4.x). */
export const loomManifest: LoomBackendManifest = {
  kind: "backend",
  family: "node",
  loomVersion: "v5",
  core: "^1.0.0",
};

const honoV5Platform: PlatformSurface = makeHonoPlatform(BACKEND_PINS);

export default honoV5Platform;
