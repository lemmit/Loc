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

import {
  type PlatformAdapterDefaults,
  type PlatformAdapters,
  type RuntimeAdapter,
  type StyleAdapter,
  stubAdapter,
  type TransportAdapter,
} from "../../../generator/_adapters/index.js";
import type { LoomBackendManifest } from "../../manifest.js";
import {
  type ComposeServiceShape,
  type PlatformSurface,
  STATIC_BUNDLE_FRAMEWORKS,
} from "../../surface.js";
import { byFeatureLayoutAdapter } from "./adapters/by-feature-layout.js";
import { byLayerLayoutAdapter } from "./adapters/by-layer-layout.js";
import { drizzlePersistenceAdapter } from "./adapters/drizzle-persistence.js";
import { layeredStyleAdapter } from "./adapters/layered-style.js";
import { mikroOrmPersistenceAdapter } from "./adapters/mikroorm-persistence.js";
import { type BackendPins, generateTypeScriptForContexts } from "./emit.js";
import { BACKEND_PINS } from "./pins.js";

/** The descriptor the resolver discovers this package by.  In-tree
 *  today; becomes the `loom` key in this package's package.json when
 *  it is extracted.
 *
 *  `family: "node"` names the JS runtime platform; `loomVersion: "v4"`
 *  is the package's own version (the `hono: ^4.x` pin in `./pins.ts`),
 *  *not* a Node.js version — the same convention as `dotnet@v10` ↔
 *  .NET 10.  The `v5/` sibling (`node@v5`) is the current default — it
 *  reuses this package's `makeHonoPlatform` factory + shared emitter with
 *  a zod 4 / TS 6 pin set; v4 (zod 3 / TS 5) stays registered + loadable
 *  via an explicit `platform: node@v4` pin. */
export const loomManifest: LoomBackendManifest = {
  kind: "backend",
  family: "node",
  loomVersion: "v4",
  core: "^1.0.0",
};

const honoPlatform: PlatformSurface = makeHonoPlatform(BACKEND_PINS);

/** Build the Hono `PlatformSurface` for a given dep-pin set.  The
 *  surface shape is identical across Hono package versions — only the
 *  `BACKEND_PINS` fed to the shared emitter differ — so `v5` (zod 4 /
 *  TS 6) reuses this factory with its own `./pins.js` rather than
 *  copying the surface boilerplate. */
export function makeHonoPlatform(pins: BackendPins): PlatformSurface {
  return {
    name: "node",
    defaultPort: 3000,
    needsDb: true,
    mountsUi: false,
    isFrontend: false,
    // Static-asset host (static middleware): serves any static-bundle
    // framework.  D-PHOENIX-SURFACE.
    hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
    // Hono repository auto-emits these per aggregate — see
    // src/generator/typescript/repository-builder.ts (`async save`,
    // `async findById`, `async getById`).  A user-declared find with
    // one of these names would compile-error with TS2393 "Duplicate
    // function implementation".
    reservedRepositoryFindNames: new Set(["save", "findById", "getById", "delete"]),
    emitProject({
      contexts,
      deployable,
      sys,
      migrations,
      emitTrace,
      styleAdapter,
      layoutAdapter,
      sourcemap,
    }): Map<string, string> {
      // The package supplies its own pins to the shared emitter —
      // edge points package → shared, never the reverse.  The deployable's
      // resolved style / layout adapters (D-REALIZATION-AXES) are forwarded
      // straight through into the generator's EmitCtx.
      return generateTypeScriptForContexts(
        contexts,
        pins,
        { deployable, sys, migrations, styleAdapter, layoutAdapter },
        { emitTrace, sourcemap },
      );
    },
    composeService({ slug }): ComposeServiceShape {
      return {
        env: [
          ["DATABASE_URL", `postgres://postgres:postgres@db:5432/${slug}`],
          // Runtime log-level knob (default info; overridable here / in k8s).
          ["LOG_LEVEL", "info"],
        ],
        dependsOnDb: true,
        // Compose healthcheck → /ready (DB-aware).  Sets the service
        // `healthy` only once the app can reach its DB, so dependent
        // services / smoke tests don't race the schema bootstrap.
        // /health stays for cheap liveness probing (k8s livenessProbe).
        healthPath: "/ready",
        internalPort: 3000,
      };
    },
    // hono (Node backend) — `drizzle` + `mikroorm` persistence + `layered` style
    // + `byLayer` / `byFeature` layout are real (F6a/b/c + Phase 5b/5d);
    // `cqrs` is a stub.  Built lazily (see PlatformSurface jsdoc).
    adapters(): PlatformAdapters {
      const menu: PlatformAdapters = {
        persistence: {
          drizzle: drizzlePersistenceAdapter,
          mikroorm: mikroOrmPersistenceAdapter,
        },
        styles: {
          layered: layeredStyleAdapter,
          cqrs: stubAdapter<StyleAdapter>("style", "cqrs", "node", () => Object.keys(menu.styles), {
            name: "cqrs",
            supportedStrategies: ["state"],
            supportedLayouts: ["byLayer", "byFeature"],
          }),
          // `flat` — reserved-not-implemented, completing the `application:`
          // vocabulary `flat` → `serviceLayer` (= `layered`) → `cqrs`
          // (realization-axes-alignment.md).
          flat: stubAdapter<StyleAdapter>("style", "flat", "node", () => Object.keys(menu.styles), {
            name: "flat",
            supportedStrategies: ["state"],
            supportedLayouts: ["byLayer", "byFeature"],
          }),
        },
        layouts: {
          byLayer: byLayerLayoutAdapter,
          byFeature: byFeatureLayoutAdapter,
        },
        transports: {
          // The Hono router — the only real HTTP surface today.
          hono: { name: "hono" },
          // Reserved alternatives (the per-transport emit is future work;
          // realization-axes-alignment.md): `express` (the canonical, most
          // widely-used Node web framework) and `fastify` (the popular modern
          // one).  `transport: controllers` is the dotnet analogue.
          express: stubAdapter<TransportAdapter>(
            "transport",
            "express",
            "node",
            () => Object.keys(menu.transports),
            { name: "express" },
          ),
          fastify: stubAdapter<TransportAdapter>(
            "transport",
            "fastify",
            "node",
            () => Object.keys(menu.transports),
            { name: "fastify" },
          ),
        },
        runtimes: {
          // DB-transaction consistency — the only real runtime today.
          transactional: { name: "transactional" },
          // `worker` — Node's built-in `worker_threads` concurrency primitive
          // (the idiomatic Node story; there is no mainstream actor runtime).
          // Reserved — the per-runtime emit is future work
          // (realization-axes-alignment.md).  Node's stand-in on the runtime
          // axis where dotnet has `orleans` and elixir `genserver`.
          worker: stubAdapter<RuntimeAdapter>(
            "runtime",
            "worker",
            "node",
            () => Object.keys(menu.runtimes),
            {
              name: "worker",
            },
          ),
        },
      };
      return menu;
    },
    adapterDefaults(): PlatformAdapterDefaults {
      return {
        persistence: { state: "drizzle", eventLog: "drizzle" },
        style: "layered",
        layout: "byLayer",
        transport: "hono",
        runtime: "transactional",
      };
    },
  };
}

export default honoPlatform;
