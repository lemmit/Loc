// ---------------------------------------------------------------------------
// hono@v4 — the versioned backend package (see
// docs/backend-packages.md).  Owns its dep pins (`./pins.ts`) and
// the `PlatformSurface` wiring; drives the shared TypeScript/Hono
// emitter under `src/generator/typescript/`.  A future `hono@v5`
// is a sibling directory that reuses the stable emitter slices by
// ordinary import and overrides only what the Hono-major change
// touches — no flat-file replacement, the previous version stays
// loadable.
// ---------------------------------------------------------------------------

import type { LoomBackendManifest } from "../../manifest.js";
import type { ComposeServiceShape, PlatformSurface } from "../../surface.js";
import { generateTypeScriptForContexts } from "./emit.js";
import { BACKEND_PINS } from "./pins.js";

/** The descriptor the resolver discovers this package by.  In-tree
 *  today; becomes the `loom` key in this package's package.json when
 *  it is extracted. */
export const loomManifest: LoomBackendManifest = {
  kind: "backend",
  family: "hono",
  loomVersion: "v4",
  core: "^1.0.0",
};

const honoPlatform: PlatformSurface = {
  name: "hono",
  defaultPort: 3000,
  needsDb: true,
  mountsUi: false,
  // Hono repository auto-emits these per aggregate — see
  // src/generator/typescript/repository-builder.ts (`async save`,
  // `async findById`, `async getById`).  A user-declared find with
  // one of these names would compile-error with TS2393 "Duplicate
  // function implementation".
  reservedRepositoryFindNames: new Set(["save", "findById", "getById"]),
  emitProject({ contexts, deployable, sys, migrations, emitTrace }): Map<string, string> {
    // The package supplies its own pins to the shared emitter —
    // edge points package → shared, never the reverse.
    return generateTypeScriptForContexts(
      contexts,
      BACKEND_PINS,
      { deployable, sys, migrations },
      { emitTrace },
    );
  },
  composeService({ slug }): ComposeServiceShape {
    return {
      env: [["DATABASE_URL", `postgres://postgres:postgres@db:5432/${slug}`]],
      dependsOnDb: true,
      // Compose healthcheck → /ready (DB-aware).  Sets the service
      // `healthy` only once the app can reach its DB, so dependent
      // services / smoke tests don't race the schema bootstrap.
      // /health stays for cheap liveness probing (k8s livenessProbe).
      healthPath: "/ready",
      internalPort: 3000,
    };
  },
};

export default honoPlatform;
