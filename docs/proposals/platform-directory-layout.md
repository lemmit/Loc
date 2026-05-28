# Proposal — Platform directory layout for multi-framework / multi-ORM backends

> Status: **Proposal**. Nothing in this document is implemented yet.
> Companion to
> [`storage-and-platform-config.md`](./storage-and-platform-config.md)
> — that proposal makes data layer + architectural style explicit on
> the deployable (`persistence: efcore | dapper`, `style: cqrs | layered`,
> etc.); this one shapes the **toolchain source tree** so those
> adapters have an obvious home.

## Why this proposal exists

The current layout was designed when each language had one framework
and one data-layer:

| Language | Framework | Data layer |
|---|---|---|
| TypeScript | Hono | drizzle |
| .NET | ASP.NET | EF Core |
| Elixir | Phoenix LiveView | Ash |
| React | (frontend) | n/a |

Three forces are about to break that one-to-one mapping:

1. **Backend-major bumps.** `hono@v4 → v5`, `net8 → net10`, `ash 3 → 4`.
   Hono has already been hoisted to `src/platform/hono/v4/` (the
   prototype of the versioned-package shape). `.NET` and Phoenix
   haven't — their dep pins are inline literals in `program.ts:425-479`
   and `phoenix-live-view/index.ts:536-579`.
2. **Multiple frameworks per language.** Express, Fastify, NestJS,
   Elysia are all plausible second TS frameworks.
3. **Multiple data layers per framework.** Per
   [`storage-and-platform-config.md`](./storage-and-platform-config.md):
   .NET wants `efcore | dapper`; TS wants `drizzle | typeorm | mikroorm`.

The current `src/generator/typescript/` is silently doing three
jobs at once — language emit (DTOs, render-expr/stmt, value objects),
ORM emit (drizzle repository builders), and was-formerly-framework
emit (the hono-coupled bits, now extracted to `src/platform/hono/v4/`).
As soon as Express+drizzle or Hono+TypeORM arrives, the conflation
becomes painful.

## Target structure

```
src/
  generator/                         # purely language-level — NEVER version-pinned
    typescript/                      # render-expr, render-stmt, DTOs, VOs, zod-refine ONLY
    dotnet/                          # render-expr/stmt, value-object emit, language-level helpers
    phoenix-live-view/               # render-expr/stmt, heex-walker, page rendering
    react/                           # body-walker, tsx-target
    _data/                           # cross-framework, data-layer-shaped emitters
      drizzle/                       # repository builders, migrations
      typeorm/                       # future
      mikroorm/                      # future
      efcore/                        # EF Core repositories + migrations
      dapper/                        # future
      ash/                           # Ash resources + migrations
    _packs/  _walker/  _obs/

  platform/                          # framework × version
    hono/
      v4/                            # pins.ts declares: framework=hono, data=drizzle
        index.ts                     #   PlatformSurface + loomManifest
        pins.ts
        emit.ts                      #   orchestrator
        routes-builder.ts            #   hono-major-coupled
        view-routes-builder.ts
        workflow-builder.ts
        auth-emit.ts
        observability-builder.ts
      v5/                            # future
    express/                         # future framework
      v5/                            # may declare data=drizzle → reuses _data/drizzle/
    fastify/                         # future framework
      v5/
    nestjs/                          # future framework
      v10/                           # may declare data=typeorm → reuses _data/typeorm/

    dotnet/
      v8/                            # ← src/platform/dotnet.ts moves here
        index.ts
        pins.ts                      # ← extracted from program.ts:425-479
        emit.ts                      #   orchestrator
        csproj-builder.ts            #   net-major-coupled
        workflow-builder.ts          # ← currently src/generator/dotnet/workflow-emit.ts
        auth-emit.ts                 # ← currently src/generator/dotnet/auth-emit.ts
        observability-builder.ts     # ← currently request-logging.ts + domain-log.ts
        cqrs-builder.ts              # ← currently cqrs-emit.ts (Mediator-coupled)
        validator-builder.ts         # ← currently validator-emit.ts (FluentValidation-coupled)
      v10/                           # incoming

    phoenix-live-view/
      v1/                            # ← src/platform/phoenix-live-view.ts moves here
        index.ts
        pins.ts                      # ← extracted from index.ts:536-579
        emit.ts
        mix-exs-builder.ts
        ash-resource-emit.ts         #   Ash-version-coupled DSL
        ash-migration-emit.ts
      v2/                            # incoming (ash 4.x)

    react/
      index.ts                       # PlatformSurface — version-agnostic
      v1/  v2/  v3/                  # ← former /stacks (each: stack.json + dep .hbs partials)

    fs-discovery.ts  manifest.ts  registry.ts  surface.ts

designs/                             # unchanged — orthogonal axis (UI library × version)
  mantine/v7,v9/  shadcn/v3,v4/  mui/v5,v7/  chakra/v2,v3/  ashPhoenix/

packages/                            # publish-shaped wrappers — one per backend version
  backend-hono-v4/
  backend-dotnet-v8/   backend-dotnet-v10/
  backend-phoenix-v1/  backend-phoenix-v2/
  core/  ui-test-driver/
```

## The classification rule

The dividing line between `src/generator/<lang>/`, `src/generator/_data/<orm>/`,
and `src/platform/<family>/v<N>/` is **type of coupling**, not which
backend the file happened to be added to first.

| Type of coupling | Where it belongs | Examples |
|---|---|---|
| **Language shapes** — stable across frameworks of that language | `src/generator/<lang>/` | DTOs, value objects, IDs, enums, render-expr/stmt, zod refinement, parameter list shape |
| **Data-layer artifacts** — ORM/SQL-shaped, cross-framework | `src/generator/_data/<orm>/` | Repository builders, migrations, query/criterion lowering, association/join emission |
| **Framework's request lifecycle** — moves with the framework major | `src/platform/<family>/v<N>/` | Routes, middleware, handlers, validation pipeline, auth integration, observability hooks, workflow drivers, server bootstrap, project-config (csproj / package.json / mix.exs) |
| **Dep pins** — moves with the framework major | `src/platform/<family>/v<N>/pins.ts` | Version constants for every transitive that the emit assumes the major-of |

Two consequences of this rule:

1. **Migrations move with the data layer, not the framework.** Today
   drizzle migrations live at `src/generator/typescript/emit/migrations.ts`
   (a hono-era choice). EF migrations live at
   `src/generator/dotnet/emit/migrations.ts`. Ash migrations at
   `src/generator/phoenix-live-view/migrations-emit.ts`. All three
   move to `src/generator/_data/{drizzle,efcore,ash}/migrations.ts`
   under the new layout. This makes Hono+drizzle and Express+drizzle
   share one drizzle migration emitter without inventing a fourth
   directory.
2. **Workflows / auth / observability move with the framework.** They
   integrate with the request lifecycle (route plumbing, mediator
   pipeline, middleware ordering), so they belong inside the
   per-`v<N>/` directory regardless of which language they're written
   in. The current `src/generator/dotnet/{workflow-emit,auth-emit,
   request-logging,domain-log}.ts` are misplaced under this rule —
   they're framework-coupled, not language-coupled.

## What each `src/platform/<family>/v<N>/index.ts` composes

Three axes are wired together at the platform-version level:

```ts
const surface: PlatformSurface = {
  name: "hono",
  emitProject({ contexts, deployable, ... }) {
    const language = "typescript";                 // → src/generator/typescript/
    const data = deployable.config.persistence;    // "drizzle" | "typeorm" | …
    const framework = "hono";                      // this directory

    // Compose: language emit (DTOs, render-expr, VOs)
    //        + data-layer emit (repos, migrations)
    //        + framework emit (routes, middleware, observability)
    //        + this version's pins
    return orchestrate(language, data, framework, BACKEND_PINS, ...);
  },
  composeService(...) { ... },
};
```

The `deployable.config.persistence` value is the
[`storage-and-platform-config.md`](./storage-and-platform-config.md)
hook — that proposal makes the data layer explicit on the deployable,
this proposal gives the resulting adapter a directory to live in.

## Migration sketch

The refactor is mechanical but touches a lot of imports. Suggested
order (each step is a single PR; the tree compiles after each):

1. **`stacks/` → `src/platform/react/v{1,2,3}/`.** Pure file move +
   `_packs/loader.ts` path constant change. Zero behaviour change.
2. **Hoist .NET to `src/platform/dotnet/v8/`.** Mirrors hono's
   existing hoist. Move `src/platform/dotnet.ts` → `v8/index.ts`,
   extract `pins.ts` from `program.ts`, move
   `{workflow,auth,cqrs,validator}-emit.ts` and
   `{request-logging,domain-log}.ts` from `src/generator/dotnet/`
   into `v8/`. The remaining `src/generator/dotnet/` is the genuinely
   language-level slice.
3. **Hoist Phoenix to `src/platform/phoenix-live-view/v1/`.** Same
   shape as step 2.
4. **Introduce `src/generator/_data/`.** Move
   `src/generator/typescript/repository-*.ts` →
   `src/generator/_data/drizzle/`; ditto `migrations.ts`. Move EF
   Core repository + migrations bits out of `src/generator/dotnet/`
   into `src/generator/_data/efcore/`. Move Ash equivalents into
   `src/generator/_data/ash/`. Each backend's `emit.ts` updates its
   imports.
5. **Wire `deployable.config.persistence`.** Once the
   `storage-and-platform-config.md` proposal lands its `persistence:`
   field, the platform-version's `emit.ts` reads it and dispatches
   to the appropriate `_data/<orm>/` adapter. Stub
   `AdapterNotImplementedError` for unimplemented choices
   (`persistence: dapper` against `dotnet@v8`, etc.) — matches the
   storage proposal's micro-plan style.
6. **Add the second TS framework** (Express? Fastify?). Lands as a
   new `src/platform/<family>/v<N>/` directory; reuses
   `src/generator/typescript/` and `src/generator/_data/drizzle/`
   without duplication.

Steps 1–4 are pure refactors; the byte-output of every generator
test should be identical (or differ only in the
deterministic-rename of an emitted comment). Step 5 is the first
behaviour change. Step 6 is the first net new backend.

## Why React's `v<N>/` doesn't follow the same shape

React's `PlatformSurface` (`src/platform/react.ts`) is
version-agnostic; only the dep pins + bundler policy change per
stack. So:

- Hono's `index.ts` lives **inside** `v4/` (the surface is
  version-coupled).
- React's `index.ts` lives **at** `src/platform/react/`, and `v<N>/`
  holds only the version-pinned templates.

This asymmetry is intentional — symmetry-for-symmetry's-sake would
force every React PR to touch a `v<N>/index.ts` re-export.

Two consequences:

- The former `stacks/` segment is dropped. The `v<N>/` directory
  *is* the stack. (If React ever grows version-coupled emit code —
  say, a router-7 vs router-8 builder that pack templates can't
  express — it lands at `src/platform/react/v3/router-builder.ts`
  next to `stack.json`, alongside the dep pins. No second parallel
  tree.)
- Design packs (`designs/<pack>/v<N>/`) stay where they are. They're
  a genuinely orthogonal axis (UI library × UI library version), not
  a sub-axis of the React stack.

## Relationship to neighbouring proposals

- **[`storage-and-platform-config.md`](./storage-and-platform-config.md).**
  That proposal makes `persistence: efcore | dapper`,
  `style: cqrs | layered`, etc. first-class on the deployable. Its
  §"Pluggable persistence / style / layout adapters per platform"
  section needs a directory to live in — this proposal supplies it
  (`src/generator/_data/<orm>/`). The two proposals can be staged
  independently: the storage proposal's micro-plan lands the
  adapter *seam* (the interface and the
  `AdapterNotImplementedError` stub), this proposal lands the
  adapter *home* (where implementations go). Either order works.
- **[`src-ir-phase-reveal.md`](./src-ir-phase-reveal.md).** That
  one reshaped `src/ir/` to make the pipeline phases visible from
  the file tree. This proposal does the analogous thing for
  `src/platform/` — make the framework × version × data-layer
  axes visible. Same family of refactor.
- **Out-of-tree backend packages.** `packages/backend-hono-v4/`
  today is a thin re-export of `src/platform/hono/v4/`. After this
  proposal lands, every `src/platform/<family>/v<N>/` has a
  matching `packages/backend-<family>-v<N>/` wrapper. The hoisting
  cost per backend version is a single re-export file; no
  duplication of source.

## Decisions to confirm

| ID | Decision | Recommended | Notes |
|---|---|---|---|
| L1 | `_data/` or `_orm/` as the directory name? | `_data/` | Some data layers (e.g. Dapper) aren't ORMs strictly speaking; `_data/` covers ORMs and micro-ORMs and raw-SQL adapters alike. |
| L2 | Does React get an `index.ts` at `src/platform/react/` (version-agnostic) or inside `v<N>/` (mirrored with hono)? | At `src/platform/react/` | The surface genuinely is version-agnostic; forcing symmetry hurts. |
| L3 | Drop the `stacks/` directory segment when hoisting under `src/platform/react/`? | Yes | The `v<N>/` directory *is* the stack; the extra segment carries no information. |
| L4 | Should `src/generator/typescript/` keep its current name once it's purely language-level (no framework, no ORM)? | Yes | The name is accurate after the split. Renaming to `src/generator/_lang/typescript/` would be busywork. |
| L5 | Migration order — refactor before or after the second TS framework lands? | Before | Step 6 ("add Express") is much easier with the seam already cut. The refactor steps are mechanical and gated by the existing generator tests. |
| L6 | Should the `packages/backend-<family>-v<N>/` wrappers exist for every backend version, or only the ones intended to publish? | Only the ones intended to publish | The in-tree `src/platform/<family>/v<N>/` is the source of truth; the wrapper is the publish shape. Don't create wrappers speculatively. |

## Open questions

- **Naming `_data/efcore/` vs `_data/ef-core/`.** Match upstream
  casing? `Microsoft.EntityFrameworkCore` packs it as `efcore` in
  most contexts. Recommend `efcore`.
- **Does Phoenix get a `_data/ash/` extraction?** Ash is so deeply
  coupled to the Phoenix backend (resources *are* the domain model
  in Ash idiom) that the cross-framework benefit is thin. Recommend
  leaving Ash inline under `src/platform/phoenix-live-view/v<N>/`
  until a second Elixir framework appears (Sugar? Membrane?).
- **Composite-version pinning for the publish shape.** A
  `packages/backend-hono-v4/` package today pins `hono@^4.12`,
  `drizzle@^0.45`, etc. as one bundle. If a deployable picks
  `persistence: typeorm`, the wrapper's published `package.json`
  becomes a lie. Three options: (a) ship one wrapper per
  framework × data-layer combo, (b) make wrappers' dep blocks
  generator-driven from the chosen `pins.ts` + `_data/<orm>/`
  pins, (c) keep wrappers framework-only and let the generator
  emit the data-layer deps into the consumer's `package.json`.
  Recommend (c) — wrappers stay simple, consumer's package gets
  the union.
