# Frontend feature-parity audit

> Status: **empirical pass — 2026-06-21.**  Covers the four registered
> frontends (React, Vue, Svelte, Angular) plus the Phoenix LiveView
> (HEEx) fullstack render path, and every shipped design pack.
> Supersedes `pack-equivalence-audit.md` (2026-05-11), which predates
> the walker-primitive architecture, still calls Phoenix
> "phoenix-live-view", and only covered the two React packs.

This audit answers one question: **does the same `.ddd` page DSL produce
an equivalent app on every frontend target and every design pack?**  It
is evidence-based — every claim below was checked against the code on
fresh `main`, and the one genuine gap was reproduced with the CLI.

## Method

Parity is enforced (or not) at four layers, audited in order:

1. **Validator surface** — `src/language/walker-stdlib.ts` (50 closed
   primitives) is the name-only mirror the validator accepts. A page
   that type-checks here is *legal against any target*.
2. **Walker-target contract** — `src/generator/_walker/target.ts`
   (`WalkerTarget`). The framework-shaped lowering seams. A frontend
   reuses the shared walker core (`walker-core.ts`) by implementing this.
3. **Primitive dispatch table** — `src/generator/_walker/registry.ts`
   (`WALKER_PRIMITIVES`). Each primitive carries a `tsx` renderer (React
   / Vue / Svelte / Angular drive it) and a `heex` renderer (Phoenix).
4. **Pack required-set gate** — `src/generator/_packs/required-primitives.ts`.
   The load-time check that a pack ships every template its format needs.

The headline finding is a **seam between layers 1 and 4**: two primitives
the validator accepts (layer 1) are absent from every `RequiredSet`
(layer 4), so a `.ddd` using them passes validation but hard-crashes
codegen on Vue and Angular.

---

## 1. Frontend roster

| Frontend | `platform:` | Generator | Walker target | Default pack | Render model |
|---|---|---|---|---|---|
| React | `react` | `src/generator/react/` | `tsxTarget` | `mantine` | Vite SPA, React Query |
| Vue | `vue` | `src/generator/vue/` | `vueTarget` | `vuetify` | Vite SPA, vue-query |
| Svelte | `svelte` | `src/generator/svelte/` | `svelteTarget` | `shadcnSvelte` | SvelteKit static SPA, svelte-query |
| Angular | `angular` | `src/generator/angular/` | `angularTarget` | `angularMaterial` | Standalone Angular 22 SPA, TanStack Angular Query |
| Phoenix | `elixir` (LiveView) | `src/generator/elixir/` | `heexTarget` (parallel core) | `ashPhoenix` | Server-rendered HEEx |

The four JSX/markup frontends share **one** walker core
(`walker-core.ts`, `walkBody`). Phoenix runs a *parallel* core
(`heex-walker-core.ts`) because LiveView's output topology diverges
(hoisted `handle_event` clauses, `for`-comprehensions), but it dispatches
off the **same** `WALKER_PRIMITIVES` table, so there is no second
primitive list to drift.

---

## 2. Walker-target seam parity

`WalkerTarget` has **17 required** members and **12 optional** fork seams.
All four JSX targets implement every required seam — full contract parity:

| Seam group | Required seams | TSX | Vue | Svelte | Angular |
|---|---|:--:|:--:|:--:|:--:|
| State (read/write/nested-write) | 3 | ✅ | ✅ | ✅ | ✅ |
| API binding (hook-use/call/hoisting) | 3 | ✅ | ✅ | ✅ | ✅ |
| Match (value + child) | 2 | ✅ | ✅ | ✅ | ✅ |
| List comprehension (`renderForEach`) | 1 | ✅ | ✅ | ✅ | ✅ |
| Navigation (`renderNavigate`) | 1 | ✅ | ✅ | ✅ | ✅ |
| Type defaults | 1 | ✅ | ✅ | ✅ | ✅ |
| Markup (comment/interp/attr/cond-child/style/escape) | 6 | ✅ | ✅ | ✅ | ✅ |

The **optional** seams reveal each frontend's idiom — this is intended
divergence, not a gap:

| Optional seam | TSX | Vue | Svelte | Angular | Meaning |
|---|:--:|:--:|:--:|:--:|---|
| `renderRouteId` | ✅ | ✅ | ✅ | ✅ | route-`id` accessor (all override) |
| `formRuntimeImports` | – | – | ✅ | – | Svelte rides pack form imports |
| `renderChildrenSlot` | – | – | ✅ | ✅ | Svelte `{@render}`, Angular `<ng-content>` |
| `renderEventHandler` | – | – | – | ✅ | Angular `(click)` binds a statement, not a fn |
| `renderQueryDataAccess` | – | – | – | ✅ | Angular reads are signals (`data()`) |
| `renderNavigateExpr` | – | – | – | ✅ | Angular `router.navigateByUrl` |
| `renderCreateForm` | – | – | – | ✅ | **Angular forks all forms** → typed Reactive Forms |
| `renderAction` | – | – | – | ✅ | |
| `renderOperationForm` | – | – | – | ✅ | |
| `renderModal` | – | – | – | ✅ | |
| `renderWorkflowForm` | – | – | – | ✅ | |
| `renderDestroyForm` | – | – | – | ✅ | |

**React / Vue / Svelte** share the form pipeline (RHF-shaped for React,
hand-rolled `useLoomForm` for Vue, runes `createForm` for Svelte — but
all flow through the shared `field-input-*` / `form-*` pack templates).
**Angular** forks the entire form family into idiomatic typed Reactive
Forms via the seams above, so it ships **no** `field-input-*` / `form-of`
pack templates.

> Note: the "deferred / stubbed" comments in `angular/index.ts:106` and
> `angular/walker/angular-target.ts` are **stale** — the form seams
> (`renderAngularOperationForm`, `renderAngularModal`, …) are fully
> implemented (corrected in `generators.md` by #1470, but the inline
> comments still read "stubbed until Slice 4b"). Cosmetic; flagged in §6.

---

## 3. Primitive coverage

The closed library is **50 primitives** (`registry.ts`), each with a
`tsx` renderer. **HEEx parity is complete** — `heex-parity.test.ts`'s
`KNOWN_HEEX_GAPS` is now **empty**: every TSX-rendered primitive has a
HEEx renderer. This is a real improvement over the old audit, which
listed several DECLINED/DEFERRED HEEx gaps.

Most primitives are walker-inlined (forms, `For`, `Modal`, `QueryView`,
`Slot`, `Column`…) or dispatch through the pack as `primitive-*`. Of the
pack-dispatched primitives, three are **not** in any `RequiredSet`:

| Primitive | Dispatch | Guarded? | Verdict |
|---|---|---|---|
| `primitive-modal-controlled` | `pack.render` | ✅ `templates.has(...)` guard (`forms.ts:606`) | Safe — degrades gracefully |
| **`primitive-section`** (`Section`) | `pack.render`, **no guard** (`layout.ts` `emitSection`) | ❌ | **Gap — crashes Vue/Angular** |
| **`primitive-sticky`** (`Sticky`) | `pack.render`, **no guard** (`layout.ts` `emitSticky`) | ❌ | **Gap — crashes Vue/Angular** |

### Finding 1 (HIGH): `Section` / `Sticky` crash Vue and Angular codegen

`Section` and `Sticky` are in `walker-stdlib.ts` (validator accepts them
on **any** target) and in `WALKER_PRIMITIVES` with both `tsx` and `heex`
renderers. But they are absent from **every** `RequiredSet`, and their
`tsx` emitters call `renderPrimitive(...)` → `pack.render(...)` with **no
`templates.has` guard**.

Pack coverage:

| | React (mantine/shadcn/mui/chakra) | Svelte (shadcnSvelte/flowbite) | Vue (vuetify/shadcnVue) | Angular (angularMaterial) | Phoenix (ashPhoenix) |
|---|:--:|:--:|:--:|:--:|:--:|
| `primitive-section` | ✅ ships | ✅ ships | ❌ absent | ❌ absent | n/a (heex inline) |
| `primitive-sticky` | ✅ ships | ✅ ships | ❌ absent | ❌ absent | n/a (heex inline) |

Because the load-time `RequiredSet` gate doesn't list them, the missing
Vue/Angular templates aren't caught at pack-load; the failure happens at
the call site. Phoenix is unaffected — it renders via the registry `heex`
renderer (`renderSectionHeex` / `renderStickyHeex`), not a pack template.

**Reproduced** (fresh `main`, after `npm install` + `npm run build`):

```
# A .ddd page body using `Section { Heading { "Hi" } }`, webApp on platform: vue
$ node bin/cli.js generate system /tmp/section-repro.ddd -o /tmp/out
Error: loader: pack vuetify: no template registered for "primitive-section".
    at Object.emitSection [as tsx] (.../_walker/primitives/layout.js)

# Same body, webApp on platform: angular
Error: loader: pack angularMaterial: no template registered for "primitive-section".
```

The control (React/Mantine) and Svelte targets generate the same page
cleanly. `Section` is used today in `web/src/examples/multifile-marketing-lib.ddd`
(a React example), so the gap is latent — it only bites when that DSL is
retargeted to Vue or Angular.

**Two clean fixes** (this is a design call — see §7):

- **Close it:** add `primitive-section.hbs` + `primitive-sticky.hbs` to
  the two Vue packs and the Angular pack (and add the names to the `vue`
  / `angular` `RequiredSet`s so the gate enforces them going forward).
  This restores full primitive parity.
- **Gate it:** if `Section`/`Sticky` are deliberately React/Svelte-only,
  pin that — add a `templates.has` guard in `emitSection`/`emitSticky`
  (degrade like `modal-controlled`) **and** a validator rule rejecting
  them on `vue`/`angular` targets, so the constraint is a checked error,
  not a codegen crash.

Either way the invariant to restore is: **a page that passes validation
must generate on its target** (or fail validation, never codegen).

---

## 4. Design-pack inventory

| Family | Frontend | Versions | Stack | Default for |
|---|---|---|---|---|
| `mantine` | React | v7, v9 | v1 / v3 | `react` |
| `shadcn` | React | v3, v4 | v1 / v3 | — |
| `mui` | React | v5, v7 | v1 / v3 | — |
| `chakra` | React | v2, v3 | v1 / v3 | — |
| `vuetify` | Vue | v3 | vue1 | `vue` |
| `shadcnVue` | Vue | v1 | vue1 | — |
| `shadcnSvelte` | Svelte | v1 | sv1 | `svelte` |
| `flowbite` | Svelte | v1 | sv1 | — |
| `angularMaterial` | Angular | v1 | ng1 | `angular` |
| `ashPhoenix` | Phoenix HEEx | v3 | — | `elixir` (forced) |

**Pack-breadth asymmetry** (Finding 2, LOW): React has 4 families / 8
versions; Vue and Svelte have 2 families each; Angular has 1.
`primeng` and `spartanNg` are reserved in the grammar's `DesignPack` rule
but **not shipped** — Angular users have a single pack today. This is a
coverage/maturity gap, not a correctness bug.

Within a frontend, packs are equivalent at the systems level (same DDL →
working app); they diverge only in design-system identity (the
architectural rule from the old audit still holds).

---

## 5. Cross-cutting feature parity

These ride the shared `_frontend/` builders, so they are uniform across
React / Vue / Svelte / Angular unless noted:

| Feature | React | Vue | Svelte | Angular | Notes |
|---|:--:|:--:|:--:|:--:|---|
| Scaffold pages (list/detail/new/home) | ✅ | ✅ | ✅ | ✅ | macro layer, target-agnostic |
| CreateForm / OperationForm / WorkflowForm / DestroyForm | ✅ | ✅ | ✅ | ✅ | Angular via Reactive-Form seams |
| Operation modals | ✅ | ✅ (`op-dialog`) | ✅ (`{#snippet}`) | ✅ (signal-toggled) | |
| Find-filter live refetch | ✅ | ✅ | ✅ | ✅ | reactive-query seam for Vue/Svelte/Ng |
| Realtime channels (SSE + toast) | ✅ | ✅ | ✅ | ✅ | shared `_frontend/realtime.ts` |
| Views (`view` read models) | ✅ | ✅ | ✅ | ✅ | shared `_frontend/views-module.ts` |
| Workflows index/run pages | ✅ | ✅ | ✅ | ✅ | |
| Named layouts | ✅ | ✅ | ✅ | ✅ | nested routing per framework |
| User components | ✅ | ✅ | ✅ | ✅ | |
| Extern function / component hatch | ✅ | ✅ | ✅ | ✅ | typed signature stub |
| Auth UI | ✅ | ✅ | ✅ | ✅ | shared `_frontend/auth-ui.ts` |
| e2e page objects + smoke spec | ✅ | ✅ | ✅ | ✅ | shared `_frontend/` builders |

---

## 6. CI parity

| Frontend | Build gate | Runtime e2e gate |
|---|---|---|
| React | `generated-react-build.yml` (tsc, all examples × all packs) | ⚠️ none dedicated — boot/preview via `playground-e2e.yml` only |
| Vue | `generated-vue-build.yml` (vue-tsc + vite build) | ✅ `generated-vue-e2e.yml` (vite preview + Playwright) |
| Svelte | `generated-svelte-build.yml` (svelte-check + vite build) | ✅ `generated-svelte-e2e.yml` |
| Angular | `generated-angular-build.yml` (`ng build`) | ⚠️ **none** |

### Finding 3 (MEDIUM): e2e-CI parity gap

Vue and Svelte each have a dedicated runtime e2e workflow that
`vite preview`s the bundle and runs the emitted Playwright smoke spec.
**React and Angular have no equivalent generated-frontend runtime e2e.**
React gets partial boot/preview coverage through `playground-e2e.yml`;
Angular's only gate is `ng build` (typecheck + bundle). All four *emit*
the same page-object/smoke-spec surface, so the gap is in *exercising*
it, not generating it. Reusing the vue/svelte e2e harness for Angular
(and adding a per-pack react runtime leg) would equalize this.

---

## 7. Findings summary & recommendations

| # | Severity | Finding | Recommended action |
|---|---|---|---|
| 1 | **HIGH** | `Section`/`Sticky` pass validation but crash Vue & Angular codegen (ungated, not in any `RequiredSet`, no `templates.has` guard) | Decide close-vs-gate (§3); restore "validates ⇒ generates" invariant. Add the names to `RequiredSet` once resolved so the gate enforces it. |
| 2 | LOW | Pack breadth uneven (React 4 families, Vue/Svelte 2, Angular 1; `primeng`/`spartanNg` reserved but unshipped) | Roadmap item — ship the reserved Angular packs; not a correctness bug. |
| 3 | MEDIUM | No runtime-e2e CI for generated React or Angular apps (Vue/Svelte have it) | Extend the vue/svelte e2e harness to Angular; add a per-pack React runtime leg. |
| 4 | COSMETIC | Stale "stubbed/deferred" comments in `angular/index.ts` + `angular-target.ts` contradict the now-complete form seams | Refresh the comments. |

**Net assessment.** Contract-level parity is strong: all 17 required
`WalkerTarget` seams are implemented on all four JSX frontends, the
cross-cutting feature set (forms, realtime, views, workflows, layouts,
auth, e2e surface) is uniform, and HEEx primitive parity is now complete.
The one functional defect is Finding 1 — a real, reproducible crash that
violates the "validates ⇒ generates" invariant on two of the four
frontends. Findings 2–4 are maturity/coverage gaps, not correctness bugs.
