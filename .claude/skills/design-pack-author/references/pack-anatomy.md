# Pack anatomy — what to copy, per framework family

For each frontend family: the closest analog to fork, its file layout, the
manifest + stack wiring, and where to register. Pick the analog that matches both
your framework (`format`) and your distribution model (npm vs source-copy).

## Table of contents
- [How packs resolve](#how-packs-resolve)
- [React (`tsx`)](#react-tsx)
- [Vue 3 (`vue`)](#vue-3-vue)
- [Svelte 5 (`svelte`)](#svelte-5-svelte)
- [Angular (`angular`)](#angular-angular)
- [Phoenix HEEx (`heex`)](#phoenix-heex-heex)
- [Manifest fields](#manifest-fields-pack-json)
- [Registration points (all formats)](#registration-points-all-formats)

## How packs resolve

`src/generator/_packs/loader-fs.ts:resolvePackDir(ui, referenceDir)` resolves a
`design:` slot value (`src/util/builtin-formats.ts:parseBuiltinDesignRef` does
the parse) in this order:

1. **Built-in family** — `family` or `family@version` matching
   `BUILTIN_PACK_LATEST` → `<repo>/designs/<family>/<version>/` (bareword version
   from `BUILTIN_PACK_LATEST`).
2. **Absolute path** — `/opt/loom-packs/x` used verbatim.
3. **Relative path** — `./x` / `../x` anchored at the `.ddd` file's directory.

`repoRoot()` walks up until it finds a `designs/` sibling. The loader cross-checks
`pack.json`'s `version` against the parent directory name and **throws on
mismatch** — so a fork must bump `version` to match its new directory.

Shared, pack-agnostic templates the pack inherits for free (no need to emit) come
from repo-root sibling dirs, gated by `format`:

| format | shared dirs pulled in |
|---|---|
| `tsx` | `vite/`, `api/`, `docker/` |
| `vue` | `vue/`, `api/`, `docker/` |
| `svelte` | `sveltekit/` |
| `heex` | `phoenix/` (empty in v0 — ashPhoenix ships its shell directly) |
| `angular` | (Angular-specific shared layer; see the angular generator) |

These supply `index-html`, `api-client`/`api-config`, `dockerfile`, etc. A pack
CAN override any by emitting the same logical name (pack wins on collision).

## React (`tsx`)

**Analogs:** `designs/mantine/v9` (npm-package model — components from
`@mantine/core`) or `designs/shadcn/v4` (source-copy model — components vendored
via `shellGlobs`). Stack `v3` (React 19 / react-router 7 / zod 4) or `v1`
(React 18 / react-router-dom 6 / zod 3).

**Layout (mantine/v9, npm model):**
```
designs/mantine/v9/
  pack.json
  main.hbs theme.hbs app-shell.hbs format-helpers.hbs   # shell
  package-json.hbs tsconfig.hbs vite-config.hbs
  primitive-*.hbs                                        # ~44 walker primitives
  field-input-*.hbs                                      # 11 form-field inputs
  form-of-decls.hbs form-op-decls.hbs form-op-module.hbs # form scaffold
  form-runs-decls.hbs form-default-onsubmit.hbs
  realtime-toast.hbs                                     # channel toast
```
Mantine's `imports` map points almost every primitive at `@mantine/core`; no
`shellGlobs`.

**shadcn/v4 (source-copy model)** adds `components-ui-*.hbs` (one per vendored
component) plus `shellGlobs: { "components-ui-*": "src/components/ui/{1}.tsx" }`
and `shellFiles` for `tailwind-config` / `globals-css` / `lib-utils`. Its
`imports` point at local `@/components/ui/*`. Fork shadcn if your library ships
components as source.

**Build gate:** `generated-react-build.yml`, script `npm run test:tsc-react`
(NOT `test:react-build`), test `test/e2e/generated-react-build.test.ts`,
`LOOM_REACT_BUILD_CASE=<ddd>:<family>@<version>`.

## Vue 3 (`vue`)

**Analogs:** `designs/vuetify/v3` (npm — `vuetify`) or `designs/shadcnVue/v1`
(source-copy — reka-ui + Tailwind 4). Stack `vue1`. Format `vue`.

**Layout:** mirrors the tsx full surface (core primitives + `field-input-*` +
`form-*`) PLUS `op-dialog.hbs` (the operation-modal wrapper the page shell
renders — `v-dialog` on vuetify). `.hbs` files yield Vue SFC `<template>` markup.

**Authoring gotcha — the mustache collision:** Handlebars and Vue both use
`{{ }}`. Generation-time substitutions stay plain Handlebars (`{{label}}`,
`{{{onClick}}}`); a literal Vue *runtime* interpolation must be written
`\{{ … }}` (Handlebars emits the literal mustache). JS-splicing attributes use
single quotes: `@click='{{{onClick}}}'`.

**Build gate:** `generated-vue-build.yml`, `npm run test:vue-build`,
`test/e2e/generated-vue-build.test.ts`, `LOOM_VUE_BUILD_CASE=<case>:<family>@v1`.

## Svelte 5 (`svelte`)

**Analogs:** `designs/shadcnSvelte/v1` (source-copy, ships `components-ui-*`) or
`designs/flowbite/v1`. Stack `sv1`. Format `svelte`.

**Layout:** the full tsx surface (core + `field-input-*` + `form-*`) PLUS
`svelte-config.hbs` (SvelteKit's `svelte.config.js`) — that `svelte-config` is the
one shell delta over tsx. `.hbs` files yield Svelte 5 runes markup. Inherits the
`sveltekit/` shared layer (api client + logger + root layout + Dockerfile).

**Build gate:** `generated-svelte-build.yml`, `npm run test:svelte-build`,
`test/e2e/generated-svelte-build.test.ts`,
`LOOM_SVELTE_BUILD_CASE=<case>:<family>@v1`. PACKS list in the workflow:
`['shadcnSvelte@v1', 'flowbite@v1']`.

## Angular (`angular`)

**Analogs:** `designs/angularMaterial/v1` (npm — Angular Material), or the
recent `designs/primeng/v1` / `designs/spartanNg/v1` (both landed days apart —
fork whichever distribution model matches yours). Stack `ng1` (Angular 22 + typed
Reactive Forms + TanStack Angular Query + zod 4). Format `angular`.

**Layout — the form family is SUBTRACTED.** Angular renders every form
(`CreateForm`/`OperationForm`/`Modal`/`WorkflowForm`/`DestroyForm`) as inline
typed Reactive Forms via walker seams (`src/generator/angular/*-form.ts`), NOT pack
templates. So an angular pack ships the **display / layout / input surface only**:
```
primitive-*.hbs        # core MINUS primitive-form-of and primitive-modal
                       # (TSX_ONLY minus primitive-modal)
app-shell.hbs format-helpers.hbs main.hbs theme.hbs tsconfig.hbs package-json.hbs
angular-json.hbs       # CLI workspace — REPLACES vite-config
```
No `field-input-*`, no `form-*`, no `op-dialog`, no `primitive-form-of`/
`primitive-modal`. JS-splicing event bindings use single quotes:
`(click)='{{{onClick}}}'`.

**Build gate:** `generated-angular-build.yml`, `npm run test:angular-build`,
`test/e2e/generated-angular-build.test.ts`,
`LOOM_ANGULAR_BUILD_CASE=<case>:<family>@v1`. PACKS:
`["angularMaterial@v1", "primeng@v1", "spartanNg@v1"]`.

## Phoenix HEEx (`heex`)

**Analog:** `designs/ashPhoenix/v3` — the ONLY HEEx pack. Format `heex`, **no
`stack`** (Phoenix manages deps via `mix.exs`). Filenames are `*.heex.hbs`.

**Layout:** `SHARED_PRIMITIVES` core + `SHARED_SHELL` only — **no** `fieldInput`
or `form` set (Phoenix renders form inputs inline via the HEEx walker from the
Ecto schema / wire shape). Several primitives the JSX walker emits as templates
(`Section`, `Sticky`, `Modal`, `Icon`, `CodeBlock`) are rendered **inline** by the
HEEx walker (`src/generator/elixir/heex-walker.ts`) and so are deliberately
exempt from the heex required set — this is the documented exemption pattern.

**Build gate:** `elixir-vanilla-build.yml`, `npm run test:phoenix`
(docker; see CLAUDE.md Docker section, `LOOM_HEX_MIRROR=1` if behind a
TLS-fingerprint proxy).

## Manifest fields (`pack.json`)

```jsonc
{
  "name": "<family>",        // display string; surfaces in errors
  "version": "v1",           // MUST equal the directory name — loader throws on drift
  "format": "tsx",           // tsx | vue | svelte | angular | heex; gates the required set
  "stack": "v3",             // required for tsx/vue/svelte/angular; omit for heex
  "emits": { "<logical>": "<file.hbs>", … },          // REQUIRED — every name the gate wants
  "imports": { "primitive-button": [{ "from": "…", "named": ["Button"] }] },  // optional
  "shellFiles": { "tailwind-config": "tailwind.config.ts" },   // optional one-off files
  "shellGlobs": { "components-ui-*": "src/components/ui/{1}.tsx" },  // optional (source-copy)
  "helpers": { "lucide": { "IconPlus": "Plus" } }     // optional icon-name maps etc.
}
```

Templates are Handlebars 4 with `strict: true` (throws at render on a missing
view-model field — keeps pack + preparer in sync). Global helpers: `expr` (raw
expression, no escaping), `json` (JSON-stringify). Every emitted template is also
a partial under its logical name, so higher-level templates compose primitives via
`{{> primitive-button label="Save"}}`.

**Stack wiring:** `package-json.hbs` carries only pack-specific deps and pulls
framework deps via `{{> stack-package-deps}}` / `{{> stack-package-devdeps}}`.
Do NOT restate React/Vue/Svelte/Angular/router/zod/Vite/TS — they live in
`stacks/<id>/stack.json` + the two `*.hbs` partials.

## Registration points (all formats)

1. **`src/util/builtin-formats.ts`** —
   - `BUILTIN_PACK_FORMATS`: add `"<family>@v1": "<format>"`.
   - `BUILTIN_PACK_LATEST`: add `<family>: "v1"` (the bareword default). For a new
     *version* of an existing family, register the version but **don't flip the
     latest** in the same PR (that's a separate soak PR + baseline-fixture
     refresh — `docs/design-packs.md` §12 Step 9).
2. **`.github/workflows/generated-<framework>-build.yml`** — add `"<family>@v1"`
   to the `PACKS` list so the build matrix covers it.
3. **`test/platform/pack-required-primitives.test.ts`** — add to `BUILTIN_PACKS`
   for the load-gate coverage (the array currently lists tsx/heex/svelte; adding
   vue/angular entries is cheap insurance — the gate runs for every format).
4. **`test/platform/pack-manifest.test.ts`** — manifest-shape contract; usually
   passes automatically if your `pack.json` is well-formed.

Reference files worth reading directly:
- `src/generator/_packs/required-primitives.ts` — the required set (live source).
- `src/generator/_packs/loader.ts` (`compilePack`) — the gate.
- `src/generator/_packs/loader-fs.ts` (`resolvePackDir`) — resolution.
- `src/generator/_walker/registry.ts` (`WALKER_PRIMITIVES`) — the dispatch table.
- `stacks/<id>/stack.json` — stack deps.
- `docs/design-packs.md` — the long-form contract (§2 manifest, §2a stacks, §3
  required emits, §12 new-version recipe).
