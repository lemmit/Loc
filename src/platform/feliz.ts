import { generateFelizForContexts } from "../generator/feliz/index.js";
import { API_BASE_PATH } from "../util/api-base.js";
import type { ComposeServiceShape, PlatformSurface } from "./surface.js";

// ---------------------------------------------------------------------------
// Feliz frontend platform — a Fable/F#/Elmish (MVU) SPA
// (fable-elmish-frontend.md).  Unlike the vite-only static frontends
// (react/svelte/vue/angular), a Feliz bundle is built by `dotnet fable`
// (F# → JS) THEN `vite build`, so it is NOT a drop-in static-bundle host:
// it can only host its own `framework: feliz` (no other static host knows
// how to run the Fable build, and it doesn't serve foreign vite bundles).
// That's why it's absent from `STATIC_BUNDLE_FRAMEWORKS` /
// `FRONTEND_GENERATORS` and dispatches to its own generator directly.
//
// Deployable contract mirrors `react`: `targets:` a backend, inherits its
// contexts via enrichment, owns no database.
// ---------------------------------------------------------------------------

const felizPlatform: PlatformSurface = {
  name: "feliz",
  defaultPort: 3005,
  needsDb: false,
  mountsUi: true,
  isFrontend: true,
  // Feliz hosts ONLY feliz — its Fable build is not the vite-only pipeline
  // the static-bundle hosts share.  Must equal the metadata descriptor.
  hostableFrameworks: new Set(["feliz"]),
  reservedRepositoryFindNames: new Set(),
  emitProject({ contexts, sys, deployable }): Map<string, string> {
    return generateFelizForContexts(contexts, sys, deployable);
  },
  composeService({ deployable, sys }): ComposeServiceShape {
    const target = sys.deployables.find((t) => t.name === deployable.targetName);
    return {
      env: [["VITE_API_BASE_URL", `http://localhost:${target?.port ?? 8080}${API_BASE_PATH}`]],
      dependsOnDb: false,
      healthPath: "/",
      internalPort: 3000,
      injectsApiProxyTarget: true,
    };
  },
};

export default felizPlatform;
