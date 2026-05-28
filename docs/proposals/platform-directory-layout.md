# Proposal — Platform directory layout: the framework-version axis

> Status: **Proposal**. Nothing in this document is implemented yet.
>
> **Companion to (and partly superseded by)**
> [`storage-and-platform-config-micro-plan.md`](./storage-and-platform-config-micro-plan.md).
> That micro-plan owns the **adapter-taxonomy axes** —
> `persistence/<adapter>/`, `styles/<adapter>/`,
> `layouts/<adapter>/` per platform, plus the shared
> `src/generator/_adapters/` contracts. This proposal is the
> **framework-version axis** that the micro-plan doesn't address:
> where `hono@v4` vs `hono@v5`, `net8` vs `net10`, `ash 3.x` vs
> `ash 4.x` live, how pins are version-owned, and how React's
> `stacks/` consolidate. Read the micro-plan first; this proposal
> only makes sense layered on top.

## What this proposal does and doesn't claim

**Owned by the micro-plan** (not re-proposed here):

- The three adapter axes per platform: `persistence`, `style`,
  `layout` — and their stub/real registration in
  `src/platform/registry.ts`.
- The shared `src/generator/_adapters/{persistence,style,layout}-surface.ts`
  contracts and the `AdapterNotImplementedError` stub helper.
- The `platform: hono` → `platform: node { framework: hono }` rename
  that makes "node" the language-level platform and `hono` / `express` /
  `fastify` / `nestjs` framework choices within it.
- F5/F6/F7's per-platform emitter reshape into
  `src/generator/<platform>/{persistence,styles,layouts}/<adapter>/`.

**Open after the micro-plan lands** (what this proposal addresses):

1. **Where do framework-version-coupled emitters and pins live?**
   `hono@v4 → v5`, `net8 → net10`, `ash 3 → 4` will all happen.
   The micro-plan registers a single `framework: hono` but doesn't
   place a v-axis directory.
2. **Does the existing `src/platform/hono/v4/` hoist survive the
   micro-plan, or get reversed?** Today hono's framework-coupled
   emitters live in `src/platform/hono/v4/{routes,view-routes,workflow,
   auth,observability}-builder.ts` and pins live in
   `src/platform/hono/v4/pins.ts`. The micro-plan's F6 reshapes
   `src/generator/node/` into the adapter layout but is silent on
   whether it absorbs the `src/platform/hono/v4/` content or leaves
   it hoisted. The two layouts can't coexist long term.
3. **Where do React `stacks/` live?** Currently at repo root; not
   touched by the micro-plan; orthogonal to its adapter taxonomy.
4. **Where do `packages/backend-<family>-v<N>/` publish-shaped
   wrappers stand?** `packages/backend-hono-v4/` exists today as a
   thin re-export of `src/platform/hono/v4/`. If the hoist reverses,
   this wrapper needs a new source.

## Two layout options, surfaced for decision

### Option A — Reverse the hono hoist (micro-plan-consistent)

Framework-coupled emitters move **down** into
`src/generator/node/frameworks/<framework>/v<N>/`. The
`src/platform/<plat>` directory holds only the version-agnostic
`PlatformSurface` + registry record.

```
src/generator/node/
  emit/                            # language + framework-agnostic (DTOs, VOs, events)
  render-expr.ts  render-stmt.ts
  persistence/
    drizzle/                       # cross-framework, shared by hono / express / fastify
    typeorm/                       # cross-framework
    mikroorm/                      # future
  styles/
    cqrs/                          # cross-framework
    layered/                       # cross-framework
  layouts/
    by-layer.ts  by-feature.ts
  frameworks/
    hono/
      v4/                          # ← src/platform/hono/v4/*.ts moves here
        pins.ts
        routes-builder.ts
        view-routes-builder.ts
        workflow-builder.ts
        auth-emit.ts
        observability-builder.ts
      v5/                          # future
    express/
      v5/
    fastify/
      v5/
    nestjs/
      v10/

src/platform/
  node.ts                          # PlatformSurface (single, version-agnostic)
  dotnet.ts                        # ditto
  phoenix.ts                       # ditto
  react.ts                         # ditto
  registry.ts  surface.ts  manifest.ts  fs-discovery.ts

src/generator/dotnet/frameworks/aspnet/{v8,v10}/   # parallel shape for .NET
src/generator/phoenix/frameworks/phoenix-live-view/{v1,v2}/
src/generator/react/stacks/{v1,v2,v3}/
```

**Argument for A:** Consistent with the micro-plan's
`src/generator/<platform>/...` shape. All adapter axes (persistence,
style, layout, **framework**) live under one root.
`src/platform/` shrinks to just the `PlatformSurface` registrar.

**Argument against A:** Reverses the existing hono hoist — every
file under `src/platform/hono/v4/` moves. Many imports change.
The publish-shaped wrapper at `packages/backend-hono-v4/` needs to
point at a different source path.

### Option B — Extend the hono hoist (current-shape-consistent)

Framework-coupled emitters stay **up** in
`src/platform/<framework>/v<N>/`, and dotnet + phoenix get hoisted
to match. The micro-plan's per-platform persistence/style/layout
adapter trees still live under `src/generator/<platform>/`, but
the framework-version-coupled bits live up at `src/platform/`.

```
src/generator/                     # purely language + ORM/style/layout adapters
  typescript/                      # render-expr, render-stmt, DTOs, VOs, zod-refine
  dotnet/
  phoenix/
  react/
  _adapters/                       # micro-plan's contracts
  node/                            # micro-plan's reshape
    persistence/  styles/  layouts/
  dotnet/persistence/  dotnet/styles/  dotnet/layouts/   # micro-plan's reshape
  phoenix/persistence/  phoenix/styles/  phoenix/layouts/

src/platform/
  hono/v4/                         # status quo
    index.ts                       #   PlatformSurface + loomManifest
    pins.ts                        #   hono@^4.12 + framework-coupled lib pins
    emit.ts                        #   orchestrator (picks adapter via deployable.config)
    routes-builder.ts              #   hono-major-coupled
    view-routes-builder.ts
    workflow-builder.ts
    auth-emit.ts
    observability-builder.ts
  hono/v5/                         # future
  express/v5/                      # new TS framework
  fastify/v5/
  nestjs/v10/

  dotnet/v8/                       # ← src/platform/dotnet.ts hoists here
    index.ts  pins.ts  emit.ts
    csproj-builder.ts
    workflow-builder.ts            # ← from src/generator/dotnet/workflow-emit.ts
    auth-emit.ts                   # ← from src/generator/dotnet/auth-emit.ts
    observability-builder.ts       # ← from request-logging.ts + domain-log.ts
    cqrs-builder.ts                # ← Mediator-coupled (style: cqrs is registered, this is the emit detail)
    validator-builder.ts           # ← FluentValidation-coupled
  dotnet/v10/                      # incoming

  phoenix-live-view/v1/            # ← src/platform/phoenix-live-view.ts hoists here
    index.ts  pins.ts  emit.ts
    mix-exs-builder.ts
    ash-resource-emit.ts           #   Ash 3.x-coupled DSL — supersedes a v2 file once Ash 4 lands
    ash-migration-emit.ts
  phoenix-live-view/v2/            # ash 4.x

  react/
    index.ts                       # PlatformSurface — version-agnostic
    v1/  v2/  v3/                  # ← former /stacks (each: stack.json + dep .hbs partials)

  registry.ts  surface.ts  manifest.ts  fs-discovery.ts

packages/                          # publish-shaped wrappers
  backend-hono-v4/                 # status quo
  backend-dotnet-v8/   backend-dotnet-v10/
  backend-phoenix-v1/  backend-phoenix-v2/
  core/  ui-test-driver/
```

**Argument for B:** Doesn't reverse existing hono work. Mirrors
hono's prototype across the other backends. Keeps version-coupled
concerns visually together (pins.ts next to routes-builder.ts).
Publish-shaped wrappers point at an obvious source path.

**Argument against B:** Two roots for backend code
(`src/platform/<family>/v<N>/` for framework-coupled +
`src/generator/<platform>/{persistence,styles,layouts}/` for
adapters). The micro-plan's `src/platform/registry.ts` adapter
menus reference adapters in the `src/generator/` tree, but the
emit orchestrator lives in `src/platform/<family>/v<N>/emit.ts` —
imports cross the boundary.

### Recommendation

**Option A is the cleaner end state; Option B is the cheaper interim.**
The decision turns on whether reversing the hono hoist is worth the
churn cost.

I lean toward **A** for two reasons:

1. The micro-plan already establishes `src/generator/<platform>/` as
   the adapter root. Putting framework-version directories under
   the same root keeps "one root per platform" rather than splitting
   into two. Engineers looking at "how is platform X built" find
   everything in one tree.
2. The publish-shaped wrappers at `packages/backend-<family>-v<N>/`
   are thin re-export shells. Changing the source path in one
   `export ... from "../../src/generator/node/frameworks/hono/v4/index.js"`
   line is a non-event.

But A's churn cost is real (~10-15 files moved per existing hoisted
backend, plus every import that referenced
`src/platform/hono/v4/...`). If the project wants to ship
multi-framework support fast and refactor later, **B is the
lower-disturbance interim** and a future PR can collapse the two
roots once it's clear they're stable.

The decision should be made jointly with the micro-plan author, ideally
before F6 lands — because F6 reshapes `src/generator/node/` and the
choice of A vs B determines whether F6 also absorbs
`src/platform/hono/v4/`.

## React `stacks/` consolidation (orthogonal to the A/B choice)

Independent of the framework-version axis above, the React `stacks/`
directory at repo root should move under `src/platform/react/`:

```
src/platform/react/
  index.ts                       # PlatformSurface — version-agnostic
  v1/  v2/  v3/                  # ← former /stacks
```

The former `stacks/` segment is dropped — the `v<N>/` directory **is**
the stack. React's `index.ts` lives at `src/platform/react/` (not
inside any `v<N>/`) because the surface is genuinely version-agnostic;
only the dep pins and bundler policy change per stack. Future
React-version-coupled emit code (e.g., a router-7 vs router-8 builder
that pack templates can't express) lands at
`src/platform/react/v3/router-builder.ts` next to `stack.json`.

Design packs (`designs/<pack>/v<N>/`) stay where they are — they're a
genuinely orthogonal axis (UI library × UI library version), not a
sub-axis of the React stack.

This move is mechanical (single PR; pure file move + path constant
change in `_packs/loader.ts`). It can land before, during, or after
the micro-plan without coordination.

## The version-pinning rule (independent of A/B)

Whichever directory layout wins, the rule for what goes in a
`v<N>/` directory is the same:

| Type of coupling | Where it belongs |
|---|---|
| **Stable across framework majors** — render-expr/stmt, DTO shape, value object emission, ID classes, zod refinement | `src/generator/<lang>/` — outside any `v<N>/` |
| **Framework-major-coupled** — routes, middleware, server bootstrap, validation pipeline, auth integration, observability hooks, workflow drivers, project-config (csproj / package.json / mix.exs) | `v<N>/` |
| **Dep pins** — every transitive whose major the emit depends on | `v<N>/pins.ts` |
| **Data-layer adapters** — repository builders, migrations, query/criterion lowering | Per the micro-plan, in `src/generator/<platform>/persistence/<adapter>/` |
| **Style adapters** — handler dispatch, DI wiring | Per the micro-plan, in `src/generator/<platform>/styles/<adapter>/` |
| **Layout adapters** — file-tree shape | Per the micro-plan, in `src/generator/<platform>/layouts/<adapter>/` |

This rule is orthogonal to A/B — only the *parent path* of `v<N>/`
changes. Adapter axes (persistence/style/layout) are not duplicated
per framework version unless the data-layer pin itself changes
(drizzle@0.45 vs drizzle@0.50 is in the framework's `v<N>/pins.ts`;
the drizzle repository builder itself is shared).

## Migration sequence (assuming the micro-plan lands first)

Once the micro-plan's F1–F8 are merged, the version-axis work is
small:

1. **React stacks consolidation** (independent of A/B; 1 PR).
   `stacks/v{1,2,3}/` → `src/platform/react/v{1,2,3}/`. Pure file
   move + `_packs/loader.ts` path update.
2. **Decide A vs B** (decision PR or design doc update; no code).
3. **Hoist dotnet to `<chosen-root>/dotnet/v8/`** (1 PR).
   Pin extraction + index hoist; emit code stays put.
4. **Hoist phoenix to `<chosen-root>/phoenix-live-view/v1/`** (1 PR).
   Same shape as step 3.
5. **If Option A: collapse hono's existing hoist** (1 PR).
   Move `src/platform/hono/v4/*.ts` →
   `src/generator/node/frameworks/hono/v4/*.ts`; update
   `packages/backend-hono-v4/index.ts` re-export path; update every
   importer. Mechanical but wide.
6. **If Option B: leave hono in place** (no PR).
7. **Add the second TS framework** (Express? Fastify? new PR per).
   Each lands as a new directory at the chosen root; reuses
   `src/generator/<platform>/{persistence,styles,layouts}/<adapter>/`
   without duplication.

Steps 1, 3, 4 are pure refactors with byte-identical output.
Step 5 (if A) is a wide-but-mechanical rename. Step 7 is the first
genuine new functionality.

## Decisions to confirm

| ID | Decision | Recommended | Notes |
|---|---|---|---|
| V1 | Option A (reverse hono hoist) vs Option B (extend it to dotnet/phoenix)? | A | Cleaner end state; the churn cost is real but bounded. Decision must be made jointly with the micro-plan author before F6 lands. |
| V2 | If Option A: keep `src/platform/` at all? | Yes, but trim | It still holds `PlatformSurface` records, the registry, the manifest, and `fs-discovery.ts`. Just no per-family/per-version emitter code. |
| V3 | Drop the `stacks/` directory segment when hoisting under `src/platform/react/`? | Yes | The `v<N>/` directory *is* the stack. Carries no information once co-located. |
| V4 | Migrate React stacks before or after the micro-plan? | Before or independent | Orthogonal to the micro-plan; can land any time. |
| V5 | `packages/backend-<family>-v<N>/` wrappers — one per backend version, or only the ones intended to publish? | Only the ones intended to publish | The in-tree source is authoritative; wrappers exist only for publishing. Don't create speculatively. |
| V6 | Naming the per-`v<N>/` directory — `v4/` or `4/` or `4.x/`? | `v<N>/` | Status quo; `v4` reads as "the v4 family" which is the right granularity. Minor releases don't bump the directory. |

## Open questions

- **Composite-version pinning for the publish shape.** A
  `packages/backend-hono-v4/` package today pins `hono@^4.12`,
  `drizzle@^0.45`, etc. as one bundle. After the micro-plan, if a
  deployable picks `persistence: typeorm`, the wrapper's published
  `package.json` becomes a lie. Three options: (a) ship one wrapper
  per framework × data-layer combo, (b) make wrappers' dep blocks
  generator-driven from the chosen `pins.ts` +
  `_adapters/<persistence>/<adapter>/`-declared deps, (c) keep
  wrappers framework-only and let the generator emit the
  data-layer deps into the consumer's `package.json`. Recommend (c).
- **Does Phoenix's Ash get extracted to a shared
  `src/generator/_adapters/persistence/ash/`?** Probably not — Ash
  is so deeply coupled to the Phoenix backend (Ash resources *are*
  the domain model in Ash idiom) that the cross-framework benefit
  is thin. Recommend leaving Ash inline under
  `src/generator/phoenix/persistence/ashPostgres/` per the
  micro-plan's F7.
- **When `nestjs@v10` lands and uses TypeORM, does TypeORM live in
  `src/generator/node/persistence/typeorm/` or in
  `src/generator/node/frameworks/nestjs/v10/persistence/`?** The
  first if TypeORM is consumed by multiple TS frameworks; the
  second if only by NestJS. Default to the first; demote later if
  it turns out only NestJS uses it.

## Relationship to neighbouring proposals

- **[`storage-and-platform-config-micro-plan.md`](./storage-and-platform-config-micro-plan.md)** —
  the authority on the adapter taxonomy. This proposal is layered on
  top of theirs; reading order is theirs first, mine second.
- **[`storage-and-platform-config.md`](./storage-and-platform-config.md)** —
  the RFC that motivates the adapter taxonomy. Background for both
  this proposal and the micro-plan.
- **[`src-ir-phase-reveal.md`](./src-ir-phase-reveal.md)** — same
  family of refactor (make a hidden axis visible from the file
  tree). This proposal does that for the framework-version axis;
  the micro-plan does it for the persistence/style/layout axes.
- **Out-of-tree backend packages** — the
  `packages/backend-<family>-v<N>/` shape is unaffected by the A/B
  choice. Wrappers are thin re-exports either way.
