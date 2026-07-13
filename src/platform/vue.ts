import { API_BASE_PATH } from "../util/api-base.js";
import { dispatchFrontendProject } from "./frontend-dispatch.js";
import {
  type ComposeServiceShape,
  type PlatformSurface,
  STATIC_BUNDLE_FRAMEWORKS,
} from "./surface.js";

// ---------------------------------------------------------------------------
// Vue frontend platform — the third frontend-only platform after
// `react` and `svelte`.  Generated projects are Vue 3 Vite SPAs
// (vue-router, `<script setup lang="ts">` SFC pages) rendered against
// a vue-format design pack (`vuetify` / `shadcnVue`) and served
// exactly like the React SPA: `vite build` → `vite preview` inside
// the docker runtime stage.
//
// Deployable contract mirrors `react`: `targets:` a backend, inherits
// its contexts via enrichment, owns no database.
// See docs/old/plans/vue-frontend-plan.md.
// ---------------------------------------------------------------------------

const vuePlatform: PlatformSurface = {
  name: "vue",
  defaultPort: 3003,
  // Frontends are SPAs hitting a peer backend; they own no DB.
  needsDb: false,
  mountsUi: true,
  isFrontend: true,
  // Standalone static-asset host (Vite preview over a built bundle):
  // serves any static-bundle framework — `vue` joined
  // `STATIC_BUNDLE_FRAMEWORKS` in the embedding slice, so vue bundles
  // host anywhere static assets are served and react bundles host
  // here.
  hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
  // Vue generator only emits API call factories — no per-aggregate
  // repository class.  No find-name collisions are possible.
  reservedRepositoryFindNames: new Set(),
  emitProject({ contexts, sys, deployable, topLevelComponents, sourcemap }): Map<string, string> {
    // Frontend hosts dispatch by the UI's framework, not the platform keyword —
    // a vue host can serve a `framework: react|svelte|angular` ui (any static
    // bundle runs on a static host).  Previously vue had NO dispatch and
    // silently emitted Vue for every framework (B19).  `vue` is the native
    // fallback.
    return dispatchFrontendProject(deployable.uiFramework, "vue", {
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

export default vuePlatform;
