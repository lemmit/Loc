# Vue frontend — implementation plan

> **Status: Slices 0–9 EXECUTED** (merged via #1117 + follow-ups).
> **Parity follow-ups landed:** extern frontend functions
> (`function <name>(...) extern from "…"`); user-defined components
> (`src/components/<Name>.vue`, ui-scope + workspace top-level; the body
> walks through the shared markup walker); extern components
> (`component <Name>(...) extern from "…"` → a typed `<Name>.props.ts` +
> a `<Name>.ts` re-export shim, imported without the `.vue` extension —
> slot params are a narrow deferral since Vue slots aren't props); the
> channels toast manager (`on <channel>.<Event>` → `src/api/realtime.ts`
> + renderless `RealtimeHandlers.vue` + a `src/lib/toast.ts` queue
> rendered by each pack's app-shell host — `<v-alert>` on vuetify, an
> `Alert` stack on shadcnVue); and live-refetch find-filters (a
> parameterised `find` hook takes a `MaybeRefOrGetter` query so a bound
> filter input re-fetches — the page passes `() => ({ … })`, React stays
> a plain object param); and named layouts (`layout <Name> { header /
> main / footer }` → nested vue-router routes; the layout SFC's inner
> `<router-view />` is the `main` outlet, `layout: none` mounts
> top-level, and the default chrome moves to `src/layouts/DefaultLayout.vue`
> with App.vue a thin host — default-only uis keep the flat
> chrome-in-App.vue shape).  **Remaining tracked gaps:** operation forms
> (Action dialogs) inside user components — create-forms and workflow
> run-forms inside a component DO work; operation forms need the op-dialog
> host so they stay a narrow deferral — slot params on extern components,
> and the docker-boot e2e fold-in once the Svelte effort settles the
> shared LOOM_E2E gate shape.

Add **Vue 3 as a frontend platform** (`platform: vue`) with feature parity to
React, plus **two Vue design packs** (`vuetify`, `shadcnVue`) with feature
parity to `react`/`mantine`. This executes Phase B of
[`platform-expansion-roadmap.md`](platform-expansion-roadmap.md): the Phase A
prerequisites that gated any new frontend — `WalkerTarget` extraction, pack
required-primitives validation, testid tripwire — have all landed.

## Decisions (locked with the user, 2026-06-10)

| Decision | Choice |
|---|---|
| Design systems | **Vuetify 3** (npm-package model, mirrors Mantine's role — the roadmap's named pick) and **shadcn-vue** (source-copy model over reka-ui + Tailwind, mirrors the shadcn TSX pack template-by-template). Pack family ids: `vuetify` (`designs/vuetify/v3/`), `shadcnVue` (`designs/shadcnVue/v1/`). |
| App shape | **Plain Vite SPA + vue-router** — `createRouter(createWebHistory())`, explicit route table in `src/router.ts`, pages as `src/pages/<X>.vue` SFCs with `<script setup lang="ts">`. The exact analog of the React output; served by the same vite-build → vite-preview two-stage docker runtime. No Nuxt. |
| Parity extras | **Backend-host embedding in scope** (`vue` joins the static-bundle hostable frameworks so dotnet/elixir hosts can serve Vue UIs). **Playground in-browser Vue preview is deferred** (needs the Vue SFC compiler in the VFS bundler — separate effort). |
| Svelte coordination | **Depend on, don't duplicate**: the shared markup-walker extraction (Svelte plan Slice 2 on `claude/dazzling-ride-6r2ux7`) is a hard prerequisite. Vue starts from the shared `src/generator/_walker/` core and supplies a `vueTarget`. See "Coordination with the Svelte effort" below. |
| Forms | **Hand-rolled `reactive()` + zod** — a small generated form helper (reactive form object, zod parse on submit, per-field error map, server-error application mirroring `apply-server-errors.ts`). No third-party form dependency. Same decision the Svelte plan made for runes. |
| Data fetching | `@tanstack/vue-query` (role-for-role analog of React Query; mature on Vue 3). Validated in Slice 3; fallback is a hand-rolled composable query helper with the same generated surface. |
| Default pack | A `platform: vue` deployable without `design:` defaults to `vuetify`. |
| Walker strategy | **Reuse, not fork**: drive the shared markup-walker core with a `vueTarget`. Vue is a `{{…}}`/`{expr}`-interpolation component framework like TSX/Svelte; HEEx keeps its parallel walker. |

## Coordination with the Svelte effort

The Svelte plan ([`svelte-frontend-plan.md`](svelte-frontend-plan.md), branch
`claude/dazzling-ride-6r2ux7`) is in flight and shares infrastructure with this
plan. Explicit coordination points:

- **Shared-walker extraction (Svelte Slice 2) is this plan's prerequisite.**
  It moves the framework-neutral walk dispatch, pack-driven primitive emitters,
  `renderPrimitive`/import aggregation, and the framework-neutral frontend
  builders (menu derivation, zod-schema half of `api-builder.ts`, page-object
  shapes) out of `src/generator/react/` into `src/generator/_walker/` /
  `src/generator/_frontend/`, byte-identical gated. **If the Svelte effort
  stalls or is reordered, Slice 0 of this plan executes that extraction
  exactly as specified there** — the work is identical either way; only the
  branch it lands from differs.
- **Frontend-platform generalizations land once.** Svelte Slice 1 already
  generalizes `loom.react-deployable-missing-ui` to all `isFrontend`
  platforms and adds the multi-frontend `e2e-render` dispatch shape. Vue's
  Slice 1 mirrors whatever of that has landed and extends rather than
  re-implements (the parsing/validator/registry tests are additive per
  keyword).
- **No resource collisions:** Svelte claims `defaultPort: 3002` and stack id
  `sv1`; Vue takes `defaultPort: 3003` and stack id `vue1`. Pack format ids
  are disjoint (`"svelte"` vs `"vue"`). Both plans add a *sibling* CI
  workflow rather than renaming `generated-react-build.yml`.
- **Shared seams stay shared.** If Vue needs a `WalkerTarget` method Svelte
  also added (`renderComment`, `escapeText`, …), implement once on the
  contract and fill all targets. `STATIC_BUNDLE_FRAMEWORKS` (Slice 8) is a
  set-extension both plans touch — whichever lands second extends, with the
  embed tests parameterized by framework rather than copy-pasted.

## Why reuse is tractable (research summary)

- The React walker primitives (`src/generator/react/walker/primitives/*`) are
  already **pack-template-driven**: they build view-models and call
  `renderPrimitive(ctx, "primitive-…", vm)`. They hardcode no JSX markup —
  the markup lives in the pack `.hbs` templates. Vue packs own `<v-btn>` /
  `:prop="…"` / `@click` / `v-for` markup the same way Mantine packs own JSX.
- The framework-divergent seams (state read/write, API call lowering, `match`,
  navigation, defaults) are already behind `WalkerTarget`
  (`src/generator/_walker/target.ts`), with `tsxTarget` and `heexTarget` as
  consumers (and `svelteTarget` arriving). The real Vue deltas:
  - **ref auto-unwrap is position-dependent** — `count` in template position,
    `count.value` in `<script setup>` position. `renderStateRead` already
    takes a position parameter (HEEx needed the same distinction), so this
    *validates* the contract rather than extending it.
  - control flow (`v-if` / `v-for` instead of ternaries / `.map()`) lives
    almost entirely in **pack templates**, which Vue packs own anyway;
    `match` in child position renders via `vueTarget.renderMatch` as
    `<template v-if>` chains (value-position arms keep ternaries).
  - the page shell (an SFC with a `<script setup lang="ts">` block instead of
    a function component with hooks) — a **per-platform emitter**, like
    today's `walker/page-shell.ts`.
- Page objects and the `@loom/ui-test-driver` runtime are **framework-neutral**
  (testid/DOM only) — they work against a Vue app unchanged as long as the
  Vue packs emit the same `data-testid` values (gated by the testid tripwire,
  extended in Slice 6).

## Slices

Implemented in order on this branch, one commit (or a few) per slice; every
slice leaves `npm test` green. Byte-identical gates protect React/Phoenix
output through any refactor touched.

---

### Slice 0 — Prerequisite sync: shared markup walker

Bring the shared-walker extraction into this branch's base.

> **Status (2026-06-10): satisfied by stacking.** This branch is rebased onto
> `claude/dazzling-ride-6r2ux7` (Svelte Slices 1–2), so the shared core is in
> the base. It landed entirely under `src/generator/_walker/` (`walker-core.ts`,
> `render-primitive.ts`, `primitives/*`, `shared/args.ts`) — the tentative
> `src/generator/_frontend/` split below did not materialize; read those
> references as `_walker/`. Gate verified on the stacked base: full fast suite
> green (4341 passed), baseline fixture re-capture zero-drift.

- **Preferred path:** the Svelte effort's Slice 2 has merged to main — rebase
  and proceed straight to Slice 1.
- **Fallback path:** execute the extraction here, exactly as specified in
  `svelte-frontend-plan.md` Slice 2 (seam additions to `WalkerTarget`, move of
  the framework-neutral core to `src/generator/_walker/`, relocation of the
  framework-neutral frontend builders), with the same byte-identical gate:
  all `test/generator/react/walker-*.test.ts` unchanged, baseline fixture
  diff empty, `LOOM_REACT_BUILD=1` showcase×mantine and `LOOM_PHOENIX_BUILD=1`
  green.

**Gate:** shared walker core exists under `src/generator/_walker/`; React and
Phoenix output byte-identical to main.

---

### Slice 1 — `platform: vue` plumbing (stub emitter)

The full language→IR→platform thread, with a placeholder project emitter so
the registry's `Record<Platform, PlatformSurface>` stays total.

- `src/language/ddd.langium`: add `'vue'` to the `Platform` rule and the
  `Framework` rule; `npm run langium:generate`; commit regenerated output.
- `src/ir/types/loom-ir.ts`: extend the `Platform` union; `uiFramework` gains
  `"vue"`.
- `src/language/validators/data/platform-rules.ts`: `FRONTEND_KEYWORDS` +=
  `vue`; `expectedFrameworkFor(vue) = "vue"`;
  `expectedPackFormatFor("vue") = "vue"` (new pack format).
- `src/language/validators/deployable.ts`: vue deployables must declare `ui:`
  (via the generalized frontend rule if Svelte Slice 1 has landed; otherwise
  generalize it here); `targets:` rules apply automatically via `isFrontend`.
- `src/ir/lower/lower-deployment.ts`: design-pack defaulting — `vue` →
  `vuetify`.
- New `src/platform/vue.ts` (`name: "vue"`, `isFrontend: true`,
  `needsDb: false`, `mountsUi: true`, `defaultPort: 3003`, `internalPort`
  3000, `VITE_API_BASE_URL` env like React); `emitProject` emits a minimal
  README stub until Slice 3. Register in `src/platform/registry.ts`.
- `src/system/e2e-render.ts`: `vue` joins the UI-platform dispatch
  (Playwright path).
- Enrichment (`moduleNames` inheritance) and IR system-checks need **no
  change** — they key off `isFrontend`.
- Tests: parsing test for `platform: vue`; negative validator tests
  (missing `ui:`, frontend-targets-frontend, design/format mismatch);
  registry lookup test.

**Gate:** `npm test` green; `langium-generated.yml` drift check clean.

---

### Slice 2 — `vue` pack format groundwork

- `src/generator/_packs/required-primitives.ts`: add the `vue` format set —
  same tiers as TSX (core + shell + fieldInput + form + the TSX-only extras:
  code-block, icon, modal), since Vue packs own forms the way TSX packs do.
- `src/util/builtin-formats.ts`: register `vuetify@v3` and `shadcnVue@v1`
  with format `"vue"`; `BUILTIN_PACK_LATEST` entries.
- `src/generator/_packs/loader-fs.ts`: shared-source dirs for the `vue`
  format — new top-level `vue/` (index.html, main.ts bootstrap, router
  scaffold, api client, config, logger, error page) + existing `docker/`
  (the dockerfile is already a neutral vite-build/vite-preview two-stage).
- New `stacks/vue1/`: `stack.json` + dep partials — `vue ^3.5`,
  `vue-router ^4`, `vite`, `@vitejs/plugin-vue`, `vue-tsc`, `typescript`,
  `@tanstack/vue-query`, `zod`, `dayjs`, `loglevel`. (Vuetify/reka-ui deps
  live in each pack's `package-json.hbs` over these partials, like Mantine
  over the React stacks.)
- Tests: extend `pack-required-primitives.test.ts` / `pack-manifest.test.ts`
  for the new format (negative case: vue pack missing a required primitive
  fails at load).

**Gate:** `npm test` green (no generator yet — pure registry/loader surface).

---

### Slice 3 — Vue generator core + project shell (empty app builds)

`src/generator/vue/` orchestrator and the vuetify pack **shell tier**, to the
point where a `.ddd` with a vue deployable and no pages emits a Vite+Vue
project that passes `vue-tsc --noEmit` and `vite build`.

- `src/generator/vue/index.ts` — `generateVueForContexts(...)`, mirroring the
  React orchestrator's shape (pack load, per-aggregate API modules, pages,
  page objects, app shell, shell files).
- `src/generator/vue/walker/vue-target.ts` — `WalkerTarget` impl:
  state via `ref()` (position-aware reads/writes: bare name in template
  position — refs auto-unwrap, including writable inline handlers — `.value`
  in script position), API via vue-query handles hoisted in `<script setup>`,
  `renderMatch` via `<template v-if>`/`<template v-else-if>` chains
  (value-position arms keep ternaries), navigation via `useRouter().push()`
  (route state via history `state`), JS zero-value defaults, `<!-- -->`
  comments in template position.
- Pages-emitter skeleton mapping page slugs/params → `src/pages/<X>.vue` +
  generated `src/router.ts` route table; app shell (`App.vue` + layout) from
  the pack (`app-shell` emit); error/catch-all route.
- API layer: `src/api/<agg>.ts` per aggregate — zod schemas (shared builder
  from the Slice 0 extraction) + `useQuery`/`useMutation` composable
  factories; `client.ts`, `config.ts` from the `vue/` shared sources.
  **Validate `@tanstack/vue-query` against the generated call surface here**;
  if it fights, swap to a hand-rolled composable without changing the
  generated call surface.
- `designs/vuetify/v3/` shell tier: `pack.json` (format `vue`, stack `vue1`),
  `package-json` (vuetify + `vite-plugin-vuetify` + `@mdi/js`), `tsconfig`,
  `vite-config`, `theme` (createVuetify config), `main`/index-html,
  `app-shell` (v-app / v-app-bar / v-navigation-drawer), `format-helpers`.

**Gate:** new opt-in suite `test/e2e/generated-vue-build.test.ts`
(`LOOM_VUE_BUILD=1`, `npm run test:vue-build`) — generates, `npm install`,
`vue-tsc --noEmit` + `vite build` — green for a minimal example; `npm test`
green.

---

### Slice 4 — Walker primitives, scaffolded pages, and forms

The parity heart: every walker primitive renders through the vuetify pack;
scaffolded list/detail/new pages and explicit `ui` pages compile.

- Vuetify primitive templates: all `primitive-*`, `field-input-*`, `form-*`
  emits (Vue control flow in templates: `v-for` table rows, `v-if` toggles,
  `v-model` field bindings, `@click` handlers; Handlebars↔Vue `{{ }}`
  collision handled with `\{{…}}` escapes — see Risks).
- Vue page shell (`page-shell` sibling): `<script setup lang="ts">` assembly —
  query/mutation handles, `ref()` state fields, `computed()` where derived
  state is needed, form-helper instantiation, imports; `<template>` block from
  the walked body.
- Forms runtime: generated `src/lib/form.ts` — `reactive()` form object, zod
  parse on submit, per-field error map (nested VO paths + field arrays),
  server-error application (mirrors `apply-server-errors.ts` semantics).
- Scaffolded pages (list/new/detail per aggregate) and explicit page bodies
  walk through the shared markup walker with `vueTarget`.
- Vue walker test suite: a representative `test/generator/vue/` set
  (~12–15 files) covering each primitive group, forms, match, state mutation,
  navigation, testids — plus `vueTarget` added to the walker-target
  contract test.

**Gate:** `LOOM_VUE_BUILD=1` green for the showcase-scale example ×
`vuetify@v3` (vue-deployable example file, see Slice 5 note); `npm test`
green.

---

### Slice 5 — Views, workflows, and remaining React-parity features

- View pages + view query composables (`view-builder` sibling), workflow pages
  + mutation composables (`workflow-builder` sibling), workflow instance
  views.
- Unions (`A or B` tagged wire), `paged`/`envelope` carriers, frontend ACL
  emission, access modifiers (editable/managed/internal/token/secret),
  transitive VO/enum zod schemas, money handling, formatters, named layouts,
  user-declared components (`src/components/<X>.vue`), `extern` component
  escape hatch, observability/logger parity.
- New example: `examples/vue-showcase.ddd` (vue deployable variant of
  showcase) — kept **separate from `showcase.ddd`** so the React/Phoenix
  baseline fixtures don't all recapture.
- Feature-parity audit against `docs/generators.md`'s React column; close or
  explicitly document any gap.

**Gate:** parity checklist in the PR description maps every React generator
feature to its Vue counterpart or a documented exclusion;
`LOOM_VUE_BUILD=1` green on the full example.

---

### Slice 6 — Page objects, e2e dispatch, testid tripwire

- Page-object emission for vue deployables (shared page-object builders from
  the Slice 0 extraction; same testid contract, same `@loom/ui-test-driver`
  runtime).
- `test e2e "…" against <vue-deployable>` lowers to Playwright (dispatch
  added in Slice 1; verify end-to-end here), including the generated `e2e/`
  harness in the emitted project.
- Extend `test/conformance/pack-testid-coverage.test.ts` to vue packs (same
  allowlist policy as TSX).
- Docker-compose boot e2e for the vue example: build the stack, hit `/`, run
  the generated Playwright specs (folded into the `LOOM_E2E` suite or a
  sibling `LOOM_VUE_E2E` gate, whichever keeps `test:e2e` runtimes sane —
  match whatever the Svelte effort settled on).

**Gate:** Playwright specs pass against the booted vue example.

---

### Slice 7 — Second pack: `shadcnVue@v1`

- `designs/shadcnVue/v1/` — full required-primitive set, **source-copy**
  distribution model translated from the existing `shadcn/v4` TSX pack:
  `globals-css`, `lib-utils`, `components-ui-*` shellGlobs emitting reka-ui
  based `.vue` component sources; Tailwind shell files; `lucide-vue-next`
  icon remap via a `helpers` table (like shadcn's `lucide` map).
- Pack joins: required-primitives test, testid tripwire, vue build matrix.

**Gate:** `LOOM_VUE_BUILD=1` green for the example set × `shadcnVue@v1`;
walker vue tests pass against both packs where pack-sensitive.

---

### Slice 8 — Backend-host embedding

- Add `vue` to `STATIC_BUNDLE_FRAMEWORKS` (`src/platform/surface.ts`) so
  static-asset hosts (react/static platform, dotnet with UI, elixir) can
  declare a vue `ui:`. If the Svelte effort already restructured this set,
  extend its shape rather than re-deriving.
- Verify the dotnet/elixir UI-mounting paths render vue bundles (mirror of
  `embed-react-phoenix` coverage with a vue variant); `expectedFrameworkFor`
  interplay for `dotnet`+vue UI.
- Tests: `test/platform/hostable-frameworks.test.ts` extension + one embed
  test per host.

**Gate:** embed test(s) green; existing react (and svelte, if landed) embed
tests unchanged.

---

### Slice 9 — CLI, CI, docs

- CLI: `ddd new --design vuetify|shadcnVue` scaffolds a vue deployable
  (design implies frontend platform via pack format, as react packs do
  today); validation messages updated.
- CI: new `.github/workflows/generated-vue-build.yml` — matrix
  `{examples × vuetify@v3, shadcnVue@v1}` running the `LOOM_VUE_BUILD` suite
  (PR slice + full matrix on main, mirroring `generated-react-build.yml`'s
  policy + matrix-sync test); vue e2e gate wired per Slice 6's choice. Biome
  doesn't lint `.vue` — generated `.ts` in vue projects joins
  `test:biome-gen`; `.vue` files rely on `vue-tsc`.
- Docs: `docs/platforms.md`, `docs/design-packs.md` (vue format + authoring),
  `docs/generators.md` (vue column), `docs/language.md` (`platform: vue`),
  `docs/decisions.md` (D-VUE-FRONTEND: reuse-not-fork, Vite+vue-router SPA,
  forms decision), `CLAUDE.md` (pipeline table, pack list, CI surface),
  `experience_gathered.md` retro entry, and a status note in
  `platform-expansion-roadmap.md` (Phase B executed; calibration answers for
  its three questions: WalkerTarget sufficiency, walker reuse %, IR gaps).

**Gate:** full verification pass (below).

---

## Final verification

```bash
npm test                                   # incl. new vue suites
LOOM_VUE_BUILD=1 npm run test:vue-build         # examples × both vue packs
LOOM_REACT_BUILD=1 npm run test:tsc-react       # unchanged React matrix
LOOM_TS_BUILD=1 npm run test:tsc                # backends unchanged
LOOM_E2E=1 npm run test:e2e                     # incl. vue boot + Playwright
# byte-identical guard for any walker-core changes (re-run on final state)
node bin/cli.js generate system examples/showcase.ddd -o /tmp/vue-final
diff -r test/fixtures/baseline-output /tmp/vue-final
```

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Handlebars `{{ }}` vs Vue `{{ }}` interpolation collide **directly** (worse than Svelte's `{}`) | Every Vue-interpolation site in pack templates uses `\{{…}}` escapes (Handlebars renders the literal); a pack-authoring lint in the pack tests greps compiled output for unrendered `{{` artifacts; pack tests pin output byte-exact. |
| ref auto-unwrap position bugs (template vs script, `.value` leaks) | `renderStateRead/Write` are position-aware (HEEx precedent); the walker vue test suite includes a state-mutation matrix across template/handler/script positions; `vue-tsc` catches `.value`-on-unwrapped errors. |
| `@tanstack/vue-query` surface friction with the generated composable shape | Validated first thing in Slice 3; the generated call surface is ours, so a hand-rolled composable helper is a drop-in fallback. |
| Svelte branch lands the shared-walker extraction with different seam names than this plan assumes | Slice 0 is a sync point, not parallel work: Vue consumes whatever contract shape merged; only `vue-target.ts` and the page shell depend on it. |
| Vuetify's vite plugin / auto-import interplay with generated code | Pin explicit component imports in pack templates (no `vite-plugin-vuetify` auto-import resolver dependency for correctness); `LOOM_VUE_BUILD` gates it. |
| `vite preview` SPA fallback for deep links | Same neutral docker two-stage as React; vue-router `createWebHistory` + the existing preview fallback config; covered by the boot e2e hitting a deep route. |
| Library version drift (vuetify/reka-ui/lucide pins) | Stack `vue1` pins ranges; `LOOM_VUE_BUILD` CI matrix catches breakage the way the React matrix does. |
