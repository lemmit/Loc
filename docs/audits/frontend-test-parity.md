# Audit — test parity across generated frontends

*Snapshot: 2026-06-21, base `main` @ `9a5949b`. Empirical; reflects code on this branch, not aspirations.*

## Verdict

The three Vite SPAs — **React, Vue, Svelte** — are at near-perfect test
parity: they emit the same Playwright test surface from the same shared
`_frontend/` generators. **Angular emits *zero* test artifacts** — no page
objects, no smoke spec, no e2e harness — and that gap is not merely missing
coverage: it produces a **broken generated project** when a system contains a
`test e2e ui … against <angular-deployable>` block (see F2). Phoenix (HEEx) is
server-rendered and largely at parity via a *parallel reimplementation* of the
page objects.

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
| Page objects (`e2e/pages/*`) | ✅ own emitter → shared `_frontend` builders | ✅ **reuses React's** `emitPageObjectsForUi` | ✅ own emitter → shared `_frontend` builders | ❌ **none** | ✅ own reimpl (`elixir/page-objects-emit.ts`) |
| `smoke.spec.ts` | ✅ shared | ✅ shared | ✅ shared | ❌ **none** | ❌ (server-rendered) |
| e2e harness (config/fixtures/pkg/tsconfig) | ✅ shared | ✅ shared | ✅ shared (pkg variant) | ❌ **none** | partial (fixtures via `system/index.ts`) |
| `<System>.ui.spec.ts` (from `test e2e ui`) | ✅ | ✅ | ✅ | ⚠️ **emitted but dangling** (F2) | ✅ |

Source: `src/generator/{react,vue,svelte}/index.ts` each `out.set` the five
`e2e/*` files (react `index.ts:216–220`, vue `:359–363`, svelte `:170–174`).
`grep -niE 'e2e/|smoke|playwright|page-object' src/generator/angular/` returns
**nothing** — Angular's `index.ts` emits app/api/docker files only.

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
| React | `generated-react-build.yml` (tsc) | `behavioral-ui-e2e.yml` runs the emitted **`*.ui.spec.ts`** (page-object round-trips). The route-driven **`smoke.spec.ts` is run by no workflow** (F3). |
| Vue | `generated-vue-build.yml` | `generated-vue-e2e.yml` — `vite preview` + emitted `smoke.spec.ts` |
| Svelte | `generated-svelte-build.yml` | `generated-svelte-e2e.yml` — `vite preview` + emitted `smoke.spec.ts` |
| **Angular** | `generated-angular-build.yml` (`ng build`) | **none** (nothing to run — no specs emitted) |

## Findings

### F1 — Angular emits no generated test surface *(major)*
React/Vue/Svelte each ship a complete `e2e/` suite; Angular ships none. A user
who generates an Angular deployable gets a project with **no page objects, no
smoke test, no Playwright harness**, while the other three SPAs are testable out
of the box. The DOM is *testable* (Angular pages do emit `data-testid`
attributes), but no page objects/specs target them.

### F2 — `test e2e ui against <angular>` produces a broken project *(bug)*
`src/system/index.ts:213-219` emits `<slug>/e2e/<System>.ui.spec.ts` (and
`e2e/fixtures.ts`) for **every** deployable whose platform `mountsUi` and has a
`uiName`. Angular's surface sets `mountsUi: true` (`src/platform/angular.ts:30`).
The emitted spec imports page objects — `import { … } from "./pages/<agg>"`
(`ui-e2e-render.ts:102`) — but the Angular generator emits **no `e2e/pages/*`
modules**. Result: a `.ui.spec.ts` with dangling imports that cannot compile or
run. The other four UI-mounting platforms (react/vue/svelte/phoenix) all emit
matching page objects, so this is Angular-specific. *This is the parity gap that
actually breaks codegen, not just thins coverage.*

### F3 — React's route-driven `smoke.spec.ts` has no runtime CI gate *(minor)*
Vue and Svelte each have a dedicated `generated-*-e2e.yml` that `vite preview`s
the bundle and runs the emitted `smoke.spec.ts`. React has no
`generated-react-e2e.yml`; `behavioral-ui-e2e.yml` exercises the
*`*.ui.spec.ts`* (a different, page-object path), not the route smoke spec. So
the React smoke spec is emitted but never executed in CI — an asymmetry, though
React's behavioral-ui tier gives it runtime coverage of another kind.

### F4 — Phoenix page objects are a parallel reimplementation *(watch)*
`elixir/page-objects-emit.ts` re-declares `buildAggregateListPageObject`,
`buildWorkflowFormPageObject`, etc. locally (reusing only `fillBlock` from
`_frontend/`), because HEEx output topology diverges. Justified, but it means
page-object changes must be made twice; divergence is only caught by the
heex-parity/conformance gates, not by a shared-builder compile error.

## Recommendations (in priority order)

1. **Fix F2 first** — either give Angular a page-object + harness emitter (port
   `emitSveltePageObjectsForUi`: same shared `_frontend` builders, Angular api
   import path + `angularTarget`), or, as a stopgap, gate the `.ui.spec.ts`
   emission in `system/index.ts` on the target actually emitting page objects so
   it never emits a dangling spec. The port is the parity-correct fix.
2. **Close F1** by reusing the shared generators: Angular's missing pieces are
   `smoke.spec.ts` (already framework-neutral — drop-in), the `e2e-harness.ts`
   constants (drop-in), and a page-object emitter modeled on Svelte's. Then add
   a `generated-angular-e2e.yml` mirroring the Vue/Svelte preview+smoke gate.
3. **F3**: add a `generated-react-e2e.yml` (or fold the React smoke spec into an
   existing preview job) for symmetry with Vue/Svelte.
4. **F4**: leave as-is, but add a name-level pin (like the heex-parity freeze)
   so a new shared page-object builder forces a conscious Phoenix decision.

## How to reproduce

```bash
# F1: Angular emits no e2e surface
grep -niE 'e2e/|smoke|playwright|page-object' src/generator/angular/   # -> nothing
grep -nE 'out\.set\("e2e' src/generator/{react,vue,svelte}/index.ts    # -> 5 files each

# F2: dangling ui spec
grep -n 'mountsUi' src/platform/angular.ts                              # mountsUi: true
sed -n '213,219p' src/system/index.ts                                   # emits .ui.spec.ts for any mountsUi+uiName
grep -n 'from "./pages/' src/system/ui-e2e-render.ts                    # spec imports e2e/pages/*
```
