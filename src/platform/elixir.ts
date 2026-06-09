import type { PlatformAdapterDefaults, PlatformAdapters } from "../generator/_adapters/index.js";
import { ashPostgresPersistenceAdapter } from "../generator/elixir/adapters/ash-postgres-persistence.js";
import { ashStyleAdapter } from "../generator/elixir/adapters/ash-style.js";
import { byFeatureLayoutAdapter } from "../generator/elixir/adapters/by-feature-layout.js";
import { ectoPersistenceAdapter } from "../generator/elixir/adapters/ecto-persistence.js";
import { vanillaStyleAdapter } from "../generator/elixir/adapters/vanilla-style.js";
import { generateElixirProject } from "../generator/elixir/index.js";
import {
  type ComposeServiceShape,
  type PlatformSurface,
  STATIC_BUNDLE_FRAMEWORKS,
} from "./surface.js";

// ---------------------------------------------------------------------------
// Elixir platform — fullstack Elixir/Ash + Phoenix deployable
// (D-ELIXIR-PLATFORM: platform names the language-ecosystem).
//
// Unlike `dotnet`/`hono` (backend-only) and `react`/`static` (frontend-only),
// an `elixir` deployable ships ONE project that both serves an
// Ash-derived API (when `serves:` is populated) AND mounts a `ui:`
// rendered as Phoenix LiveView modules against the `ashPhoenix` HEEx
// design pack.  It owns its own Postgres database (`needsDb: true`),
// matches the backend platforms for `serves:` validity, and matches
// the frontend platforms for `ui:` mount validity (`mountsUi: true`).
//
// All project emission (mix.exs, configs, Dockerfile, lib/<app>/*,
// migrations, LiveView modules, controllers) lives under
// `../generator/elixir/`; this module is a thin `PlatformSurface`
// wiring that delegates to the orchestrator.
// ---------------------------------------------------------------------------

const elixirPlatform: PlatformSurface = {
  name: "elixir",
  defaultPort: 4000,
  needsDb: true,
  mountsUi: true,
  isFrontend: false,
  // The keystone (D-PHOENIX-SURFACE): Phoenix is the only platform that
  // is BOTH a server-render runtime (LiveView, spelled `phoenixLiveView`)
  // AND a static-asset host (`priv/static`), so it serves its own
  // runtime-coupled framework UNIONED with every static-bundle framework.
  // Richest `hostableFrameworks` of any platform.
  hostableFrameworks: new Set(["phoenixLiveView", ...STATIC_BUNDLE_FRAMEWORKS]),
  // Ash code-interface conventions.  A user-declared find named one
  // of these would collide with the auto-generated CRUD action of
  // the same name on the resource module.
  reservedRepositoryFindNames: new Set(["get", "read", "create", "update", "destroy"]),
  emitProject({
    contexts,
    deployable,
    sys,
    migrations,
    emitTrace,
    styleAdapter,
  }): Map<string, string> {
    // Forward the deployable's resolved style adapter (D-REALIZATION-AXES
    // `application:`) into the generator's EmitCtx; the layout axis has no
    // Phoenix consumer (Ash owns the byFeature layout), so it's dropped.
    return generateElixirProject({
      contexts,
      deployable,
      sys,
      migrations,
      emitTrace,
      styleAdapter,
    });
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
  // elixir — two foundations share these axes (D-REALIZATION-AXES;
  // docs/plans/realization-axes-alignment.md).  Per FOUNDATION_OWNED_AXES,
  // `ash` owns `application` + `transport` (NOT persistence — `ashPostgres`
  // stays selectable); `vanilla` owns nothing.  So both data layers are
  // first-class on the persistence axis (`ashPostgres` for Ash, `ecto` for
  // plain Phoenix) and both styles on the application axis (`ash`, `vanilla`).
  // The defaults below describe elixir's DEFAULT foundation (ash); a
  // `foundation: vanilla` deployable overrides them to `ecto` / `vanilla` in
  // lowering (`foundationAdapterOverride`).  All real (F7a/b/c); no stubs.
  adapters(): PlatformAdapters {
    return {
      persistence: { ashPostgres: ashPostgresPersistenceAdapter, ecto: ectoPersistenceAdapter },
      styles: { ash: ashStyleAdapter, vanilla: vanillaStyleAdapter },
      layouts: { byFeature: byFeatureLayoutAdapter },
      // Phoenix (Router + controllers) — the Elixir backend's HTTP surface,
      // shared by both foundations (D-PHOENIX-TRANSPORT).
      transports: { phoenix: { name: "phoenix" } },
    };
  },
  adapterDefaults(): PlatformAdapterDefaults {
    return {
      persistence: { state: "ashPostgres", eventLog: "ashPostgres" },
      style: "ash",
      layout: "byFeature",
      transport: "phoenix",
    };
  },
};

export default elixirPlatform;
