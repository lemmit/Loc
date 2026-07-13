# Packaging split — `@loom/core` + installable backend packages

> **Status:** design proposal for review. Extends
> `backend-packages.md` (B0–B2.1 shipped the in-tree versioned-package
> machinery + the load-bearing `package → shared` layering
> invariant). This doc is the *distribution* half: ship the shared
> core and each backend as **separately-installable npm packages**,
> discovered at runtime via a small manifest.

## Goal

```
npm i -g @loom/cli            # the compiler + CLI, ships @loom/core
npm i  @loom/backend-hono@4   # add the Hono backend you want
# .ddd:  deployable api { platform: node, ... }   ← resolves automatically
```

The user installs **core + the backend(s) they target**. Core does
*not* statically import every backend (today `registry.ts`
`import`s dotnet/hono/phoenix/react unconditionally → one fat
bundle). Backends are discovered from installed packages via a
manifest, so the dependency graph is exactly what the project uses,
old + new majors coexist, and a backend ships/versions/releases on
its own cadence.

This is only possible because B2.1 made every edge point
`package → shared`. A `shared → package` edge would force core to
bundle a specific backend and foreclose this entirely. **That
invariant is the precondition; this doc builds on it.**

## The manifest (the "small thing shipped with each package")

A backend package declares a `loom` key in its **package.json** —
npm-idiomatic discovery (like `bin` / `exports`), no extra file,
the resolver just reads package.json:

```jsonc
// @loom/backend-hono-v4/package.json
{
  "name": "@loom/backend-hono-v4",
  "version": "4.3.1",                      // npm semver (release cadence)
  "peerDependencies": { "@loom/core": "^1.0.0" },
  "loom": {
    "kind": "backend",                     // backend | designpack (future)
    "family": "hono",                      // the `platform:` bareword
    "loomVersion": "v4",                   // the `@vN` pin segment
    "format": "ts",                        // emitted-source family (cf. BUILTIN_PACK_FORMATS)
    "surface": "./dist/index.js",          // default-exports a PlatformSurface
    "core": "^1.0.0"                       // PlatformSurface contract range it implements
  }
}
```

- **Tiny + declarative.** `family` + `loomVersion` are exactly the
  two halves `parseBuiltinPlatformRef` already splits (`hono@v4`).
  `format` mirrors `BUILTIN_PACK_FORMATS` for design packs — the
  validator's framework/format cross-check generalises to it.
- **`core` range** is the `PlatformSurface` contract version the
  backend was built against (see "The contract" below). The
  resolver refuses a backend whose `core` range doesn't satisfy the
  running core — a loud, early error instead of a deep crash.
- npm version is independent (release/patch cadence); the Loom
  identity is `family@loomVersion`. Mapping lives in the manifest,
  not inferred from npm semver.

## Resolution — static registry → manifest discovery

`registry.ts`'s static `versionedPlatforms` map becomes a
**discovered** map. `resolvePlatformRef(ref)` (B0) keeps its
signature; its body changes:

1. Parse `ref` → `family@version` (`parseBuiltinPlatformRef`,
   unchanged — frontend/unknown still `null`).
2. Look up an installed package whose `loom` manifest matches
   `kind:"backend"`, `family`, and (for a pin) `loomVersion`.
   Bareword → `BUILTIN_PLATFORM_LATEST[family]` (core-shipped
   default table, unchanged) → that version's package.
3. Validate `manifest.core` satisfies the running core's
   `PlatformSurface` contract version; else hard error.
4. Dynamic `import(manifest.surface)`; assert the default export
   shape-checks as a `PlatformSurface`; cache.
5. Not installed → actionable error:
   `platform 'hono@v4' needs '@loom/backend-hono-v4' — run \`npm i @loom/backend-hono-v4\``.

Discovery source = the **consuming project's** dependency closure
(resolve from the `.ddd` file's package root, like how custom
design packs already resolve relative to the `.ddd`). Determinism
is preserved exactly as for design packs: explicit pin wins;
bareword → the core default table (mutable across core upgrades,
deterministic within one).

## The core ↔ backend boundary (resolves the open shared-emitter question)

`backend-packages.md` left "how much of `render-expr`/templating is
shared" open. The packaging split forces the answer — the boundary
must be a published API surface:

| Lives in `@loom/core` | Lives in `@loom/backend-<family>-<vN>` |
| --- | --- |
| Pipeline: parser, validator, `lower*`, **Loom IR**, enrichment | — |
| `PlatformSurface` **contract** (the public API) | implements it |
| Framework-neutral TS lowering: `render-expr`/`render-stmt` (IR → TS *language*), id/VO/event/DTO templates | — (imports from core) |
| The resolver + manifest reader + default table | — |
| CLI (`@loom/cli` re-exports core) | — |
| — | Framework wiring: route/middleware/app-bootstrap emitters, OpenAPI, Dockerfile, `pins.ts` |

So `src/generator/typescript/` splits: the **neutral** half (domain
→ TS) is core; the **Hono-framework** half (routes-builder,
app/middleware/openapi, Dockerfile) is the backend package. That is
the doc's 3-slice model finally drawn as a package line — and it
makes B3 concrete: `@loom/backend-hono-v5` reuses core's neutral
half, reimplements only the Hono-5 wiring, ships its own pins.

**The contract is the load-bearing artifact.** `PlatformSurface`
(`src/platform/surface.ts`) becomes `@loom/core`'s versioned public
export. Changing it is a breaking change for every backend package;
the manifest's `core` range is how a backend says which contract it
speaks. Treat it like a plugin ABI.

## npm layout & coexistence

- `@loom/core` — pipeline + neutral emitters + contract + resolver.
- `@loom/cli` — thin; depends on `@loom/core`, ships the `ddd` bin.
- `@loom/backend-hono-v4`, **`@loom/backend-hono-v5`** — *separate
  npm packages per Loom-major*, so a project can install **both**
  (npm can't hoist two versions of one package name; old+new
  coexistence — the session-long North Star — needs distinct
  names). `@loom/backend-dotnet-v8`, `-phoenix-v1`, …
- Repo becomes an npm/pnpm **workspace**: `packages/core`,
  `packages/cli`, `packages/backend-*`. `web/` (playground) stays a
  workspace consumer.

## Migration — P0–P4, each byte-identical until the publish (B0-style discipline)

| Phase | Scope | Gate |
| --- | --- | --- |
| **P0** ✅ | `loom` manifest type + `discoverBackends()`; injectable source; `registry` derives from it. **Byte-identical.** (PR #180) | `npm test` 905 + fixture clean |
| **P1** ✅ | _Subsumed by P0_ — `resolvePlatformRef`/`backendVersionsForFamily`/`isRegisteredBackendRef` already resolve through `discoverBackends()` (the injectable seam, in-tree manifests). Same surfaces; byte-identical. | as P0 |
| **P2** ✅ | Split `src/generator/typescript/` along the core↔backend line into `src/platform/hono/v4/`. **P2a** (#181): orchestrator (`generate*` + project assembly + `package.json`/Dockerfile) → `emit.ts`. **P2b**: the five Hono-framework builders (`routes`/`workflow`/`view-routes`/`auth-emit`/`observability`) moved into the package — they were each consumed *only* by the orchestrator (the cross-generator hits were per-generator same-named siblings, not these). `src/generator/typescript/` now holds **only** framework-neutral code: `render-expr`/`render-stmt`, `templates`/`templates.ts`, `zod-refine`, `repository-builder` (drizzle), `extern-builder`. The core↔backend line is physically real; the package imports the neutral library by ordinary import (package → shared). **Byte-identical.** | fixture clean + `LOOM_TS_BUILD` 3/3 + layering test green |
| **P3** 🟡 | Repo → workspaces. Landed as 5 sub-slices: **s1** ✅ npm `workspaces` + `packages/backend-hono-v4/` shell with real `loom` key (#194); **hotfix** ✅ dropped a `peerDependencies` that 404'd `npm install` (#196); **s2** ✅ removed the unused catch-all `@loom` Vite alias (#195); **s3** ✅ Node-only fs-backed `discoverBackendsFs` + `installFsBackendSource`, composed with the in-tree default, wired into the CLI (#197); **s4** ✅ `packages/core/` (`@loom/core`) shell + `loom.contract` marker (#198). All byte-identical. **s5 (physical source relocation) — BLOCKED, see below.** |
| **P4** | Publish (`@loom/*` released independently; backends `peerDependency` `@loom/core`; the `workspace:`-protocol / version-range story this npm can't express in dev). Gated on P3-s5. | e2e against a clean `npm i` |

### P3 slice 5 is blocked (do not attempt the relocation yet)

Slice 5 was to `git mv src/platform/hono/v4/* → packages/backend-hono-v4/src/` and drop the in-tree static backend entry so the workspace package becomes the *runtime* source (fs-discovery `import(pkg)`). **It cannot land cleanly yet.** Verified facts on `main`:

- `src/platform/registry.ts` **statically imports** the backend surfaces (`honoPlatform`, …) into its in-tree set (`inTreeBackends`). That static import is what every *synchronous, non-CLI* caller resolves through.
- **Only the CLI** installs the fs source (`src/cli/main.ts` → `installFsBackendSource`). The **playground build worker** (`web/src/build/build.worker.ts` → `generateSystems`) and the **fixture/capture script** (`scripts/capture-baseline-fixture.mjs`) call the generator **directly with no fs-discovery**, and the browser can't run `node:fs` discovery at all.

So removing hono from the static set breaks: browser previews (`platform: node` unresolvable), the fixture script, and any direct-API caller — **not byte-identical.** The intermediate "move source but keep a static import from `packages/`" re-creates the exact `core → backend` static coupling the discovery seam exists to *eliminate* (B2.1 + the manifest seam) — relocation for its own sake, not progress.

**Unblock path** (any one):
1. A **browser-capable, build-time backend discovery** that seeds the in-repo backend packages + their `loom` manifests into the playground worker (the design doc's original "VFS source"), so the generator resolves built-ins without `node:fs` and without a static registry import. NOTE: this is *generator-side* discovery and runs **before** the npm engine populates its VFS — it cannot reuse the #185 npm-engine VFS, which only holds the *generated project's* runtime deps.
2. The npm engine becoming default **and** carrying generator-package discovery — larger, and orthogonal to the #184–#187 track's current scope.
3. Accept a permanent static "built-ins" import (only third-party backends discovered via fs) — but that abandons the core↔backend decoupling that motivated the split.

Until one lands, **P3 stops at slice 4.** Slices 1–4 are the durable foundation: the workspace exists, `@loom/backend-hono-v4` + `@loom/core` are real package-shaped targets with `loom` keys, fs-discovery works for third-party backends, and nothing's output changed. The relocation + publish resume once browser-side generator discovery exists.

P0–P2 are pure machinery in the existing repo (the proven Phase-0
pattern: land the seam with zero output change). The architectural
commitment to confirm now is **the manifest schema + the core↔backend
boundary table** — those are the hard-to-change public contracts.
P3 (workspaces) and P4 (publish) are mechanical once the boundary is
real and tested.

## Playground discovery (P3) — the detailed plan

The playground is the only consumer that cannot use the fs /
`node_modules` resolver, so P3's backend discovery has two
implementations behind the one `setBackendSource()` seam P0 added.
This section is the concrete plan; it is the highest-risk part of
P3 and the reason the seam was built in P0 rather than later.

### Why fs discovery can't work there

`web/` builds the toolchain into a browser bundle (Vite) and runs
it in a Web Worker over esbuild-wasm + esm.sh. It has no
`node_modules` at runtime and no `fs`. It already solves the
analogous problem for *template packs*:

- `web/vite.config.ts` ships a plugin that rewrites imports of
  `_packs/loader-fs.js` (Node, `fs`-bound) to
  `web/src/build/loader-vfs.ts` (reads templates from an in-memory
  VFS).
- `web/src/build/template-bundled.ts` seeds that VFS at build time
  via `import.meta.glob` over `designs/**` and `stacks/**`, so the
  worker has every pack/stack as data without a filesystem.

Backend discovery (P3) is the same shape, one level up: the thing
being discovered is a *backend package*, not a template file.

### The two sources behind the seam

| | fs source (CLI / Node) | VFS source (playground) |
| --- | --- | --- |
| Enumerate | walk the project's dependency closure for `package.json` with a `loom` key | a build-time `import.meta.glob` manifest of the in-repo backend packages |
| Read manifest | `JSON.parse(fs.readFileSync(pkgJson)).loom` | the globbed manifest object (already JS) |
| Load surface | dynamic `import(manifest.surface)` resolved from disk | the surface module statically referenced by the glob entry (bundled by Vite) |
| Injected by | the CLI/Node entrypoint at startup | the worker bootstrap, via `setBackendSource(vfsSource)` |

Both produce the same `DiscoveredBackend[]` shape `discoverBackends()`
already returns — the resolver, validator, and lowering are
unchanged and source-agnostic (pinned by the P0
`packaging-split-discovery` test).

### Concrete P3 playground tasks

1. **`web/src/build/discovery-vfs.ts`** — the VFS-backed
   `() => DiscoveredBackend[]`. Analogue of `loader-vfs.ts`.
2. **Seed backends into the bundle.** Extend
   `template-bundled.ts` (or a sibling) with an
   `import.meta.glob` over the backend packages'
   `package.json` + their `surface` entry, producing the
   `{ manifest, surface }` array the VFS source returns. This is
   the backend-package analogue of the existing `designs/**` /
   `stacks/**` globs.
3. **Wire the seam.** In the worker bootstrap (same place the
   loader is swapped today) call
   `setBackendSource(vfsBackends)` before any `platformFor`.
4. **`@loom/core` aliasing.** Once backends are workspace
   packages that `import "@loom/core"`, `web/vite.config.ts`
   needs an alias so an in-browser-bundled backend resolves
   `@loom/core` to the **local toolchain source** (today the
   playground imports the toolchain from `../src`), *not* esm.sh.
   Without this the bundler worker (`web/src/bundle/plugin.ts`,
   which sends bare specifiers to esm.sh) would try to fetch
   `@loom/core` from the CDN and get a different/absent build.
   This is the subtlest item — it is a Vite resolve.alias plus a
   guard in the bundler plugin's bare-specifier branch to treat
   `@loom/*` as local.
5. **Keep the fs source the default.** `discovery-vfs` is injected
   only in the playground; the CLI/Node path stays fs-backed. The
   default export of the seam must remain the fs source so a fresh
   `npm i @loom/cli` works with zero wiring.

### Verification

The playground side cannot be proven in the dev sandbox (esm.sh
unreachable; the e2e self-skips). It is gated by the **deployed**
`playground-e2e.yml` — boot a storybook example whose deployable
targets a backend, confirm the preview builds. Same discipline as
every runtime gate this session (lesson #7): the unit-level seam is
verified locally (`packaging-split-discovery`), the in-browser
reality is verified on deployed CI. Add a `playground-e2e` spec
that exercises a `platform: "node@v4"`-pinned example so a
discovery regression is caught there.

### Non-goal

No backend is *bundled and executed* in the browser — the
playground only runs the in-browser Hono+PGlite preview it already
runs. P3's playground work is purely making the **generator
resolve** which backend package to *emit from*; the emitted project
still builds/boots exactly as today.

## Open decisions / risks

1. **Playground (`web/`) is the sharpest constraint** — fully
   planned in *Playground discovery (P3)* above. The P0 injectable
   `setBackendSource()` seam already de-risks it: P3 implements +
   wires the VFS source, it is not a rearchitecture.
2. **Bareword default with nothing installed.** Pin not installed →
   hard error with the `npm i` hint. Bareword + family not installed
   → same. The core default table (`BUILTIN_PLATFORM_LATEST`) names
   the *version*, not whether it's present — resolution checks
   presence and fails loudly. (No silent fallback — determinism.)
3. **`PlatformSurface` ABI versioning.** Needs a real semver +
   compatibility policy doc once it's a published export. Additive
   changes = minor; required-field/shape changes = major (every
   backend must republish). Keep the contract deliberately small.
4. **Frontend (`react`/`static`).** Out of scope — they version via
   the design-pack/stack axis and aren't backend packages. The
   resolver leaves them on the in-core path (mirrors B0's
   frontend-excluded handling).
5. **`dotnet`/`phoenix`.** Same split applies; sequenced after Hono
   proves the boundary (these have no automated build gate yet —
   `dotnet` especially; P-series should not block on them).

## Recommendation

Adopt the manifest schema + boundary table above. Implement **P0**
now (manifest type + `discoverBackends()` + an injectable resolver
interface that the playground can back with a VFS impl —
byte-identical, the static registry stays the fallback). P1–P2 are
gated follow-ups; P3/P4 (workspaces + publish) are a separate, larger
mechanical effort to schedule once the boundary is proven in-tree.
