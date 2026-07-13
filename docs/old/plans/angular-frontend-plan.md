# Angular frontend — implementation plan

> **Status: PLANNED — not yet executed.** Converts the vision proposal
> [`docs/old/proposals/angular-frontend.md`](../proposals/angular-frontend.md)
> into an actionable, slice-by-slice plan, recalibrated against the
> *current* codebase — where the shared markup-walker extraction, the Vue
> frontend, and the Svelte frontend have all landed since the proposal was
> written. Angular is the **fourth** frontend platform (`platform:
> angular`), reaching feature parity with React, with at least one Angular
> design pack.

Add **Angular (standalone components + signals)** as a frontend platform
(`platform: angular`) with feature parity to React/Vue/Svelte, plus three
Angular **design packs** (`angularMaterial` default + `primeng` enterprise
+ `spartanNg` modern/source-copy). A frontend is **not a domain-logic backend** — it
consumes the enriched `wireShape` and walks the page-DSL primitive bodies;
it runs no domain logic, so there is **no `render-expr` / `render-stmt`**
(same as React/Vue/Svelte). This plan supersedes the original proposal's
phasing where the two diverge (see "Recalibration vs the proposal").

## Recalibration vs the proposal (what changed since it was written)

The proposal predates Vue and Svelte shipping. Three of its assumptions
are now resolved by precedent:

1. **`embedded-frontend-composition` is NOT a blocking prerequisite.** The
   proposal made that reshape the keystone for *any* second frontend. In
   practice Vue and Svelte shipped backend-host embedding **without** it —
   `embedded-frontend-composition.md` is still `status: proposal /
   problem-framing`, yet `dotnet`/`elixir` hosts serve Vue and Svelte
   UIs today via `STATIC_BUNDLE_FRAMEWORKS`
   (`src/platform/surface.ts`) + the existing `hosts:` relation
   (D-PHOENIX-SURFACE). **Angular joins the same way** — add it to that
   set (Slice 8). No grammar reshape required.
2. **The shared markup walker already exists.** The proposal anticipated
   extracting a framework-neutral walker. That landed under
   `src/generator/_walker/` (`walker-core.ts`/`walkBody`, `target.ts`/
   `WalkerTarget`, `render-primitive.ts`, `primitives/*`) plus the
   framework-neutral frontend builders under `src/generator/_frontend/`.
   Angular consumes both unchanged and supplies an `angularTarget` — this
   is the Vue/Svelte path, not a new extraction.
3. **Angular is a markup/HTML-template framework — it reuses `walkBody`,
   it does NOT need a HEEx-style parallel engine.** Angular templates are
   HTML with `{{ }}` interpolation, `[prop]="expr"` / `(event)="expr"`
   bindings, element-style component invocation (`<app-card [x]="y" />`),
   and `@if`/`@for`/`@switch` control-flow blocks (Angular 17+). That is
   the same structural family as Vue (and Svelte), driven through the
   shared `walkBody` core with an `angularTarget`. The hoisted-clause HEEx
   engine (`heex-walker-core.ts`) is **not** the model here.

## Why Angular (unchanged from the proposal)

Angular completes the **enterprise pairing** — with the .NET and Java
backends, it is the frontend those shops reach for, and the one
structurally distinct frontend (opinionated module/DI/typed-service shape)
versus the JS-SPA culture React/Vue/Svelte share. Signals give the
walker's hardest seam (`state := …`) a read/write surface as clean as
React's `useState` — arguably cleaner, see below.

## Decisions (recommended — confirm before Slice 1)

These mirror the "Decisions (locked with the user)" tables the Vue and
Svelte plans opened with. Recommendations are pinned.

> **Idiomaticity over reuse-parity (calibration note).** An earlier draft
> of this table optimized two decisions (data layer, forms) for *generator
> reuse / parity with Vue+Svelte*. That is the wrong objective: Loom's
> product thesis is **idiomatic-per-ecosystem output** — a .NET/Java shop
> adopting Angular wants code that reads like Angular, not
> React-with-Angular-syntax. And the reuse cost was overstated: the
> architecture already isolates the framework-facing output (the
> per-platform page-shell and `angularTarget`) from the shared core (wire
> shape, `walkBody`, zod, page objects), so an idiomatic data/forms choice
> only swaps the `api-module`/form *builders* — which are per-platform by
> design. The data-layer and forms rows below were therefore flipped back
> toward the proposal's idiomatic picks; the second-pack row is a genuine
> taste call (marked **⚠ taste**).

| Decision | Recommendation | Notes |
|---|---|---|
| Component model | **Standalone components** (Angular ≥ 19, standalone-by-default) | No `NgModule` ceremony; `provideRouter`/`bootstrapApplication`. Proposal-aligned. |
| Reactivity for `state` | **Signals** (`signal()`/`set()`/`update()`/`computed()`) | Reads are `count()` **in every position** (template *and* class) — simpler than Vue's position-dependent `.value`; under-uses `renderStateRead`'s `position` param (harmless). Proposal-aligned. |
| `match` rendering | **`@switch` / `@if` control-flow blocks** | `@for (x of xs; track x.id)` for collections. Modern, less verbose than `*ngSwitch`/`*ngFor`. Proposal-aligned. |
| App shape / build | **Angular CLI standalone app**, `ng build` → static `dist/<app>/browser`, served by a tiny static server in the docker runtime stage | The one real structural break from Vue/Svelte: Angular does **not** ride the shared `vite build`/`vite preview` `docker/` two-stage. See Slice 2 + Risks. |
| API layer / DI | **DI-native** — the API client + per-aggregate access as `@Injectable({ providedIn: 'root' })` services consumed via `inject()` | DI is the heart of Angular; the other frontends' module-scope functions/hooks/composables are not the Angular shape. The shared `_frontend/api-module.ts` gains an Angular-idiomatic injectable-service builder variant (per-platform output, like the page-shell). zod schemas reuse unchanged. |
| Data layer | **`@Injectable` services returning `Observable<T>` via `HttpClient`, consumed with `toSignal()`** (or the `async` pipe) | The version-proof, zero-experimental-surface idiomatic floor — stable across every modern Angular (v16+), DI-native, signal-shaped at the call site. No special version pin (any current major). **`httpResource()`/`rxResource()` is a forward-path opt-in** (a drop-in upgrade behind the same generated component shape) *once it's marked stable* — not led with, since it's still experimental-branded (and leading with it would repeat the very experimental-API objection that rules out `@tanstack/angular-query-experimental`, which is also rejected as a React-culture transplant). |
| Forms | **Typed Reactive Forms** (`FormGroup<{…}>` / `FormControl` / `Validators`, strictly-typed since v14) | THE idiomatic, generator-friendly Angular forms story — a typed `FormGroup` is mechanical codegen from the wire shape. Server field errors map onto `control.setErrors(...)` (same `apply-server-errors` semantics as the other frontends, different sink). Observable→signal bridge via `toSignal(form.valueChanges)`. (A hand-rolled signal-form object — the Svelte/Vue shape — is an anti-pattern in Angular; rejected.) |
| Frontend ACL / auth | **Functional route guards** (`CanActivateFn` + `inject(SessionService)`) on the generated route table + `@if` on a session signal in templates | More idiomatic than porting React's render-time gate component; slots into the `provideRouter` route table this plan already emits. `_frontend/auth-ui.ts` gains an `AUTH_GUARD_ANGULAR` + session service variant. |
| Design packs | **Three: `angularMaterial@v1` (default) + `primeng@v1` + `spartanNg@v1`** | Enterprise + modern spread, no artificial two-pack cap. `angularMaterial` — first-party (Google), default, safest enterprise baseline (npm-model). `primeng` — most-deployed enterprise Angular suite (npm-model). `spartanNg` — modern Tailwind + source-copy (the shadcn-for-Angular analog, mirrors the shadcn/shadcnVue/shadcnSvelte packs). Cost is linear: each pack ≈ 1.5–2.5k LOC + a CI matrix cell + required-primitives coverage, so three ≈ one extra pack over the two-pack baseline the other frontends shipped. |
| Default pack | A `platform: angular` deployable without `design:` defaults to **`angularMaterial`** | `lower-deployment.ts` defaulting, mirroring `svelte → shadcnSvelte`, `vue → vuetify`. |
| Walker strategy | **Reuse, not fork**: drive the shared `walkBody` core with an `angularTarget`; HEEx keeps its parallel engine | Angular is a `{{…}}`/`[bind]`/`(event)` HTML-template framework, structurally like Vue. |

## Resource claims (no collisions with react/svelte/vue)

| Resource | Value | Existing |
|---|---|---|
| `defaultPort` | **3004** | react 5173-ish, svelte 3002, vue 3003 |
| `internalPort` | 3000 | (frontend convention) |
| Stack id | **`ng1`** | `v1/v2/v3` (react), `sv1` (svelte), `vue1` (vue) |
| Pack format id | **`"angular"`** | `"tsx"`, `"heex"`, `"svelte"`, `"vue"` |
| Shared-source dir | **`angular/`** (+ `api/`; **not** the vite `docker/`) | `vite`+`api`+`docker` (tsx), `sveltekit` (svelte), `vue`+`api`+`docker` (vue) |

## What reuses vs what's new (anchored to the current code)

| Layer | Angular |
|---|---|
| Enriched `wireShape` (DTO field order) | **Reuse** — identical to react/vue/svelte. |
| Page-DSL primitive **registry** (`src/generator/_walker/registry.ts`) + name-only mirror (`src/language/walker-stdlib.ts`) | **Reuse** — closed, framework-neutral set. |
| Shared `walkBody` core (`src/generator/_walker/walker-core.ts`) | **Reuse** — drive with `angularTarget`. |
| `WalkerTarget` contract (`src/generator/_walker/target.ts`) | **Reuse the contract** — implement `angularTarget`. The 18 seams already exist (`renderStateRead/Write`, `renderApiCall/Hoisting`, `buildHookUse`, `renderMatch/MatchChild`, `renderForEach`, `renderNavigate`, `defaultInitFor`, `renderComment`, `renderInterpolation`, `renderAttrBinding`, `renderConditionalChild`, `renderStyleAttr`, `escapeText`, optional `formRuntimeImports`/`renderChildrenSlot`). Angular fills them with `[prop]`/`(event)`/`@if`/`@for`/signal syntax. **Expectation: no new seam** (Vue validated the position-aware reads; Svelte added the markup seams). If Angular's `(event)` inline-handler restriction forces one, add it once on the contract + all targets. |
| Framework-neutral frontend builders (`src/generator/_frontend/`: `api-module.ts`, `zod-schemas.ts`, `views-module.ts`, `workflows-module.ts`, `menu-emitter.ts`, `page-objects-builder.ts`, `walker-page-objects.ts`, `theme-preparer.ts`, `smoke-spec.ts`, `e2e-harness.ts`, `extern-functions.ts`, `realtime.ts`, `auth-ui.ts`) | **Reuse** — Angular adds an `AUTH_GUARD_ANGULAR` (functional `CanActivateFn` route guard) + session-service variant to `auth-ui.ts`, an injectable-service variant to `api-module.ts`, and an `E2E_PACKAGE_JSON_ANGULAR` to `e2e-harness.ts`, the way Vue/Svelte each added their variants. Page objects + `@loom/ui-test-driver` are framework-neutral (testid/DOM only). |
| `WalkerTarget` impl `angular-target.ts` | **New** — `src/generator/angular/walker/angular-target.ts`. |
| Generator orchestrator | **New** — `src/generator/angular/index.ts` (`generateAngularForContexts(...)`), plus siblings mirroring vue/svelte (`walker/page-shell.ts`, `routes-emitter.ts`, `layouts-emitter.ts`, `realtime-handlers-builder.ts`, `emit-templates.ts`). |
| `PlatformSurface` | **New** — `src/platform/angular.ts`; register in `src/platform/registry.ts`. |
| Design pack(s) | **New** — `designs/angularMaterial/v1/` + `designs/primeng/v1/` + `designs/spartanNg/v1/`. The dominant variable cost. |
| Angular project scaffold | **New** — `angular/` shared-source dir (`angular.json`, `tsconfig*`, `main.ts` bootstrap, `index.html`, api `client.ts`/`config.ts`, logger, error component, **dockerfile** — Angular's own build/serve) + `stacks/ng1/` dep manifest. |

No `render-expr.ts` / `render-stmt.ts` — frontend.

## Slices

In order; one commit (or a few) per slice; every slice leaves `npm test`
green. Angular adds output, so there is **no byte-identical refactor
gate** here (unlike the original walker extraction) — but the
React/Phoenix/Vue/Svelte baseline fixtures must stay zero-drift through
every shared-file touch (any change to `_walker/`/`_frontend/`/`surface.ts`
re-runs the fixture diff).

---

### Slice 0 — Prerequisite check (shared walker already in base)

The shared `walkBody` core, `WalkerTarget`, and `_frontend/` builders are
on `main`. **No extraction work** — this slice is just confirming the base
(`src/generator/_walker/walker-core.ts` exports `walkBody`;
`src/generator/_frontend/` holds the neutral builders) and rebasing onto
`main`.

**Gate:** shared core present; fast suite green on base.

---

### Slice 1 — `platform: angular` plumbing (stub emitter)

The full language→IR→platform thread, with a placeholder project emitter
so the registry's `Record<Platform, PlatformSurface>` stays total.

- `src/language/ddd.langium`: add `'angular'` to the `Platform` rule
  (line ~306) and the `Framework` rule (line ~292); `npm run
  langium:generate`; **commit regenerated `src/language/generated/`**.
- `src/ir/types/loom-ir.ts`: extend the `Platform` union (line ~2118) with
  `"angular"`; `uiFramework` accepts `"angular"`.
- `src/language/validators/data/platform-rules.ts`: `FRONTEND_KEYWORDS`
  (line 38) += `"angular"`; `expectedFrameworkFor(angular) = "angular"`
  (line ~116); `expectedPackFormatFor("angular") = "angular"` (line ~137,
  new pack format).
- `src/language/validators/deployable.ts`: angular deployables must
  declare `ui:` — already generalized to all `isFrontend` platforms
  (Svelte Slice 1); `targets:` rules apply automatically via `isFrontend`.
- `src/ir/lower/lower-deployment.ts`: design-pack defaulting (lines
  ~88–119) — `platform === "angular"` → `"angularMaterial"`; and in the
  fullstack-host-serving-different-UIs branch, `uiFramework === "angular"`
  → `"angularMaterial"`.
- New `src/platform/angular.ts` — `name: "angular"`, `isFrontend: true`,
  `needsDb: false`, `mountsUi: true`, `defaultPort: 3004`, `internalPort:
  3000`, `dependsOnDb: false`, `healthPath: "/"`, `hostableFrameworks:
  STATIC_BUNDLE_FRAMEWORKS`, `reservedRepositoryFindNames: new Set()`,
  `env: [["VITE_API_BASE_URL", …]]` (the api base env, name kept for
  parity; Angular reads it at build/runtime config). `emitProject` emits a
  minimal README stub until Slice 3. Register `angular: angularPlatform`
  in `src/platform/registry.ts`.
- `src/system/e2e-render.ts`: `angular` joins the UI-platform dispatch
  (Playwright path), alongside react/vue/svelte/static.
- Enrichment (`moduleNames` inheritance) + IR system-checks need **no
  change** — they key off `isFrontend`.
- Tests: parsing test for `platform: angular`; negative validator tests
  (missing `ui:`, frontend-targets-frontend, design/format mismatch);
  registry lookup test.

**Gate:** `npm test` green; `langium-generated.yml` drift check clean.

---

### Slice 2 — `angular` pack format groundwork + project scaffold

- `src/generator/_packs/required-primitives.ts`: add the `angular` format
  set — same tiers as TSX (the `SHARED_PRIMITIVES` core + shell +
  fieldInput + form + the TSX-only extras code-block/icon/modal), since
  Angular packs own forms the way TSX/Vue/Svelte packs do.
- `src/util/builtin-formats.ts`: add `"angular"` to the `PackFormat` union
  (line ~31); register `angularMaterial@v1`, `primeng@v1`, `spartanNg@v1` with
  format `"angular"` in `BUILTIN_PACK_FORMATS` + `BUILTIN_PACK_LATEST`.
- `src/generator/_packs/loader-fs.ts`: `SHARED_SOURCE_DIRS_ANGULAR =
  ["angular", "api"]` — a **new top-level `angular/`** dir (index.html,
  `main.ts` bootstrap via `bootstrapApplication`, `app.config.ts`
  `provideRouter`/`provideHttpClient`, api `client.ts`/`config.ts`,
  logger, error component, **its own dockerfile** — `ng build` then serve
  `dist/<app>/browser` with a static server) + the existing neutral `api/`
  dir. **Note the divergence:** Angular does *not* include the shared
  vite `docker/` dir (that two-stage assumes `vite build`/`vite preview`).
- New `stacks/ng1/`: `stack.json` + dep partials — `@angular/core`,
  `@angular/common` (provides `HttpClient`; `httpResource` too, if opted in),
  `@angular/router`, `@angular/forms` (Reactive Forms),
  `@angular/platform-browser`, `@angular/build` (or `@angular-devkit/build-angular`),
  `@angular/cli`, `typescript`, `zod`, `dayjs`, `loglevel`. **No external
  data-layer dep** — reads use `HttpClient` (in `@angular/common`) +
  `toSignal()` (`@angular/core/rxjs-interop`). Pin a **current Angular
  major** (e.g. `^20`) — no special floor, the data/forms/state APIs are
  all long-stable; the `httpResource` opt-in would only raise the floor if
  adopted later. (Material / PrimeNG / spartan deps live in each pack's
  `package-json.hbs` over these partials, like Vuetify over `vue1`.)
- Tests: extend `pack-required-primitives.test.ts` / `pack-manifest.test.ts`
  for the new format (negative: an angular pack missing a required
  primitive fails at load).

**Gate:** `npm test` green (no generator yet — pure registry/loader surface).

---

### Slice 3 — Angular generator core + project shell (empty app builds)

`src/generator/angular/` orchestrator + the `angularMaterial` pack
**shell tier**, to where a `.ddd` with an angular deployable and no pages
emits an Angular project that passes `ng build` (strict `tsc`).

- `src/generator/angular/index.ts` — `generateAngularForContexts(...)`,
  mirroring the Vue orchestrator's shape (pack load, per-aggregate API
  modules, pages, page objects, app shell, shell files).
- `src/generator/angular/walker/angular-target.ts` — `WalkerTarget` impl:
  - **state** via signals: `renderStateRead` → `name()` (position-
    independent — return the call form in both template and class
    position); `renderStateWrite` → `name.set(value)` (or `.update(...)`
    for functional updates).
  - **API** via signal data handles hoisted in the component class —
    `toSignal(service.findAll())` reads off an `inject()`-ed `@Injectable`
    API service returning `Observable<T>` (mutations call the service
    method directly), per the DI-native data-layer decision.
    (`httpResource` is the same shape if/when opted in.)
  - `renderMatch` → `@switch (expr) { @case (v) { … } @default { … } }`;
    value-position arms keep ternaries.
  - `renderForEach` → `@for (item of coll; track item.id) { … }`.
  - `renderNavigate` → `inject(Router).navigate([...])` (route state via
    navigation extras / input-binding).
  - `renderInterpolation` → `{{ jsExpr }}`; `renderAttrBinding` →
    `[name]="jsExpr"`; `renderConditionalChild` → `@if (cond) { … } @else
    { … }`; `renderComment` → `<!-- … -->`; `escapeText`/`renderStyleAttr`
    Angular-shaped; JS zero-value `defaultInitFor`.
- Angular **page shell** (`walker/page-shell.ts`): a `@Component({
  standalone: true, selector, imports: [...], template: \`…\` })` **class**
  — signal fields, injected services/query handles, methods, the walked
  body as the inline `template`. (The class body is the `<script setup>`
  analog.)
- Routes: `routes-emitter.ts` maps page slugs/params → a generated
  `app.routes.ts` route table (`{ path, loadComponent }`), lazy standalone
  components; route params via signal `input()` (with
  `withComponentInputBinding`) or `ActivatedRoute`. App shell component +
  error/catch-all route from the pack (`app-shell` emit).
- API layer: `src/api/<agg>.ts` per aggregate — zod schemas (shared
  `_frontend/zod-schemas.ts`) + an `@Injectable({ providedIn: 'root' })`
  service exposing typed methods over the shared client (Angular-idiomatic
  variant of `_frontend/api-module.ts`); `client.ts`/`config.ts` from the
  `angular/` shared sources. The service returns `Observable<T>` over the
  shared client; components read via `toSignal()`. (No experimental data
  primitive on the critical path; `httpResource` is an optional later
  upgrade behind the same consuming component shape.)
- `designs/angularMaterial/v1/` shell tier: `pack.json` (format `angular`,
  stack `ng1`), `package-json` (`@angular/material` + `@angular/cdk` +
  `@angular/material/...` theme), `tsconfig`/`tsconfig.app`,
  `angular-json`, `theme` (Material theme css), `main`/index-html,
  `app-shell` (mat-toolbar / mat-sidenav-container), `format-helpers`.

**Gate:** new opt-in suite `test/e2e/generated-angular-build.test.ts`
(`LOOM_ANGULAR_BUILD=1`, `npm run test:angular-build`) — generates, `npm
install`, `ng build` — green for a minimal example; `npm test` green.

---

### Slice 4 — Walker primitives, scaffolded pages, and forms

The parity heart: every walker primitive renders through the
`angularMaterial` pack; scaffolded list/detail/new pages and explicit `ui`
pages compile.

- `angularMaterial` primitive templates: all `primitive-*`,
  `field-input-*`, `form-*` emits (Angular control flow in templates:
  `@for` table rows, `@if` toggles, `[(ngModel)]` or signal-bound field
  inputs, `(click)` handlers; Handlebars↔Angular `{{ }}` collision handled
  with `\{{…}}` escapes — **identical mitigation to the Vue pack**, see
  Risks).
- Angular page shell assembly: signal fields, `computed()` where derived
  state is needed, query/mutation handles, form-helper instantiation,
  `imports: [...]` standalone import aggregation.
- Forms: **typed Reactive Forms** — per command, emit a typed
  `FormGroup<{…}>` built from the wire shape (nested `FormGroup` for VOs,
  `FormArray` for field arrays), with `Validators` from the field
  constraints; submit reads `form.getRawValue()`. Server field errors apply
  via `control.setErrors(...)` (the `apply-server-errors` semantics, Angular
  sink). A small generated `src/lib/forms.ts` holds the shared error-mapping
  helper; `toSignal(form.valueChanges)` bridges to the signal world where a
  template needs reactive reads.
- Scaffolded pages (list/new/detail per aggregate) + explicit page bodies
  walk through the shared `walkBody` with `angularTarget`.
- Angular walker test suite: a representative `test/generator/angular/`
  set (~12–16 files, matching the Vue suite's breadth) covering each
  primitive group, forms, match, state mutation, navigation, testids —
  plus `angularTarget` added to the walker-target contract test.

**Gate:** `LOOM_ANGULAR_BUILD=1` green for the showcase-scale example ×
`angularMaterial@v1` (angular-deployable example file, see Slice 5);
`npm test` green.

---

### Slice 5 — Views, workflows, and remaining React-parity features

- View pages + view query handles (`view-builder` via shared
  `_frontend/views-module.ts`), workflow pages + mutation handles
  (`workflow-builder` via `_frontend/workflows-module.ts`), workflow
  instance views.
- Unions (`A or B` tagged wire), `paged`/`envelope` carriers, frontend ACL
  emission as **functional route guards** (`CanActivateFn` +
  `inject(SessionService)` on the route table) + `@if`-on-session-signal in
  templates (`_frontend/auth-ui.ts` + `AUTH_GUARD_ANGULAR` / session
  service), access modifiers
  (editable/managed/internal/token/secret), transitive VO/enum zod
  schemas, money handling, formatters, named layouts (`layouts-emitter.ts`
  → nested router routes with an inner `<router-outlet>` as the `main`
  slot), user-declared components (`src/components/<X>.ts` standalone
  component, body walks through the shared walker), `extern` component
  escape hatch (typed `<Name>Props` + a `.ts` shim, mirroring Vue),
  channels/realtime toast manager (`realtime-handlers-builder.ts` +
  `_frontend/realtime.ts`), observability/logger parity.
- New example: `examples/angular-showcase.ddd` (angular deployable variant
  of showcase) — kept **separate from `showcase.ddd`** so the
  React/Phoenix/Vue/Svelte baseline fixtures don't recapture.
- Feature-parity audit against `docs/generators.md`'s React column; close
  or explicitly document any gap.

**Gate:** parity checklist in the PR maps every React generator feature to
its Angular counterpart or a documented exclusion; `LOOM_ANGULAR_BUILD=1`
green on the full example.

---

### Slice 6 — Page objects, e2e dispatch, testid tripwire

- Page-object emission for angular deployables (shared
  `_frontend/page-objects-builder.ts` + `walker-page-objects.ts`; same
  testid contract, same `@loom/ui-test-driver` runtime). Angular packs
  emit the same `data-testid` values (`data-testid="…"` static, or
  `[attr.data-testid]` when bound).
- `test e2e "…" against <angular-deployable>` lowers to Playwright
  (dispatch added in Slice 1; verify end-to-end here), including the
  generated `e2e/` harness (`_frontend/e2e-harness.ts` +
  `E2E_PACKAGE_JSON_ANGULAR`, `_frontend/smoke-spec.ts`).
- Extend `test/conformance/pack-testid-coverage.test.ts` to angular packs
  (same allowlist policy as TSX/vue).
- Runtime e2e for the angular example: `ng build`, serve the static
  bundle, run the emitted Playwright smoke against the live app —
  **sibling-gate** shape (`generated-angular-e2e.yml` / `LOOM_ANGULAR_E2E`),
  matching `generated-vue-e2e` / `generated-svelte-e2e`. Pure client-side
  (no backend/docker; the smoke asserts navigation + a visible body).

**Gate:** Playwright smoke passes against the served angular example.

---

### Slice 7 — Additional packs: `primeng@v1` (enterprise) + `spartanNg@v1` (modern)

The two packs beyond the `angularMaterial` baseline, giving the
enterprise + modern spread. Can land as two commits (PrimeNG first — the
npm-model is closer to `angularMaterial`, so it shakes out the pack-format
surface; spartan second — the source-copy model adds the Tailwind shell).

- `designs/primeng/v1/` — full required-primitive set, **npm-package**
  model, deps in `package-json.hbs` over `ng1` (PrimeNG + PrimeIcons +
  a theme preset); the most-deployed enterprise Angular suite.
- `designs/spartanNg/v1/` — full required-primitive set, **source-copy**
  model (the shadcn-for-Angular analog: spartan brain/helm + Tailwind),
  translated primitive-by-primitive; Tailwind shell files; `lucide-angular`
  icon remap via a `helpers` table (like shadcn's `lucide` map).
- Each pack joins: required-primitives test, testid tripwire, the angular
  build matrix (one CI cell each).

**Gate:** `LOOM_ANGULAR_BUILD=1` green for the example set × both new packs;
walker angular tests pass across all three packs where pack-sensitive.

---

### Slice 8 — Backend-host embedding

- Add `"angular"` to `STATIC_BUNDLE_FRAMEWORKS` (`src/platform/surface.ts`,
  line 37) so static-asset hosts (react/static platform, dotnet with UI,
  elixir) can declare an angular `ui:`. (Set-extension both Vue and Svelte
  already touched — extend, don't re-derive.)
- Verify the dotnet/elixir UI-mounting paths serve the angular static
  bundle (mirror of the `embed-react-phoenix` / vue / svelte coverage with
  an angular variant); `expectedFrameworkFor` interplay for `dotnet` +
  angular UI. **Mind the build delta:** the host's asset-copy step takes
  Angular's `dist/<app>/browser` output, not a `vite` `dist/`.
- Tests: `test/platform/hostable-frameworks.test.ts` extension + one embed
  test per host.

**Gate:** embed test(s) green; existing react/vue/svelte embed tests
unchanged.

---

### Slice 9 — CLI, CI, docs

- CLI: `ddd new --design angularMaterial|spartanNg` scaffolds an angular
  deployable (design implies frontend platform via pack format, as the
  other packs do); validation messages updated.
- CI: new `.github/workflows/generated-angular-build.yml` — matrix
  `{examples × angularMaterial@v1, primeng@v1, spartanNg@v1}` running the
  `LOOM_ANGULAR_BUILD` suite (PR slice + full matrix on main, mirroring
  `generated-react-build.yml`'s policy + matrix-sync test);
  `generated-angular-e2e.yml` per Slice 6. Biome doesn't lint Angular
  `.html` templates — generated `.ts` joins `test:biome-gen`; templates
  rely on `ng build` strict template type-checking.
- Docs: `docs/platforms.md`, `docs/design-packs.md` (angular format +
  authoring), `docs/generators.md` (angular column), `docs/language.md`
  (`platform: angular`), `docs/decisions.md` (**D-ANGULAR-FRONTEND**:
  reuse-not-fork walker, Angular-CLI static SPA + own docker stage, and the
  *idiomatic-over-reuse* decisions — signals state, DI-native injectable
  services + `HttpClient`/`toSignal` data (`httpResource` as a later
  opt-in), typed Reactive Forms, `CanActivateFn` ACL, three packs), `CLAUDE.md` (pipeline table, pack
  list, CI surface), `experience_gathered.md` retro entry, and a status
  flip on this plan + the proposal (`docs/old/proposals/angular-frontend.md`).

**Gate:** full verification pass (below).

---

## Final verification

```bash
npm test                                       # incl. new angular suites
LOOM_ANGULAR_BUILD=1 npm run test:angular-build # examples × all three angular packs
LOOM_REACT_BUILD=1  npm run test:tsc-react      # unchanged React matrix
LOOM_VUE_BUILD=1    npm run test:vue-build       # unchanged Vue matrix
LOOM_SVELTE_BUILD=1 npm run test:svelte-build    # unchanged Svelte matrix
LOOM_TS_BUILD=1     npm run test:tsc             # backends unchanged
# zero-drift guard for every shared-file touch (re-run on final state)
node bin/cli.js generate system examples/showcase.ddd -o /tmp/angular-final
diff -r test/fixtures/baseline-output /tmp/angular-final
```

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Handlebars `{{ }}` vs Angular `{{ }}` interpolation collide directly (same class as Vue) | Every Angular-interpolation site in pack templates uses `\{{…}}` escapes (Handlebars renders the literal); the pack tests grep compiled output for unrendered `{{` artifacts; pack tests pin output byte-exact. **Reuse the Vue pack's exact mitigation.** |
| Angular `(event)="…"` template-expression restriction (no arbitrary statements) blocks an inline handler the walker emits | Signals make the common cases inline-able (`(click)="count.set(count()+1)"`). For anything the template grammar rejects, the page-shell hoists a class method and `angularTarget` references it — a known seam shape (the API-hoisting path already does this). Only if a *new* seam is unavoidable, add it once on `WalkerTarget` + all targets. |
| Data-layer maturity (avoid generating onto an experimental API) | Default to `HttpClient` + `toSignal()` — long-stable (v16+), zero experimental surface, no special version pin. `httpResource`/`rxResource` are an opt-in *upgrade* behind the same generated component shape, taken only once marked stable. (TanStack Angular Query rejected as a React-culture transplant.) |
| Reactive Forms (observable-based) vs the signals-everywhere model | `toSignal(form.valueChanges)` bridges where a template needs reactive reads; typed `FormGroup` construction is mechanical codegen and `ng build` strict-typing catches shape drift. Reactive Forms is the rock-solid, version-proof idiomatic choice (stable since v14). |
| Angular doesn't ride the shared vite `docker/` two-stage (`ng build`, not `vite build`/`preview`) | Angular brings its **own** dockerfile in the `angular/` shared-source dir — `ng build` → serve `dist/<app>/browser` with a tiny static server; the embed path (Slice 8) copies that `browser/` dir. Isolated to one dockerfile + the host asset-copy step; covered by `LOOM_ANGULAR_BUILD` + the embed tests. |
| Standalone `imports: [...]` aggregation drift (a primitive's component not imported) | The pack primitives declare their required Angular imports; the page-shell aggregates them into the component `imports`; `ng build` strict template checking catches a missing import the way `vue-tsc` catches Vue's. |
| Library version drift (Angular major / Material / spartan pins) | Stack `ng1` pins ranges; the `LOOM_ANGULAR_BUILD` CI matrix catches breakage the way the React/Vue matrices do. |
| Static-bundle deep-link fallback (Angular router `PathLocationStrategy`) | The angular dockerfile's static server serves `index.html` for unmatched routes (SPA fallback); covered by the boot e2e hitting a deep route. |

## Cross-references

- [`docs/old/proposals/angular-frontend.md`](../proposals/angular-frontend.md)
  — the originating vision proposal (this plan recalibrates its phasing
  and dependency claims).
- [`docs/old/plans/vue-frontend-plan.md`](vue-frontend-plan.md) /
  [`docs/old/plans/svelte-frontend-plan.md`](svelte-frontend-plan.md) — the
  two executed sibling plans this mirrors; Angular reuses the shared
  walker + `_frontend/` infra both landed.
- [`docs/page-metamodel.md`](../../page-metamodel.md) — the page-DSL surface
  the walker consumes (framework-neutral).
- [`docs/design-packs.md`](../../design-packs.md) — pack authoring guide (add
  the angular format + an `angularMaterial` baseline).
- [`docs/platforms.md`](../../platforms.md) — the `PlatformSurface` contract
  (`mountsUi`, `composeService`, `hostableFrameworks`).
- [`frontend-acl.md`](../proposals/frontend-acl.md) — frontend
  authorization surface Angular must honour at parity.
