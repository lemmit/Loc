# Stack versions audit

Rolling reference for the modernization rollout. Captures **what we
pin** vs **current latest stable upstream** for every generated stack
and the playground itself. Refresh this doc when bumping anything in
Phase 1.X / Phase 2.

Snapshot date: **2026-06** (verify against npm/nuget/hex before
acting; these numbers age).

> **⚠️ PARTIALLY SUPERSEDED — verify against disk (refreshed 2026-06-21,
> code-verified against #1496).** Several columns below are stale; the
> on-disk emitter pins are the contract. Confirmed drift corrected in this
> refresh:
> - **There is no `stacks/v2`.** `ls stacks/` returns `v1, v3, sv1, vue1,
>   ng1`. The old "stack v2 (mantine@v9)" column was the React-19 stack;
>   that is **stack `v3`** today (React 19.2 + Router 7 + Zod 4 —
>   `stacks/v3/stack.json`). mantine@v9 maps to stack `v3`.
> - **.NET is on `net10.0`**, not deferred-on-net8. `renderCsproj`
>   (`src/generator/dotnet/emit/program.ts:632`) emits `<TargetFramework>net10.0`
>   with EF Core / Npgsql.EntityFrameworkCore `10.0.x` (program.ts:594–603).
> - **Spring Boot is `4.1.0`** (`src/generator/java/emit/program.ts`), on
>   the **Java 25** LTS toolchain (`JAVA_VERSION = "25"`). The Java 25 bump
>   pulls **Gradle 9** (`gradle:9-jdk25` build image, `GRADLE_IMAGE_MAJOR`),
>   **ASM 9.10.1** (class-file v69 for the `injectSmap` sourcemap task), and
>   **eclipse-temurin:25-jre** runtime; deps: jMolecules `2.0.1`, springdoc
>   `3.0.3`, nimbus-jose-jwt `10.9.1`, java-uuid-generator `5.2.0`. CI pins
>   Gradle 9.6.1 via `gradle/actions/setup-gradle` (no wrapper is emitted).
> - **The Hono backend now lives in `src/platform/hono/v5/`** (zod 4, the
>   default lane) with v4 pinnable via `platform: node@v4` — not
>   `src/generator/typescript/index.ts`. Hono v5 pins: hono `^4.12.0`,
>   zod `^4.0.0`, drizzle-orm `^0.45.0` (`src/platform/hono/v5/pins.ts`).
> - Backends added since the original snapshot: **Java** (Spring Boot) and
>   **Python** (FastAPI + SQLAlchemy 2) have no rows below; **Angular**
>   (`stacks/ng1`), **Svelte** (`stacks/sv1`), and **Vue** (`stacks/vue1`)
>   frontend stacks likewise post-date the React-only tables.
> The per-package "latest stable" columns below are point-in-time and not
> re-verified in this refresh.

> **Phase 0.5 note:** the cross-cutting deps below are no longer
> declared per-pack. They live in `stacks/<id>/stack-package-deps.hbs`
> (and `-devdeps.hbs`) and are pulled into each pack's
> `package-json.hbs` via `{{> stack-package-deps}}`. The columns
> below are still organised per-pack for readability, but a pack's
> column == the stack it declares (`mantine@v7` → stack `v1`,
> `mantine@v9` → stack `v3` — the React-19 stack; **there is no stack
> `v2` on disk**). See
> [`stack-versioning.md`](./stack-versioning.md).

## Design packs (pack-specific deps in `designs/<family>/<vN>/package-json.hbs`; framework deps in `stacks/<id>/`)

### Stack-supplied cross-cutting deps (one row per stack)

| package | stack v1 (mantine@v7, chakra@v2, mui@v5, shadcn@v3) | stack v3 (mantine@v9; React 19 + Router 7 + Zod 4) | latest stable |
| --- | --- | --- | --- |
| `react` / `react-dom` | ^18.3.0 | **^19.2.0** | 19.2 |
| `react-router-dom` | ^6.27.0 | `react-router` ^7.0.0 (renamed; RR 7 adopted in stack v3) | **7.x** |
| `@tanstack/react-query` | ^5.59.0 | ^5.59.0 | 5.100 |
| `react-hook-form` | ^7.53.0 | ^7.53.0 | 7.75 |
| `@hookform/resolvers` | ^3.9.0 | ^5.0.0 | **5.x** |
| `zod` | ^3.23.0 | ^4.0.0 | **4.x** |
| `dayjs` | ^1.11.0 | ^1.11.0 | 1.11 |
| `@types/react` / `-dom` (dev) | ^18.3.0 | **^19.2.0** | 19.2 |
| `@vitejs/plugin-react` (dev) | **^6.0.0** | **^6.0.0** | 6.x (Vite-8 / Rolldown era) |
| `typescript` (dev) | ^5.7.0 | ^5.7.0 | **6.x** |
| `vite` (dev) | **^8.0.0** | **^8.0.0** | 8.x |

Per-pack legacy table (kept for the per-dep latest-stable column):

### React-side cross-cutting deps (historically declared by every TSX pack; now stack-supplied)

| package | mantine@v7 | mantine@v9 | shadcn@v3 | mui@v5 | chakra@v2 | latest stable |
| --- | --- | --- | --- | --- | --- | --- |
| `react` / `react-dom` | ^18.3.0 | **^19.2.0** | ^18.3.0 | ^18.3.0 | ^18.3.0 | 19.2 |
| `react-router-dom` | ^6.27.0 | ^6.27.0 | ^6.27.0 | ^6.27.0 | ^6.27.0 | **7.x (renamed `react-router`)** |
| `@tanstack/react-query` | ^5.59.0 | ^5.59.0 | ^5.59.0 | ^5.59.0 | ^5.59.0 | 5.100 (same major) |
| `react-hook-form` | ^7.53.0 | ^7.53.0 | ^7.53.0 | ^7.53.0 | ^7.53.0 | 7.75 |
| `@hookform/resolvers` | ^3.9.0 | ^3.9.0 | ^3.9.0 | ^3.9.0 | ^3.9.0 | **5.x** |
| `zod` | ^3.23.0 | ^3.23.0 | ^3.23.0 | ^3.23.0 | ^3.23.0 | **4.x** |
| `dayjs` | ^1.11.0 | ^1.11.0 | ^1.11.0 | ^1.11.0 | ^1.11.0 | 1.11 |
| `vite` (dev) | ^8.0.0 | ^8.0.0 | ^8.0.0 | ^8.0.0 | ^8.0.0 | 8.x |
| `typescript` (dev) | ^5.7.0 | ^5.7.0 | ^5.7.0 | ^5.7.0 | ^5.7.0 | **6.x** |

### Pack-specific deps

| package | mantine@v7 | mantine@v9 | shadcn@v3 | mui@v5 | chakra@v2 | latest stable |
| --- | --- | --- | --- | --- | --- | --- |
| `@mantine/core` | ^7.13.0 | **^9.2.0** | — | — | — | 9.2 |
| `@mantine/hooks` + ecosystem | ^7.13.0 | **^9.2.0** | — | — | — | 9.2 |
| `@tabler/icons-react` | ^3.20.0 | ^3.20.0 | — | — | — | 3.20+ |
| `@mui/material` + `@mui/icons-material` | — | — | — | ^5.16.0 | — | **7.x** (skip v6) |
| `@chakra-ui/react` | — | — | — | — | ^2.10.0 | **3.x** |
| `@chakra-ui/icons` | — | — | — | — | _removed PR #146_ | (none — drop) |
| `@emotion/react` + `@emotion/styled` | — | — | — | ^11.13.0 | ^11.13.0 | 11.14 |
| `framer-motion` | — | — | — | — | ^11.0.0 | **12.x** |
| `tailwindcss` | — | — | ^3.4.0 | — | — | **4.x** |
| `autoprefixer` / `postcss` | — | — | ^10.4 / ^8.4 | — | — | (now via `@tailwindcss/postcss`) |
| `tailwindcss-animate` | — | — | ^1.0.7 | — | — | (drop on TW4 — built in) |
| `class-variance-authority` | — | — | ^0.7.0 | — | — | 0.7 |
| `clsx` | — | — | ^2.1.0 | — | — | 2.x |
| `tailwind-merge` | — | — | ^2.5.0 | — | — | 2.x |
| `lucide-react` | — | — | ^0.468.0 | — | — | **1.x** |
| `sonner` | — | — | ^1.7.0 | — | — | 1.x |
| `@radix-ui/react-*` (dialog, label, select, slot, switch, tabs, tooltip) | — | — | ^1.1 / ^2.1 | — | — | 1.x / 2.x (same major) |
| `notistack` | — | — | — | ^3.0.0 | — | 3.x |

## Backends

### Hono (TypeScript) — `src/platform/hono/v5/pins.ts` (default lane; v4 pinnable via `platform: node@v4`)

| package | pinned | latest | notes |
| --- | --- | --- | --- |
| `hono` | ^4.12.0 | 4.12 | same-major |
| `@hono/node-server` | ^1.19.0 | latest 1.x | safe bump |
| `@hono/zod-openapi` | ^1.0.0 | latest | v5 is on the 1.x line |
| `zod` | ^4.0.0 | 4.x | v5 default is zod 4 (v4 backend stays on zod 3) |
| `drizzle-orm` | ^0.45.0 | 0.45+ | pre-1.0 — every minor is breaking; treat with care |
| `drizzle-kit` | ^0.31.0 | latest | bump paired with drizzle-orm |
| `pg` / `@types/pg` | ^8.13 / ^8.11 | 8.x | safe |
| `typescript` (dev) | ^5.7 | 6.x | major bump |
| `tsx` / `tsup` / `vitest` (dev) | recent | latest 4.x / 8.x / 2.x | safe |

### Phoenix LiveView (Elixir / Ash) — `src/generator/elixir/shell/project.ts:~67–93`

**(Superseded 2026: the Ash foundation was removed; `platform: elixir` now generates plain Ecto/Phoenix only and `foundation: ash` is a validation error. The `ash` / `ash_postgres` / `ash_phoenix` dep rows below no longer ship.)**

| package | pinned | latest | notes |
| --- | --- | --- | --- |
| `phoenix` | `~> 1.8` | 1.8 | on 1.8 |
| `phoenix_live_view` | `~> 1.0` | 1.1 | minor bump available |
| `ash` | `~> 3.24` | 3.24 | within major |
| `ash_postgres` | `~> 2.0` | 2.x | within major |
| `ash_phoenix` | `~> 2.0` | 2.3 | within major |
| `bandit` | `~> 1.5` | latest | safe |
| `postgrex` | `~> 0.20` | 0.20.x | **DONE** — tightened from the old `">= 0.0.0"` loose-peer range |

### .NET — `src/generator/dotnet/emit/program.ts` (`renderCsproj`, `renderTestCsproj`)

TFM is `net10.0` (`DOTNET_TFM`). NuGet pins refreshed **2026-07-18** to newest
stable, each verified by a `dotnet build /warnaserror` (sdk:10.0) of the
representative generated projects — showcase (multi-context), dapper, byfeature
(extern/Scrutor), the auth-oidc verifier, the 13 single-context gate fixtures,
and the emitted xUnit Tests project.

| package | was | now | notes |
| --- | --- | --- | --- |
| `Microsoft.EntityFrameworkCore` (+ `.Design`/`.Tools`) | 10.0.9 | **10.0.10** | within major |
| `Microsoft.EntityFrameworkCore.Relational` | *(transitive)* | **10.0.10** | now pinned explicitly — `Design`/`Tools` are `PrivateAssets` so without this the Relational version floats to the transitive floor (10.0.4) in the sibling Tests project and MSB3277-conflicts with the base |
| `Npgsql.EntityFrameworkCore.PostgreSQL` | 10.0.2 | **10.0.3** | within major |
| `Npgsql` (dapper path) | 10.0.3 | 10.0.3 | already latest |
| `Dapper` | 2.1.35 | **2.1.79** | within major |
| `Ardalis.Specification` (+ EF Core) | 9.3.1 | 9.3.1 | already latest |
| `FluentValidation` (+ `.DependencyInjectionExtensions`) | 11.10.0 | **12.1.1** | major — builds clean; the emitted `AbstractValidator`/`ValidationBehavior` surface is unaffected |
| `Scrutor` | 5.0.2 | **7.0.0** | major — the `[ExternHandler]` assembly-scan API is unaffected |
| `Cronos` | 0.8.4 | **0.13.0** | `CronExpression.Parse`/`GetNextOccurrence` unchanged |
| `Microsoft.IdentityModel.JsonWebTokens` / `.Protocols.OpenIdConnect` | 8.0.1 | **8.19.2** | within major (OIDC verifier) |
| `Mediator.SourceGenerator` / `.Abstractions` | 2.1.7 | 2.1.7 | **held** — 3.0.2 requires migrating the emitted `IPipelineBehavior.Handle` signature AND handling `MSG0005` (v3 rejects the handler-less domain-event notifications Loom emits by design). A runtime-affecting migration, not a bump; do as its own PR. |
| `Swashbuckle.AspNetCore` | 6.9.0 | **8.1.4** | bumped to the newest version still on **Microsoft.OpenApi 1.x**. 9.0.0+ moves to Microsoft.OpenApi **2.0**, which rewrites the three emitted OpenAPI filters (`OpenApiSchema.Type`, `Nullable`, `OpenApiReference` → `IOpenApiSchema`/`JsonSchemaType`) and must be re-verified against the gated cross-backend OpenAPI parity — its own PR. |
| `Microsoft.NET.Test.Sdk` | 17.11.1 | **18.8.1** | test project (major) |
| `xunit` | 2.9.2 | **2.9.3** | test project |
| `xunit.runner.visualstudio` | 2.8.2 | **3.1.5** | test project (major) |
| `AwesomeAssertions` | 8.0.0 | **9.4.0** | test project (major) |

## Playground itself (`web/package.json`)

| package | pinned | latest | notes |
| --- | --- | --- | --- |
| `react` / `react-dom` | ^18.3 | 19.2 | bump when the playground UI itself is modernized (separate axis from packs) |
| `@mantine/core` / `@mantine/hooks` | ^7.13 | 9.2 | the playground's Monaco-host shell — separate from generator-emitted packs |
| `monaco-editor` | ^0.52 | latest | safe |
| `esbuild-wasm` | ^0.28 | latest | bump when esbuild stable bumps; ties into the in-browser bundler |
| `@playwright/test` (dev) | ^1.59 | latest | safe |
| `vite` (dev) | ^5.4 | 8.x | same major change as the packs |
| `typescript` (dev) | ~5.7 | 6.x | major bump |

## Root toolchain (`package.json`)

| package | pinned | latest | notes |
| --- | --- | --- | --- |
| `chalk` | ~5.3 | latest | safe |
| `chevrotain` | ~12.0.0 | 12.x | bumped with Langium 4 (its dep) |
| `commander` | ~12.1 | latest | safe |
| `handlebars` | ^4.7 | 4.x | template engine; unchanged |
| `ignore` | ^7.0 | latest | safe |
| `langium` | **~4.3** | 4.3 | bumped 3.3 → 4.3 — `computeExports`→`collectExportedSymbols`, `findDeclaration`→`findDeclarations`, hover returns raw string, `Reference.ref` now required, `copyAstNode` ref-builder gained `origReference` |
| `vscode-languageserver` | ~10.0 | 10.x | bumped with Langium 4 (subpaths `/node`, `/browser`) |
| `typescript` (dev) | **~6.0.0** | 6.x | now on TS 6 (the `@types/node` global-resolution follow-up landed) |
| `vitest` (dev) | ~4.1 | 4.x | already on 4.x |

## Notable loose ranges to fix opportunistically

| range | location | risk |
| --- | --- | --- |
| ~~`postgrex: ">= 0.0.0"`~~ | `src/generator/elixir/shell/project.ts` | **RESOLVED** — now pinned `~> 0.20` (project.ts:72). |
| `@chakra-ui/icons@>=2.0.0` (was) | resolved in PR #146 by dropping the dep | for any future Chakra icon need, vendor inline SVG instead of pulling a sibling package |

## Refresh procedure

When bumping any cell:

1. Update this table (snapshot date + the new values).
2. Update the relevant `package-json.hbs` / `index.ts` / `mix.exs` pin
   in the same PR.
3. Run the LOOM_REACT_BUILD shard for any affected pack (the
   per-shard `vite build` step gates the runtime layer).
4. If a backend dep bumped, run `LOOM_TS_BUILD=1` or
   `LOOM_PHOENIX_BUILD=1` accordingly.
