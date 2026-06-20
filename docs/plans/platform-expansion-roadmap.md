# Platform-expansion roadmap

> **[2026-06-20 status audit]** Snapshot stale — Vue/Svelte AND Angular have shipped (4 frontends now: `src/platform/{vue,svelte,angular}.ts` + registry). The intro 'one frontend (React)' and Phase B Vue='Sketch' are out of date; Angular landed outside the A–I phase plan.

Multi-phase plan to grow Loom's compilation targets beyond the current three
backends (Hono / .NET / Phoenix LiveView) and one frontend (React) without
abandoning the architectural invariants that keep the toolchain tractable.

This document is the index. Each phase has (or will get) its own detailed plan
file; the entries below summarise scope, sequencing, and gating.

**Architectural invariant for every phase** (from `experience_gathered.md` §13):
backends stay idiomatic; shared semantics live in pure IR helpers
(`wire-projection.ts`, `invariant-classify.ts`, `enrichments.ts`,
`src/generator/_walker/target.ts`). No uniform `Platform` flattening interface.
If a new platform tempts a wide cross-platform abstraction, the answer is to
push more into the IR — not to flatten the backends.

---

## Status snapshot

| Phase | Title | State | Detail |
|---|---|---|---|
| A | Platform-expansion prerequisites | Planned, ready to execute | [`phase-a-platform-expansion-prereqs.md`](phase-a-platform-expansion-prereqs.md) |
| B | First new frontend — Vue | Sketch | This doc |
| C | Behavioral parity cleanup | Sketch (data-driven) | This doc |
| D | ashPhoenix primitive backfill | Sketch | This doc |
| E | First new backend — FastAPI | Sketch | This doc |
| F | Typed-pair contracts for shared-language stacks | Sketch | This doc |
| G | Blazor (WASM + Server) | Sketch | This doc |
| H | Project-shell abstraction | Conditional | This doc |
| I | Svelte / Rails | **Svelte: SHIPPED** (executed ahead of Vue — see [`svelte-frontend-plan.md`](svelte-frontend-plan.md)); Rails: sketch | This doc |

Phase B onward is **provisional ordering**. Calibration data from Phase A
(Item 2's behavioral conformance run) and from Phase B (first WalkerTarget
consumer outside React/Phoenix) will likely re-shuffle B → I.

---

## Phase A — Prerequisites (detailed plan exists)

See [`phase-a-platform-expansion-prereqs.md`](phase-a-platform-expansion-prereqs.md).

Four items, independent, suggested merge order 4 → 3 → 2 → 1:

1. Finish `WalkerTarget` extraction (Phase 7). Unblocks every new frontend.
2. Multi-backend behavioral conformance harness. Unblocks every new backend
   and surfaces calibration data for Phase C.
3. Test-ID coverage tripwire.
4. Pack required-primitives validation.

**Phase A exit criteria:** all four items merged; `npm test` green;
`LOOM_E2E=1`, `LOOM_REACT_BUILD=1`, `LOOM_PHOENIX_BUILD=1`,
`LOOM_DOTNET_BUILD=1` green.

---

> **Status note (2026-06):** the Svelte frontend shipped FIRST (Phase I
> pulled ahead of Phase B) — see [`svelte-frontend-plan.md`](svelte-frontend-plan.md).
> It answered Phase B's calibration questions: the `WalkerTarget`
> contract needed six additional methods (4 markup seams +
> `renderChildrenSlot` + `formRuntimeImports`); walker reuse was
> total (the core moved to `src/generator/_walker/walker-core.ts` and
> both TSX and Svelte consume it — no fork); no IR gaps surfaced.
> Vue, when it comes, inherits all of that.

## Phase B — First new frontend (Vue)

> **Status: EXECUTED** (vue-frontend-plan.md, merged via #1117 + the
> Slice 6–9 follow-ups).  Calibration answers:
>
> 1. **The contract needed three extensions**, all true cross-frontend
>    seams (none framework-private): `renderInterpolation` +
>    `renderAttrBinding` (Vue's `{{ }}` mustaches / `:attr` bindings
>    vs the JSX family's braces) and `renderMatchChild` (structural
>    `<template v-if>` chains — a markup ternary can't live in a
>    mustache).  The 4 markup seams the Svelte port added were also
>    consumed.  Verdict: the contract is elastic; extensions were
>    mechanical and byte-identical for TSX/HEEx.
> 2. **Walker reuse was effectively total** — the Vue generator ships
>    zero forked walker code; `vueTarget` (~300 LOC of leaf seams) +
>    the Vue page shell (~350 LOC, the SFC analogue of
>    `react/walker/page-shell.ts`) are the only Vue-side walker code.
>    The api/views/workflows module builders were extracted to
>    `_frontend/` and shared verbatim (one import-specifier knob).
> 3. **No IR gaps.**  Vue's reactivity surfaced POSITION questions
>    (template auto-unwrap vs script `.value` — solved with bare-name
>    reads everywhere walker output lands plus shell-side `.value`
>    rewrites for hook hoists), not IR-shape questions.  The live-refetch
>    find-filter follow-up shipped: parameterised `find` hooks take a
>    `MaybeRefOrGetter` query (`computed(toValue(query))` in the queryKey),
>    and the page passes a getter so a bound filter input re-fetches.

**Goal:** prove the post-Phase-A `WalkerTarget` contract by adding a second
frontend that is *not* HEEx (which has structural exemptions).

**Why Vue first, not Svelte or Blazor:**
- Vue is the closest neighbour to React's mental model — SFC + reactive state +
  JSX-like template. The walker reuse should be near-total.
- Svelte's compiler-driven reactivity (Svelte 5 runes) is a bigger shape
  delta; better as Phase I once the contract is proven elastic.
- Blazor introduces a separate concern (typed-pair contracts with .NET on the
  backend) — bundling that with "first new frontend" mixes two unknowns.
  Defer to Phase G.

**Scope:**
- `src/generator/vue/` mirroring `src/generator/react/` shape.
- `src/generator/vue/vue-target.ts` implementing `WalkerTarget` (state via
  `ref()` / `.value`, API hooks via composables, navigation via `vue-router`,
  match via template `<template v-if>`).
- One initial design pack — `designs/vuetify/v3/` (most mature Vue component
  library; matches Mantine's role in TSX).
- `Platform` rule additions: `ddd.langium`, `loom-ir.ts`, `ddd-validator.ts`
  (same pattern as the existing `'react'` / `'phoenixLiveView'` adds).
- `PlatformSurface` impl in `src/platform/vue.ts`; registry add.
- New CI matrix dimension in `generated-react-build.yml` → renamed
  `generated-frontend-build.yml`, or a sibling workflow.

**Calibration questions Phase B answers:**
1. Did `WalkerTarget`'s 8-method contract cover Vue with no extensions?
   If yes — contract holds. If no — what method(s) does Vue need, and is the
   gap framework-private (stays in `vue-target.ts` internals) or a true
   cross-frontend seam (extend the contract)?
2. How much of `body-walker.ts` was actually reusable vs. how much had to be
   forked? Target: ≥ 80% reuse measured by LOC of shared walker code path.
3. Does Vue's reactivity model expose IR gaps (e.g., does `state := ...`
   lowering need a new node)? Should be no — but worth measuring.

**Phase B exit criteria:** Vue project for `examples/showcase.ddd` builds
under `tsc --noEmit` and Vue compiler; Playwright e2e tests (rendered via
the existing page-object generator pointed at the Vue target) pass against
the booted Vue app.

---

## Phase C — Behavioral parity cleanup (data-driven)

**Trigger:** Phase A Item 2 (the behavioral conformance harness) reports its
first set of divergences across Hono / .NET / Phoenix.

**Goal:** close every actionable divergence before any new backend lands.
A new backend's correctness is only meaningful relative to a baseline that
agrees with itself.

**Cannot pre-plan in detail** because the work is driven by what the harness
discovers. Expected categories (from `experience_gathered.md` retro):
- Response shape parity (full DTO vs `{id}` on writes).
- RFC 7807 vs custom error envelopes on 422/400/404.
- Validation ordering when multiple invariants fire on the same payload.
- Optimistic-concurrency edge cases (which backend returns 409, which 412).
- Pagination metadata shape (total/hasMore/links — not yet specified).

**Method:** each divergence gets its own short-cycle PR, attributed to one
backend, with the test that surfaces it as the regression gate. Treat .NET
as the reference where the divergence isn't otherwise canonical — it's the
oldest backend and the one closest to standards.

**Phase C exit criteria:** every `test e2e` block in the canonical example
corpus passes against every backend in its system, with no parity excuses
in code comments.

---

## Phase D — ashPhoenix primitive backfill

**Trigger:** after Phase A; can run in parallel with Phase B.

**Goal:** bring the HEEx design pack closer to TSX-pack feature parity so
Phoenix LiveView can serve as a primary frontend (not just a parity
demonstrator).

**Scope:**
- Build Form archetype: `primitive-form-of`, `primitive-form-default-onsubmit`,
  `field-input-*` (HEEx versions, threading through `AshPhoenix.Form`).
- Build List archetype: `primitive-query-list`, pagination controls,
  filter/search input wiring.
- Fill Detail archetype gaps (the ~17-key delta against Mantine).
- Add `primitive-modal` to HEEx required set (Phase A Item 4 open question).
- Broaden HEEx testid emission (deferred from Phase A Item 3).

**Phase D exit criteria:** `showcase.ddd` rendered to Phoenix LiveView serves
every page archetype TSX serves, with feature parity at the user-facing level
(forms validate, lists paginate, search filters).

---

## Phase E — First new backend (FastAPI) — **SHIPPED** (see [`python-backend-plan.md`](python-backend-plan.md))

**Trigger:** after Phase A; ideally after Phase C reaches steady-state on
the existing backends.

**Why FastAPI first, not Rails / Django / Spring:**
- FastAPI's mental model is closest to Hono (handler → DTO → repo) so the
  generator structure can mirror `src/generator/typescript/`.
- Pydantic v2 + SQLAlchemy 2 give strong static typing — easier IR-to-source
  mapping than Rails' magic.
- Python deployment is well-understood; the docker-compose composition layer
  needs no exotic adaptations.

**Scope:**
- `src/generator/fastapi/` with the per-platform generator shape: `emit/*.ts`,
  `*-builder.ts`, `render-expr.ts`, `render-stmt.ts` for domain logic.
- `PlatformSurface` impl; registry add; `Platform` rule.
- Pydantic DTOs read directly from `agg.wireShape` (the Phase A enrichment).
  No re-resolution.
- SQLAlchemy 2 declarative models — uses the same property typing the .NET
  EF backend uses.
- Docker compose service: Python 3.12 + uvicorn + postgres sidecar.
- CI: new workflow `fastapi-build.yml` (`pip install` + `mypy --strict` +
  `pytest`).
- The behavioral conformance harness (Phase A Item 2) automatically replays
  every `test e2e` block against the new backend with no harness change —
  this is the load-bearing reason Phase A came first.

**Calibration questions Phase E answers:**
1. Does Python's runtime-only validation (Pydantic) hide bugs the static
   conformance harness catches? Expect: yes, several. Add to Phase C.
2. How much expression-rendering code (`render-expr.ts`) is genuinely
   per-language vs. mechanical translation? Should be ~300-500 LOC.

**Phase E exit criteria:** FastAPI project for `showcase.ddd` passes the
multi-backend behavioral suite against Hono and .NET. OpenAPI parity check
green.

---

## Phase F — Typed-pair contracts for shared-language stacks

**Trigger:** before Phase G (Blazor), driven by Blazor's WASM + Server
deployable pair sharing a `.NET` language ecosystem.

**Goal:** when two deployables in a system share a language (e.g., Blazor
WASM frontend + ASP.NET backend, both C#), emit a shared-contracts project
they both depend on instead of duplicating DTO classes on each side.

**Why this needs its own phase:** the current system-orchestrator
(`src/system/`) composes deployables as independent docker services with
JSON-over-HTTP between them. Shared contracts means a third artefact (a NuGet
package in `.NET` land, a Maven module in JVM land, a workspace package in
TS land) that two deployables consume. This changes the dependency graph
that the orchestrator produces, and the wire-spec JSON Schema artefact's
role (it becomes secondary documentation, not the primary contract).

**Scope:**
- New IR-level concept: `SharedContractBundle` derived from a set of
  deployables sharing `language: <lang>`.
- New emitter: `src/system/shared-contracts/` — one impl per language family
  (TS workspace package, .NET shared project, JVM module). Reads
  `wireShape` from IR; emits classes/types/interfaces with appropriate
  language idioms.
- `PlatformSurface` extension: deployables declare their language so the
  orchestrator can group them.
- Backwards compatibility: systems without language-paired deployables
  continue to emit per-project DTOs; the shared-contracts path is opt-in
  via system composition.

**Phase F exit criteria:** an example with `react` + Hono (both TS) emits a
shared TS contracts package; both projects import from it; types are
structurally identical on both sides; `tsc --noEmit` passes for both.

---

## Phase G — Blazor (WASM + Server)

**Trigger:** after Phase F.

**Goal:** add Blazor as a frontend with two deployment modes (WASM and
Server), demonstrating the shared-contracts path with ASP.NET backend.

**Scope:**
- `src/generator/blazor/` for Razor component generation. Reuses `tsxTarget`'s
  shape but emits Razor (`@code { … }` blocks, `@onclick`, etc.).
- Two `Platform` keywords: `blazorWasm` and `blazorServer`.
  - WASM: client-side, calls API via `HttpClient`, uses the shared-contracts
    package emitted in Phase F.
  - Server: SignalR-driven, runs server-side, calls into the same ASP.NET
    backend's services directly (no HTTP hop). Treat as a frontend that
    happens to colocate with the backend.
- Razor pack: `designs/blazor/v8/` with primitive templates (likely thinner
  than TSX packs because MudBlazor / Radzen are well-componentised).
- CI: `blazor-build.yml` running `dotnet publish` for WASM and `dotnet test`
  for the bUnit test layer.

**Calibration questions Phase G answers:**
1. Did Phase F's shared-contracts emission generalise cleanly to .NET?
2. Does Blazor Server's "frontend colocates with backend" model fit the
   docker-compose orchestration, or does it need its own composition path?

**Phase G exit criteria:** Blazor WASM project for `showcase.ddd` builds
and passes Playwright e2e (the existing page-object generator emits
Playwright tests against any frontend with the page-shell shape).

---

## Phase H — Project-shell abstraction (conditional)

**Trigger:** evaluated after Phase G. **May not be needed.**

**Goal:** if Phases B / E / G show that per-platform project scaffolding
(`tsconfig.json`, `package.json`, `pyproject.toml`, `.csproj`, `mix.exs`,
docker entries, vite/uvicorn/dotnet run wrappers) is producing significant
duplicated logic across `src/generator/<platform>/index.ts` orchestrators,
abstract it.

**Goal NOT:** abstract preemptively. The current per-platform orchestrators
are small (~200-400 LOC each) and the duplication is shallow. Phase A and B
will surface whether the duplication is real or perceived.

**Phase H exit criteria:** measurable LOC reduction in per-platform
orchestrators; no regression in fixture diffs.

---

## Phase I — Svelte / Rails (or other later additions)

**Trigger:** after Phases A-G in steady state.

These represent the next round of new platforms, where prior phase work
should pay off in low marginal cost. Svelte tests how elastic the
`WalkerTarget` contract is once Vue + React + HEEx + Blazor are consumers.
Rails tests how well the backend generator shape generalises to a
convention-heavy framework with macro-driven scaffolding.

No detailed scope until Phase G calibration data is in.

---

## Cross-cutting policies

**No backwards-compatibility hacks at expansion boundaries.** A new platform
can require IR enrichment changes; if the existing backends need updating
to consume the new enrichments, update them in the same PR. The wire-spec
JSON Schema artefact is the change-detection mechanism — if the schema
diff is empty across the change, no consumer migration is needed.

**One new platform per quarter, maximum.** The IR + walker + pack
infrastructure is the long-pole work; cramming two platforms into one
quarter under-tests the abstractions added for the first.

**Every new platform PR ships its CI gate in the same PR.** No "we'll add
the workflow next sprint." If `tsc --noEmit` / `mix compile` / `mypy` /
`dotnet build` doesn't gate the matrix from day one, the platform rots
silently.

**The behavioral conformance harness (Phase A Item 2) is non-negotiable
for every new backend.** Adding a backend without it would be adding a
second-class backend.

---

## Reading order

For someone picking this up cold:

1. `experience_gathered.md` §13 (the "backends stay idiomatic" principle).
2. `docs/architecture.md` (the system-composition model).
3. `docs/technical.md` (the pipeline).
4. This document.
5. [`phase-a-platform-expansion-prereqs.md`](phase-a-platform-expansion-prereqs.md) for the work that's actually starting.
