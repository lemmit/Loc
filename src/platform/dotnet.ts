import {
  type PersistenceAdapter,
  type PlatformAdapterDefaults,
  type PlatformAdapters,
  type StyleAdapter,
  stubAdapter,
} from "../generator/_adapters/index.js";
import { byFeatureLayoutAdapter } from "../generator/dotnet/adapters/by-feature-layout.js";
import { byLayerLayoutAdapter } from "../generator/dotnet/adapters/by-layer-layout.js";
import { cqrsStyleAdapter } from "../generator/dotnet/adapters/cqrs-style.js";
import { dapperPersistenceAdapter } from "../generator/dotnet/adapters/dapper-persistence.js";
import { efcorePersistenceAdapter } from "../generator/dotnet/adapters/efcore-persistence.js";
import { generateDotnetForContexts } from "../generator/dotnet/index.js";
import {
  type ComposeServiceShape,
  type PlatformSurface,
  STATIC_BUNDLE_FRAMEWORKS,
} from "./surface.js";

const dotnetPlatform: PlatformSurface = {
  name: "dotnet",
  defaultPort: 8080,
  needsDb: true,
  isFrontend: false,
  // Static-asset host (embeds a SPA via wwwroot + SPA fallback):
  // serves any static-bundle framework.  D-PHOENIX-SURFACE.
  hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
  // .NET admits an embedded React SPA via static-files middleware +
  // SPA fallback route — see the fullstack branch in
  // `generator/dotnet/index.ts` that fires when `deployable.uiName`
  // is set.  Backend-only dotnet deployables (no `ui:`) stay
  // unaffected; the deployable validator only errors when
  // `hasUiBinding && !platformMountsUi`, which never fires absent
  // an explicit `ui:` declaration.
  mountsUi: true,
  // .NET repository auto-emits `SaveAsync` and `GetByIdAsync`.  Find
  // names are Pascal-cased on the C# side, so a DSL find named
  // `saveAsync` lowers to `SaveAsync()` colliding with the auto
  // method.  Plain `save` (→ `Save()`) doesn't collide on .NET, but
  // it DOES on Hono — the validator takes the union across all
  // platforms (see `validateLoomModel`).
  reservedRepositoryFindNames: new Set(["saveAsync", "getByIdAsync"]),
  emitProject({
    contexts,
    deployable,
    sys,
    migrations,
    styleAdapter,
    layoutAdapter,
  }): Map<string, string> {
    const namespace = deployable.name[0]!.toUpperCase() + deployable.name.slice(1);
    // The orchestrator (`generator/dotnet/index.ts`) dispatches
    // per-aggregate CQRS emission + byLayer path routing through the
    // deployable's RESOLVED style / layout adapters
    // (D-REALIZATION-AXES `application:` / `directoryLayout:`).  The
    // resolution itself happens at the system orchestrator (`src/system/`,
    // which may import `platform/resolve-adapters.ts`); we just FORWARD the
    // resolved adapters into the generator.  This keeps the generator free
    // of any `src/generator/* → src/platform/*` edge (the backend-packages
    // layering invariant) and avoids re-entering the load-time cycle
    // (registry → platform/dotnet → generator/dotnet/index → ir/enrich →
    // platformFor → registry).  When the orchestrator passes none (legacy
    // single-context generate mode), the generator falls back to its own
    // sibling adapters — byte-identical under the size-1 real menus.
    return generateDotnetForContexts(contexts, namespace, {
      deployable,
      sys,
      migrations,
      styleAdapter,
      layoutAdapter,
    });
  },
  composeService({ slug }): ComposeServiceShape {
    return {
      env: [
        [
          "ConnectionStrings__Default",
          `Host=db;Port=5432;Database=${slug};Username=postgres;Password=postgres`,
        ],
      ],
      dependsOnDb: true,
      // Compose healthcheck → /ready (DB-aware).  Sets the service
      // `healthy` only once the app can reach its DB, so dependent
      // services / smoke tests don't race the schema bootstrap.
      // /health stays for cheap liveness probing (k8s livenessProbe).
      healthPath: "/ready",
      internalPort: 8080,
    };
  },
  // .NET — EF Core + Dapper + Marten persistence; CQRS + layered style;
  // byLayer + byFeature layout.  `efcore` / `dapper` / `cqrs` / `byLayer` /
  // `byFeature` are real (F5a/b/c + Phase 5a/5c); `marten` / `layered` are stubs.
  // Built lazily (see PlatformSurface.adapters jsdoc) so the adapter
  // bindings are read after init, not during the load-time cycle.
  adapters(): PlatformAdapters {
    const menu: PlatformAdapters = {
      persistence: {
        efcore: efcorePersistenceAdapter,
        dapper: dapperPersistenceAdapter,
        marten: stubAdapter<PersistenceAdapter>(
          "persistence",
          "marten",
          "dotnet",
          () => Object.keys(menu.persistence),
          {
            name: "marten",
            supportedStrategies: ["state", "eventLog"],
            supports: (type) => type === "postgres",
          },
        ),
      },
      styles: {
        cqrs: cqrsStyleAdapter,
        layered: stubAdapter<StyleAdapter>(
          "style",
          "layered",
          "dotnet",
          () => Object.keys(menu.styles),
          {
            name: "layered",
            supportedStrategies: ["state"],
            supportedLayouts: ["byLayer"],
          },
        ),
      },
      layouts: {
        byLayer: byLayerLayoutAdapter,
        byFeature: byFeatureLayoutAdapter,
      },
    };
    return menu;
  },
  adapterDefaults(): PlatformAdapterDefaults {
    return {
      persistence: { state: "efcore", eventLog: "marten" },
      style: "cqrs",
      layout: "byLayer",
    };
  },
};

export default dotnetPlatform;
