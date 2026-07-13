# Svelte frontend — implementation plan

> **Status (2026-06): IMPLEMENTED** — slices 1–10 landed on
> `claude/dazzling-ride-6r2ux7`.  Deltas vs the plan, decided during
> implementation:
>
> - `@tanstack/svelte-query` landed at **v6** (the runes-native line —
>   `createQuery(() => opts)` returning a reactive object), not v5;
>   the generated factories keep the TSX hook names.
> - The walker gained **six** new `WalkerTarget` methods, not three:
>   the four markup seams plus `renderChildrenSlot` (Svelte renders
>   children as `{@render children?.()}`) and `formRuntimeImports`
>   (react-hook-form's import set moved off the shared form
>   primitives onto the TSX target).
> - shadcnSvelte ships **hand-rolled tailwind-4 markup** (one vendored
>   `Tabs.svelte`), not vendored bits-ui components — zero component
>   deps proved more robust for generated code; flowbite@v1 is the
>   npm-model pack (real `flowbite-svelte` components).
> - Operation-form modals render as page-scope
>   `{#snippet <op>OpModal(form)}` blocks (one component per .svelte
>   file — module scope lands in the template).
>
> **Known follow-ups (deliberately out of this pass):**
> - ~~Named layouts map to the `(app)` chrome group (no per-layout route
>   group yet); `layout: none` works via `(bare)`.~~ DONE — each named
>   `layout <Name>` emits a `(<name>)/+layout.svelte` route group
>   rendering its header/sidebar/footer slots around
>   `{@render children()}`; `layout: <Name>` pages route into it.
> - ~~`extern` components throw a clear error on svelte (escape hatch
>   not wired).~~ DONE — svelte emits the forwarding `.svelte` wrapper +
>   typed `<Name>.props.ts` (Snippet for slots), mirroring react.
> - ~~Phoenix hosting of svelte uis is rejected by the validator —
>   SvelteKit under the `/app` path prefix needs `paths.base`
>   threading (nav hrefs, goto, assets).~~ DONE — phoenix embeds svelte
>   with `kit.paths.base = "/app"` (also fixed the react/vue asset base).
> - Playground in-browser svelte preview (per the original scope
>   decision).
> - Docker-compose boot e2e for the svelte example (the compile +
>   smoke surface is gated; the booted-stack Playwright pass rides
>   the existing LOOM_E2E machinery once a svelte deployable joins a
>   compose example).

Add **Svelte 5 as a second frontend platform** (`platform: svelte`) with feature
parity to React, plus **two Svelte design packs** (`shadcnSvelte`, `flowbite`)
with feature parity to `react`/`mantine`. This plan supersedes the
Vue-first ordering in [`platform-expansion-roadmap.md`](platform-expansion-roadmap.md)
(Phase B/I): the Phase A prerequisites that gated any new frontend —
`WalkerTarget` extraction, pack required-primitives validation, testid
tripwire — have all landed, so Svelte proceeds directly.

## Decisions (locked with the user, 2026-06-10)

| Decision | Choice |
|---|---|
| Design systems | **shadcn-svelte** (source-copy model, mirrors the shadcn TSX pack) and **Flowbite Svelte** (npm-package model, mirrors Mantine's). Pack family ids: `shadcnSvelte`, `flowbite` (versioned `designs/<family>/v1/`). |
| App shape | **SvelteKit static SPA** — `@sveltejs/adapter-static`, `ssr = false`, file-based routes (`src/routes/orders/[id]/+page.svelte`), navigation via `goto()`. Served exactly like the React SPA: `vite build` → `vite preview` in the docker runtime stage. |
| Parity extras | **Backend-host embedding in scope** (`svelte` joins the static-bundle hostable frameworks so dotnet/elixir hosts can serve Svelte UIs). **Playground in-browser Svelte preview is deferred** (needs the Svelte compiler in the VFS bundler — separate effort). |
| Forms | **Hand-rolled runes + zod** — a small generated form helper (`$state` form object, zod parse on submit, per-field error map, server-error application mirroring `apply-server-errors.ts`). No third-party form dependency. |
| Data fetching | `@tanstack/svelte-query` (role-for-role analog of React Query). Validated in Slice 4; fallback is a hand-rolled `$state` query helper with the same generated surface. |
| Default pack | A `platform: svelte` deployable without `design:` defaults to `shadcnSvelte`. |
| Walker strategy | **Reuse, not fork**: extract the framework-neutral markup-walker core out of `src/generator/react/` into `src/generator/_walker/` (byte-identical gated), then drive it with a `svelteTarget`. HEEx keeps its parallel walker. |

## Why reuse is tractable (research summary)

- The React walker primitives (`src/generator/react/walker/primitives/*`) are
  already **pack-template-driven**: they build view-models and call
  `renderPrimitive(ctx, "primitive-…", vm)`. They hardcode no JSX markup —
  the markup lives in the pack `.hbs` templates.
- The framework-divergent seams (state read/write, API call lowering, `match`,
  navigation, defaults) are already behind `WalkerTarget`
  (`src/generator/_walker/target.ts`), with `tsxTarget` and `heexTarget` as
  consumers.
- Svelte 5 is much closer to TSX than HEEx is: component invocation
  (`<Comp x={y}/>`), `{expr}` interpolation, and inline arrow-function event
  handlers are syntactically identical. The real deltas are:
  - control flow (`{#if}` / `{#each}` instead of ternaries / `.map()`) — lives
    almost entirely in **pack templates**, which Svelte packs own anyway;
  - comments (`<!-- -->` vs `{/* */}`) and text escaping — two or three small
    **new `WalkerTarget` seams**;
  - the page shell (a `.svelte` file with a `<script lang="ts">` block instead
    of a function component with hooks) — a **per-platform emitter**, like
    today's `walker/page-shell.ts`.
- Page objects and the `@loom/ui-test-driver` runtime are **framework-neutral**
  (testid/DOM only) — they work against a Svelte app unchanged as long as the
  Svelte packs emit the same `data-testid` values (gated by the testid
  tripwire, extended in Slice 7).

## Slices

Implemented in order on this branch, one commit (or a few) per slice; every
slice leaves `npm test` green. Byte-identical gates protect React/Phoenix
output through the refactor slices.

---

### Slice 1 — `platform: svelte` plumbing (stub emitter)

The full language→IR→platform thread, with a placeholder project emitter so
the registry's `Record<Platform, PlatformSurface>` stays total.

- `src/language/ddd.langium`: add `'svelte'` to the `Platform` rule and the
  `Framework` rule; `npm run langium:generate`; commit regenerated output.
- `src/ir/types/loom-ir.ts`: extend the `Platform` union; `uiFramework` gains
  `"svelte"`.
- `src/language/validators/data/platform-rules.ts`: `FRONTEND_KEYWORDS` +=
  `svelte`; `expectedFrameworkFor(svelte) = "svelte"`;
  `expectedPackFormatFor("svelte") = "svelte"` (new pack format).
- `src/language/validators/deployable.ts`: generalize rule 4b
  (`loom.react-deployable-missing-ui`) to all frontend platforms (svelte
  deployables must declare `ui:`); `targets:` rules apply automatically via
  `isFrontend`.
- `src/ir/lower/lower-deployment.ts`: design-pack defaulting — `svelte` →
  `shadcnSvelte`.
- New `src/platform/svelte.ts` (`name: "svelte"`, `isFrontend: true`,
  `needsDb: false`, `mountsUi: true`, `defaultPort: 3002`, `internalPort`
  3000, `VITE_API_BASE_URL` env like React); `emitProject` emits a minimal
  README stub until Slice 4. Register in `src/platform/registry.ts`.
- `src/system/e2e-render.ts`: `svelte` joins `react`/`static` in the
  UI-platform dispatch (Playwright path).
- Enrichment (`moduleNames` inheritance) and IR system-checks need **no
  change** — they key off `isFrontend`.
- Tests: parsing test for `platform: svelte`; negative validator tests
  (missing `ui:`, frontend-targets-frontend, design/format mismatch);
  registry lookup test.

**Gate:** `npm test` green; `langium-generated.yml` drift check clean.

---

### Slice 2 — Shared markup-walker extraction (byte-identical refactor)

Make the TSX walker core consumable by a second `{expr}`-interpolation
framework, without changing any output.

- Extend `WalkerTarget` with the minimal markup seams a non-JSX framework
  needs (exact list discovered during extraction; expected:
  `renderComment(text)`, `escapeText(text)`, possibly an empty-node/fragment
  shape). Implement on `tsxTarget` and `heexTarget`; update the contract test.
- Move the framework-neutral core out of `src/generator/react/` into
  `src/generator/_walker/`: the walk dispatch of `body-walker.ts`, the
  pack-driven primitive emitters (`walker/primitives/*`), `walker/shared/args.ts`,
  and `renderPrimitive`/import aggregation from `walker/context.ts`.
  `src/generator/react/body-walker.ts` becomes thin wiring that supplies
  `tsxTarget`. The registry's `tsx` renderer column becomes the shared
  markup-renderer column (renamed `markup`); `heex` stays as-is.
- Also relocate the **framework-neutral frontend builders** Svelte will need
  (`menu-emitter.ts` nav-data derivation, the zod-schema half of
  `api-builder.ts`, page-object shapes) into shared homes (`_walker/` or a new
  `src/generator/_frontend/`), since `generator/svelte/` must not import from
  `generator/react/`.

**Gate (primary):** all `test/generator/react/walker-*.test.ts` byte-identical;
baseline fixture diff empty
(`node bin/cli.js generate system examples/showcase.ddd -o /tmp/...` before vs
after); `LOOM_REACT_BUILD=1` showcase×mantine cell and `LOOM_PHOENIX_BUILD=1`
green. Same pattern as PRs #607–#627/#843.

---

### Slice 3 — `svelte` pack format groundwork

- `src/generator/_packs/required-primitives.ts`: add the `svelte` format set —
  same tiers as TSX (35 core + 7 shell + 11 fieldInput + 5 form + the three
  TSX-only extras: code-block, icon, modal), since Svelte packs own forms the
  way TSX packs do.
- `src/util/builtin-formats.ts`: register `shadcnSvelte@v1` and `flowbite@v1`
  with format `"svelte"`; `BUILTIN_PACK_LATEST` entries.
- `src/generator/_packs/loader-fs.ts`: shared-source dirs for the `svelte`
  format — new top-level `sveltekit/` (svelte.config, app.html, api client,
  logger, error page) + existing `docker/` (the dockerfile is already a
  neutral vite-build/vite-preview two-stage).
- New `stacks/sv1/`: `stack.json` + dep partials — `svelte ^5`,
  `@sveltejs/kit ^2`, `@sveltejs/adapter-static`, `@sveltejs/vite-plugin-svelte`,
  `vite`, `svelte-check`, `typescript`, `@tanstack/svelte-query`, `zod ^4`,
  `dayjs`, `loglevel`.
- Tests: extend `pack-required-primitives.test.ts` /
  `pack-manifest.test.ts` for the new format (negative case: svelte pack
  missing a required primitive fails at load).

**Gate:** `npm test` green (no generator yet — pure registry/loader surface).

---

### Slice 4 — Svelte generator core + project shell (empty app builds)

`src/generator/svelte/` orchestrator and the shadcnSvelte pack **shell tier**,
to the point where a `.ddd` with a svelte deployable and no pages emits a
SvelteKit project that passes `svelte-check` and `vite build`.

- `src/generator/svelte/index.ts` — `generateSvelteForContexts(...)`, mirroring
  the React orchestrator's shape.
- `src/generator/svelte/walker/svelte-target.ts` — `WalkerTarget` impl:
  state via `$state` (plain assignment writes), API via svelte-query handles,
  `renderMatch` via `{#if}/{:else if}` blocks (value-position arms keep
  ternaries), navigation via `goto()` (route state via SvelteKit shallow-state),
  JS zero-value defaults, `<!-- -->` comments.
- Pages-emitter skeleton mapping page slugs/params → `src/routes/<path>/+page.svelte`;
  `+layout.svelte` app shell from the pack (`app-shell` emit); `+error.svelte`.
- `designs/shadcnSvelte/v1/` shell tier: `pack.json` (format `svelte`, stack
  `sv1`), `package-json`, `tsconfig`, `vite-config`, `svelte-config`, `theme`,
  `main`/app-html, `format-helpers`, plus the shadcn-svelte source-copy
  scaffolding (`globals-css`, `lib-utils`, `components-ui-*` shellGlobs —
  translated from the existing `shadcn/v4` TSX pack).
- API layer: `src/api/<agg>.ts` per aggregate — zod schemas (shared builder
  from Slice 2) + `createQuery`/`createMutation` factories; `client.ts`,
  `config.ts` from the `sveltekit/` shared sources. **Validate
  `@tanstack/svelte-query` + Svelte 5 here**; if it fights runes, swap to the
  hand-rolled query helper without changing the generated call surface.

**Gate:** new opt-in suite `test/e2e/generated-svelte-build.test.ts`
(`LOOM_SVELTE_BUILD=1`, `npm run test:svelte-build`) — generates, `npm install`,
`svelte-check` + `vite build` — green for a minimal example; `npm test` green.

---

### Slice 5 — Walker primitives, scaffolded pages, and forms

The parity heart: every walker primitive renders through the shadcnSvelte
pack; scaffolded list/detail/new pages and explicit `ui` pages compile.

- shadcnSvelte primitive templates: all `primitive-*`, `field-input-*`,
  `form-*` emits (Svelte control flow in templates: `{#each}` table rows,
  `{#if}` toggles, `{@html}` for icon SVGs, `bind:value` field bindings).
- Svelte page shell (`page-shell` sibling): `<script lang="ts">` assembly —
  query/mutation handles, `$state` fields, `$derived` where derived state is
  needed, form-helper instantiation, imports.
- Forms runtime: generated `src/lib/form.svelte.ts` — `$state` form object,
  zod parse on submit, per-field error map (nested VO paths + field arrays),
  server-error application (mirrors `apply-server-errors.ts` semantics).
- Scaffolded pages (list/new/detail per aggregate) and explicit page bodies
  walk through the shared markup walker with `svelteTarget`.
- Svelte walker test suite: a representative `test/generator/svelte/` set
  (~12–15 files) covering each primitive group, forms, match, state mutation,
  navigation, testids — plus `svelteTarget` added to the walker-target
  contract test.

**Gate:** `LOOM_SVELTE_BUILD=1` green for `examples/showcase.ddd` ×
`shadcnSvelte@v1` (new svelte-deployable example file, see Slice 6 note);
`npm test` green.

---

### Slice 6 — Views, workflows, and remaining React-parity features

- View pages + view query hooks (`view-builder` sibling), workflow pages +
  mutation hooks (`workflow-builder` sibling), workflow instance views.
- Unions (`A or B` tagged wire), `paged`/`envelope` carriers, frontend ACL
  emission, access modifiers (editable/managed/internal/token/secret),
  transitive VO/enum zod schemas, money handling, formatters, named layouts,
  user-declared components (`src/lib/components/<X>.svelte`), `extern`
  component escape hatch, observability/logger parity.
- New example: `examples/svelte-showcase.ddd` (or a svelte deployable variant
  of showcase) — kept **separate from `showcase.ddd`** so the React/Phoenix
  baseline fixtures don't all recapture.
- Feature-parity audit against `docs/generators.md`'s React column; close or
  explicitly document any gap.

**Gate:** parity checklist in the PR description maps every React generator
feature to its Svelte counterpart or a documented exclusion;
`LOOM_SVELTE_BUILD=1` green on the full example.

---

### Slice 7 — Page objects, e2e dispatch, testid tripwire

- Page-object emission for svelte deployables (shared page-object builders
  from Slice 2; same testid contract, same `@loom/ui-test-driver` runtime).
- `test e2e "…" against <svelte-deployable>` lowers to Playwright (dispatch
  added in Slice 1; verify end-to-end here), including the generated
  `e2e/` harness in the emitted project.
- Extend `test/conformance/pack-testid-coverage.test.ts` to svelte packs
  (same allowlist policy as TSX).
- Docker-compose boot e2e for the svelte example: build the stack, hit `/`,
  run the generated Playwright specs (folded into the `LOOM_E2E` suite or a
  sibling `LOOM_SVELTE_E2E` gate, whichever keeps `test:e2e` runtimes sane).

**Gate:** Playwright specs pass against the booted svelte example.

---

### Slice 8 — Second pack: `flowbite@v1`

- `designs/flowbite/v1/` — full required-primitive set, npm-package
  distribution model (deps in `package-json.hbs` over the `sv1` stack
  partials, like Mantine over React stacks); `flowbite-svelte` +
  `flowbite-svelte-icons` (icon remap via a `helpers` table, like shadcn's
  `lucide` map); Tailwind shell files.
- Pack joins: required-primitives test, testid tripwire, svelte build matrix.

**Gate:** `LOOM_SVELTE_BUILD=1` green for the example set × `flowbite@v1`;
walker svelte tests pass against both packs where pack-sensitive.

---

### Slice 9 — Backend-host embedding

- Add `svelte` to `STATIC_BUNDLE_FRAMEWORKS` (`src/platform/surface.ts`) so
  static-asset hosts (react/static platform, dotnet with UI, elixir) can
  declare a svelte `ui:`.
- Verify the dotnet/elixir UI-mounting paths render svelte bundles (mirror of
  `embed-react-phoenix` coverage with a svelte variant);
  `expectedFrameworkFor` interplay for `dotnet`+svelte UI.
- Tests: `test/platform/hostable-frameworks.test.ts` extension + one embed
  test per host.

**Gate:** embed test(s) green; existing react embed tests unchanged.

---

### Slice 10 — CLI, CI, docs

- CLI: `ddd new --design shadcnSvelte|flowbite` scaffolds a svelte deployable
  (design implies frontend platform via pack format, as react packs do
  today); validation messages updated.
- CI: new `.github/workflows/generated-svelte-build.yml` —
  matrix `{examples × shadcnSvelte@v1, flowbite@v1}` running the
  `LOOM_SVELTE_BUILD` suite (PR slice + full matrix on main, mirroring
  `generated-react-build.yml`'s policy + matrix-sync test); svelte e2e gate
  wired per Slice 7's choice. Biome doesn't lint `.svelte` — generated
  `.ts` in svelte projects joins `test:biome-gen`; `.svelte` files rely on
  `svelte-check`.
- Docs: `docs/platforms.md`, `docs/design-packs.md` (svelte format +
  authoring), `docs/generators.md` (svelte column), `docs/language.md`
  (`platform: svelte`), `docs/decisions.md` (D-SVELTE-FRONTEND: reuse-not-fork,
  SvelteKit-static, forms decision), `CLAUDE.md` (pipeline table, pack list,
  CI surface), `experience_gathered.md` retro entry, and a status note in
  `platform-expansion-roadmap.md` (Svelte executed ahead of Vue; calibration
  answers for the Phase B questions).

**Gate:** full verification pass (below).

---

## Final verification

```bash
npm test                                   # incl. new svelte suites
LOOM_SVELTE_BUILD=1 npm run test:svelte-build   # examples × both svelte packs
LOOM_REACT_BUILD=1 npm run test:tsc-react       # unchanged React matrix
LOOM_TS_BUILD=1 npm run test:tsc                # backends unchanged
LOOM_E2E=1 npm run test:e2e                     # incl. svelte boot + Playwright
# byte-identical guard for the Slice 2 refactor (re-run on final state)
node bin/cli.js generate system examples/showcase.ddd -o /tmp/svelte-final
diff -r test/fixtures/baseline-output /tmp/svelte-final
```

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `@tanstack/svelte-query` × Svelte 5 runes friction | Validated first thing in Slice 4; the generated call surface is ours, so a hand-rolled `$state` query helper is a drop-in fallback. |
| Handlebars vs Svelte `{}` collisions in templates | Same class of problem the HEEx pack already solved with `.heex.hbs`; Svelte templates use `\{{…}}` escapes / `{{{raw}}}` deliberately; pack tests pin output. |
| `vite preview` SPA fallback for adapter-static deep links | `adapter-static` `fallback: "index.html"` + preview config; covered by the boot e2e hitting a deep route. |
| Walker extraction breaking React/Phoenix output | Byte-identical gate (fixture diff + walker tests) exactly as in PRs #607–#627/#843. |
| Library version drift (shadcn-svelte/bits-ui/flowbite pins) | Stack `sv1` pins ranges; `LOOM_SVELTE_BUILD` CI matrix catches breakage the way the React matrix does. |
| `match` arms containing markup can't be ternaries in Svelte | `svelteTarget.renderMatch` emits `{#if}` blocks; walker already places match output in child position. |
