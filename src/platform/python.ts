import {
  type ComposeServiceShape,
  type PlatformSurface,
  STATIC_BUNDLE_FRAMEWORKS,
} from "./surface.js";

// ---------------------------------------------------------------------------
// Python platform — FastAPI + SQLAlchemy 2 backend deployable
// (canonical language-ecosystem name, like `node`/`dotnet`/`elixir`;
// the `fastapi` spelling desugars to `python` at the lowering
// boundary — see `canonicalPlatform` / `LEGACY_PLATFORM_ALIASES`).
//
// Backend-only: serves an api (`serves:`), owns a Postgres database
// (`needsDb: true`), mounts no `ui:` in v1 (static SPA hosting is a
// later slice — `hostableFrameworks` records the static-asset-host
// capability the dormant `hosts:` check will consume).
//
// All project emission (pyproject.toml, Dockerfile, app/*, Alembic
// migrations) lives under `../generator/python/`; this module is the
// thin `PlatformSurface` wiring.  The adapter menu (`adapters()` /
// `adapterDefaults()`) lands with the persistence slice — until then
// `hasAdapters("python")` is false and the orchestrator passes no
// resolved style/layout, exactly like the legacy single-context path.
// ---------------------------------------------------------------------------

const pythonPlatform: PlatformSurface = {
  name: "python",
  // uvicorn convention.
  defaultPort: 8000,
  needsDb: true,
  mountsUi: false,
  isFrontend: false,
  // Static-asset host (FastAPI StaticFiles): can serve any
  // static-bundle framework.  D-PHOENIX-SURFACE.
  hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
  // The Python repository auto-emits these per aggregate (snake_cased
  // on the Python side: `save`, `find_by_id`, `get_by_id`, `delete`).
  // The validator compares DSL-cased find names (and unions the
  // reserved sets across ALL platforms), so this set deliberately
  // matches Hono's: anything broader would outlaw today-legal finds
  // (e.g. a user-declared `all`) on every backend.  The Python
  // emitter sidesteps the remaining names itself (wire projection is
  // `_to_wire`; a user find named `all` merges with the auto reader
  // the same way Hono's does).
  reservedRepositoryFindNames: new Set(["save", "findById", "getById", "delete"]),
  emitProject(): Map<string, string> {
    // Project emission lands with the generator slice
    // (`src/generator/python/`).  Until then a python deployable
    // contributes no files — the compose stanza below already
    // describes its service shape.
    return new Map();
  },
  composeService({ slug }): ComposeServiceShape {
    return {
      env: [["DATABASE_URL", `postgresql+asyncpg://postgres:postgres@db:5432/${slug}`]],
      dependsOnDb: true,
      // Compose healthcheck → /ready (DB-aware), /health stays for
      // cheap liveness probing — same split as dotnet/hono.
      healthPath: "/ready",
      internalPort: 8000,
    };
  },
};

export default pythonPlatform;
