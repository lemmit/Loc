# Architecture review — multi-target growth (2026-06)

A snapshot-in-time review of the toolchain after the platform roster grew to
**5 backends** (Hono/node, .NET, Elixir, Python/FastAPI, Java/Spring) and
**3 frontends** (React, Vue, Svelte). The pipeline architecture itself is
sound; this audit catalogues the weak spots that growth has exposed and ranks
where a refactor pays off. Like every file under `docs/audits/`, it is a
snapshot — not authoritative for what ships today.

## Top line

The one-directional pipeline (`language → ir → generator → system`), the
platform-neutral fully-resolved IR, and the two shared dispatch seams
(`_expr/target.ts`, `_walker/target.ts`) are healthy and worth preserving as
the model. The problems are all **growth debt**: seams that were proven on the
first 2–3 targets but not extended to the new ones, guards/docs that were
written against the old roster and never widened, and one half-landed platform.

## Weak spots, ranked

### 1. Svelte is a registered-but-stub platform *(correctness / UX)*

`src/platform/svelte.ts` is wired into `registry.ts` as a first-class
`Platform`, has grammar + validator support (`svelte-deployable.test.ts`), but
its `emitProject` (svelte.ts:31-44) just emits a `README.md` saying "generator
not yet implemented." There is **no `src/generator/svelte/`**, no
`WalkerTarget`, no design pack. A user can write `platform: svelte`, pass
validation, run `generate system`, and silently get a non-project instead of an
error. Git history shows Svelte landed "Slice 1" plumbing and stalled, while
Vue (started later) ran all the way through Slice 5.

**Fix options:** either (a) gate the stub so `platform: svelte` is rejected by
the validator with a clear "not yet implemented" diagnostic until the generator
lands, or (b) finish the generator. The frontend walker seam already
anticipates Svelte cleanly (target.ts comments call out its `{#if}`/`<!-- -->`
divergences), so option (b) is mostly mirroring Vue. Leaving it as a silent
stub is the worst of the three.

### 2. The sibling-platform layering guard is stale *(latent layering hole)*

`test/platform/pipeline-layering.test.ts:171` hardcodes the platform list it
guards against cross-imports:

```js
const platformDirs = ["typescript", "dotnet", "elixir", "react"];
```

This **omits `java`, `python`, and `vue`**. A `generator/vue/` file importing
`generator/react/`, or `generator/java/` importing `generator/dotnet/`, would
not be caught — exactly the edge most likely to appear given Vue was built for
"shared-walker reuse." Verified there is **no actual violation today**, so this
is latent, not active. Trivial fix: derive the list from the registry's
platform families or from the directory listing rather than hardcoding it, so
new platforms are guarded automatically.

### 3. `src/platform/` layout is inconsistent — only 1 of 9 follows the documented pattern *(architecture decision needed)*

`surface.ts:48` documents the contract as *"Implement `PlatformSurface` in
`src/platform/<name>/index.ts`."* In reality:

| Pattern | Platforms | Shape |
|---|---|---|
| Thin surface delegating to `src/generator/<name>/` | dotnet, elixir, java, python, react, vue, svelte | `src/platform/<name>.ts` (35–187 LOC) |
| Full versioned package owning its emit | **hono only** | `src/platform/hono/v4/` (~14 files) |

Hono-in-`platform/` is a deliberate "versioned backend package" prototype
(see `pins.ts`, the `v4` dir, `docs/backend-packages.md`) and it is
forward-compatible. But it is the **only** platform that follows the pattern the
contract doc prescribes, so the doc and the code disagree for the other eight.
This isn't a layering violation (the generator→platform edge test still passes),
but it is a coherence problem: a reader can't tell from the layout whether a
backend's logic lives in `platform/` or `generator/`.

**Decision needed:** either declare the thin-`src/platform/<name>.ts` +
`src/generator/<name>/` split the canonical pattern (and reframe Hono as the
*versioned* exception, fixing the surface.ts doc), or commit to migrating the
other backends to versioned packages. Today it reads as an incomplete
migration. Recommend documenting the dichotomy explicitly either way.

### 4. Backend emission duplication — the seam pattern was not extended past expressions *(maintainability)*

The expression seam is the success story: all five backends supply an
`ExprTarget` leaf (`TS_TARGET`/`CS_TARGET`/`PY_TARGET`/`JAVA_TARGET`/
`ELIXIR_TARGET`) and the 17-arm dispatch lives once in `_expr/target.ts`. A new
`ExprIR.kind` is a compile error until every backend fills it. That is exactly
the leverage the architecture is built for.

That leverage was **not** applied to the larger emission concerns. Each backend
re-implements, by copy-paste-with-tweaks:

- **Workflow emission** — `workflow-emit.ts` / `workflow-builder.ts` /
  `workflows-builder.ts` in all five backends (e.g. `dotnet/workflow-emit.ts` is
  1,187 LOC). The high-level choreography is identical across backends
  (precondition→guard, `factory-let`→create, `repo-let`→find, `op-call`→invoke,
  `emit`→event record, transaction wrap, after-save dispatch); only the
  per-statement rendering and the async/transaction idiom diverge.
- **Repository emission** — `emit/repository.ts` / `repository-builder.ts`
  across the four domain backends. Same shape (auto `getById`/`save`, one method
  per `find`, pagination, `currentUser` threading); diverges only at the
  ORM/query-language lowering.
- **DTO / wire-shape emission** and **API route registration** — same story,
  moderate duplication.

This is genuinely harder to unify than expressions because transaction models
and ORMs diverge — but the *choreography* (the order and meaning of the
steps) is uniform and is currently duplicated. **Highest-payoff target: a
`WorkflowChoreographer` seam** that owns the statement-sequence lowering with
backend hooks for (1) per-statement rendering — which already exists as
`render-stmt.ts` — (2) transaction wrapping, and (3) event dispatch. Repository
and DTO seams are lower urgency.

> Note: an earlier draft circulated inflated line counts here (byte counts read
> as LOC). The duplication is real and structural; the magnitude is "thousands
> of lines of parallel choreography," not the 75K figure.

### 5. Phoenix runs a parallel walker — justified, but the parity gap is untracked *(maintainability)*

The frontend story claims a shared body-walker with framework seams captured by
`WalkerTarget`. React and Vue genuinely consume the shared
`_walker/walker-core.ts` (1,346 LOC) via `walkBody(body, target)`. Phoenix/HEEx
does **not** — it runs its own `elixir/heex-walker-core.ts` (1,068 LOC) +
`heex-primitives.ts` (956 LOC), roughly a parallel ~2,000-LOC engine. The
`heexTarget` is mainly a conformance shim; the real HEEx rendering is the
parallel engine.

**On closer inspection, the two engines should NOT be merged** — and an earlier
draft of this audit was wrong to suggest "factor out the shared skeleton." The
divergence is *topological*, not cosmetic, on three axes the `WalkerTarget`
seams deliberately exclude (target.ts:49-68):

- **Lambdas** — inline in JSX (`onClick={() => navigate(...)}`, one node → one
  expression) vs hoisted in LiveView (`phx-click="ev"` attribute **plus** a
  separate `handle_event/3` clause accumulated on the module body, one node →
  two non-adjacent fragments; heex-walker-core.ts:14,74,194).
- **Collection ops** — `xs.map(...)` returning markup vs `<%= for x <- xs %>`
  comprehension blocks.
- **Conditional children** — `cond ? <A/> : <B/>` vs `<%= if do %>` blocks.

A single recursion engine can only emit both topologies by branching on
framework internally — re-introducing exactly the `if (framework === "heex")`
leakage the seam was built to prevent. Note what *is* already shared: the
`WALKER_PRIMITIVES` registry (`_walker/registry.ts`) is a single table carrying
both a `tsx` and a `heex` renderer per primitive, and
`walker-stdlib-completeness.test.ts` pins the primitive *names* across both. So
the catalogue isn't duplicated — only the two engines are, and that's earned.

**The actionable risk is parity drift, not LOC.** The registry has **49 `tsx`
renderers but only 32 `heex`** ones — ~17 primitives (Field, Toggle, Money,
Avatar, Bold/Italic/InlineCode, the input family, Tabs, DestroyForm, …) render
on React but **silently fall through to a "not supported" comment** on Phoenix.
Nothing guards that gap, so a newly-added primitive defaults to TSX-only and
quietly degrades Phoenix output. Fix is cheap and engine-free: a parity test
that, for every primitive meant to be cross-framework, asserts a `heex` renderer
exists or the gap is on an explicit allow-list — turning silent divergence into
a reviewed list. Also state plainly in CLAUDE.md that HEEx is a parallel engine,
not a `WalkerTarget` consumer (today's docs imply the seam is universal).

### 6. React still uses its own API builder while Vue uses the shared one *(small, clean-up)*

`_frontend/api-module.ts` is explicitly framework-neutral (Zod + TanStack
Query, parameterised by `queryPackage`). Vue consumes it
(`vue/index.ts` → `@tanstack/vue-query`). React still imports its own older
`react/api-builder.ts` (`react/index.ts:16`). Output is equivalent, but React
should migrate onto the shared module so there's one source of truth — otherwise
a future API-shape change has to be made twice and kept byte-identical by hand.

### 7. Documentation drift across the whole roster *(docs)*

`CLAUDE.md` and several `docs/` files describe the pre-Python/Vue/Svelte world.
Concrete stale spots:

- **CLAUDE.md opening (line 7)** lists "TypeScript/Hono, .NET, React/Vite,
  Phoenix/Ash" — omits Python/FastAPI, Vue, Svelte, and Java from the headline.
- **CLAUDE.md line 119** "backends (Hono/node, .NET, Phoenix/elixir,
  Spring Boot/java)" — omits Python.
- **CLAUDE.md line 121** speaks of "a 5th domain-logic backend" as
  hypothetical; Python exists and ships `render-expr.ts`.
- **CLAUDE.md line 125** design-pack list `mantine|shadcn|mui|chakra` +
  `ashPhoenix` — omits **vuetify**.
- **CLAUDE.md CI section** omits `python-build.yml` (exists) and notes no
  Vue/Svelte build gate; lists no `python-obs-e2e`.
- **docs/platforms.md** registered-platforms table lists 6 of 9 platforms,
  references a non-existent `src/platform/phoenix-live-view.ts` (real file is
  `src/platform/elixir.ts`), and the `BUILTIN_PLATFORM_LATEST` prose omits
  python/java.
- **docs/generators.md** feature matrix has only TS/.NET/React columns.

### 8. Newer platforms lack the test/CI gates the older ones have *(quality gate)*

Test-file density by platform: React 49, Phoenix 37, TS/Hono 32, .NET 25,
**Python 13, Java 12, Vue 3, Svelte 0**. CI: every older backend has an
`*-obs-e2e.yml`; **Python has none**. There is `generated-react-build.yml` and a
Vue build test, but no Svelte build path. The newer the platform, the thinner
the safety net — which is backwards from where regressions are most likely
(newest code, least exercised). Recommend at minimum a Python obs-e2e gate and a
Vue generator test pass that approaches the others' density before either is
called production-ready.

## Healthy — leave alone

- **`loom-ir.ts` (2,737 LOC)** is a type-only single source of truth with ~122
  exported types and no logic. Splitting it would invite circular imports for no
  benefit. Revisit only past ~3,500 LOC, and then only as a re-export facade.
- **`validate/validate.ts`** is an exemplary lean orchestrator fanning out to
  themed check leaves. Use it as the template for the seam extractions above.
- **`enrich/enrichments.ts` (1,331 LOC)** is cohesive but at the threshold;
  extract sub-stages (wire / deployment / workflow / payload / traceability)
  only if it crosses ~1,500 LOC, keeping the orchestrator for idempotency.
- **The expression and (JSX-family) walker seams** — the architecture's payoff.

## Suggested ordering

1. Close the Svelte stub gap (gate it or finish it) — user-visible correctness.
2. Widen the sibling-platform layering guard — one-line latent-bug fix.
3. Refresh CLAUDE.md + docs/platforms.md + docs/generators.md to the real roster.
4. Add the missing Python/Vue test + CI gates.
5. Resolve the `platform/` layout dichotomy (document or migrate).
6. Extract the `WorkflowChoreographer` seam (largest duplication payoff).
7. Migrate React onto `_frontend/api-module.ts`.
8. Add a HEEx primitive-parity test + document HEEx as a parallel engine (do
   NOT merge the walkers — the divergence is topological).
