import type { ComposeServiceShape, PlatformSurface } from "./surface.js";

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
// See docs/plans/vue-frontend-plan.md.
// ---------------------------------------------------------------------------

const vuePlatform: PlatformSurface = {
  name: "vue",
  defaultPort: 3003,
  // Frontends are SPAs hitting a peer backend; they own no DB.
  needsDb: false,
  mountsUi: true,
  isFrontend: true,
  // Standalone static-asset host for its own Vue bundle.  Joins
  // `STATIC_BUNDLE_FRAMEWORKS` (making vue bundles hostable on any
  // static-asset host, and react bundles on this one) in the
  // backend-host-embedding slice — until then the surface hosts only
  // its own framework.
  hostableFrameworks: new Set(["vue"]),
  // Vue generator only emits API call factories — no per-aggregate
  // repository class.  No find-name collisions are possible.
  reservedRepositoryFindNames: new Set(),
  emitProject({ contexts, sys, deployable }): Map<string, string> {
    // Stub until the Vue generator lands (vue-frontend-plan.md
    // Slice 3).  Emitting a README keeps `generate system` total over
    // every registered platform without pretending to build.
    void contexts;
    return new Map([
      [
        "README.md",
        `# ${deployable.name}\n\nVue frontend deployable for system ${sys.name} — generator not yet implemented (see docs/plans/vue-frontend-plan.md).\n`,
      ],
    ]);
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

export default vuePlatform;
