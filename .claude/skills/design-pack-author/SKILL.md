---
name: design-pack-author
description: >-
  Scaffold a Loom design-system pack — a new pack family, a new pack version, or
  a port of an existing pack to another frontend framework — to COMPLETENESS, so
  it satisfies the required-emit gate and never crashes codegen on a primitive it
  forgot to render. Use this whenever the task is to add or extend a `.ddd`
  frontend design pack: "add a <library> design pack" (PrimeNG, Spartan/NG,
  Flowbite, Vuetify, Carbon, Bootstrap, whatever), "new pack version" / "fork
  mantine v9 → v10", "port pack X to Vue/Svelte/Angular/HEEx", "wire up a custom
  design slot", or picking up `docs/design-packs.md`. Reach for it even when the
  user just says "make Loom render with <UI library>", "the new pack is missing
  a template", or "my pack tsc-fails on generate". It walks the manifest + stack
  + required-emit set + walker-primitive coverage + registration + the matching
  `generated-{react,vue,svelte,angular}-build` gate so the pack lands complete,
  not half-built on one example. NOT for adding a UI page *primitive* to the DSL
  (that's the body walker / language-feature-developer) — this is for the pack
  that *renders* the existing primitives.
---

# Loom design-pack author

A **design pack** is the pluggable unit of UI in Loom's frontend generators.
When a `.ddd` deployable says `design: <name>`, the frontend generator
(`src/generator/{react,vue,svelte,angular}/` or `elixir/` for HEEx) loads that
pack and renders every page, form, table, and cell through its `.hbs` templates.
A pack is a directory under `designs/<family>/<version>/` holding a `pack.json`
manifest plus one `.hbs` file per logical name the generator dispatches.

The failure mode this skill exists to prevent: a pack that **validates but
crashes codegen**. The page DSL's primitives (`Section`, `Sticky`, `Modal`, …)
are accepted by the validator on *any* target — so a pack that omits the
template for one of them passes `loadPack` and the editor, then throws
`pack.render("primitive-section", …)` deep in the walker the first time a real
`.ddd` uses it. This is exactly the #1478 `Section`/`Sticky` regression: the
primitives were dispatched with no presence guard, so the gap was invisible
until generation. The fix is the **required-emit gate** in
`src/generator/_packs/required-primitives.ts` — and the discipline of this skill
is: a pack isn't done until that gate is green *and* every `WALKER_PRIMITIVES`
entry the pack's format owns has a real template behind it.

`docs/design-packs.md` is the long-form contract. This skill is the operational
workflow. Read both; the doc explains *why each field exists*, this explains
*what to do in what order and how to know you're done*.

## Before anything: orient on fresh `main`

Loom's `main` moves fast (parallel agents land packs continuously — primeng and
spartanNg landed within days of each other). Sync first:
`git fetch origin main && git reset --hard origin/main`, and confirm
`npm install` has run (the SessionStart hook does this; `node_modules/.bin/biome`
and `src/language/generated/` should exist). Then **check the pack isn't already
there**: `ls designs/` and grep `src/util/builtin-formats.ts` for the family.
A pack you "remember" not existing may have shipped under you.

## Step 1 — Pin the target framework family

A pack's `format` decides almost everything downstream — which generator drives
it, which required-set it must satisfy, which build gate covers it, what shell
templates it needs. Pin it first:

| Framework | `format` | Stack | Build gate | Closest analog to copy |
|---|---|---|---|---|
| React (JSX) | `tsx` | `v3` (React 19) or `v1` (React 18) | `generated-react-build` | `designs/mantine/v9` (npm model) or `designs/shadcn/v4` (source-copy) |
| Vue 3 (SFC) | `vue` | `vue1` | `generated-vue-build` | `designs/vuetify/v3` (npm) or `designs/shadcnVue/v1` (source-copy) |
| Svelte 5 / SvelteKit | `svelte` | `sv1` | `generated-svelte-build` | `designs/shadcnSvelte/v1` or `designs/flowbite/v1` |
| Angular (standalone) | `angular` | `ng1` | `generated-angular-build` | `designs/angularMaterial/v1`, `primeng/v1`, `spartanNg/v1` |
| Phoenix LiveView (HEEx) | `heex` | (none) | `elixir-vanilla-build` | `designs/ashPhoenix/v3` (the only HEEx pack) |

The **distribution model** is a second axis orthogonal to framework: *npm-package*
(components imported from a dependency, e.g. mantine, vuetify, angularMaterial) vs
*source-copy* (components vendored into the generated project via `shellGlobs`,
e.g. shadcn, shadcnVue, shadcnSvelte). Pick the analog that matches *both* the
framework and the model you're targeting — a shadcn-style library ports cleanest
from a shadcn-family pack because the `imports`-to-`@/components/ui/*` + `shellGlobs`
wiring is already in place.

`references/pack-anatomy.md` has the per-family file layout, the exact analog
paths, and the manifest + registration wiring. Read the section for your target.

## Step 2 — Copy the closest analog, then rename

Forking an existing pack is the recipe — the upstream library's own docs do the
real design thinking; you're swapping component names and imports.

```bash
cp -r designs/<analog-family>/<version> designs/<new-family>/v1
# Bump the manifest's name + version to match the directory.
```

Edit `designs/<new-family>/v1/pack.json`: set `name`, `version` (must match the
directory name — **the loader cross-checks and throws on mismatch**, catching
stale copy-paste forks), keep `format`, and keep or pick the `stack` (Step 4).
For a **new version of an existing family** (e.g. mantine v9 → v10), follow
`docs/design-packs.md` §12 instead — audit the upstream migration guide, grep the
old pack's `.hbs` for renamed props/components, fork the directory, apply the
deltas. The mechanics below still apply.

## Step 3 — Fill the required-emit set (this is what "complete" means)

The single source of truth for what a pack MUST emit is
`REQUIRED_PRIMITIVES[format]` in `src/generator/_packs/required-primitives.ts`.
At load time, `compilePack` (`src/generator/_packs/loader.ts`) computes
`flattenRequired(REQUIRED_PRIMITIVES[format])` and throws — naming every missing
template — if any name isn't satisfied by `manifest.emits` or an inherited shared
source. So you don't have to guess the set: **try to load the pack and read the
error**. The fastest loop:

```bash
node -e '
  const { loadPack, resolvePackDir } = require("./out/generator/_packs/loader-fs.js");
  loadPack(resolvePackDir("<new-family>@v1"));
  console.log("OK — required set satisfied");
'
# (needs `npm run build` first so out/ exists; or assert via the gate test below.)
```

The error lists exactly which logical names are missing. Add each to
`pack.json`'s `emits` map, create the `.hbs` file, repeat until it loads clean.

The required set is **format-specific** — `tsx`/`svelte`/`vue` own the full form
family (`field-input-*`, `form-*`); `heex` and `angular` do NOT (Phoenix
renders form inputs inline through the HEEx walker from the Ecto schema / wire
shape; Angular emits typed Reactive Forms inline
through walker seams, so an angular pack ships the display/layout/input surface
*minus* `form-of`/`modal`/`field-input-*`/`form-*`). Vue additionally owns
`op-dialog`; Svelte additionally owns `svelte-config`. The exact per-format lists,
and how to read what's missing, are in `references/required-emit-set.md` — read it
before you start filling templates so you don't backfill in the wrong order.

The enforcing test is **`test/platform/pack-required-primitives.test.ts`**. Add
your pack to its `BUILTIN_PACKS` array so CI keeps it covered (note: that array
currently lists only tsx/heex/svelte packs — vue/angular packs are gated by the
build workflows, but adding yours there is cheap insurance and the load-gate runs
for every format).

## Step 4 — Wire the stack manifest

`tsx`/`vue`/`svelte`/`angular` packs declare `"stack": "<id>"`, which pulls the
cross-cutting framework deps (React/Vue/Svelte/Angular, router, zod, Vite, TS)
from `stacks/<id>/` so they're not restated per pack. Pick the stack from the
Step-1 table. The pack's `package-json.hbs` carries **only pack-specific deps**
(e.g. `@mantine/core`, `vuetify`, `primeng`) and injects the framework deps via
`{{> stack-package-deps}}` / `{{> stack-package-devdeps}}`. **Do not restate
React/router/zod/Vite/TS** — the stack abstraction exists to prevent exactly that
drift, and the validation flags overlap. If your framework baseline doesn't exist
as a stack yet, create `stacks/<newId>/` first (`stack.json` + the two
`*.hbs` partials) — see `docs/design-packs.md` §2a "Adding a new stack". `heex`
packs declare no stack (Phoenix has its own `mix.exs` deps).

## Step 5 — Register the pack

Two edits make the pack resolvable by `design: <family>`:

1. `src/util/builtin-formats.ts` — add `"<family>@v1": "<format>"` to
   `BUILTIN_PACK_FORMATS` and `<family>: "v1"` to `BUILTIN_PACK_LATEST` (the
   bareword default). Both consumers (the FS/VFS loaders and the validator) pick
   it up automatically.
2. The build-gate workflow — add `"<family>@v1"` to the `PACKS` list in
   `.github/workflows/generated-<framework>-build.yml` so the matrix covers it.

For a **new version** of an existing family, register the version in
`BUILTIN_PACK_FORMATS` but **do not flip `BUILTIN_PACK_LATEST` in the same PR** —
promoting the bareword default is a separate soak PR paired with refreshing
`test/fixtures/baseline-output/` (see `docs/design-packs.md` §12 Step 9).

## Step 6 — Cover every WALKER_PRIMITIVE your format owns (the #1478 lesson)

The required-emit gate covers the *named* required set, but the real contract is
that **every primitive the body walker can dispatch on your format has a working
template**. The dispatch table is `WALKER_PRIMITIVES` in
`src/generator/_walker/registry.ts` — one entry per closed-library primitive
(`Stack`, `Heading`, `Button`, `Section`, `Sticky`, `Modal`, …). The validator
accepts every one of these on any target, so a pack that omits the matching
`primitive-*` template renders fine in tests that don't exercise that primitive,
then crashes on a `.ddd` that does.

Walk the checklist in `references/required-emit-set.md` ("WALKER_PRIMITIVES
coverage") against your pack's `emits`. For each primitive in the table whose
`tsx` renderer is defined (i.e. the JSX-family walker dispatches it), your pack's
format must either emit the corresponding `primitive-*` template or — if the
required set deliberately exempts it (HEEx renders some inline, Angular subtracts
the form family) — confirm the exemption is real, not an oversight. When you find
a gap the required set *didn't* catch, that's a #1478-class bug: either add the
template, or if the primitive genuinely can't be rendered on your format, the gap
must become a *reviewed decision* — add the name to the required set's exemption
with a comment explaining why, the way `TSX_ONLY_PRIMITIVES` documents each HEEx
inline-render exemption. A silent gap is the bug; a documented one is a decision.

## Step 7 — Run the build gate locally until green

The static gate generates the project, `npm install`s it, and runs the
framework's typechecker + bundler. **`tsc --noEmit` alone is not enough** — the
`vite build` / `ng build` / `svelte-check` step catches class-shape mismatches and
asset/CSS errors that typecheck clean. Run your pack's gate, sharded to your pack:

```bash
# React  (script: npm run test:tsc-react — note: NOT "test:react-build")
LOOM_REACT_BUILD_CASE="web/src/examples/sales-system.ddd:<family>@v1" \
  npx vitest run test/e2e/generated-react-build.test.ts

# Vue
LOOM_VUE_BUILD_CASE="<case>:<family>@v1" npm run test:vue-build

# Svelte
LOOM_SVELTE_BUILD_CASE="<case>:<family>@v1" npm run test:svelte-build

# Angular
LOOM_ANGULAR_BUILD_CASE="<case>:<family>@v1" npm run test:angular-build
```

The build-case format is `<ddd-path>:<family>@<version>` (split on the first `:`;
the pack half is the qualified `family@version`). Omit the env var to run the full
`example × pack` matrix. If the case string doesn't match, the test fails loudly
and prints every available case — copy one from there. For a HEEx pack, the gate
is `LOOM_PHOENIX_VANILLA_BUILD=1 npm run test:phoenix` (docker; see the CLAUDE.md Docker
section). Iterate template fixes against this gate until it's green across the
example matrix, not just one example.

A quick manual smoke before the gate, per `docs/design-packs.md` §8:
`node bin/cli.js generate system <your.ddd> -o /tmp/out`, then `cd` into the
generated frontend project and run its `npm install` + typecheck + build.

## Step 8 — Tests, docs, finish

- Confirm `test/platform/pack-required-primitives.test.ts` and
  `test/platform/pack-manifest.test.ts` pass (`npm test` runs both).
- If you added a stack or a `format` behaviour, extend the relevant
  `test/platform/*-pack-groundwork.test.ts`.
- Mention the pack in `docs/design-packs.md` §10's family list and (for a custom
  pack) leave the `pack.json` as the contract. Don't write new doc files.
- The Stop hook runs Biome — keep the diff clean. Commit in coherent commits;
  **don't open a PR unless asked**.

## Why completeness, not coverage-by-example

The whole point of the required-emit gate and the WALKER_PRIMITIVES walk is that
a pack is consumed by `.ddd` files you'll never see — every future user's page
bodies. A pack that renders the three storybook examples but omits `primitive-tabs`
is a landmine. The gate makes "did I emit everything?" a load-time question with a
named-gap answer, instead of a runtime surprise. Land the pack complete: the gate
green, the WALKER_PRIMITIVES walk clean, the build matrix passing — the way a Loom
maintainer ships one.
