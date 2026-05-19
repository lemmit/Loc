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
| **P0** | Define the `loom` manifest TypeScript type + a `discoverBackends()` reader. In-tree backends get a manifest object (co-located, not yet package.json). `registry.ts` keeps its static map as the fallback. **Byte-identical.** | `npm test` + fixture clean |
| **P1** | `resolvePlatformRef` resolves via the discovery layer (reading in-tree manifests) instead of the hardcoded `versionedPlatforms`. Single bundle still; same surfaces returned. **Byte-identical.** | fixture + `LOOM_TS_BUILD` + the new layering test |
| **P2** | Split `src/generator/typescript/` along the core/backend line; move the Hono-framework half into `src/platform/hono/v4/` (still in-tree, still one package). **Byte-identical.** | fixture + `LOOM_TS_BUILD` |
| **P3** | Repo → workspaces: `packages/{core,cli,backend-hono-v4,…}`. Wire `@loom/core` `exports`; backends `peerDependency` it; manifests become real package.json `loom` keys. Resolver reads the project closure. CLI = `@loom/cli`. Output unchanged. | full suite + `LOOM_TS_BUILD` + a from-registry install smoke |
| **P4** | Publish. Backends versioned/released independently; `@loom/cli` install docs. | e2e against a clean `npm i` |

P0–P2 are pure machinery in the existing repo (the proven Phase-0
pattern: land the seam with zero output change). The architectural
commitment to confirm now is **the manifest schema + the core↔backend
boundary table** — those are the hard-to-change public contracts.
P3 (workspaces) and P4 (publish) are mechanical once the boundary is
real and tested.

## Open decisions / risks

1. **Playground (`web/`) is the sharpest constraint.** It bundles
   the toolchain in-browser (esbuild-wasm + esm.sh) and already
   swaps the Node `loader-fs` for a VFS `loader-vfs` via a Vite
   plugin. Manifest discovery is Node-`fs`/`node_modules`-bound, so
   the playground needs a parallel discovery shim: backends seeded
   into the VFS (as design packs already are) with their manifests,
   resolved without `node_modules`. P1 must keep the resolver
   behind an injectable interface (fs-backed vs VFS-backed) — same
   pattern as `loader-fs`/`loader-vfs`. **This is the gating design
   detail; get it right in P0's interface.**
2. **Bareword default with nothing installed.** Pin not installed →
   hard error with the `npm i` hint. Bareword + family not installed
   → same. The core default table (`BUILTIN_PLATFORM_LATEST`) names
   the *version*, not whether it's present — resolution checks
   presence and fails loudly. (No silent fallback — determinism.)
2. **`PlatformSurface` ABI versioning.** Needs a real semver +
   compatibility policy doc once it's a published export. Additive
   changes = minor; required-field/shape changes = major (every
   backend must republish). Keep the contract deliberately small.
3. **Frontend (`react`/`static`).** Out of scope — they version via
   the design-pack/stack axis and aren't backend packages. The
   resolver leaves them on the in-core path (mirrors B0's
   frontend-excluded handling).
4. **`dotnet`/`phoenix`.** Same split applies; sequenced after Hono
   proves the boundary (these have no automated build gate yet —
   `dotnet` especially; P-series should not block on them).

## Recommendation

Adopt the manifest schema + boundary table above. Implement **P0**
now (manifest type + `discoverBackends()` + an injectable resolver
interface that the playground can back with a VFS impl —
byte-identical, the static registry stays the fallback). P1–P2 are
gated follow-ups; P3/P4 (workspaces + publish) are a separate, larger
mechanical effort to schedule once the boundary is proven in-tree.
