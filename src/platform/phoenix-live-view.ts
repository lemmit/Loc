import { generatePhoenixLiveViewProject } from "../generator/phoenix-live-view/index.js";
import type { ComposeServiceShape, PlatformSurface } from "./surface.js";

// ---------------------------------------------------------------------------
// Phoenix LiveView platform — fullstack Elixir/Ash deployable.
//
// Unlike `dotnet`/`hono` (backend-only) and `react`/`static` (frontend-only),
// a `phoenixLiveView` deployable ships ONE project that both serves an
// Ash-derived API (when `serves:` is populated) AND mounts a `ui:`
// rendered as Phoenix LiveView modules against the `ashPhoenix` HEEx
// design pack.  It owns its own Postgres database (`needsDb: true`),
// matches the backend platforms for `serves:` validity, and matches
// the frontend platforms for `ui:` mount validity (`mountsUi: true`).
//
// All project emission (mix.exs, configs, Dockerfile, lib/<app>/*,
// migrations, LiveView modules, controllers) lives under
// `../generator/phoenix-live-view/`; this module is a thin
// `PlatformSurface` wiring that delegates to the orchestrator.
// ---------------------------------------------------------------------------

const phoenixLiveViewPlatform: PlatformSurface = {
  name: "phoenixLiveView",
  defaultPort: 4000,
  needsDb: true,
  mountsUi: true,
  // Ash code-interface conventions.  A user-declared find named one
  // of these would collide with the auto-generated CRUD action of
  // the same name on the resource module.
  reservedRepositoryFindNames: new Set(["get", "read", "create", "update", "destroy"]),
  emitProject({ contexts, deployable, sys, emitTrace }): Map<string, string> {
    return generatePhoenixLiveViewProject({ contexts, deployable, sys, emitTrace });
  },
  composeService({ slug }): ComposeServiceShape {
    return {
      env: [
        ["DATABASE_URL", `ecto://postgres:postgres@db:5432/${slug}`],
        ["SECRET_KEY_BASE", "loom-dev-secret-replace-in-production-with-mix-phx-gen-secret"],
        ["PHX_HOST", "localhost"],
        ["PHX_SERVER", "true"],
        ["PORT", "4000"],
      ],
      dependsOnDb: true,
      healthPath: "/health",
      internalPort: 4000,
    };
  },
};

export default phoenixLiveViewPlatform;
