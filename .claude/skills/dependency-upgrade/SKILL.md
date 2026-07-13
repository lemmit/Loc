---
name: dependency-upgrade
description: >-
  Land a dependency / runtime / image bump in the Loom repo across BOTH
  surfaces it touches and gate BOTH — so it doesn't leave `main` red one merge
  later. Use this whenever the task is to bump a version: "bump <dep>",
  "upgrade to <runtime> N", "Langium 4 / TS 6 / Node 24 / Spring Boot 4 / PG18",
  "run the currency batch", picking up `docs/old/proposals/dependency-upgrades.md`
  or `docs/audits/stack-versions-audit.md`, clearing an `npm audit` finding, or
  a Dependabot-shaped task. Reach for it even when the user just says "update
  the postgres image", "move the generated apps to React 19", "bump the .NET
  TFM", or "why did the bump turn main red" — anything that changes a pinned
  version. Its whole reason to exist: an upgrade touches TWO surfaces (the
  TOOLCHAIN's own deps AND the GENERATED projects' stack/backend templates),
  and the heavy gate that would catch the second one does NOT run on a narrow
  diff — so the author ships, and a compose-boot job fails on `main` afterward.
  It classifies the bump, enumerates every file that pins the version on each
  surface, sequences stacked upgrades, runs the matching per-backend gate
  locally, and forces the compose-boot gate a narrow diff skips.
---

# Loom dependency upgrade

A version bump in this repo is dangerous for a structural reason, not a careless
one: **every upgrade can touch two completely separate surfaces, and they are
gated by different CI jobs that don't both run on a narrow diff.**

- **Surface A — the toolchain itself.** Root `package.json`, the compiler that
  consumes the dep (Langium, TypeScript, vitest, chevrotain). Gated by the fast
  `test.yml` + `langium-generated.yml`, which run on almost any PR.
- **Surface B — the generated projects.** The stack templates (`stacks/v*/`,
  `stacks/{sv1,vue1,ng1}/`) and each backend's dependency-manifest emitter
  (`package.json` / `.csproj` / `build.gradle.kts` / `pyproject.toml` /
  `mix.exs`), plus the `docker/` base images and the Postgres image in
  `src/system/index.ts`. Gated by the **heavy** per-backend build jobs
  (`hono-build`, `dotnet-build`, `java-build`, `python-build`,
  `elixir-*-build`) and the **compose-boot** jobs (`conformance-parity`, the
  `*-obs-e2e` legs, `k8s-e2e`) — most of which are **path-filtered or not
  per-PR at all**.

The recurring failure this skill prevents is concrete. The #1422–#1430 currency
batch left `main` red on four jobs (→ fix #1464) because each bump had a Surface
B footprint the author didn't gate:

- **#1423** PG16→18 was "just an image-tag bump" — a one-line narrow diff. But
  PG18 moved `PGDATA` and the volume mount path, so the db container refused to
  boot. `conformance-parity` is path-filtered (`docker/**`, `src/system/**`,
  `src/generator/**`) and didn't run on that narrow diff; it only failed later
  on `main` when an unrelated PR re-triggered it.
- **#1427** Spring Boot 4.1 + Jackson 3 silently dropped Flyway
  auto-configuration (`flyway-core` alone no longer wires migrations) — caught
  only by booting the .NET/Java compose stack and migrating.
- **#1430** Langium 3.3→4.3 forced TS 5.9 and a real API migration
  (`computeExports`→`collectExportedSymbols`, `findDeclaration`→
  `findDeclarations`, the hover-provider return shape) — Surface A only, but
  foundational.
- **#1463** TS 6 was deferred to its own PR because it independently breaks
  `@types/node` global resolution across the Node-only islands (`src/cli`,
  `src/mcp`, `src/language/main.ts`) — ~49 errors unrelated to the dep that
  pulled it in.

The fix is always the same discipline: **classify which surfaces the bump
touches, walk every pin on each, and force-run the gate the narrow diff would
skip.** This skill is that discipline.

## Before anything: orient on fresh `main`

`main` moves fast here (parallel agents land PRs). Sync first —
`git fetch origin main && git reset --hard origin/main` (or rebase the feature
branch) — and confirm `npm install` has run (`node_modules/.bin/biome` and
`src/language/generated/` exist). A version pin you "remember" may already have
moved: this session's research found `docs/audits/stack-versions-audit.md`
already stale vs the disk (it lists a `stack v2` / mantine@v9 that **does not
exist on disk** — only `stacks/{v1,v3,sv1,vue1,ng1}` are present — and lists
.NET as "defer net8" / Spring Boot 3.5 when the emitters are already on
`net10.0` and Spring Boot `4.1.0`). **Trust the on-disk emitter, not the audit
doc.** Read the pin in the actual source before you decide it needs bumping.

Then read `docs/old/proposals/dependency-upgrades.md` (the live backlog this skill
operationalizes) and skim `docs/audits/stack-versions-audit.md` for the
intended-vs-latest deltas — treating its numbers as a hint, re-verified on disk.

## Step 1 — Classify the bump

Decide which surface(s) the dep lives on. This single decision drives everything
after it. Read `references/upgrade-footprint.md` for the full surface ↔ file ↔
gate map; the short version:

| The bump is… | Surface | Tell |
|---|---|---|
| A toolchain dep (langium, langium-cli, typescript, vitest, chevrotain, vscode-languageserver, handlebars, commander, chalk) | **A only** | Listed in root `package.json`; the compiler imports it. |
| A generated-frontend dep (react, vue, svelte, angular, vite, zod, a router, a design-pack lib, a query lib) | **B only** | Pinned in `stacks/<id>/*.hbs` or `designs/<pack>/.../package-json.hbs`. |
| A generated-backend dep (hono, drizzle, EF Core, Spring Boot, fastapi, sqlalchemy, phoenix, ecto) | **B only** | Pinned in that backend's `pins.ts` / `renderCsproj` / `renderGradleBuild` / `renderPyproject` / `renderMixExs`. |
| A runtime / base image (Node, Python, Elixir/OTP, JDK, .NET SDK, the Postgres image) | **B only — and on the compose-boot path** | A `FROM` in `docker/` or a backend emitter, or `postgres:NN` in `src/system/index.ts`. **These are the ones that skip the gate.** |
| A dep the toolchain uses **and** mirrors into generated output (zod, typescript) | **BOTH** | Appears in root `package.json` *and* in a stack/backend emitter. Bump them together or note explicitly why not. |

For a **BOTH** bump, write down the two pin sites — the toolchain one and the
generated-stack one — before editing either. They drift apart silently
otherwise (the playground's own `web/package.json` is a *third*, independent
axis — bumping it is separate from bumping the packs it emits).

## Step 2 — For each surface, touch every pin

The footprint reference has the exact files. The map you must not have holes in:

**Surface A (toolchain):** root `package.json` → if it's Langium, re-run
`npm run langium:generate` and commit the regenerated `src/language/generated/`
(`langium-generated.yml` fails on drift) and expect API breaks in
`src/language/{ddd-module,ddd-scope}.ts`, `validators/*`, `lsp/*` (see the
known-landmines reference for the 4.3 renames).

**Surface B (generated output)** — pin lives in exactly one of:
- **Frontend framework deps:** `stacks/<id>/stack-package-deps.hbs` /
  `-devdeps.hbs` (the cross-cutting react/vue/svelte/angular + vite + zod + TS
  pins). Which stack a deployable uses is resolved in
  `src/ir/lower/lower-deployment.ts` → `src/util/builtin-formats.ts` → loaded by
  `src/generator/_packs/loader-fs.ts`. A version whose *import specifier*
  changed across the major (e.g. `react-router-dom`→`react-router` at v7) also
  needs the seam in `src/generator/_packs/stack-runtime.ts`
  (`routerPackageForStack`) — a pure deps bump there silently emits broken
  imports.
- **Pack-specific deps:** `designs/<pack>/<vN>/package-json.hbs`.
- **Backend deps:** the backend's manifest emitter (Hono — bareword `node`
  resolves to the **`node@v5`** default lane, so the live pins are
  `src/platform/hono/v5/pins.ts`; `v4/` is the legacy pinnable lane, bump it only
  if a deployable pins `node@v4`. .NET `renderCsproj` in
  `src/generator/dotnet/emit/program.ts`; Java `renderGradleBuild` +
  `SPRING_BOOT_VERSION`/`JAVA_VERSION` in `src/generator/java/emit/program.ts`;
  Python `src/generator/python/pins.ts`; Elixir `renderMixExs` in
  `src/generator/elixir/shell/project.ts`).
- **Base images / Postgres:** the `FROM` lines in `docker/dockerfile.hbs` and
  each backend's `renderDockerfile`, and `postgres:NN-alpine` in
  `renderDockerCompose` (`src/system/index.ts`). **A runtime-major image bump
  (Postgres especially) almost always has a boot-time footprint beyond the tag —
  check the known-landmines reference before assuming one line is enough.**

## Step 3 — Sequence stacked upgrades

Some bumps gate others; do them as **stacked PRs** in dependency order rather
than one mega-diff, so each gate is meaningful and a revert is surgical:

- **Langium 4 needs TypeScript ≥ 5.8** → bump TS to 5.9 *in the same PR* as
  Langium 4 (they're one unit; #1430).
- **TS 6 is its own PR, after** → it breaks `@types/node` global resolution on
  the Node-only islands independently of any other dep (#1463). Never fold TS 6
  into a feature/dep PR; it generates unrelated noise.
- **A frontend major that renamed its package** (router v6→v7) → bump the stack
  deps *and* the `stack-runtime.ts` specifier seam together; neither half
  compiles alone.
- **A backend major that changed an adjacent tool** (Spring Boot 4 → Flyway
  starter; #1427) → the dep bump and the migration-wiring fix are one PR.

When one bump blocks another, stack the second PR on the first's branch rather
than waiting for it to merge — don't idle on CI (CLAUDE.md "keep going").

## Step 4 — Run the matching gate locally, and force the one the diff skips

Per-backend compile gates run fast and should be run locally for any Surface B
backend bump:

| Touched | Local gate |
|---|---|
| Hono / TS backend deps | `LOOM_TS_BUILD=1 npm run test:tsc` |
| React stack / pack | `LOOM_REACT_BUILD=1 npm run test:tsc-react` |
| Svelte / Vue stack | `npm run test:svelte-build` / `test:vue-build` |
| .NET deps / TFM | `LOOM_DOTNET_BUILD=1 npm run test:dotnet` (sdk:10.0 container) |
| Java / Spring Boot / JDK | `LOOM_JAVA_BUILD=1 npm run test:java` (host JDK 21 + Gradle) |
| Python deps / version | `LOOM_PYTHON_BUILD=1 npm run test:python` |
| Elixir / Phoenix / OTP | `LOOM_PHOENIX_VANILLA_BUILD=1 npm run test:phoenix` (add `LOOM_HEX_MIRROR=1` behind a TLS-fingerprinting proxy — see landmines) |

**The part that actually prevents the #1423-class failure:** if the bump moved a
**runtime path** — the Postgres image, a migration tool (Flyway/EF/Ecto), a
language-runtime base image, or anything that affects how a container boots or
migrates — the per-backend *compile* gate is not enough. A project that
type-checks can still fail to boot. You must force the **compose-boot / migrate**
gate that the narrow diff's path filter would skip.

**Delegate this to the sibling `generated-stack-verifier` skill**
(`.claude/skills/generated-stack-verifier/`), which owns standing up the
generated stack, booting it against a real Postgres, and asserting `/ready` +
a read/write round-trip through the migrated DB — the exact thing
`conformance-parity` / `*-obs-e2e` / `k8s-e2e` do, run on demand. Hand it the
generated system and the backend(s) the bump touched. If that skill is
unavailable, run the gate by hand: start `dockerd`, `node bin/cli.js generate
system <f.ddd> -o out`, `docker compose up` from `out/`, and assert the `db`
container reaches healthy and the backend reaches `/ready` (see
`docs/tools.md` → "Compiling generated backends in Docker", and CLAUDE.md's
Docker section). Don't trust the path filter to have caught it — that's the
whole bug.

## Step 5 — Walk the landmine list

Before declaring done, check the bump against `references/known-landmines.md` —
each entry is a real failure (PGDATA, Spring Boot 4 Flyway, the Erlang/OTP hex
TLS 503 → `LOOM_HEX_MIRROR=1`, TS 6 `@types/node`, the Langium 4 renames) with
its symptom, cause, fix, and the PR that found it. The point of the list is that
each landmine is *checked, not rediscovered*. If the bump matches a landmine,
apply the documented fix; if it's a new landmine, add an entry so the next bump
inherits it.

Then: update `docs/audits/stack-versions-audit.md` (snapshot date + new values)
and tick the line in `docs/old/proposals/dependency-upgrades.md`. Run the fast suite
(`npm test`) and report exactly which gates you ran and their real results —
never claim a green you didn't see. Commit in coherent per-surface commits; do
**not** open a PR unless the user asks.

## Why this shape

The two-surface split is the entire reason a "trivial" bump goes wrong here.
Surface A is well-gated and cheap; Surface B has expensive gates that are
deliberately path-filtered or nightly to save CI minutes — which means a narrow
diff is *exactly* the diff that escapes them. Classifying first forces you to
notice Surface B even when the diff looks like one line; the footprint map keeps
you from leaving a half-bumped pin; the stacked-PR sequencing keeps each gate
meaningful; and forcing the compose-boot gate via `generated-stack-verifier` is
the one step that turns "green PR, red main" back into "red PR, fixed before
merge." The landmine list makes the recurring boot-time breakages a checklist
instead of a fresh investigation each time.
