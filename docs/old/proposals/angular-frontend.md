# Angular frontend — standalone components + signals generator

> Status: **PLANNED.** This vision has been turned into an actionable,
> slice-by-slice implementation plan in
> [`docs/old/plans/angular-frontend-plan.md`](../plans/angular-frontend-plan.md),
> recalibrated against the current codebase (the shared walker, Vue, and
> Svelte have all landed since this proposal was written — notably the
> `embedded-frontend-composition` reshape this proposal named as a hard
> prerequisite turned out **not** to be one: Vue and Svelte shipped
> host-embedding without it). The sections below are the originating
> design rationale; the plan supersedes the phasing where they differ.
>
> Captures the design and
> effort shape for a second frontend framework alongside React (and the
> in-flight Vue/Svelte targets). A frontend is **not a domain-logic
> backend** — it consumes `wireShape` and renders the page-DSL body
> walker; it runs no domain logic, so there is **no `render-expr` /
> `render-stmt`**. Builds on the body-walker architecture
> (`src/generator/_walker/`), the `WalkerTarget` seam, and the design-pack
> layer (`designs/`). Closely related to
> [`embedded-frontend-composition.md`](./embedded-frontend-composition.md),
> which decouples the served UI framework from the host platform — the
> precondition that makes "any host serves Angular" expressible.

> **[2026-06-20 status audit]** SHIPPED — full generator tree `src/generator/angular/` + `src/platform/angular.ts` (registry) + `angularMaterial` design pack + tests; consumes the shared `walkBody`. The angular-frontend-plan.md is largely executed. Parity tail: page-`requires`/nav-link auth gating hasn't reached Angular yet.

## TL;DR

Add an **Angular** frontend — standalone components, the **signals**
reactivity model, typed `HttpClient` services, the Angular router — at
`src/generator/angular/` with an `angular`-shaped `WalkerTarget`
(`src/generator/angular/walker/ng-target.ts`) and at least one Angular
**design pack** under `designs/`. It reads the same enriched `wireShape`
and the same page-DSL primitive bodies the React backend consumes — the
IR and the walker registry are untouched. The yardstick is the React
frontend (**≈ 9.4k LOC / 33 files**, of which `body-walker.ts` ≈ 1.2k and
the `react/walker/` target dir ≈ 3.7k); Angular lands in a comparable
band, with the per-pack template work being the dominant variable cost.

**Effort: ~6–9 engineer-weeks** for React-parity (List/Detail/Form/
MasterDetail/Stack/match/state, one design pack, e2e page-objects), or
**~3–4 weeks** for a walking skeleton (one pack, CRUD pages,
`tsc --noEmit` + `ng build` green, deferring `match`/workflow views/auth
ACL).

## Why Angular over "yet another SPA"

The in-flight Vue and Svelte targets, like React, serve the **same
JS-SPA culture** — unopinionated libraries where the generator imposes
structure. Angular is the one structurally distinct frontend:

- **It completes the enterprise pairing.** With .NET and (in-flight) Java
  backends, Angular is the frontend those shops actually reach for. It is
  the missing half of the enterprise story, not a fourth flavour of the
  startup story.
- **It is the cleanest structural match for a code generator.** Angular's
  opinionated module/DI/strongly-typed-service shape *wants* the rigidity
  a generator produces — you emit into a framework that expects
  generated-looking code, rather than fighting an unopinionated library's
  "there are ten ways to do this." Typed `HttpClient` services map 1:1
  onto the generated API client; the router config is declarative and
  table-shaped (a natural emit target); standalone components (Angular
  14+) remove the old `NgModule` ceremony that would have bloated output.
- **Signals make the walker's hardest seam tidy.** The `WalkerTarget`
  state read/write seam (`state := …`) — the framework-shaped part that
  can't be a pack template — is where frontends diverge most. Angular
  **signals** (`signal()` / `set()` / `update()` / `computed()`) give a
  read/write surface as clean as React's `useState`, arguably cleaner for
  the `Form`/`MasterDetail` two-way cases.

## What a frontend target actually is (and isn't)

A frontend reuses far more than a backend:

| Layer | Reuse vs new for Angular |
|---|---|
| Enriched `wireShape` (DTO field order) | **Reuse** — identical to React/Phoenix. |
| Page-DSL primitive **registry** (`src/generator/_walker/registry.ts`) | **Reuse** — the closed primitive set (List/Detail/Form/MasterDetail/Stack/Heading/Button/Card/Toolbar/match/lambdas/`state :=`) is framework-neutral; the name-only mirror (`walker-stdlib.ts`) is shared. |
| `WalkerTarget` contract (`src/generator/_walker/target.ts`) | **Reuse the contract** — implement a new `NG_TARGET` for the framework-shaped seams (state read/write, helper imports, navigation, API-call lowering, `match` rendering). This is the React `tsx-target.ts` / Elixir `heex-target.ts` analogue. |
| Body walker dispatcher | **New thin walker** (`src/generator/angular/body-walker.ts` equivalent) dispatching per-primitive through the active Angular design pack + `NG_TARGET`. Mirrors `react/body-walker.ts`. |
| **Design pack(s)** (`designs/<ng-pack>/`) | **New** — the per-primitive `.hbs` templates. This is the bulk of the variable cost. Angular Material is the natural first pack (the MUI/enterprise analog); PrimeNG a strong second. |
| Vite project scaffold | **New** — Angular CLI (`angular.json`) project scaffold instead of `vite/`, with `stacks/v*`-style dependency manifest. |
| e2e page-objects (`@loom/ui-test-driver`) | **Reuse the runtime** — emit Angular-shaped locators against the same cross-window page-object contract. |

No `render-expr.ts` / `render-stmt.ts`: the frontend doesn't execute
domain logic, it consumes the wire shape — same as React skipping them
today.

## What gets written (anchored to React ≈ 9.4k LOC / 33 files)

| Piece | React reference | Angular estimate |
|---|---|---|
| `PlatformSurface` impl (`src/platform/angular.ts`, `mountsUi`/`composeService`) | react.ts | ~150 |
| Orchestrator (`index.ts`) | react index | ~600 |
| Body walker (per-primitive dispatch) | body-walker.ts 1,244 | ~1,200 |
| **`WalkerTarget` impl** (`ng-target.ts` — state/nav/api/match seams) | tsx-target.ts (part of walker dir 3,653) | ~1,000 |
| Page-object / locator emit (e2e) | (in walker dir) | ~700 |
| Typed `HttpClient` API service emit | api client | ~500 |
| Router config + app bootstrap (standalone, `provideRouter`) | app shell | ~500 |
| TypeScript model/DTO emit from `wireShape` | dto | ~400 |
| **One design pack** (`designs/ng-material/`, all primitives) | designs/mantine (separate tree) | ~1,500–2,500 |
| Angular CLI project scaffold (`angular.json`, `tsconfig`, manifest) | vite/ + stacks/v* | ~350 |
| Grammar + validator wiring (`framework: angular`) | small | ~80 |
| **Subtotal** | | **~7,400–8,400** |

### The fiddly parts

1. **The `WalkerTarget` `match` seam.** `match` rendering is the most
   framework-shaped primitive (React → conditional JSX; HEEx → `<%= case
   %>`). Angular's idiom is `@switch`/`@if` control-flow blocks (Angular
   17+) or `*ngSwitch`; pick the control-flow blocks (the modern, less
   verbose form) and pin it.
2. **Forms.** `Form`/`MasterDetail` two-way binding maps to Angular
   **reactive forms** (`FormGroup`/`FormControl`) or signal-based
   template-driven forms. Reactive forms are the typed, generator-friendly
   choice but add a `FormGroup`-construction emit step per command.
3. **The byte-identical gate is per-seam.** Each `WalkerTarget` seam
   extraction on React/Elixir was guarded by a byte-identical-output gate
   (PRs #607–#627). A new target doesn't need that gate (there's no prior
   output to preserve), but the **`walker-*.test.ts` per-primitive suite
   (~30 files)** is the parity yardstick — Angular needs its own
   per-primitive coverage mirroring those.

## CI

- `generated-angular-build.yml` — matrix `{example × ng-pack}`, generate
  the Angular project, `npm install`, `ng build` (or `tsc --noEmit` +
  `ng build --configuration production`). Mirrors
  `generated-react-build.yml`; this catches generator drift invisible to
  IR-level tests and is the primary frontend gate.
- `playground-e2e.yml` — extend with an Angular spec (editor → generate →
  bundle → boot → preview) once a pack is stable.

## Dependency on embedded-frontend-composition

Today the served UI framework is **derived from the host** and the embed
is hardwired to React in three places
([`embedded-frontend-composition.md`](./embedded-frontend-composition.md)
§ generator `dotnet/index.ts`, validator `expectedFrameworkFor`, grammar
`Framework` enum). Until that proposal moves framework/design/stack onto
the `ui` declaration and makes hosting an explicit `hosts:` capability,
"`dotnet` embeds Angular" / "`phoenix` embeds Angular" is **inexpressible**
— Angular would only be reachable as a standalone Vite-style host.
**Recommendation:** land `embedded-frontend-composition` first (it is the
keystone for *any* second frontend, Vue/Svelte included), then Angular,
Vue, and Svelte are each "add a framework generator + a capability set"
with no host-side changes — exactly that proposal's success test.

## Phasing

1. **Skeleton (wk 1–3)** — `PlatformSurface` (`mountsUi`) + `framework:
   angular` wiring + `NG_TARGET` for state/nav/api seams + one pack +
   List/Detail/Form for one aggregate; `ng build` green.
2. **Primitive parity (wk 3–6)** — MasterDetail/Stack/Card/Toolbar/Button
   + `match` (`@switch`) + the `walker-*.test.ts` per-primitive suite →
   pass `generated-angular-build`.
3. **Parity features (wk 6–8)** — workflow-instance views, auth/frontend
   ACL, e2e page-objects, a second pack (PrimeNG).
4. **Hardening (wk 8–9)** — every `examples/*.ddd` × pack, playground e2e
   spec, docs rows in `platforms.md` / `generators.md` / `design-packs.md`.

## Decisions to pin before starting

- Standalone components vs `NgModule`. **Standalone** (Angular 17+).
- Signals vs RxJS `BehaviorSubject` for `state`. **Signals.**
- Reactive forms vs template-driven for `Form`. **Reactive forms.**
- `match` → `@switch` control-flow vs `*ngSwitch`. **`@switch`.**
- First design pack: Angular Material vs PrimeNG. **Angular Material**
  (the enterprise/MUI analog, best-documented), PrimeNG as fast-follow.
- Land before or after `embedded-frontend-composition`. **After** — it is
  the precondition for an embeddable second frontend.

## Cross-references

- [`embedded-frontend-composition.md`](./embedded-frontend-composition.md)
  — **prerequisite**: moves framework/design/stack onto `ui`, makes
  hosting a `hosts:` capability; the keystone for any non-React frontend.
- [`docs/page-metamodel.md`](../../page-metamodel.md) — the page-DSL surface
  the walker consumes (framework-neutral).
- [`docs/design-packs.md`](../../design-packs.md) — pack authoring guide (add
  an Angular Material pack row + stack baseline).
- [`docs/platforms.md`](../../platforms.md) — the `PlatformSurface` contract
  (`mountsUi`, `composeService`).
- [`frontend-acl.md`](./frontend-acl.md) — frontend authorization surface
  Angular must honour at parity.
