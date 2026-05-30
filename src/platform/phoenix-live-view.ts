import type { PlatformAdapterDefaults, PlatformAdapters } from "../generator/_adapters/index.js";
import { ashPostgresPersistenceAdapter } from "../generator/phoenix-live-view/adapters/ash-postgres-persistence.js";
import { ashStyleAdapter } from "../generator/phoenix-live-view/adapters/ash-style.js";
import { byFeatureLayoutAdapter } from "../generator/phoenix-live-view/adapters/by-feature-layout.js";
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
  isFrontend: false,
  // Ash code-interface conventions.  A user-declared find named one
  // of these would collide with the auto-generated CRUD action of
  // the same name on the resource module.
  reservedRepositoryFindNames: new Set(["get", "read", "create", "update", "destroy"]),
  // The Phoenix router wraps every JSON controller in `scope "/api"`
  // (health/ready aside), so a consuming React frontend must target
  // `<origin>/api`, not the bare origin.
  apiBasePath: "/api",
  emitProject({ contexts, deployable, sys, migrations, emitTrace }): Map<string, string> {
    return generatePhoenixLiveViewProject({ contexts, deployable, sys, migrations, emitTrace });
  },
  composeService({ slug }): ComposeServiceShape {
    return {
      env: [
        ["DATABASE_URL", `ecto://postgres:postgres@db:5432/${slug}`],
        // Phoenix requires ≥64 bytes for secret_key_base; the previous
        // value was 61 chars and tripped a `Plug.Session.assert_secret/2`
        // raise at boot.  Generate via `mix phx.gen.secret` for prod.
        ["SECRET_KEY_BASE", "loom-dev-secret-replace-in-production-with-mix-phx-gen-secret-aaaa"],
        ["PHX_HOST", "localhost"],
        ["PHX_SERVER", "true"],
        ["PORT", "4000"],
      ],
      dependsOnDb: true,
      healthPath: "/health",
      internalPort: 4000,
    };
  },
  // phoenixLiveView — Ash owns persistence + style (the Ash action
  // surface), so the menu is a single ashPostgres persistence + an
  // `ash` style + a default `byFeature` layout.  All real (F7a/b/c);
  // no stubs.  Built lazily (see PlatformSurface.adapters jsdoc).
  adapters(): PlatformAdapters {
    return {
      persistence: { ashPostgres: ashPostgresPersistenceAdapter },
      styles: { ash: ashStyleAdapter },
      layouts: { byFeature: byFeatureLayoutAdapter },
    };
  },
  adapterDefaults(): PlatformAdapterDefaults {
    return {
      persistence: { state: "ashPostgres", eventLog: "ashPostgres" },
      style: "ash",
      layout: "byFeature",
    };
  },
};

export default phoenixLiveViewPlatform;
