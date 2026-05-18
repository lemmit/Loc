# Stack versions audit

Rolling reference for the modernization rollout. Captures **what we
pin** vs **current latest stable upstream** for every generated stack
and the playground itself. Refresh this doc when bumping anything in
Phase 1.X / Phase 2.

Snapshot date: **2026-05** (verify against npm/nuget/hex before
acting; these numbers age).

> **Phase 0.5 note:** the cross-cutting deps below are no longer
> declared per-pack. They live in `stacks/<id>/stack-package-deps.hbs`
> (and `-devdeps.hbs`) and are pulled into each pack's
> `package-json.hbs` via `{{> stack-package-deps}}`. The columns
> below are still organised per-pack for readability, but a pack's
> column == the stack it declares (`mantine@v7` → stack `v1`,
> `mantine@v9` → stack `v2`, …). See
> [`stack-versioning.md`](./stack-versioning.md).

## Design packs (pack-specific deps in `designs/<family>/<vN>/package-json.hbs`; framework deps in `stacks/<id>/`)

### Stack-supplied cross-cutting deps (one row per stack)

| package | stack v1 (mantine@v7, chakra@v2, mui@v5, shadcn@v3) | stack v2 (mantine@v9) | latest stable |
| --- | --- | --- | --- |
| `react` / `react-dom` | ^18.3.0 | **^19.2.0** | 19.2 |
| `react-router-dom` | ^6.27.0 | ^6.27.0 (RR 7 is a follow-up stack axis) | **7.x** |
| `@tanstack/react-query` | ^5.59.0 | ^5.59.0 | 5.100 |
| `react-hook-form` | ^7.53.0 | ^7.53.0 | 7.75 |
| `@hookform/resolvers` | ^3.9.0 | ^3.9.0 | **5.x** |
| `zod` | ^3.23.0 | ^3.23.0 | **4.x** |
| `dayjs` | ^1.11.0 | ^1.11.0 | 1.11 |
| `@types/react` / `-dom` (dev) | ^18.3.0 | **^19.2.0** | 19.2 |
| `@vitejs/plugin-react` (dev) | ^4.3.0 | ^4.3.0 | latest 4.x |
| `typescript` (dev) | ^5.7.0 | ^5.7.0 | **6.x** |
| `vite` (dev) | ^5.4.0 | ^5.4.0 | **8.x** |

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
| `vite` (dev) | ^5.4.0 | ^5.4.0 | ^5.4.0 | ^5.4.0 | ^5.4.0 | **8.x** |
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

### Hono (TypeScript) — `src/generator/typescript/index.ts:204–216`

| package | pinned | latest | notes |
| --- | --- | --- | --- |
| `hono` | ^4.6.0 | 4.12 | same-major, safe bump |
| `@hono/node-server` | ^1.13.0 | latest 1.x | safe bump |
| `@hono/zod-openapi` | ^0.18.0 | latest | pre-1.0, check minors |
| `zod` | ^3.23.0 | 4.x | major bump (paired with the pack-side zod bump) |
| `drizzle-orm` | ^0.36.0 | **0.45+** | pre-1.0 — every minor is breaking; treat with care |
| `drizzle-kit` | ^0.28.0 | latest | bump paired with drizzle-orm |
| `pg` / `@types/pg` | ^8.13 / ^8.11 | 8.x | safe |
| `typescript` (dev) | ^5.7 | 6.x | major bump |
| `tsx` / `tsup` / `vitest` (dev) | recent | latest 4.x / 8.x / 2.x | safe |

### Phoenix LiveView (Elixir / Ash) — `src/generator/phoenix-live-view/index.ts:600`

| package | pinned | latest | notes |
| --- | --- | --- | --- |
| `phoenix` | `~> 1.7` | 1.8 | minor bump |
| `phoenix_live_view` | `~> 1.0` | 1.1 | minor bump |
| `ash` | `~> 3.0` | 3.24 | within major |
| `ash_phoenix` | `~> 2.0` | 2.3 | within major |
| `bandit` | `~> 1.5` | latest | safe |
| `postgrex` | **`">= 0.0.0"`** | 0.20.x | **TIGHTEN to `~> 0.20`** — current range is the same loose-peer trap that bit Chakra |

### .NET — `src/generator/dotnet/templates/program.tpl.ts:325–360`

| package | pinned | latest | notes |
| --- | --- | --- | --- |
| `Microsoft.EntityFrameworkCore` (suite) | 8.0.10 | 10.0.x | **defer until 2026-11** (.NET 8 is LTS); revisit when ecosystem catches up |
| `MediatR` (in code: `Mediator.SourceGenerator`) | 2.1.7 | 14.1 | defer |
| `FluentValidation` | 11.10.0 | 12.1 | defer |
| `Microsoft.NET.Test.Sdk` | 17.11.1 | latest | defer |

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
| `chevrotain` | ~11.0.3 | latest 11.x | safe (Langium dep, ride along) |
| `commander` | ~12.1 | latest | safe |
| `handlebars` | ^4.7 | 4.x | template engine; unchanged |
| `ignore` | ^7.0 | latest | safe |
| `langium` | ~3.3 | 4.x | major bump (separate effort — Langium 4 changes the services API) |
| `vscode-languageserver` | ~9.0 | latest 9.x | safe |
| `typescript` (dev) | ~5.7 | 6.x | major bump |
| `vitest` (dev) | ~2.1 | 3.x | major bump |

## Notable loose ranges to fix opportunistically

| range | location | risk |
| --- | --- | --- |
| `postgrex: ">= 0.0.0"` | `src/generator/phoenix-live-view/index.ts:600` | accepts literally anything; Hex resolves to whatever's newest at install time. Tighten to `~> 0.20`. |
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
