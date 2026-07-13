import { API_BASE_PATH } from "../util/api-base.js";
import { dispatchFrontendProject } from "./frontend-dispatch.js";
import {
  type ComposeServiceShape,
  type PlatformSurface,
  STATIC_BUNDLE_FRAMEWORKS,
} from "./surface.js";

// ---------------------------------------------------------------------------
// Svelte frontend platform — the second frontend-only platform after
// `react`.  Generated projects are Svelte 5 / SvelteKit static SPAs
// (adapter-static, ssr off) rendered against a svelte-format design
// pack (`shadcnSvelte` / `flowbite`) and served exactly like the React
// SPA: `vite build` → `vite preview` inside the docker runtime stage.
//
// Deployable contract mirrors `react`: `targets:` a backend, inherits
// its contexts via enrichment, owns no database.
// See docs/old/plans/svelte-frontend-plan.md.
// ---------------------------------------------------------------------------

const sveltePlatform: PlatformSurface = {
  name: "svelte",
  defaultPort: 3002,
  // Frontends are SPAs hitting a peer backend; they own no DB.
  needsDb: false,
  mountsUi: true,
  isFrontend: true,
  // Standalone static-asset host (vite preview over a built bundle):
  // serves any static-bundle framework.  D-PHOENIX-SURFACE.
  hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
  // Svelte generator only emits API call factories — no per-aggregate
  // repository class.  No find-name collisions are possible.
  reservedRepositoryFindNames: new Set(),
  emitProject({ contexts, sys, deployable, topLevelComponents, sourcemap }): Map<string, string> {
    // Frontend hosts dispatch by the UI's framework, not the platform keyword —
    // a svelte host can serve a `framework: react|vue|angular` ui (any static
    // bundle runs on a static host).  `svelte` is the native fallback.
    return dispatchFrontendProject(deployable.uiFramework, "svelte", {
      contexts,
      sys,
      deployable,
      topLevelComponents,
      sourcemap,
    });
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

export default sveltePlatform;
