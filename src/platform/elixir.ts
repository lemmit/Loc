import {
  type PlatformAdapterDefaults,
  type PlatformAdapters,
  type RuntimeAdapter,
  stubAdapter,
} from "../generator/_adapters/index.js";
import { byFeatureLayoutAdapter } from "../generator/elixir/adapters/by-feature-layout.js";
import { ectoPersistenceAdapter } from "../generator/elixir/adapters/ecto-persistence.js";
import { layeredStyleAdapter } from "../generator/elixir/adapters/layered-style.js";
import { generateElixirProject } from "../generator/elixir/index.js";
import type { ComposeServiceShape, PlatformSurface } from "./surface.js";

/** A cryptographically-random lowercase-hex string of `bytes` bytes (2 hex
 *  chars each).  Uses the Web Crypto global (`getRandomValues`) — available in
 *  both Node (≥19) and the browser playground — so the Elixir surface stays
 *  browser-safe (no `node:crypto` import). */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

// ---------------------------------------------------------------------------
// Elixir platform — fullstack Phoenix deployable
// (D-ELIXIR-PLATFORM: platform names the language-ecosystem).
//
// Unlike `dotnet`/`hono` (backend-only) and `react`/`static` (frontend-only),
// an `elixir` deployable ships ONE project that both serves a JSON
// API (when `serves:` is populated) AND mounts a `ui:` rendered as
// Phoenix LiveView modules against the `coreComponents` HEEx design
// pack, all on plain Ecto/Phoenix (the `vanilla` foundation).  It owns
// its own Postgres database (`needsDb: true`), matches the backend
// platforms for `serves:` validity, and matches the frontend platforms
// for `ui:` mount validity (`mountsUi: true`).
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
  // AND a static-asset host (`priv/static`) — it hosts its
  // runtime-coupled LiveView plus every static bundle (react / vue /
  // svelte), all served from `/app`.  The SvelteKit bundle builds with
  // `paths.base = "/app"` so its asset URLs + base-aware links resolve
  // under the prefix (the same `basePath` thread react/vue use for their
  // vite `base`).
  hostableFrameworks: new Set(["phoenixLiveView", "react", "static", "vue", "svelte"]),
  // Context-function conventions.  A user-declared find named one of
  // these would collide with the generated CRUD context function of the
  // same name (`get_<agg>` / `create_<agg>` / …).
  reservedRepositoryFindNames: new Set(["get", "read", "create", "update", "destroy"]),
  emitProject({
    contexts,
    deployable,
    sys,
    migrations,
    emitTrace,
    styleAdapter,
    sourcemap,
  }): Map<string, string> {
    // Forward the deployable's resolved style adapter (D-REALIZATION-AXES
    // `application:`) into the generator's EmitCtx; the layout axis has no
    // Phoenix consumer, so it's dropped.
    return generateElixirProject({
      contexts,
      deployable,
      sys,
      migrations,
      emitTrace,
      styleAdapter,
      sourcemap,
    });
  },
  composeService({ slug }): ComposeServiceShape {
    return {
      env: [
        ["DATABASE_URL", `ecto://postgres:postgres@db:5432/${slug}`],
        // Phoenix signs/encrypts sessions with secret_key_base and requires
        // ≥64 bytes.  Generated per project at `generate` time (64 random
        // bytes → 128 hex chars) so no two generated stacks — and no two
        // deployables — share a session-signing key, instead of the old
        // hard-coded shared literal.  (`mix phx.gen.secret` is the manual
        // equivalent.)  k8s routes it to a Secret; see `secretEnvKeys`.
        ["SECRET_KEY_BASE", randomHex(64)],
        ["PHX_HOST", "localhost"],
        ["PHX_SERVER", "true"],
        ["PORT", "4000"],
        // Runtime log-level knob (default info; overridable here / in k8s).
        ["LOG_LEVEL", "info"],
      ],
      // SECRET_KEY_BASE signs/encrypts sessions — sensitive, so the k8s
      // emitter routes it to a Secret rather than a plaintext ConfigMap.
      secretEnvKeys: ["SECRET_KEY_BASE"],
      dependsOnDb: true,
      healthPath: "/health",
      internalPort: 4000,
    };
  },
  // elixir — the `vanilla` foundation (plain Ecto/Phoenix) is the only
  // foundation (D-REALIZATION-AXES; docs/plans/realization-axes-alignment.md).
  // Persistence is `ecto` (the DB-agnostic data layer); the application style
  // is `layered` (DSL `serviceLayer` — plain Phoenix's controller → context →
  // repository pipeline).  The transport (`phoenix`) and runtime
  // (`transactional`) adapters are real; `genserver` (process-per-aggregate
  // runtime) is a reserved stub.
  adapters(): PlatformAdapters {
    const menu: PlatformAdapters = {
      persistence: { ecto: ectoPersistenceAdapter },
      styles: { layered: layeredStyleAdapter },
      layouts: { byFeature: byFeatureLayoutAdapter },
      // Phoenix (Router + controllers) — the Elixir backend's HTTP surface,
      // shared by both foundations (D-PHOENIX-TRANSPORT).
      transports: { phoenix: { name: "phoenix" } },
      runtimes: {
        // DB-transaction consistency — the only real runtime today.
        transactional: { name: "transactional" },
        // A BEAM process per aggregate — reserved (the GenServer-runtime emit
        // is future work; realization-axes-alignment.md).
        genserver: stubAdapter<RuntimeAdapter>(
          "runtime",
          "genserver",
          "elixir",
          () => Object.keys(menu.runtimes),
          { name: "genserver" },
        ),
      },
    };
    return menu;
  },
  adapterDefaults(): PlatformAdapterDefaults {
    return {
      // Both state + eventLog persist through the `ecto` data layer (plain
      // Phoenix on Ecto).
      persistence: { state: "ecto", eventLog: "ecto" },
      style: "layered",
      layout: "byFeature",
      transport: "phoenix",
      runtime: "transactional",
    };
  },
};

export default elixirPlatform;
