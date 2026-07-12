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
| `node` (default `node@v4`; Hono web framework) | `src/platform/hono/v4/index.ts` | 3000 | ✓ | ✗ |
| `dotnet` (default `dotnet@v10`) | `src/platform/dotnet.ts` | 8080 | ✓ | ✓ (when `ui:` is declared) |
| `elixir` (default `elixir@v1`; legacy aliases `phoenix` / `phoenixLiveView` desugar to it) | `src/platform/elixir.ts` | 4000 | ✓ | ✓ (fullstack) |
| `python` (default `python@v1`) | `src/platform/python.ts` | 8000 | ✓ | ✓ (when `ui:` is declared — dotnet-style dual mode) |
| `java` (default `java@v1`) | `src/platform/java.ts` | 8081 | ✓ | ✓ (`ui:` embedded-SPA mount; `hosts:` gated) |
| `react` | `src/platform/react.ts` | 3001 | ✗ | ✓ |
| `vue` | `src/platform/vue.ts` | 3003 | ✗ | ✓ |
| `svelte` | `src/platform/svelte.ts` | 3002 | ✗ | ✓ |
| `angular` | `src/platform/angular.ts` | 3004 | ✗ | ✓ |
| `static` | aliased to `react.ts` | 3001 | ✗ | ✓ |

- **Needs DB** — the system orchestrator (`src/system/index.ts`)
  reads this flag to decide whether to emit a per-deployable
  `CREATE DATABASE` line in `db-init/00-create-databases.sql` and
  wire a `depends_on: db` healthcheck in `docker-compose.yml`.
- **Mounts UI** — whether the deployable validator allows a `ui:`
  binding on this platform.  `react` / `vue` / `svelte` / `angular` / `static`
  always mount; `dotnet`, `java` and `python` are
  dual-mode (mount when `ui:` is declared, otherwise backend-only);
  `elixir` always mounts (fullstack LiveView); `node` never does.

## Resolving a `platform:` value

The grammar accepts two forms:

```ddd
deployable api1 { platform: node,        ... }              // bareword
deployable api2 { platform: "node@v4",   ... }              // pinned
```

Resolution happens in two parts (see `parseBuiltinPlatformRef` in
`src/platform/registry.ts`):

1. **Bareword backend** — resolves through `BUILTIN_PLATFORM_LATEST`
   to today's default version.  Currently: `node → v4`,
   `dotnet → v8`, `elixir → v1`, `python → v1`, `java → v1`.
   Frontend platforms (`react`, `vue`, `svelte`, `angular`, `static`)
   intentionally aren't versioned at the platform layer — their
   version lives on the design pack / stack axis (see
   [`design-packs.md`](design-packs.md)).

   > **What `vN` means.** A backend package's Loom version mirrors the
   > **major version of its defining framework/runtime**, *not* the
   > platform's own name. So `node@v4` tracks **Hono 4** (the `hono:
   > ^4.x` pin in `src/platform/hono/v4/pins.ts`; `v5` is reserved for
   > the next Hono major), exactly as `dotnet@v10` tracks **.NET 10** and
   > `mantine@v9` tracks Mantine 9. `node@v4` is therefore *not* "Node.js
   > 4" — the `node` platform names the JS runtime, while the `4` versions
   > the Hono web framework it emits. (Sources never spell this out: every
   > deployable uses the bareword `platform: node`, and `@v4` is only the
   > internal qualified ref the resolver fills in.)
2. **Pinned `family@version`** — looked up directly in the
   registered backend surfaces.  Unknown versions are a validation
   error that lists the available pins (`backendVersionsForFamily`).

Both forms resolve to the same `PlatformSurface` instance the system
orchestrator dispatches against.

## Realization axes — picking *how* a backend renders

Beyond *which* backend, a deployable can pick *how* that backend
realises the code, via an optional block on `platform:` — the
**realization axes** (full design in
[`proposals/platform-realization-axes.md`](proposals/platform-realization-axes.md);
in-flight tracker in
[`plans/realization-axes-rollout.md`](plans/realization-axes-rollout.md)):

```ddd
deployable api { platform: dotnet { persistence: dapper }                  ... }
deployable web { platform: node   { persistence: mikroorm, directoryLayout: byFeature } ... }
```

Each axis has a per-platform **menu** of real adapters; an out-of-menu or
not-yet-implemented value is a validation error that lists what's
available. The matured axis today is **`persistence:`**:

| Platform | `persistence:` | Default |
|---|---|---|
| `dotnet` | `efcore`, `dapper` | `efcore` |
| `node` | `drizzle`, `mikroorm` | `drizzle` |
| `elixir` | `ecto` | `ecto` |

- **The default (`efcore` / `drizzle`) is the full-surface adapter** — every
  aggregate shape, inheritance, associations, audit/provenance, etc.
- **The alternates (`dapper`, `mikroorm`) are minimal-v1**: relational,
  state-based, flat aggregates with scalar / enum / value-object / single
  id-ref fields, CRUD + simple finds. Anything outside that (document/
  embedded shape, associations, nested parts, inheritance, event-sourcing,
  audit/provenance/managed fields, retrievals, seeds) is rejected at
  validate time (`loom.dapper-unsupported` / `loom.mikroorm-unsupported`)
  with an actionable message — use the default for that model, or drop the
  unsupported feature. The alternates share the generated **domain layer**
  with the default and only swap the persistence layer (Dapper SQL
  repositories / MikroORM `EntitySchema` + `EntityManager`), so a project
  can switch persistence without touching its domain code.

**Event-sourcing** (`persistedAs(eventLog)` + `apply(...)`) emits on **node,
.NET, Python, Java and Elixir** (append-only per-aggregate `<agg>_events`
stream, fold-on-load). A dedicated **Marten**
document/event-store backend is **3rd priority (if ever)**: `D-DOCUMENT-AXIS`
(see [`decisions.md`](decisions.md)) currently pins *no new Marten backend* —
the event log lives on the existing relational stores.

The only other user-selectable axis is **`directoryLayout: byLayer | byFeature`**
(the fully adapter-consumed axis — it routes each artifact's path via
`layout.pathFor`). The former `style` / `application`, `transport`, and `runtime`
axes were **removed** — style is now one fixed emission per backend (`cqrs` on
dotnet, `layered` elsewhere), kept internally but no longer user-selectable, and
the name-only `transport` / `runtime` registries were deleted whole. So a
`platform { … }` block accepts only `persistence:` and `directoryLayout:` today
(`ddd.langium`; validator `RealizationAxis`). See the D-REALIZATION-AXES
supersession note in `decisions.md`.

### Phoenix backend (plain Ecto/Phoenix)

`platform: elixir` emits plain `Ecto.Schema` / `Ecto.Changeset` / `Ecto.Repo`
over `Phoenix.Endpoint` + LiveView. The former `foundation: ash` is **removed**,
and with it the `foundation:` axis itself — it had collapsed to a single value
(`vanilla`) on every backend, so it no longer exists on the grammar. A would-be
`foundation:` clause no longer parses.

The document sub-case below is the one feature with a partial story:

| Feature | `elixir` (vanilla) | Gate (fail-fast) |
|---|---|---|
| Event-sourced storage `persistedAs(eventLog)` | ✓ emits | — |
| Event-sourced **workflow** (saga appliers) | 🚫 gated | `loom.event-sourced-workflow-unsupported` |
| Provenanced fields (runtime trace) | ✓ emits | — |
| `shape(document)` aggregate | ✓ CRUD + finds/ops/functions/returning-ops; small residual gated¹ | `loom.vanilla-document-unsupported` (sub-case) |
| `or`-union-returning op with `emit`/`add`/`remove` body | ✓ full bodies | — |
| State persistence, unions, carriers, filters, stamping, inheritance | ✓ emits | — |

¹ `vanilla` emits the document CRUD surface (an `(id, data, version)` jsonb
table) plus **custom finds** (in-memory `Enum.filter` over the `data` map, incl.
value-object-subfield reads), **named operations** (body over the `data` map →
`update/2`), pure **functions** (over the `data` map), and **returning ops**
(`: A or B` → tagged tuple) — DEBT-07. Only a small residual stays gated —
audited/provenanced ops, collection mutation, derived / dereferenced-entity /
collection-method reads, and paged/union finds; host those on
node/dotnet/python/java.

Every emitter is compiled against real Elixir/Ecto by
`elixir-vanilla-build.yml` (one fixture per feature under
`test/e2e/fixtures/elixir-vanilla-build/`), so the gate is verified, not paper.

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
  family: BackendFamily;       // "node" | "dotnet" | "elixir" | "python" | "java"
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
- [`architecture.md`](architecture.md) — how `subdomain`, `deployable`,
  `api`, `storage`, `resource`, and `ui` compose into a runnable system.
- [`design-packs.md`](design-packs.md) — frontend versioning via
  design pack + stack.
- [`technical.md`](technical.md) — pipeline phases, including how
  phase ⑨ dispatches over the platform registry.
- [`plans/backend-packages.md`](plans/backend-packages.md) — the
  in-flight design for distributing backends as installable npm
  packages.
