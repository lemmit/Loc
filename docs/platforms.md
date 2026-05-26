# Platforms — the backend registry

The `platform:` slot on a `deployable` picks which backend renders it.
Every platform is implemented by a `PlatformSurface` in
`src/platform/`, registered in `src/platform/registry.ts`.  This doc
covers the registered set, how a `platform:` value is resolved, and
what each platform contributes.

For per-construct generator output (DTO shapes, route files, repository
shapes), see [`generators.md`](generators.md) — that's the one with the
per-platform file maps.  This doc covers the **registry contract**:
which platforms exist, what flags they carry, and how backend
versioning works.

## Registered platforms

| `platform:` keyword | Surface file | Default port | Needs DB | Mounts UI |
|---|---|---|---|---|
| `hono` (default `hono@v4`) | `src/platform/hono/v4/index.ts` | 3000 | ✓ | ✗ |
| `dotnet` (default `dotnet@v8`) | `src/platform/dotnet.ts` | 8080 | ✓ | ✓ (when `ui:` is declared) |
| `react` | `src/platform/react.ts` | 3001 | ✗ | ✓ |
| `static` | aliased to `react.ts` | 3001 | ✗ | ✓ |
| `phoenixLiveView` (default `phoenixLiveView@v1`) | `src/platform/phoenix-live-view.ts` | 4000 | ✓ | ✓ |

- **Needs DB** — the system orchestrator (`src/system/index.ts`)
  reads this flag to decide whether to emit a per-deployable
  `CREATE DATABASE` line in `db-init/00-create-databases.sql` and
  wire a `depends_on: db` healthcheck in `docker-compose.yml`.
- **Mounts UI** — whether the deployable validator allows a `ui:`
  binding on this platform.  `react`/`static` always mount; `dotnet`
  is dual-mode (mounts when `ui:` is declared, otherwise backend-
  only); `phoenixLiveView` always mounts (fullstack); `hono` never
  does.

## Resolving a `platform:` value

The grammar accepts two forms:

```ddd
deployable api1 { platform: hono,        ... }              // bareword
deployable api2 { platform: "hono@v4",   ... }              // pinned
```

Resolution happens in two parts (see `parseBuiltinPlatformRef` in
`src/platform/registry.ts`):

1. **Bareword backend** — resolves through `BUILTIN_PLATFORM_LATEST`
   to today's default version.  Currently: `hono → v4`,
   `dotnet → v8`, `phoenixLiveView → v1`.  Frontend platforms
   (`react`, `static`) intentionally aren't versioned at the
   platform layer — their version lives on the design pack / stack
   axis (see [`design-packs.md`](design-packs.md)).
2. **Pinned `family@version`** — looked up directly in the
   registered backend surfaces.  Unknown versions are a validation
   error that lists the available pins (`backendVersionsForFamily`).

Both forms resolve to the same `PlatformSurface` instance the system
orchestrator dispatches against.

## Backend versioning

Backend families are discoverable through an injectable source
(`setBackendSource` / `resetBackendSource` in `registry.ts`) so the
playground can back it with a VFS impl instead of `fs` /
`node_modules`.  The in-tree set is exposed by
`defaultBuiltInBackends()`.

Each registered backend ships a manifest:

```ts
interface LoomBackendManifest {
  kind: "backend";
  family: BackendFamily;       // "hono" | "dotnet" | "phoenixLiveView"
  loomVersion: string;         // e.g. "v4"
  core: string;                // semver range against @loom/core
}
```

Today every backend family registers exactly one version.  Adding a
second version for a family means:

1. Build the new surface (e.g. `src/platform/hono/v5/index.ts`),
   typically by forking the existing one and applying upstream
   migration steps.
2. Add an entry in `inTreeBackends` (`src/platform/registry.ts`) with
   the new manifest + surface.
3. Optionally flip `BUILTIN_PLATFORM_LATEST[family]` once the new
   version is the recommended default.  Pinning via
   `platform: "<family>@<version>"` is the opt-out for projects that
   want determinism across toolchain upgrades.

## The `PlatformSurface` contract

Every surface implements:

| Member | Role |
|---|---|
| `name` | Discriminator matching the `Platform` IR / grammar token. |
| `defaultPort` | Used when the deployable doesn't specify one. |
| `needsDb` | Drives `db-init` script + `depends_on: db` wiring. |
| `mountsUi` | Drives validator acceptance of `ui:` on this platform. |
| `reservedRepositoryFindNames` | Names a user-declared `find` would collide with (e.g. an auto-emitted `findAll`).  IR validator surfaces collisions at parse time. |
| `emitProject({ contexts, deployable, sys, migrations, emitTrace })` | Returns `Map<path, content>` for the deployable's project tree. |
| `composeService({ deployable, sys, slug })` | Returns the docker-compose stanza (env, healthcheck path, internal port). |

`emitProject` is the platform's entire output surface.  It MUST be
self-contained — no cross-platform calls.  The system orchestrator
in `src/system/` composes the resulting per-deployable file maps into
one tree and writes the cross-cutting `docker-compose.yml`,
`db-init/`, and `.loom/` artefacts on top.

## Cross-references

- [`generators.md`](generators.md) — per-platform feature matrix
  (what each backend emits, file-by-file).
- [`architecture.md`](architecture.md) — how `module`, `deployable`,
  `api`, `storage`, and `ui` compose into a runnable system.
- [`design-packs.md`](design-packs.md) — frontend versioning via
  design pack + stack.
- [`technical.md`](technical.md) — pipeline phases, including how
  phase ⑨ dispatches over the platform registry.
- [`plans/backend-packages.md`](plans/backend-packages.md) — the
  in-flight design for distributing backends as installable npm
  packages.
