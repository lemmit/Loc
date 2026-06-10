import { generateSvelteForContexts } from "../generator/svelte/index.js";
import type { ComposeServiceShape, PlatformSurface } from "./surface.js";

// ---------------------------------------------------------------------------
// Svelte frontend platform — the second frontend-only platform after
// `react`.  Generated projects are Svelte 5 / SvelteKit static SPAs
// (adapter-static, ssr off) rendered against a svelte-format design
// pack (`shadcnSvelte` / `flowbite`) and served exactly like the React
// SPA: `vite build` → `vite preview` inside the docker runtime stage.
//
// Deployable contract mirrors `react`: `targets:` a backend, inherits
// its contexts via enrichment, owns no database.
// See docs/plans/svelte-frontend-plan.md.
// ---------------------------------------------------------------------------

const sveltePlatform: PlatformSurface = {
  name: "svelte",
  defaultPort: 3002,
  // Frontends are SPAs hitting a peer backend; they own no DB.
  needsDb: false,
  mountsUi: true,
  isFrontend: true,
  // Standalone static-asset host for its own Svelte bundle.  Joins
  // `STATIC_BUNDLE_FRAMEWORKS` (making svelte bundles hostable on any
  // static-asset host, and react bundles on this one) in the
  // backend-host-embedding slice — until then the surface hosts only
  // its own framework.
  hostableFrameworks: new Set(["svelte"]),
  // Svelte generator only emits API call factories — no per-aggregate
  // repository class.  No find-name collisions are possible.
  reservedRepositoryFindNames: new Set(),
  emitProject({ contexts, sys, deployable, topLevelComponents }): Map<string, string> {
    return generateSvelteForContexts(contexts, sys, deployable, { topLevelComponents });
  },
  composeService({ deployable, sys }): ComposeServiceShape {
    const target = sys.deployables.find((t) => t.name === deployable.targetName);
    return {
      env: [["VITE_API_BASE_URL", `http://localhost:${target?.port ?? 8080}`]],
      dependsOnDb: false,
      healthPath: "/",
      internalPort: 3000,
    };
  },
};

export default sveltePlatform;
