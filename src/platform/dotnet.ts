import {
  type LayoutAdapter,
  type PersistenceAdapter,
  type PlatformAdapterDefaults,
  type PlatformAdapters,
  type StyleAdapter,
  stubAdapter,
} from "../generator/_adapters/index.js";
import { byLayerLayoutAdapter } from "../generator/dotnet/adapters/by-layer-layout.js";
import { cqrsStyleAdapter } from "../generator/dotnet/adapters/cqrs-style.js";
import { efcorePersistenceAdapter } from "../generator/dotnet/adapters/efcore-persistence.js";
import { generateDotnetForContexts } from "../generator/dotnet/index.js";
import type { ComposeServiceShape, PlatformSurface } from "./surface.js";

const dotnetPlatform: PlatformSurface = {
  name: "dotnet",
  defaultPort: 8080,
  needsDb: true,
  isFrontend: false,
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
  // Standalone .NET mounts controllers at the root (`[Route("orders")]`).
  // The fullstack/embedded-SPA mode moves them under `/api`, but that is
  // a per-deployable decision handled inside the dotnet orchestrator
  // (the SPA fetches same-origin `/api`), not a platform-wide default —
  // so the platform's standalone base path is the empty root.
  apiBasePath: "",
  emitProject({ contexts, deployable, sys, migrations }): Map<string, string> {
    const namespace = deployable.name[0]!.toUpperCase() + deployable.name.slice(1);
    // The orchestrator (`generator/dotnet/index.ts`) dispatches
    // per-aggregate CQRS emission + byLayer path routing through its
    // OWN sibling adapters (`src/generator/dotnet/adapters/`), imported
    // directly — never via `src/platform/`.  Two reasons: the
    // `package → shared` layering invariant forbids `src/generator/`
    // importing `src/platform/`, and resolving through `platform/`
    // would re-enter the load-time cycle (registry → platform/dotnet →
    // generator/dotnet/index → ir/enrich/enrichments → platformFor →
    // registry).  Per-deployable `persistence:` / `style:` / `layout:`
    // overrides resolve through `platform/resolve-adapters.ts` at the
    // system orchestrator (`src/system/`, which may import
    // `src/platform/`), not here.
    return generateDotnetForContexts(contexts, namespace, { deployable, sys, migrations });
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
  // byLayer + byFeature layout.  `efcore` / `cqrs` / `byLayer` are real
  // (F5a/b/c); `dapper` / `marten` / `layered` / `byFeature` are stubs.
  // Built lazily (see PlatformSurface.adapters jsdoc) so the adapter
  // bindings are read after init, not during the load-time cycle.
  adapters(): PlatformAdapters {
    const menu: PlatformAdapters = {
      persistence: {
        efcore: efcorePersistenceAdapter,
        dapper: stubAdapter<PersistenceAdapter>(
          "persistence",
          "dapper",
          "dotnet",
          () => Object.keys(menu.persistence),
          {
            name: "dapper",
            supportedStrategies: ["state"],
            supports: (type, kind, strategy) =>
              strategy === "state" &&
              ["postgres", "mysql", "sqlite"].includes(type) &&
              ["state", "snapshot", "replica"].includes(kind),
          },
        ),
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
        byFeature: stubAdapter<LayoutAdapter>(
          "layout",
          "byFeature",
          "dotnet",
          () => Object.keys(menu.layouts),
          { name: "byFeature" },
        ),
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
