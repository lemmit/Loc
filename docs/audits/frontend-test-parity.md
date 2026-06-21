# Audit — test parity across generated frontends

*Snapshot: 2026-06-21, base `main` @ `9a5949b`. Empirical; reflects code on this branch, not aspirations.*

> **Update (2026-06-21, @ `86d55e8`):** every finding below is now resolved on
> `main` — **F3** by #1476 (React runtime e2e gate), **F1 + F2** by #1474
> (Angular emits the full Playwright suite + has its own runtime gate). The
> verdict/matrices have been refreshed to the post-fix state; the per-finding
> sections are kept (marked RESOLVED) as the record of what was wrong and how it
> was closed.

## Verdict

All four Vite SPAs — **React, Vue, Svelte, Angular** — are now at parity: each
emits the same Playwright test surface (page objects, route-driven
`smoke.spec.ts`, e2e harness) from the same shared `_frontend/` generators, and
each has both a build gate and a runtime `vite preview` + smoke gate. Angular
reuses React's `emitPageObjectsForUi` (like Vue), with one documented narrowing
— it skips *custom-walker* page objects (Angular forms render inline, so the
shared React TSX walker can't run against the angularMaterial pack); the
framework-neutral scaffold-archetype page objects still emit. Phoenix (HEEx) is
server-rendered and largely at parity via a *parallel reimplementation* of the
page objects (F4).

## What "test parity" means here

A generated frontend ships its own standalone Playwright suite under `e2e/`:

| Artifact | Emitted by |
|---|---|
| `e2e/pages/*.ts` — testid-keyed page objects (list/detail/new, workflow, view, custom-walker) | shared builders in `src/generator/_frontend/` (`page-objects-builder.ts`, `walker-page-objects.ts`, `workflow-page-object.ts`, `view-page-object.ts`) |
| `e2e/smoke.spec.ts` — route-driven smoke (every param-less page navigates + asserts URL) | `src/generator/_frontend/smoke-spec.ts` (framework-neutral) |
| `e2e/{fixtures,playwright.config,package.json,tsconfig}.ts/.json` | `src/generator/_frontend/e2e-harness.ts` |
| `<deployable>/e2e/<System>.ui.spec.ts` — the user's `test e2e ui … against <d>` block, driving the page objects | `src/system/ui-e2e-render.ts`, emitted from `src/system/index.ts:217` for **any** `mountsUi` deployable |

Parity = does each target emit the same set, from the same source, gated the
same way in CI.

## Emitted-artifact matrix

| Artifact | React | Vue | Svelte | **Angular** | Phoenix |
|---|:--:|:--:|:--:|:--:|:--:|
| Page objects (`e2e/pages/*`) | ✅ own emitter → shared `_frontend` builders | ✅ **reuses React's** `emitPageObjectsForUi` | ✅ own emitter → shared `_frontend` builders | ✅ **reuses React's** `emitPageObjectsForUi` (no custom-walker pages) | ✅ own reimpl (`elixir/page-objects-emit.ts`) |
| `smoke.spec.ts` | ✅ shared | ✅ shared | ✅ shared | ✅ shared | ❌ (server-rendered) |
| e2e harness (config/fixtures/pkg/tsconfig) | ✅ shared | ✅ shared | ✅ shared (pkg variant) | ✅ shared (pkg variant) | partial (fixtures via `system/index.ts`) |
| `<System>.ui.spec.ts` (from `test e2e ui`) | ✅ | ✅ | ✅ | ✅ (page objects now emitted) | ✅ |

Source: `src/generator/{react,vue,svelte,angular}/index.ts` each `out.set` the
five `e2e/*` files (react `index.ts:216–220`, vue `:359–363`, svelte
`:170–174`, angular `:301–305`, gated on the deployable mounting a `ui`).

## Generator sharing (good parity engineering)

- `smoke-spec.ts` and `e2e-harness.ts` are framework-neutral and shared by all
  three SPAs verbatim.
- Page-object **content** is shared: Svelte's `emitSveltePageObjectsForUi`
  (`routes-emitter.ts:298`) calls the same `buildPageObjectModule` /
  `buildWorkflowPageObject` / `buildViewPageObject` / `buildWalkerPageObject`
  from `_frontend/`; only the api-import path (`../../src/lib/api`) and walker
  target differ. Vue imports React's emitter outright
  (`vue/index.ts:47`). → React/Vue/Svelte page objects are structurally
  identical.

## CI-gating matrix

| Target | build/typecheck gate | runtime e2e gate (runs the emitted spec) |
|---|---|---|
| React | `generated-react-build.yml` (tsc) | `behavioral-ui-e2e.yml` runs the emitted **`*.ui.spec.ts`** (page-object round-trips); **`generated-react-e2e.yml`** (`vite preview` + emitted `smoke.spec.ts`) — added to close F3. |
| Vue | `generated-vue-build.yml` | `generated-vue-e2e.yml` — `vite preview` + emitted `smoke.spec.ts` |
| Svelte | `generated-svelte-build.yml` | `generated-svelte-e2e.yml` — `vite preview` + emitted `smoke.spec.ts` |
| **Angular** | `generated-angular-build.yml` (`ng build`) | `generated-angular-e2e.yml` — `vite preview` + emitted `smoke.spec.ts` (added by #1474) |

## Findings

### F1 — Angular emits no generated test surface *(major — RESOLVED by #1474)*
React/Vue/Svelte each ship a complete `e2e/` suite; Angular shipped none — a
generated Angular deployable had **no page objects, no smoke test, no Playwright
harness**, while the other three SPAs were testable out of the box. **Fixed**:
Angular's `index.ts` now reuses React's `emitPageObjectsForUi` and the shared
`smoke-spec.ts` / `e2e-harness.ts`, emitting `e2e/{pages/*, smoke.spec.ts,
fixtures.ts, playwright.config.ts, package.json, tsconfig.json}` whenever the
deployable mounts a `ui` (`angular/index.ts:283-306`). Custom-walker page
objects are intentionally skipped (Angular forms render inline, so the React TSX
walker can't run against the angularMaterial pack); scaffold-archetype page
objects still emit.

### F2 — `test e2e ui against <angular>` produced a broken project *(bug — RESOLVED by #1474)*
`src/system/index.ts` emits `<slug>/e2e/<System>.ui.spec.ts` for **every**
`mountsUi` deployable, and that spec imports page objects from `./pages/<agg>`
(`ui-e2e-render.ts`). Angular sets `mountsUi: true` but emitted no `e2e/pages/*`
modules, so the spec had dangling imports that couldn't compile or run.
**Fixed** as a consequence of F1: now that Angular emits matching page objects,
the `.ui.spec.ts` resolves like the other four UI-mounting platforms.

### F3 — React's route-driven `smoke.spec.ts` had no runtime CI gate *(minor — RESOLVED)*
Vue and Svelte each have a dedicated `generated-*-e2e.yml` that `vite preview`s
the bundle and runs the emitted `smoke.spec.ts`. React had no such workflow;
`behavioral-ui-e2e.yml` exercises the *`*.ui.spec.ts`* (a different, page-object
path), not the route smoke spec — so the React smoke spec was emitted but never
executed in CI. **Fixed**: `test/e2e/generated-react-e2e.test.ts` +
`generated-react-e2e.yml` (`showcase` → `console_web` × `{mantine@v7, shadcn@v4}`)
build the bundle, `vite preview` it, and run the emitted `smoke.spec.ts`,
mirroring the Vue/Svelte gate. `npm run test:react-e2e` runs it locally.

### F4 — Phoenix page objects are a parallel reimplementation *(watch)*
`elixir/page-objects-emit.ts` re-declares `buildAggregateListPageObject`,
`buildWorkflowFormPageObject`, etc. locally (reusing only `fillBlock` from
`_frontend/`), because HEEx output topology diverges. Justified, but it means
page-object changes must be made twice; divergence is only caught by the
heex-parity/conformance gates, not by a shared-builder compile error.

## Recommendations

All three findings (F1, F2, F3) are **resolved** (#1474, #1476). The only open
item is the standing watch:

- **F4** *(open, low priority)*: Phoenix page objects are a parallel
  reimplementation. Leave as-is, but consider a name-level pin (like the
  heex-parity freeze) so a new shared page-object builder forces a conscious
  Phoenix decision rather than silent drift.

Possible deepening (not a gap, an enhancement): the emitted `smoke.spec.ts` only
navigates *param-less* pages — `/x/:id` detail routes are skipped (no seeded
entity). Seeding one record and driving a detail page would close the largest
remaining runtime-coverage hole, uniformly across all four frontends.

## How to verify the resolved state

```bash
# F1/F2: Angular now emits the full e2e surface (page objects + smoke + harness)
grep -nE 'out\.set\("e2e|emitPageObjectsForUi|smoke\.spec' src/generator/angular/index.ts
ls .github/workflows/generated-angular-e2e.yml                          # runtime gate exists

# Every SPA emits the five e2e/* files
grep -nE 'out\.set\("e2e' src/generator/{react,vue,svelte,angular}/index.ts
```
