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
# .ddd:  deployable api { platform: hono, ... }   ← resolves automatically
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
| **P3** 🟡 | Repo → workspaces. Landed as 5 sub-slices: **s1** ✅ npm `workspaces` + `packages/backend-hono-v4/` shell with real `loom` key (#194); **hotfix** ✅ dropped a `peerDependencies` that 404'd `npm install` (#196); **s2** ✅ removed the unused catch-all `@loom` Vite alias (#195); **s3** ✅ Node-only fs-backed `discoverBackendsFs` + `installFsBackendSource`, composed with the in-tree default, wired into the CLI (#197); **s4** ✅ `packages/core/` (`@loom/core`) shell + `loom.contract` marker (#198). All byte-identical. **s5 (physical source relocation) — unblocked: VFS source (tasks 1–5); the npm-engine C-track that the old "block" leaned on has merged (sole engine, esm.sh deleted #220). See below.** |
| **P4** | Publish (`@loom/*` released independently; backends `peerDependency` `@loom/core`; the `workspace:`-protocol / version-range story this npm can't express in dev). Gated on P3-s5. | e2e against a clean `npm i` |

### P3 slice 5 — sequenced, not indefinitely blocked (2026-05 re-assessment)

A prep pass for slice 5 corrected the earlier "blocked until the npm engine
ships" framing. Slice 5 is **unblockable on its own**, via the *VFS source*
already designed below (*Concrete P3 playground tasks*, tasks 1–5). It never
needed the playground engine work — and that work (the C0–C5 npm-engine-default
track) **has since merged anyway** (npm-install-bundle is the sole engine; esm.sh
engine deleted in #220), so the point is now moot. The two share no load-bearing
dependency. The reason: there are two distinct `node_modules`-shaped things, and
only one belonged to the engine track:

- **Toolchain backend packages** (`@loom/backend-hono-v4`) — the generator code
  the playground bundles **at its own build time**. Resolved by a build-time
  `import.meta.glob` (the VFS source, task 2), *never* at browser runtime.
- **The generated project's runtime deps** (react/mantine/hono/drizzle) — what
  the npm engine installs into its VFS to *preview* the emitted app. This is
  the C1–C5 track's domain and runs **after** generation.

So the playground's backend discovery is a build-time-chosen static import that
lives in **`web/` (the app)**, not in `src/platform/registry.ts` (core). Moving
the static reference from core → the app *is* the decoupling — the app/CLI
composes its backends; core stays neutral. That is categorically different from
the rejected "keep a static import in core" half-step (unblock option 3 below).
**Import style (locked):** the relocated package imports the publish-shaped
`@loom/core`, not relative `../../src` — see task 4.

**Task 4 — `@loom/core` resolution (now a one-liner; the engine track resolved the old hazard).** The npm-engine-default C-track (C0–C5) **has merged** (#203/#207/#208/#209/#211/#213, esm.sh engine deleted in #220). npm-install-bundle is the sole engine; `web/src/bundle/plugin.ts` survived #220 as a *shared-helper* module (the real resolver is now `web/src/engine/npm/esbuild-vfs-plugin.ts`, against in-VFS `node_modules`, no CDN). So the earlier "guard the esm.sh bare-specifier branch" worry is gone. With the relocated backend importing the publish-shaped `@loom/core`, the resolution is just a Vite `resolve.alias: { "@loom/core": "../src" }` (already foreseen at `web/vite.config.ts:53`) so the playground app build maps it to local toolchain source; the npm engine's VFS resolver treats `@loom/*` as local toolchain, never a registry fetch. **Import style decision (locked):** the relocated package imports `@loom/core` (publish-shape), not relative `../../src` — packages ship separately one day, so the source already looks like what's published; no version-pinned dep is declared yet (this npm rejects both `"*"` and `"workspace:*"` — deferred to P4), resolution rides the workspace symlink + the alias.

#### Consumer inventory (relocation mechanics — grep `src/platform/hono/v4`)

The `git mv src/platform/hono/v4/* → packages/backend-hono-v4/src/` touches
these consumers; all but the registry are *path* updates:

- `src/platform/registry.ts:5-7` — **the core coupling.** Static
  `import honoPlatform from "./hono/v4/index.js"` + the `honoV4Manifest` import,
  feeding the `inTreeBackends` hono entry (`registry.ts:83`). Drop both; hono
  becomes discovery-only. `dotnet@v8` / `phoenixLiveView@v1` stay in-tree.
- `src/cli/main.ts:9,13` — direct `emit.js` / `pins.js` import for the legacy
  `generate ts` path. Repoint to the package (or discovery).
- `web/src/build/build.worker.ts:12,13` — same direct `emit.js`/`pins.js` import
  (legacy single-context build) **and** relies on the static registry default
  for `generateSystems` (no `setBackendSource` today). The browser blocker;
  outside the toolchain's `tsc` scope (the B2.1 trap).
- `scripts/capture-baseline-fixture.mjs` — calls `generateSystems` from `out/`
  with no fs-discovery wiring. Node-side, so it needs `installFsBackendSource`
  added before generation (and the package built — see next).
- `test/generator-ts.test.ts:7,8,933` — direct imports + a dynamic string ref.
- `test/backend-packages-layering.test.ts` — path constants for
  `src/platform/<family>/<vN>/`.
- `packages/backend-hono-v4/index.ts` — the thin re-export becomes the *real*
  entry (stops re-exporting `../../src/platform/hono/v4/`).

**New requirement surfaced:** the backend package needs **its own build** (tsc →
JS) so the CLI/Node fs source can `import()` a compiled artifact. Today it is a
thin TS re-export compiled by its consumers; once it owns the source it must
emit `index.js`. (Foreseen below: "Slice 3 adds its own build when consumers
need a compiled artifact.")

---

### P3 slice 5 — build-graph design (FOR REVIEW, not yet implemented)

Making `@loom/backend-hono-v4` the *real* runtime source (not a never-executed
identity shell) forces a build-graph decision. This section is the design to
ratify before any `git mv`.

#### The hard constraint

npm's `"exports"` subpath targets **cannot escape their own package directory**
(`../` targets throw `ERR_INVALID_PACKAGE_TARGET`). So `@loom/core/ir` cannot
map straight to the repo's top-level `out/ir/…`. `@loom/core` must contain (or
re-export through a package name) the JS its `exports` map points at. Today's
build is a single `tsc -b` with `rootDir: src` → `out/`, `include:
["src/**/*"]`; it never compiles `packages/`, and the package shells are pure
identity (never imported at runtime). That ends here.

#### Decisions already locked (this turn)

- `generator/typescript/` is a **shared TS-emission layer** (future
  nestjs/nextjs backends will use it), so it does **not** move into the hono
  package and is **not** "neutral core." For now it rides a
  **`@loom/core/generator-ts` subpath**; a dedicated `@loom/generator-ts`
  package is deferred until a second TS backend exists.
- Backend imports are **publish-shape `@loom/core/*` subpaths**, not relative
  `../../src` (packages ship separately eventually).
- **Subpaths, not a bloated `@loom/core` root export** — the root entry stays
  the curated browser-safe API; internals come via explicit subpaths.

#### Target package build graph

Three compiled units, wired as composite TS project references from a root
solution tsconfig:

```
loc-ddd-dsl (root)   rootDir src → out/   ← unchanged toolchain build
   │  adds an `exports` map exposing its own out/: ./ir, ./util/*, ./surface,
   │  ./manifest, ./generator-ts  (root CAN export its own out/ — in-package)
   ▼
@loom/core           packages/core/   tsconfig→ dist/   (composite)
   │  thin re-export shells; subpaths re-export the root package by name:
   │    core/ir.ts        → export * from "loc-ddd-dsl/ir"
   │    core/generator-ts → export * from "loc-ddd-dsl/generator-ts"
   │    core/surface,manifest,util  likewise
   │  package.json exports: { ".": …, "./ir": "./dist/ir.js", "./generator-ts":
   │    "./dist/generator-ts.js", "./surface": …, "./manifest": …, "./util/*" }
   ▼
@loom/backend-hono-v4  packages/backend-hono-v4/{src,…}  tsconfig→ dist/ (composite)
      the relocated platform/hono/v4 source; imports @loom/core/* only;
      package.json exports { ".": "./dist/index.js", "./pins": "./dist/pins.js" }
```

Why route core's subpaths *through the root package name* (`loc-ddd-dsl/ir`)
rather than relative `../../src`: the exports-can't-escape rule. The root
package legally exports its own `out/`; `@loom/core` (a sibling package) re-exports
those by package specifier, and its own `exports` map points only at its own
`dist/`. No `../` escape anywhere. The hono package never names `loc-ddd-dsl`
— only `@loom/core/*` — so the publish-shape boundary is clean.

#### The 3-context resolution matrix (the subtle part)

The same `@loom/core/ir` specifier is resolved by three different runtimes; each
must land on a working artifact:

| Context | Resolves via | Must hit | Mechanism |
| --- | --- | --- | --- |
| Compiled CLI (`bin/cli.js`→`out/`), capture script | Node `exports` | `dist/*.js` | default `exports` condition |
| Test suite (vitest, transforms `.ts`) | vite/vitest resolve | `*.ts` source | a **`"source"` export condition** + `resolve.conditions:["source",…]` in `vitest.config.ts` (and the root `exports` gets a `source` branch → `./src/ir/…ts`) |
| Playground (`web/`, Vite) | vite resolve | `.ts` source | same `"source"` condition added to `web/vite.config.ts`; **plus** the `@loom/core` Vite alias / condition so the npm-engine VFS resolver treats `@loom/*` as local toolchain, never a registry fetch |

The `"source"` condition is the linchpin: published consumers and the compiled
CLI get `dist/`; in-repo dev (vitest + Vite) gets `.ts`, so there's no
build-before-test ordering trap and HMR still works. Without it, tests would
import stale/absent `dist/`.

#### Build-order & the existing gates

- Root solution tsconfig references `packages/core` then `packages/backend-hono-v4`;
  `npm run build` becomes `tsc -b` over the solution (core → backend → … after
  the root lib). `prepare` unchanged otherwise.
- **Byte-identity is unaffected by toolchain layout** — the fixture diff is over
  *generated project output*, not where the compiler emits its own JS. This is
  the key freedom: the build graph can be reshaped freely as long as
  `generateSystems` emits identical files.
- Gates per the standing pipeline: fixture byte-identical, `npm test`,
  `LOOM_TS_BUILD`, `cd web && tsc -b`. The browser path (playground discovery)
  is PR B, gated on deployed `playground-e2e`.

#### Open questions for review

1. **`"source"` condition naming** — `"source"` vs `"development"` (Vite adds
   `development` by default; reusing it avoids a `vitest.config.ts` change but is
   less explicit). Recommend explicit `"source"`.
2. **Root `exports` field** — adding one *restricts* `loc-ddd-dsl` deep imports
   to the listed subpaths. Relative importers (web `../../../src`, tests
   `../src`) are unaffected (they don't go through the package name), but any
   future deep import of `loc-ddd-dsl/<unlisted>` would break. Acceptable?
3. **Scope of PR A** — land all three build units + root `exports` + the
   `source` condition + the hono relocation in one PR, or split the build-infra
   (root exports + core dist + conditions, no behaviour change) from the hono
   relocation (drops the static `inTreeBackends` entry)? Recommend splitting:
   build-infra first (provably byte-identical, no discovery change), relocation
   second.

---

#### Original blocked-state notes (conclusion superseded by the re-assessment above)

Slice 5 was to `git mv src/platform/hono/v4/* → packages/backend-hono-v4/src/` and drop the in-tree static backend entry so the workspace package becomes the *runtime* source (fs-discovery `import(pkg)`). The facts below remain accurate; what the re-assessment revises is the **conclusion** ("P3 stops at slice 4") — the VFS source (tasks 1–5) is the unblock and it does not wait on the engine track. Verified facts on `main`:

- `src/platform/registry.ts` **statically imports** the backend surfaces (`honoPlatform`, …) into its in-tree set (`inTreeBackends`). That static import is what every *synchronous, non-CLI* caller resolves through.
- **Only the CLI** installs the fs source (`src/cli/main.ts` → `installFsBackendSource`). The **playground build worker** (`web/src/build/build.worker.ts` → `generateSystems`) and the **fixture/capture script** (`scripts/capture-baseline-fixture.mjs`) call the generator **directly with no fs-discovery**, and the browser can't run `node:fs` discovery at all.

So removing hono from the static set breaks: browser previews (`platform: hono` unresolvable), the fixture script, and any direct-API caller — **not byte-identical.** The intermediate "move source but keep a static import from `packages/`" re-creates the exact `core → backend` static coupling the discovery seam exists to *eliminate* (B2.1 + the manifest seam) — relocation for its own sake, not progress.

**Unblock path** (any one):
1. A **browser-capable, build-time backend discovery** that seeds the in-repo backend packages + their `loom` manifests into the playground worker (the design doc's original "VFS source"), so the generator resolves built-ins without `node:fs` and without a static registry import. NOTE: this is *generator-side* discovery and runs **before** the npm engine populates its VFS — it cannot reuse the #185 npm-engine VFS, which only holds the *generated project's* runtime deps.
2. The npm engine becoming default **and** carrying generator-package discovery — larger, and orthogonal to the #184–#187 track's current scope.
3. Accept a permanent static "built-ins" import (only third-party backends discovered via fs) — but that abandons the core↔backend decoupling that motivated the split.

Slices 1–4 are the durable foundation: the workspace exists, `@loom/backend-hono-v4` + `@loom/core` are real package-shaped targets with `loom` keys, fs-discovery works for third-party backends, and nothing's output changed. **Re-assessment:** the unblock is option 1 (the VFS source, tasks 1–5) and it is implementable now — slice 5 is *sequenced*, not blocked, and does not wait on the engine track. Option 3 (a permanent static built-ins import) is rejected; option 2 (ride the npm engine) is the unnecessary-coupling route the re-assessment retires.

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
that exercises a `platform: "hono@v4"`-pinned example so a
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
