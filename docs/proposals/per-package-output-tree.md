# Proposal — Per-package output tree (Loom as ORM / partial-stack adoption)

> Status: **Proposal**. Nothing in this document is implemented yet.

## Why this proposal exists

Loom today emits a **whole-stack** result: one project per backend with
domain, persistence, repositories, routes, migrations, and (for React) UI
all interleaved under a single `src/` tree per deployable, plus a
`docker-compose.yml` that wires them. That's the right shape for the
green-field "scaffold me a whole system" use case, but it shuts the door
on a use case that several people have asked for:

> *Can I use Loom as the domain + data-mapping layer in my existing
> project, like an ORM? I don't want the routes, the UI, or the
> compose stack — just the entities and the repositories.*

That request is reasonable and the IR already has everything needed to
serve it. What's missing is an **output tree that exposes the
architectural layers as first-class, independently consumable units**,
so a user can pick "just the domain and dal" without the generator
emitting orphan files referenced from code that no longer exists.

This proposal describes that output shape, the single knob (`.loomignore`)
that drives subset selection, and the per-backend specifics.

## Vision in one sentence

**The output tree is the architecture diagram.** Each architectural
layer (domain, dal, contracts, api, ui) is its own package with its own
manifest, its own dependency declarations, and a name that says what
layer it is — so the dependency direction is visible in `package.json` /
`.csproj` and a user can `.loomignore` any layer they don't want
without leaving dangling references.

## Non-goals

- **No CLI flags** for layer selection (no `--only=domain,dal`, no
  `--without=ui`). The single knob is `.loomignore`. Rationale:
  combinatorial CLI surface that has to be validated per-backend, and
  Phoenix's structural inability to split layers (see below) would
  force awkward per-backend error messages.
- **No new IR concept.** This is a purely output-side restructuring;
  `LoomModel`, `EnrichedLoomModel`, and the phase pipeline are unchanged.
- **No partial-output type-checking gates.** CI continues to build the
  whole tree; users who slice with `.loomignore` are on their own for
  partial consumability (which is fine because the package boundaries
  are real).

## The output tree

```
out/
  packages/
    <module>-domain/         # pure, zero framework deps (per backend)
    <module>-dal/            # depends on -domain, owns schema + migrations
    <module>-api/            # depends on -dal, exposes routes/handlers
    <system>-contracts/      # shared wire DTOs + cross-context events
    <system>-ui/             # React app, depends on -contracts only
  apps/
    <deployable>/            # thin composition root, Dockerfile lives here
  infra/
    docker-compose.yml
    migrations/              # aggregated view of per-dal migrations
  .loom/                     # mermaid, likec4, traceability, wire-spec,
                             # snapshots (unchanged)
```

### Why flat under `packages/`

Flat (`packages/users-domain/`, `packages/orders-domain/`) is the TS
monorepo convention — pnpm, npm, yarn workspaces, Turborepo, and Nx all
default to a single-level `packages/*` glob, IDE workspace detection
expects it, and scoped names like `@<system>/<module>-domain` carry the
grouping. Nesting (`packages/users/domain/`) works with `packages/**`
but cuts against tooling defaults and the grouping it provides is
already conveyed by the scoped name. For the realistic upper bound
(~10 modules × 3-4 packages = 30-40 entries) flat is fine; revisit only
past ~50 packages.

### Three properties this tree enforces

1. **Dependency direction is visible in manifests.** If `-api`
   accidentally imports `-ui`, you can see it in `package.json` deps,
   not just by reading code.
2. **Portability is structural.** `-domain` having zero framework
   dependencies means you can lift it into any consumer — the
   "Loom as ORM" enabler.
3. **`<system>-contracts` is the canonical cross-deployable boundary.**
   The `wireShape` enrichment becomes a first-class package instead of
   being buried in route emitters.

## The single knob — `.loomignore`

`.loomignore` is the existing, documented file-glob exclusion mechanism
(see `docs/tools.md`). With real package boundaries it becomes a clean
projection. Example for the "Loom as ORM" recipe:

```
# .loomignore — emit only domain + dal for the TS backend
*
!packages/*-domain/
!packages/*-dal/
!packages/<system>-contracts/   # if you want the shared DTOs too
```

The user then `pnpm link` / `npm link` / project-reference the resulting
packages into their host project. No generator flags. No CLI surface.
The recipe is the documentation.

## Prerequisite: package boundaries must be *real*

This is the non-negotiable structural requirement. For `.loomignore`
to work as a projection, each package must be self-contained:

- **Own manifest** — `package.json` / `.csproj` / `mix.exs` per package,
  with its own dep list.
- **Scoped imports across packages** — `@<system>/<module>-domain`, not
  `../../domain/Trainer`. Otherwise ignoring `packages/<module>-api/`
  leaves the dal package with dangling relative imports into a folder
  that no longer exists.
- **Explicit cross-package dependency declarations** —
  `"@<system>/<module>-domain": "workspace:*"` in `-dal`'s
  `package.json`; `<ProjectReference Include="..\<module>-domain\<module>-domain.csproj" />`
  in `-dal.csproj`.

Without these the slicing doesn't survive contact with users.

## Per-backend specifics

### TypeScript / Hono — clean fit

The TS backend's layers are already in distinct path prefixes
(`src/domain/`, `src/db/`, `src/repos/`, `src/routes/`); the work is
to lift these into separate packages with their own manifests.

| Package | Contents | Deps |
|---|---|---|
| `@<system>/<module>-domain` | aggregate classes, VOs, IDs, events | (none) |
| `@<system>/<module>-dal` | Drizzle schema, repo classes, migrations | `-domain` |
| `@<system>/<module>-api` | Hono routes, OpenAPI, app composition | `-dal` |
| `@<system>/<system>-contracts` | wire DTOs (from `wireShape`), cross-context event types | (none) |
| `@<system>/<system>-ui` | React app | `-contracts` |

Workspace strategy: **pnpm workspaces** (fastest, best symlink behavior
for generated trees, dominant in modern TS tooling). TypeScript project
references (`composite: true` + `references: [...]`) can layer on top
for incremental builds but aren't strictly required.

### .NET — matches the platform's natural idiom

.NET already conventionally splits into multiple projects per solution,
and the existing generator already emits `src/Domain/`, `src/Infrastructure/`,
`src/Api/` as separate-`.csproj`-shaped folders. The refactor here is
mostly about making those projects real (own `.csproj`, own
`ProjectReference` lines, listed in `.sln`) and aligning the directory
shape with the TS proposal.

#### Deterministic GUIDs

`.sln` files require GUIDs in two places per project:

```
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Domain", "src/Domain/Domain.csproj", "{<project-guid>}"
```

The first GUID is the well-known project-type constant (hardcoded).
The second — the per-project GUID, also referenced in
`GlobalSection(ProjectConfigurationPlatforms)` — must be **stable
across regenerations** or every `ddd generate` produces a noisy
solution-file diff.

Approach: **GUID v5** (name-based, SHA-1, RFC 4122 §4.3), via the
`uuid` npm package:

```ts
import { v5 as uuidv5 } from 'uuid';

const LOOM_DOTNET_NS = '<pick-once-and-freeze>';
const projectGuid = uuidv5(`${system}:${module}:${pkg}`, LOOM_DOTNET_NS);
// wrap as `{${projectGuid.toUpperCase()}}` for .sln (uppercase, braced)
```

Constraints:
- The namespace constant must be fixed forever — changing it churns
  every existing solution.
- `.sln` wants **uppercase**, **braced** GUIDs; the `uuid` lib returns
  lowercase, unbraced. Wrap on emission.
- Skip emitting `[assembly: Guid("...")]` entirely (COM-interop relic,
  not needed for SDK-style csproj).
- Apply the same v5 trick to `UserSecretsId` so dev-secrets storage
  stays stable per-project across regenerations.

Two practical gotchas: `ProjectReference` paths are relative to the
*referencing* `.csproj`, not the solution root (easy to get wrong with
`packages/<module>-dal/` referencing `../<module>-domain/`), and
package versions need to coordinate with the runtime TFM (`net8.0` vs
`net9.0`) through the same `stacks/` mechanism that already governs
the TS stack versions.

### Phoenix — module-level only, no layer split

**(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only and `foundation: ash` is now a validation error. The Ash-specific reasoning below — resource/data-layer fusion, "Ash is the ORM" — no longer reflects emitted output; the layer-split conclusion should be re-derived against plain Ecto/Phoenix schemas + contexts.)**

An Ash `Resource` fuses domain attributes, the `postgres do … end`
data-layer block, validations, and API actions into one module
declaration. You **cannot** ship "just the domain" — the persistence
config and the entity are the same file.

For the per-module dimension, Elixir umbrella apps (`apps/<app_name>/`
with sub-Mix projects) map onto Loom modules cleanly. Umbrellas have
fallen out of fashion in the modern Elixir community (most teams now
prefer single-app with contexts or "poncho" sibling projects), so
we'd offer this only if the user opts in.

**The "Loom as ORM" recipe does not apply on Phoenix.** Ash *is* the
ORM; if a user wants Ash, they use Ash directly. The Phoenix backend
remains a whole-stack target.

### React — depends only on contracts

The React deployable consumes wire DTOs, not domain classes. With the
package split, the React app's only generated dependency is
`@<system>/<system>-contracts`, which makes the existing
"frontend doesn't run domain logic" architectural claim visible in the
manifest.

## Breaking changes & migration cost

This is a coordinated, breaking change for everyone consuming Loom
output. Eyes-open list:

- **Every example under `examples/` and `web/src/examples/`** will
  regenerate to the new shape.
- **Every fixture snapshot under `test/fixtures/`** needs to be
  recaptured (script: `scripts/capture-baseline-fixture.mjs`).
- **Every CI gate that builds emitted output** —
  `LOOM_TS_BUILD`, `LOOM_REACT_BUILD`, `LOOM_DOTNET_BUILD`,
  `LOOM_PHOENIX_BUILD`, the observability e2e suites, the conformance
  parity suite — needs path updates.
- **Every design-pack stack template** (`stacks/v1/`, `v2/`, `v3/`)
  needs reshaping; the `stack-package-deps.hbs` /
  `stack-package-devdeps.hbs` model assumes one `package.json` per
  deployable today.
- **Docs that show generated-tree paths** in `docs/generators.md`,
  `docs/platforms.md`, `docs/tools.md` need rewriting.

Recommendation: **a single coordinated PR per backend**, in this order:

1. **TS** first (cleanest layer separation, biggest payoff for the
   "Loom as ORM" use case).
2. **.NET** second (mostly mechanical given existing project
   separation; deterministic-GUID work lives here).
3. **Phoenix** third, scoped to **module-level umbrellas only** —
   no layer split.
4. **React** rolls in with the contracts package introduced in step 1.

Partial rollouts will be more painful than the cutover. Don't try to
thread backwards-compat across the two shapes.

## Package manager — npm in toolchain, pnpm in emitted output

Two separate decisions kept separate:

- **Loom's own repo** stays on **npm**. Single-package project with a
  flat dep tree; none of pnpm's wins (strictness, monorepo speed,
  `workspace:*`) apply. Switching would mean converting the lockfile,
  updating every CI workflow, and the `prepare` lifecycle script — real
  cost, near-zero benefit.
- **Generated output** moves to **pnpm**. The proposal's core claim
  — "dependency direction is visible in manifests" — needs pnpm's
  strict-by-default behavior to actually be enforced at runtime. Under
  npm/yarn workspaces a generated `-api` package could `import` from
  `-domain` without declaring the dep (hoisting makes it work
  silently), which would let the architecture lie. Touches
  `docker/dockerfile.hbs` (`pnpm install --frozen-lockfile` +
  `pnpm run build`) and the workspace root manifest.

Yarn skipped entirely: Yarn 1 is legacy, Yarn 2+/PnP introduces a
different mental model with worse ecosystem compatibility, and the
community has fragmented.

No fragmentation worries on the other backends — NuGet + `dotnet`
CLI + SDK-style `.csproj` is universal in .NET; Mix + Hex + `mix.exs`
is universal in Elixir.

## TODO — Playground workspace support

The Loom Playground (`web/`) runs an in-browser bundler
(`NpmInstallBundleEngine` — `web/src/engine/npm-install-bundle-engine.ts`)
that fetches real npm tarballs and bundles via esbuild-wasm against a
single-root VFS. **It has zero concept of workspace-local packages**:
grepping `web/src/engine/` for `workspace|monorepo|workspaces` returns
zero hits. So the multi-package shape collides with the playground
architecture regardless of which package manager the emitted output
uses — `workspace:*` and path-based local resolution are equally
unsupported.

This is a **TODO**, not an open question — playground support is
required for the multi-package shape to ship, otherwise the playground
silently regresses to "can't bundle Loom's own output."

### Initial research — how far are we?

The architecture is **not fundamentally hostile** to workspace
resolution, but workspace support is **not a plug-in**. The change
touches surface area from the dependency model down to the esbuild
plugin factory.

**Files needing changes:**

1. **`web/src/engine/dependencies.ts`** — add a `"workspace"` /
   `"local"` resolution kind alongside the existing `"custom-vendored"`
   precedent. The dependency model has the shape for this already.
2. **`web/src/engine/npm/resolve-tree.ts`** — currently fetches every
   package from the registry. Needs to intercept workspace packages
   before registry lookup and return a synthetic `PlannedPackage`
   pointing at local VFS paths.
3. **`web/src/engine/npm/install.ts`** — install orchestrator always
   calls `extract()` → `fetchTarball()`. For workspace packages, skip
   extraction and write project files directly from the VFS. The
   existing `mirror` parameter is a precedent for local overrides.
4. **`web/src/engine/npm/esbuild-vfs-plugin.ts`** — the resolver is
   pluggable-ish (accepts `aliases` + `externalizeVendor`) but
   workspace packages would need to be injected at plugin
   construction time. Add a workspace-root mapping
   (`@<system>/<module>-domain` → `/<module>-domain` path in VFS)
   and insert workspace resolution **before** the `resolveBare()`
   call.
5. **`web/src/engine/node-resolve.ts`** — clean and pure, reusable
   as-is. `resolveBare()` already works against any `FileSource`.
6. **`PrepareInput`** in the engine — currently passes only
   `honoEntry` / `reactEntry`; needs a `workspaceConfig?: { [packageName]: vfsPath }`
   threaded through.

**Open architectural decisions for the playground side:**

- **Single shared `node_modules` or one per workspace root?** Cheapest
  is single (hoist) but loses fidelity with pnpm's strict layout.
- **Can workspace packages participate in the install phase, or do
  they sidestep it?** Sidestepping (treat like vendored) is simpler
  but doesn't reflect that the package lives in the same VFS and can
  be edited live.
- **esbuild plugin lifecycle** — the plugin is created once per
  bundle, not per request. Workspace paths need to either be baked
  into the plugin factory contract or smuggled in via a closure when
  the worker initializes. Untested whether esbuild-wasm's plugin
  contract allows the latter cleanly; **validate this first** before
  committing to a design.

**Effort estimate: 1-2 weeks for a minimal MVP**, delivered in three
sequenced steps rather than one — the pluggability refactor is worth
extracting because **the engine already contains three disjoint
ad-hoc "skip the registry" mechanisms** that would be consolidated
under one contract:

- the `mirror?: Map<string, string>` parameter in
  `web/src/engine/npm/install.ts:29` (same-origin tarball override,
  used by the deployed playground's `npm-mirror/` directory),
- the `"custom-vendored"` resolution kind in
  `web/src/engine/dependencies.ts:28` (user-supplied package files,
  bypasses the registry entirely),
- the prebuilt-vendor (C2) path in
  `web/src/engine/npm/esbuild-vfs-plugin.ts` (different layer —
  bundle-time externalization — but the same family of
  "don't fetch this normally").

The contract is validated by **at least three existing consumers
before workspace becomes the fourth**, so the abstraction is
"consolidate the present" rather than "design for the future."

### Sequencing — three steps, not one

**Step 0 — Day-1 spike (blocking).** Confirm esbuild-wasm's
`onResolve` handler can dispatch across multiple resolution strategies
in one plugin instance. This isn't dodged by the pluggability refactor;
the pluggable contract has to fit through whatever esbuild's lifecycle
allows, so the spike result *shapes the interface*. Probably fine (the
handler already supports arbitrary VFS paths) but the answer is the
input to step 1's design.

**Step 1 — Pluggability refactor PR, zero behavior change.**
Introduce a `ResolutionStrategy` interface (or similar — shape roughly
`resolve(spec) → PlannedPackage | null`, `install(planned) → vfsFiles`).
Move the existing registry-fetch path behind it as the default
strategy. Run the existing `"custom-vendored"` kind through the same
interface. Tests confirm bit-for-bit identical playground output.
Touches the same five files listed above but with no new behavior —
reviewable on its own without referencing the workspace work.

**Step 2 — Workspace PR.** Add `WorkspaceResolutionStrategy` as the
second real implementation. Thread `workspaceConfig` through
`PrepareInput` → engine → worker. Smaller diff than step 1 because
the contract already exists.

Rough day-count under this split:

- Day 1 — spike (step 0).
- Days 2-5 — pluggability refactor (step 1), behavior-preserving.
- Days 6-8 — workspace strategy (step 2).
- Days 9+ — testing edge cases (circular deps, missing packages,
  Vite shim for `_packs/loader-fs.js`), validation against the
  realistic generated tree.

**Why this split rather than one PR:**

- Each PR is smaller and independently reviewable.
- The abstraction is justified by three existing concrete consumers
  (`mirror`, `"custom-vendored"`, prebuilt vendor) before workspace
  becomes the fourth — consolidating existing ad-hoc mechanisms, not
  designing for hypothetical future ones.
- Step 1 ships value independently: today the three mechanisms have
  separate code paths and parameters threaded to different places;
  unifying them simplifies the engine even before workspace lands.
- If the workspace PR gets blocked on something downstream (e.g.
  waiting on the TS generator refactor), step 1 still ships and
  unblocks future work on the existing mechanisms.

**Main risk:** esbuild-wasm's plugin lifecycle, addressed by the
step-0 spike. If `onResolve` can't dispatch across strategies in one
plugin instance, step 1's interface needs to absorb the constraint
(e.g. a static strategy list known at plugin construction rather than
dynamic dispatch per call).

**Not in scope for the MVP:** multi-root VFS (the playground would
treat workspace packages as subdirs of one root, not as independently
mounted projects). Sufficient for the proposal's needs; revisit only
if the single-root assumption hits a real limit.

#### Playground = preview, CI = enforcement

The playground's in-browser engine is flat-install only (BFS,
highest-wins, single `/node_modules` root — see
`web/src/engine/npm/resolve-tree.ts`). It cannot replicate pnpm's
strict-isolation behaviour because the browser VFS doesn't do
meaningful symlinks, and implementing real per-package isolation
would be a much larger project than the resolution-strategy refactor.

So the playground is going to be **pnpm-shaped (`workspace:*`
protocol via `WorkspaceStrategy`) but npm-behaved (flat install)**.
Architectural violations between generated packages would silently
work in the playground and only surface when CI runs real `pnpm
install` against the emitted tree.

**This is fine** for two reasons:

1. **The playground's input surface is the `.ddd` file, not the
   generated code.** Users never see or edit `package.json`,
   `csproj`, or import statements in generated packages — only the
   generator can produce a boundary violation, and that's caught by
   the existing per-backend CI gates (`LOOM_TS_BUILD`,
   `LOOM_DOTNET_BUILD`, etc.) running against real package managers.
2. **If a user introduces hand-written code that violates a
   boundary, it's their code to fix.** The playground's job is
   preview; enforcement lives one layer down in real package-manager
   land.

No "the playground enforces your architecture" promise gets made, so
no mismatch to discover later.

### Design — `ResolutionStrategy` contract

After studying the actual code paths the right design has a key
realisation: the **bundle layer doesn't need a strategy seam at all**.
The pluggability work is concentrated entirely in the
resolve/install layer.

#### Two seams, one of which doesn't need refactoring

1. **Resolution layer** (`resolve-tree.ts` + `install.ts`) — given a
   `DependencySpec`, produce "files in `node_modules`-shaped paths."
   This is where the four existing mechanisms diverge today
   (registry packument fetch / mirror tarball / vendored files /
   `RegistryResolver`). **The strategy seam lives here.**
2. **Bundle layer** (`esbuild-vfs-plugin.ts`) — resolves import
   specifiers at bundle time. `onResolve` already walks the populated
   VFS via `resolveBare` against `node_modules`. **If the resolution
   layer materialises workspace files into the right
   `node_modules/@<scope>/<name>/` paths, the bundle layer finds them
   with zero changes.** This dramatically simplifies the design and
   collapses the step-0 spike's importance — `onResolve` doesn't need
   to dispatch across strategies if the on-disk layout is uniform.

The C2 prebuilt-vendor path (externalisation) is a **separate
concern**: it's a bundle-output strategy ("don't bundle this, the
runtime supplies it"), distinct from a resolution strategy ("here's
where the package comes from"). Keep `externalizeVendor` as a plugin
parameter; if it grows multiple variants, give it its own seam later.

#### The existing scaffolding to build on

`web/src/engine/dependencies.ts` already declares the
forward-looking shape: `DependencyResolution` has four kinds
(`verified` / `custom-public` / `custom-vendored` / `custom-private`)
and `RegistryResolver` is documented as "the resolver seam for
`custom-private`… declared now so adding it later is plug-in work
behind the engine, not a refactor." The contract below **generalises
that seam from one kind to all of them**, plus workspace as a fifth.

#### The contract

```ts
import type { DependencySpec } from "../dependencies.js";
import type { PlannedPackage } from "./resolve-tree.js";
import type { TarEntry } from "./targz.js";

export interface ResolutionStrategy {
  /** Identifier for diagnostics / logging. */
  readonly id: string;

  /** Does this strategy claim this spec? First match wins; strategies
   *  are tried in registration order. */
  matches(spec: DependencySpec): boolean;

  /** Plan the install: resolve metadata + transitive deps for this
   *  spec.  Returns every package this strategy will be responsible
   *  for acquiring; the orchestrator collects across strategies. */
  plan(spec: DependencySpec, ctx: PlanContext): Promise<PlannedPackage[]>;

  /** Acquire the files for a planned package previously returned by
   *  `plan()`.  Entries have `name` relative to
   *  `node_modules/<pkg.name>/` — same shape as today's `extract()`. */
  acquire(planned: PlannedPackage): Promise<TarEntry[]>;
}

export interface PlanContext {
  /** Re-enter the orchestrator for transitive deps.  A
   *  registry-resolved package whose `dependencies` includes a
   *  workspace package re-dispatches to the workspace strategy. */
  resolve(name: string, range: string): Promise<PlannedPackage>;
  /** Read-only view of what's already been planned (dedupe). */
  readonly planned: ReadonlyMap<string, PlannedPackage>;
}
```

#### Mapping the existing mechanisms onto strategies

| Today's mechanism | Strategy | `matches()` | `plan()` | `acquire()` |
|---|---|---|---|---|
| Registry (`verified` + `custom-public`) | `RegistryStrategy` | `resolution ∈ {verified, custom-public}` | `fetchPackument` + `maxSatisfying` (current logic in `resolve-tree.ts`) | `fetchTarball(pkg.meta.dist.tarball)` |
| Mirror Map | **composition** — `MirroredStrategy(inner, mirror)` | delegates to `inner` | delegates to `inner` | check `mirror.get(key)` first, else `inner.acquire` |
| `custom-vendored` | `VendoredStrategy` | `resolution === custom-vendored` | look up `VendoredPackage` in `DependencySet.vendored` | return its `files` directly |
| `custom-private` (`RegistryResolver`) | `RegistryResolverStrategy` | `resolution === custom-private` | `resolver.resolve(spec)` → synthesise plan | return `ResolvedTarball.files` |
| **Workspace (new)** | `WorkspaceStrategy` | `resolution === workspace` | read package's `package.json` from VFS path → synthesise meta | copy files from workspace VFS root |

Two design choices visible in this table:

- **Mirror is composition, not a strategy.** It's an acquisition-time
  override, not a different resolution source. Modelling it as a
  wrapper around `RegistryStrategy` keeps "every registry fetch
  checks the mirror first" exactly as today, without forcing a
  matcher onto every package.
- **`PlannedPackage.meta` is the strategy's choice.** Today it's
  `VersionMeta` (registry packument). Workspace and vendored
  strategies synthesise a minimal meta (name, version, `dependencies`
  read from the workspace `package.json`). May become a discriminated
  union later; for the B3-era stack consumers a synthesised meta is
  enough.

#### What changes where

1. **`web/src/engine/dependencies.ts`** — add `"workspace"` to
   `DependencyResolution`. Add `WorkspaceConfig` (`name → vfsPath`)
   to `DependencySet`.
2. **`web/src/engine/npm/resolve-tree.ts`** — current `planInstall`
   logic becomes `RegistryStrategy.plan()`. New top-level
   `planInstall` becomes a strategy-dispatching loop over
   `DependencySpec[]`.
3. **`web/src/engine/npm/install.ts`** — `extract()` becomes
   strategy-dispatched (the orchestrator looks up which strategy
   produced each `PlannedPackage` and calls its `acquire`). The
   `mirror` parameter moves to `MirroredStrategy`.
4. **`web/src/engine/npm/esbuild-vfs-plugin.ts`** — **no changes.**
   Once `node_modules` is populated uniformly, `resolveBare` finds
   everything.
5. **`web/src/engine/npm-install-bundle-engine.ts`** — wires the
   strategy list from inputs (workspace config, vendored set,
   registry resolver, mirror).

Composition example at engine wiring:

```ts
const strategies: ResolutionStrategy[] = [
  workspaceConfig && new WorkspaceStrategy(workspaceConfig, vfs),
  vendored?.length && new VendoredStrategy(vendored),
  registryResolver && new RegistryResolverStrategy(registryResolver),
  new MirroredStrategy(new RegistryStrategy(), mirror), // default fallback
].filter(Boolean);
```

#### Constraints

- **First-match dispatch.** Strategies are an ordered list, first
  `matches()` wins. Predictable; no merge semantics.
- **No cross-strategy coordination at plan time** beyond
  `PlanContext.resolve` for transitive deps. A registry-resolved
  package whose transitive is a workspace package re-enters the
  orchestrator and dispatches to the workspace strategy — clean
  fall-through.
- **Strategies own their cache.** `InstallCache` stays as today
  (keyed by `name@version`); each strategy can opt into it. Workspace
  strategy probably doesn't (files are live).
- **Bundle layer stays simple.** The whole point of materialising
  into `node_modules` paths is to keep `esbuild-vfs-plugin.ts`
  unchanged. Don't grow a parallel dispatch there.

#### Sequencing — revised against the design

The original three-step plan stands but the contents shift now that
the bundle layer doesn't need surgery:

- **Step 0 — spike** (1 day). Confirm `WorkspaceStrategy.acquire`
  copying files into `node_modules/@<scope>/<name>/` actually lets
  the existing `resolveBare` find them through scoped paths
  (`@scope/name` joins). Probably yes — `resolveBare` already
  handles scopes — but verify before committing.
- **Step 1a — interface + RegistryStrategy** (2-3 days). Extract
  current `planInstall` + `extract` into `RegistryStrategy`. Engine
  wires `[new MirroredStrategy(new RegistryStrategy(), mirror)]`.
  Behaviour bit-for-bit identical. **Reviewable PR.**
- **Step 1b — VendoredStrategy + RegistryResolverStrategy** (2 days).
  Wire the existing `vendored` field on `DependencySet` through the
  new strategy. `custom-private` becomes a real consumer of the
  contract (even if no production engine ships a `RegistryResolver`
  yet, the strategy exists). The contract is validated by **three
  concrete strategies** before workspace lands. **Reviewable PR.**
- **Step 2 — WorkspaceStrategy** (3 days). Add `"workspace"` to
  `DependencyResolution`, add `WorkspaceConfig` to `DependencySet`,
  implement `WorkspaceStrategy`. Thread config through `PrepareInput`.
  **Reviewable PR.**

Total: ~9 working days, same as before but with each PR meaningfully
smaller because the bundle-layer changes drop out.

#### Open design questions

1. **Hot-edit semantics for workspace packages.** If the user edits
   a file in `packages/users-domain/` in the playground, does
   `WorkspaceStrategy` re-acquire (recopy into `node_modules`) on
   next bundle? Probably yes, but the trigger needs spec'ing — does
   it watch VFS writes, or does the engine re-plan from scratch each
   `prepare()` call?
2. **Workspace package versions.** Registry packages get a `version`
   from semver. Workspace packages have whatever's in their on-disk
   `package.json`. Use that verbatim (and let users see `0.0.0` if
   that's what's there) or synthesise `"0.0.0-workspace"`? Leaning
   verbatim — matches pnpm/npm workspace behaviour and the proposal
   doesn't need version negotiation.
3. **Transitive workspace deps.** If `@<system>/users-dal` declares
   `@<system>/users-domain` as a dep, both must be in
   `WorkspaceConfig`. Auto-discover by reading the root
   `pnpm-workspace.yaml` from the VFS, or require explicit config?
   **Lean explicit for the MVP** (less magic, less to debug;
   auto-discovery can be a layer on top later).
4. **VFS path for workspace roots.** Do workspace packages live under
   `/packages/<module>-<layer>/` in the VFS (matching the on-disk
   tree) or somewhere engine-internal? Probably the former — the
   playground UI shows the file tree, users expect to see the
   packages where they are on disk.

## Recipe document

The proposal ships with one new doc:

- `docs/recipes/loom-as-orm.md` — walks through "I have an existing
  TS project, I want Loom to emit just my domain + dal, here's the
  `.loomignore` + `pnpm link` recipe."

## Open questions

1. **Apps as packages, or directories?** Is
   `apps/<deployable>/` its own `package.json` (workspace member) or
   just a directory under the workspace root? Leaning workspace member
   for symmetry, but it's mostly composition glue.
2. **Migrations ownership.** Each `-dal` package owns its own
   migrations; do we also emit an aggregated `infra/migrations/` view
   for ops convenience, or is per-package enough? (The `migrationsOwner`
   enrichment already picks the owner per module.)
3. **Cross-module references inside the same backend.** If module A's
   aggregate references module B's via `X id`, does `-domain` package
   A depend on `-domain` package B? Probably yes, but worth making the
   rule explicit.
4. **Workspace root manifest.** Do we emit a `pnpm-workspace.yaml` +
   root `package.json` at `out/`, or assume the user provides the
   workspace skeleton? Leaning emit-it (matches the
   "regenerate the whole tree" model).
5. **Phoenix umbrella default.** Single-app or umbrella by default?
   Umbrella matches this proposal's per-module split but is the less
   fashionable choice today.

## Decision points before implementation

- [ ] Confirm `.loomignore` semantics are sufficient (path-prefix
      include/exclude with negation) for the realistic recipe set.
- [ ] Confirm the workspace strategy (pnpm vs npm vs yarn) — pnpm
      recommended.
- [ ] Pick + freeze the `LOOM_DOTNET_NS` namespace UUID.
- [ ] Resolve the five open questions above.
- [ ] Decide whether `docs/recipes/` is a new top-level doc area or
      folds into `docs/tools.md`.
- [ ] **Spike day 1**: confirm esbuild-wasm's `onResolve` handler
      can return both `node_modules`-resolved and workspace-resolved
      paths in the same plugin instance. Blocks the playground TODO
      design — the result shapes the `ResolutionStrategy` interface
      designed in step 1.
