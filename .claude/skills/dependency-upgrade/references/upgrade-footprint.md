# Upgrade footprint — the two-surface map

The thing to internalize: a Loom dependency bump can touch **two surfaces**, and
each surface has its own pin sites and its own CI gates. A bump that looks like
one line on Surface A may have a mirrored pin on Surface B (and vice versa). This
file is the lookup so you don't leave a hole.

All paths are real and verified on disk (snapshot 2026-06). The companion
`docs/audits/stack-versions-audit.md` is a useful intent doc but was already
stale vs the emitters this session — **trust the source file's pin over the
audit's number.**

## Table of contents
- [Surface A — toolchain](#surface-a--the-toolchain)
- [Surface B — generated frontends (stacks + packs)](#surface-b--generated-frontends)
- [Surface B — generated backends (manifest emitters)](#surface-b--generated-backends)
- [Surface B — base images + Postgres (the compose-boot path)](#surface-b--base-images--postgres)
- [Which stack version pins what](#which-stack-version-pins-what)
- [Surface ↔ pin ↔ gate, in one table](#surface--pin--gate-in-one-table)

---

## Surface A — the toolchain

The deps the Loom compiler itself runs on. One pin site: root `package.json`.
Gated by the fast, near-always-on jobs.

| Dep | Pin site | Consumer that breaks on a major | Gate |
|---|---|---|---|
| `langium` / `langium-cli` | root `package.json` | `src/language/{ddd-module,ddd-scope}.ts`, `validators/*`, `lsp/*`, regenerated `src/language/generated/` | `test.yml` + `langium-generated.yml` (drift) |
| `typescript` (toolchain) | root `package.json` | the whole `tsc -b` build; the Node-only islands `src/cli`, `src/mcp`, `src/language/main.ts` on TS 6 | `test.yml` (build) |
| `chevrotain` | root `package.json` (transitive under langium) | grammar processing; pulls `lodash` (the `npm audit` chain) | `langium-generated.yml` |
| `vscode-languageserver` | root `package.json` | `src/language/lsp/*`, subpath imports `/node` `/browser` | `test.yml` |
| `vitest` / `@vitest/coverage-v8` | root `package.json` | the test runner itself | `test.yml` |
| `handlebars`, `commander`, `chalk`, `ignore` | root `package.json` | design-pack rendering / CLI | `test.yml` |

**Langium-specific:** after bumping, **re-run `npm run langium:generate` and
commit `src/language/generated/`** — `langium-generated.yml` fails CI on any
drift between `ddd.langium` and the committed output. See known-landmines for the
4.3 API renames.

**Already-landed (correcting SKILL.md's in-flight framing):** as of the disk
snapshot, root `package.json` is already on `langium ~4.3.0`, `typescript
~6.0.0`, `@types/node ~24.13.0`. SKILL.md / the audit doc describe #1430
(Langium 4 + TS 5.9) and #1463 (TS 6) as pending — they have **landed**. The
4.3 renames (`collectExportedSymbols`, `findDeclarations`) are live in
`src/language/lsp/*` and `ddd-scope.ts`. Treat those PRs as the history that
produced today's pins, and re-read the actual pin before assuming a bump is
needed. (A stale comment at `ddd-scope.ts:100` still says `computeExports` —
comment only; the code is migrated.)

---

## Surface B — generated frontends

The deps that land in a **generated project's** `package.json`. These are NOT in
root `package.json` — they're Handlebars-template strings.

### Stack-supplied cross-cutting deps (one place per frontend family)

| File | Pins |
|---|---|
| `stacks/v1/stack-package-deps.hbs` + `-devdeps.hbs` | React 18 + react-router-dom 6 + zod 3 + react-query 5 + react-hook-form 7 / resolvers 3; vite 8, **typescript 6** (devdeps) |
| `stacks/v3/stack-package-deps.hbs` + `-devdeps.hbs` | React 19 + react-router 7 + zod 4 + resolvers 5; vite 8, typescript 6 |
| `stacks/sv1/stack-package-deps.hbs` + `-devdeps.hbs` | Svelte 5 + SvelteKit 2 + adapter-static 3 + svelte-query 6 + zod 4 + vite 8 + **TS 6.0** + svelte-check 4 |
| `stacks/vue1/stack-package-deps.hbs` + `-devdeps.hbs` | Vue 3.5 + vue-router 4 + @vitejs/plugin-vue 6 + vue-query 5 + vue-tsc 3 + zod 4 + vite 8 + **TS 6.0** |
| `stacks/ng1/stack.json` | Angular 22 + TanStack angular-query-experimental 5 + rxjs 7 + zone.js 0.15 + zod 4 + **TS 6.0** |

> `stacks/*/stack.json` is the human-readable manifest (descriptive, not consumed
> at emit time); the `stack-package-deps.hbs` / `-devdeps.hbs` files are the
> **actual emitted pins**. Every stack — v1, v3, sv1, vue1, ng1 — has both `.hbs`
> files on disk; bump the `.hbs`, not `stack.json`. Framework-runtime deps are
> stack-supplied; only library-specific deps (`@mantine/core`, `vuetify`, …) live
> in the pack's `package-json.hbs`.

### Pack-specific deps

`designs/<pack>/<vN>/package-json.hbs` (e.g. `designs/mantine/v9/`,
`designs/shadcn/`, `designs/vuetify/`, `designs/angularMaterial/`). The pack lib
itself (`@mantine/core`, `@mui/material`, `vuetify`, tailwind, etc.) is pinned
here, not in the stack.

### How a deployable picks its stack (so you bump the right one)

1. `src/ir/lower/lower-deployment.ts` → `lowerDeployable()` picks the design pack
   default from the frontend platform (react→mantine, svelte→shadcnSvelte,
   vue→vuetify, angular→angularMaterial) and qualifies it to `family@version`.
2. `src/util/builtin-formats.ts` (`BUILTIN_PACK_FORMATS` / `BUILTIN_PACK_LATEST`)
   maps each `family@version` → its `stack:` id.
3. `src/generator/_packs/loader-fs.ts` (`loadPack`, ~line 187) reads
   `stacks/<id>/*.hbs` and registers each as a Handlebars partial; the pack's
   `package-json.hbs` pulls them in via `{{> stack-package-deps}}`.

### The import-specifier seam (do NOT forget on a renaming major)

`src/generator/_packs/stack-runtime.ts` → `routerPackageForStack(stackId)`:
`react-router-dom` for v1, **`react-router`** for v3 (RR7 renamed the package).
Consumed by `src/generator/react/templating/render.ts` and
`react/walker/page-shell.ts`. A version bump that renames a package's import
specifier needs this seam updated too, or the deps bump and the emitted imports
disagree.

**Backends do not use stacks at all** — only the four frontends do.

---

## Surface B — generated backends

Each backend emits its own dependency manifest from a dedicated pin site. This is
where a generated-backend dep (hono, EF Core, Spring Boot, fastapi, phoenix) is
bumped — never root `package.json`.

| Backend | Manifest | Pin site | Notable current pins |
|---|---|---|---|
| **Hono / node** | `package.json` | **default = `src/platform/hono/v5/pins.ts`** (`BACKEND_PINS`); legacy `src/platform/hono/v4/pins.ts` stays pinnable via `platform: node@v4`. Both registered in `src/platform/registry.ts` (bareword `node` → v5). | **v5 (default):** hono ^4.12, @hono/zod-openapi ^1.0, **zod ^4.0**, drizzle-orm ^0.45, pg ^8.13, pino ^9.5; dev **typescript ^6.0**, vitest ^4.0, tsup ^8.3, pino-pretty ^13. **v4 (legacy):** @hono/zod-openapi ^0.19, zod ^3.25, typescript ^5.9, vitest ^2.1 — the zod-3 / TS-5 lane kept for reproducibility. The cross-major bumps (zod 4 / TS 6 / vitest 4) were the *reason* v5 forked, not deferred. |
| **.NET** | `<ns>.csproj` | `renderCsproj` in `src/generator/dotnet/emit/program.ts` (~line 575) | **TargetFramework net10.0**, EF Core 10.0.9, Npgsql.EFCore.PostgreSQL 10.0.2, Mediator.SourceGenerator 2.1.7, Swashbuckle 6.9; conditional FluentValidation 11.10, Ardalis.Specification 9.3, Microsoft.IdentityModel 8.0 (OIDC), Dapper 2.1 (dapper persistence) |
| **Java / Spring** | `build.gradle.kts` | `renderGradleBuild` + `SPRING_BOOT_VERSION`/`JAVA_VERSION` consts in `src/generator/java/emit/program.ts` | **Spring Boot 4.1.0**, Java 21, jMolecules 1.10, springdoc 3.0.3, nimbus-jose-jwt 10.3 (OIDC); Flyway via `spring-boot-starter-flyway` + `flyway-database-postgresql` when migrations exist |
| **Python / FastAPI** | `pyproject.toml` | `src/generator/python/pins.ts` (rendered by `renderPyproject` in `python/index.ts`) | **requires-python >=3.13**, fastapi >=0.115,<1, uvicorn[standard], sqlalchemy[asyncio] >=2.0.36,<3, asyncpg, pydantic >=2.10; dev mypy/ruff/pytest/pytest-asyncio; pyjwt (OIDC) |
| **Elixir / Phoenix** | `mix.exs` | `renderMixExs` in `src/generator/elixir/shell/project.ts` | phoenix ~> 1.8, phoenix_live_view ~> 1.0, ecto_sql ~> 3.10, postgrex ~> 0.20, bandit ~> 1.5, open_api_spex ~> 3.0; jose (OIDC) |

> The old `docs/audits/stack-versions-audit.md` cites `phoenix-live-view/index.ts`
> and "defer net8 / Spring Boot 3.5" — both stale. The current homes are
> `src/generator/elixir/` and the emitters above (net10.0, Spring Boot 4.1).

---

## Surface B — base images + Postgres

**The compose-boot path.** A bump here changes how a container boots/migrates —
and is exactly the narrow diff that path-filtered gates skip.

| Image / tag | Pin site | Current |
|---|---|---|
| Node (Hono build+runtime; SPA build stage in fullstack backends) | `docker/dockerfile.hbs`; each backend's `renderDockerfile` | `node:24-alpine` |
| .NET SDK / runtime | `renderDockerfile` in `dotnet/emit/program.ts` | `mcr.microsoft.com/dotnet/sdk:10.0` / `aspnet:10.0` |
| Java build / runtime | `renderDockerfile` in `java/emit/program.ts` | `gradle:8-jdk21` / `eclipse-temurin:21-jre` |
| Python | `renderDockerfile` in `python/index.ts` | `python:3.13-slim` (+ `ghcr.io/astral-sh/uv`) |
| Elixir / OTP | `renderDockerfile` in `elixir/shell/project.ts` | `ELIXIR_VERSION=1.18.4` / `OTP_VERSION=27.3.4` / debian bookworm |
| **Postgres** | **`renderDockerCompose` in `src/system/index.ts` (~line 403)** | **`postgres:18-alpine`** — with the PGDATA + volume-path workaround, see landmines |
| Keycloak (bundled OIDC) | `src/system/index.ts` (~line 490) | `quay.io/keycloak/keycloak:26.0` |

---

## Which stack version pins what

| Stack | Family | React/FW | router | zod | TS | vite |
|---|---|---|---|---|---|---|
| `v1` | React (mantine@v7, chakra@v2, mui@v5, shadcn@v3) | 18 | react-router-dom 6 | 3 | 6 | 8 |
| `v3` | React (mantine@v9, chakra@v3, mui@v7, shadcn@v4) | 19.2 | react-router 7 | 4 | 6 | 8 |
| `sv1` | Svelte (shadcnSvelte, flowbite) | Svelte 5 / Kit 2 | — | 4 | 6 | 8 |
| `vue1` | Vue (vuetify, shadcnVue) | Vue 3.5 | vue-router 4 | 4 | 6 | 8 |
| `ng1` | Angular (angularMaterial, primeng, spartanNg) | Angular 22 | @angular/router 22 | 4 | 6.0 | (Angular CLI / `@angular/build`) |

**On-disk reality vs the audit doc:** there is **no `stacks/v2`** — the audit's
"stack v2 / mantine@v9" column refers to a stack that was removed; React 19 lives
in `v3`. Verify with `ls stacks/` before acting on the audit's stack names.

---

## Surface ↔ pin ↔ gate, in one table

The column that matters: a ✗ in "per-PR" means a narrow diff escapes the gate and
the bump can land green then break `main`. Force those via the local gate +
`generated-stack-verifier`.

| Bump | Surface | Pin site | Per-PR gate (compile) | Compose-boot gate (per-PR?) |
|---|---|---|---|---|
| langium / langium-cli | A | root package.json | `test.yml`, `langium-generated.yml` | n/a |
| toolchain typescript / vitest | A | root package.json | `test.yml` | n/a |
| React/Vue/Svelte/Angular stack dep | B | `stacks/<id>/*.hbs` | `generated-{react,vue,svelte,angular}-build.yml` (path-filtered) | `generated-*-e2e.yml` — **path-filtered ✗** |
| design-pack lib | B | `designs/<pack>/.../package-json.hbs` | same generated-build matrix | same |
| hono / drizzle / TS-backend dep | B | `hono/v5/pins.ts` (default; `v4/pins.ts` is the legacy pinnable lane) | `hono-build.yml` (path-filtered) | `hono-obs-e2e.yml` — **push:main only ✗**, `conformance-parity` path-filtered |
| EF Core / .NET TFM | B | `dotnet/emit/program.ts` | `dotnet-build.yml` | `dotnet-obs-e2e.yml` — **push:main only ✗** |
| Spring Boot / JDK / Flyway | B | `java/emit/program.ts` | `java-build.yml` | `java-obs-e2e.yml` — **push:main only ✗** |
| fastapi / sqlalchemy / py version | B | `python/pins.ts` | `python-build.yml` | `python-obs-e2e.yml` — **push:main only ✗** |
| phoenix / ecto / OTP | B | `elixir/shell/project.ts` | `elixir-vanilla-build.yml` | `elixir-vanilla-obs-e2e.yml` — **push:main only ✗** |
| **Postgres image** | B (boot path) | `src/system/index.ts` | none directly | `conformance-parity` (path-filtered `src/system/**`,`docker/**` — ✗ on a tag-only diff), `k8s-e2e` (**nightly / `e2e-k8s` label ✗**) |
| Node/Python/Elixir/JDK base image | B (boot path) | `docker/` + backend `renderDockerfile` | the per-backend build job (path-filtered) | the obs-e2e / conformance leg — ✗ |

The pattern is unmistakable: **every compose-boot gate is path-filtered or
push:main-only**. That is the structural reason a narrow diff is the dangerous
diff, and why Step 4 forces the boot gate by hand.
