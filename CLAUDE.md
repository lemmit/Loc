# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Answering style

Be concise and lead with the answer. No preamble, no recap of what you're about to do, no summary of what you just did.

- **Cut the obvious.** Don't narrate routine mechanics (opening a PR, kicking CI, running tests, committing) — just do them and report the result in a line.
- **Language features always carry two examples:** the Loom (`.ddd`) source *and* the generated target-language output. Show, don't describe.
- Prefer a short snippet or a one-line answer over a paragraph. Drop hedging and restated context.

## Keep going without being asked

Once a plan exists (or the user has approved an approach), **execute it end to end** — don't stop after each slice to ask "continue?". Finishing step 1 well *is* the go-ahead for step 2; treat the next planned item as the default action, not a decision point.

- **Work slice by slice to the end of the plan.** Only pause for a genuinely user-owned decision — an ambiguous requirement, a destructive/irreversible action, or a fork the plan didn't settle. "Should I proceed with the next step?" is not such a decision; just proceed.
- **Don't idle on CI.** If the next slice is independent, start it while CI runs. If it builds on an unmerged branch, **stack the PR** on the previous one rather than waiting for green. Report status in a line and keep moving.
- **Surface, don't stall.** When you do hit a real blocker, say what's blocked and what you'd do by default, then take that default unless it's irreversible — don't wait for "continue with recommended".

## What this is

**Loom** — a Langium-based DSL for Domain-Driven Design. A `.ddd` source describes a `system` of `module`s, `aggregate`s, `valueobject`s, `event`s, `repository`s, `api`s, `storage`s, `ui`s, and `deployable`s; the toolchain generates a runnable multi-project tree wired together as one `docker compose` stack. Five backends (TypeScript/Hono, .NET/ASP.NET+EF+Mediator, Phoenix LiveView/Ash, Python/FastAPI+SQLAlchemy, Java/Spring Boot+JPA) and four frontends (React/Vite+Mantine, Vue 3/Vite+Vuetify, Svelte/SvelteKit, Angular+Angular Material) are supported.

The package name in `package.json` is `loc-ddd-dsl`; the CLI binary is `ddd`; the working name everywhere in docs and code is "Loom".

## Build & test commands

```bash
npm install                  # also runs the `prepare` lifecycle (below)
npm run langium:generate     # regenerate parser/AST from src/language/ddd.langium
npm run build                # tsc -b (composite project)
npm run watch                # tsc -b --watch
npm run prepare              # = langium:generate && build; runs on `npm install`
```

`src/language/generated/` (parser/AST/reflection) is **committed**, produced by `npm run langium:generate`. After any grammar edit, re-run `prepare` (or at least `langium:generate`) and commit the regenerated files — `langium-generated.yml` fails CI on any drift between `ddd.langium` and the committed output. A fresh clone already has them, but many imports resolve into this dir, so run `prepare` if a checkout looks stale before `tsc`.

### Tests

The default `npm test` excludes the slow opt-in suites below. Run a single test by path:

```bash
npm test                                   # fast vitest suite (~all unit + IR + generator tests)
npm run test:watch                         # same, watch mode
npx vitest run test/parsing.test.ts        # one suite
npx vitest run -t "test name pattern"      # filter by name

# Opt-in slow suites (each gated on a LOOM_* env var; default `npm test` excludes them):
npm run test:e2e          # LOOM_E2E=1 — boots docker-compose stack + hits /health + runs DSL e2e + Playwright UI + OpenAPI parity diff
npm run test:tsc          # LOOM_TS_BUILD=1 — emits TS projects and runs `tsc --noEmit` against them
npm run test:tsc-react    # LOOM_REACT_BUILD=1 — emits React projects for every example × design pack and tscs them
                          # CI shards via LOOM_REACT_BUILD_CASE=<ddd-path>:<pack>
npm run test:svelte-build # LOOM_SVELTE_BUILD=1 — emits SvelteKit projects (examples × svelte packs), svelte-checks + vite-builds them
                          # CI shards via LOOM_SVELTE_BUILD_CASE=<ddd-path>:<pack>
npm run test:vue-build    # LOOM_VUE_BUILD=1 — {minimal,scaffold,showcase} × {vuetify,shadcnVue}: vue-tsc + vite build
                          # CI shards via LOOM_VUE_BUILD_CASE=<case>:<pack>
npm run test:vue-e2e      # LOOM_VUE_E2E=1 — RUNTIME e2e: vite-builds vue-showcase, `vite preview`s the bundle, runs the
                          # emitted Playwright smoke spec against it (pure client-side; pack via LOOM_VUE_E2E_PACK)
npm run test:svelte-e2e   # LOOM_SVELTE_E2E=1 — the Svelte sibling of the above (vite preview + Playwright smoke)
npm run test:dotnet       # LOOM_DOTNET_BUILD=1 — `dotnet build /warnaserror` against generated .NET projects
npm run test:java         # LOOM_JAVA_BUILD=1 — `gradle testClasses bootJar` against generated Spring Boot projects (JDK 21 + Gradle)
npm run test:python       # LOOM_PYTHON_BUILD=1 — `uv sync` + `ruff check` + `mypy --strict` + `pytest` against generated FastAPI projects (uv)
npm run test:phoenix      # LOOM_PHOENIX_BUILD=1 — `mix compile --warnings-as-errors` against real Ash 3.x in Elixir docker
npm run test:obs          # LOOM_OBS_E2E=1 — boots generated Hono backend, asserts catalog envelope on stdout
npm run test:obs-dotnet   # LOOM_OBS_E2E_DOTNET=1 — same for the .NET backend (postgres sidecar via docker)
npm run test:obs-phoenix  # LOOM_OBS_E2E_PHOENIX=1 — same for the Phoenix backend (postgres sidecar via docker)
npm run test:obs-java     # LOOM_OBS_E2E_JAVA=1 — same for the Java backend (docker postgres, or LOOM_OBS_PG_URL override)
npm run test:obs-python   # LOOM_OBS_E2E_PYTHON=1 — same for the Python backend (docker postgres, or LOOM_OBS_PG_URL override)
npm run test:biome-gen    # LOOM_BIOME=1 — Biome lint against emitted TS/TSX (already run in `test.yml`)
npm run test:k8s          # LOOM_K8S=1 — `generate system --k8s` → helm lint + helm template | kubeconform (+ raw k8s/); needs helm + kubeconform on PATH
npm run test:k8s-e2e      # cluster smoke — install ONE backend's chart (per-deployable enabled toggle) into a kind cluster + throwaway postgres, assert it boots + /ready + real read (findAll GET) AND write (POST a fixture body → 201 → read back) round-trips; parametrized SMOKE_DDD/SMOKE_BACKEND/SMOKE_FIXTURE (k8s-e2e.yml fans it across backends as a matrix); needs kind + kubectl + helm + docker (run `kind create cluster` first)
```

`LOOM_E2E_CA_DIR=<dir-of-*.crt>` injects custom CAs when running the e2e suite behind a TLS-intercepting proxy.

### Docker (running the container-backed suites)

**Docker is runnable in the remote/sandbox environment** — the Docker-backed suites above (`test:e2e`, `test:phoenix`, the `obs-*` / `auth-e2e-*` legs, `test:k8s-e2e`) are *not* off-limits. The container ships the Docker **client** but **no running daemon by default, and the daemon is intentionally not auto-started** — bring it up yourself when a task needs it:

```bash
dockerd >/tmp/dockerd.log 2>&1 &     # root + passwordless sudo; backgrounded
until docker info >/dev/null 2>&1; do sleep 1; done   # readiness gate
```

It does **not** persist — if `docker info` starts failing mid-session, just relaunch it (the daemon process gets reaped). Image pulls from Docker Hub / `mcr.microsoft.com` work through the standard egress.

**Every backend target compiles locally without waiting on CI** (verified end-to-end here — generate → compile):

- **Java** — `gradle testClasses bootJar` on the *host* (JDK 21 + Gradle present; no container needed).
- **.NET** — host has no SDK, so build in the `mcr.microsoft.com/dotnet/sdk:8.0` container (matches the `net8.0` target): `dotnet restore` + `dotnet build /warnaserror` are clean.
- **Phoenix/Elixir** — `mix deps.get && mix compile --warnings-as-errors` in the `hexpm/elixir` image, against real Ash 3.x.
- **Python** — `uv sync` + ruff + mypy + pytest on the host.

The fast recipe for spot-checking a backend by hand: `node bin/cli.js generate system <f.ddd> -o out`, then run that backend's compiler (host for Java/.NET/Python, `docker run … hexpm/elixir … 'mix deps.get && mix compile'` for Phoenix).

**Egress proxy wrinkle (Elixir only):** some proxies allowlist by *TLS fingerprint* — system OpenSSL (curl/.NET/Gradle/Python `ssl`) passes, but Erlang/OTP's `:ssl` gets a bare HTTP 503, so `mix deps.get` can't reach hex.pm from the container. Set **`LOOM_HEX_MIRROR=1`** to route hex.pm through a loopback TLS-terminating mirror (`scripts/hex-mirror.py` via `test/e2e/support/hex-mirror.ts`) that re-originates with the accepted fingerprint — `LOOM_PHOENIX_BUILD=1 LOOM_HEX_MIRROR=1 npm run test:phoenix` then runs green. Needs `python3` + `openssl` and the privilege to bind `:443`. Unset, it's a no-op (CI runners have direct hex.pm access). Full write-up: [`docs/tools.md`](docs/tools.md) → "Compiling generated backends in Docker"; gotcha log in `experience_gathered.md` §14.

### CLI

```bash
node bin/cli.js new <name> [--platform hono|dotnet|elixir|java|python] [--template blank|crud] [--design <pack>]  # scaffold a starter project (main.ddd + README + .loomignore), validated before writing
node bin/cli.js parse <file.ddd>                       # parse + validate, exit non-zero on errors
node bin/cli.js generate ts     <file.ddd> -o <out>    # single Hono project (legacy single-context mode)
node bin/cli.js generate dotnet <file.ddd> -o <out>    # single .NET project (legacy)
node bin/cli.js generate system <file.ddd> -o <out>    # full multi-deployable tree + docker-compose.yml
node bin/cli.js snapshot        <file.ddd> -o <out>    # capture immutable .loom/snapshots/<ts>-<guid>.loomsnap.json (provenance rule snapshot — like `ef migrations add`, run deliberately)
node bin/cli.js verify          <file.ddd> --results <results.json> [--out <dir>]  # join an existing test-results JSON onto the requirements graph → .loom/verification.{json,md} (gates the exit code; does NOT run the suites itself)
```

Flags: `-o/--out`, `-w/--watch` (legacy generate only), `--dry-run` (print `write`/`skip` plan, touch nothing).

## Architecture — the one-directional pipeline

The single most important fact: **layers are strictly one-directional and enforced by file structure.** The compiler runs in **ten phases**; the canonical detailed walk-through is in [`docs/technical.md`](docs/technical.md).

```
.ddd → ① parse → ② macro expand → ③ scope/link → ④ AST validate → ⑤ lower → ⑥ enrich → ⑦ IR validate → ⑧ per-platform codegen → ⑨ system compose + migration derive → ⑩ write
        src/language/generated/    src/macros/    src/language/    src/language/   src/ir/lower/  src/ir/enrich/   src/ir/validate/                     src/generator/<plat>/    src/system/                       src/cli/main.ts
                                   expander.ts    ddd-scope.ts     validators/     lower.ts +     enrichments.ts   validate.ts                          + src/platform/<plat>/   + src/system/migrations-builder.ts
                                   registry.ts                     + type-system   lower-expr.ts                                                                                  (called from system, not ir)
                                                                                   + walker-
                                                                                   primitive-
                                                                                   expander.ts
```

- `language/` knows nothing about `ir/`.
- `ir/` knows nothing about `generator/`.
- `generator/<platform>/` knows nothing about other platforms.
- `system/` composes outputs from the platform generators; it never generates domain code itself.
- **No target-backend IR.** Every backend consumes `LoomModel` directly. The only secondary IR is `MigrationsIR`, derived once in phase ⑨ and shared by every backend with a database.

This is **test-enforced**, not just convention: `test/platform/pipeline-layering.test.ts` fails on any *value* (runtime) backward-edge across the `language → ir → generator → system` chain (type-only imports of the shared IR vocabulary are exempt — `import type` carries no runtime edge), and `test/platform/backend-packages-layering.test.ts` guards the `generator → platform` package edge. A shared helper consumed across layers belongs at the layer its consumers live at (e.g. pack-identity metadata and source-type predicates are in `src/util/`; the Postgres-SQL renderer is in `src/generator/`), never imported "upward" against the pipeline.

**Loom IR (`src/ir/types/loom-ir.ts`) is platform-neutral and fully resolved.** Every name carries a `refKind` (`param`/`let`/`this-prop`/`enum-value`/…), every member access carries `receiverType` and `memberType`, every call carries `callKind`, every find filter is a typed `ExprIR`. Backends never re-resolve. This is the architectural payoff for phase ⑤'s complexity — adding a backend means writing emitters, not redoing name resolution.

The lowering phase has three sub-passes, all driven by `lowerModel`:

- **⑤a** `src/ir/lower/lower.ts` — structural walk (`lowerModel` / `lowerProject` / `lowerSystem` / `lowerContext` / `lowerAggregate`, etc.). Never descends into expressions. `lower.ts` is now a **thin orchestrator** (~1.1k LOC): the per-declaration-kind lowerers live in sibling leaf modules it imports — `lower-platform.ts` (design/platform qualification), `lower-requirements.ts`, `lower-capabilities.ts` (filter/stamp/implements collection), `lower-members.ts` (shared field/derived/invariant/function/containment + operation/create/destroy/apply action bodies), `lower-view.ts`, `lower-deployment.ts`, `lower-ui.ts`, `lower-workflow.ts`. The graph is acyclic: leaves never import `lower.ts`; the only public exports (`lowerModel`/`lowerProject`/`mergeLoomModels`) stay in `lower.ts`.
- **⑤b** `src/ir/lower/lower-expr.ts` + `lower-stmt.ts` + `lower-types.ts` — expressions, statements, types, name resolution, member typing. `lower.ts` (and the ⑤a sibling leaves) import from these; they never import from `lower.ts`.
- **⑤c** `src/ir/lower/walker-primitive-expander.ts` — inline scaffold expansion (`scaffoldDetails(of:)` / `scaffoldOperations(of:)` in page bodies → full walker-stdlib `ExprIR`). Called as the last statement of `lowerSystem`; downstream phases never see the un-expanded form.

After lowering, `src/ir/enrich/enrichments.ts` runs **one pure pass** (phase ⑥) that derives:

1. **`wireShape`** on every aggregate / part / value object — the canonical ordered field list every backend's DTO emitter consumes (`id`, then declared properties, then containments, then derived). Cross-backend wire compatibility is structural, not coincidental.
2. **Auto-`findAll`** on every aggregate's repository.
3. **Associations** for `X id[]` collection fields (join-table metadata).
4. **React `targets:` module inheritance** — react deployables inherit their target backend's `moduleNames`.
5. **Per-module `migrationsOwner`** — picks one backend deployable per module to own schema-migration emission; consumed by `buildMigrations` in phase ⑨.

The output is a branded `EnrichedLoomModel` — the validator, system orchestrator, and generators all take `EnrichedLoomModel` / `EnrichedBoundedContextIR` / `EnrichedAggregateIR` at their entry points, so an un-enriched IR fails to type-check rather than getting silently passed through with a `wireShape!` cast.

Then `src/ir/validate/validate.ts` runs phase ⑦ — cross-aggregate / multi-file IR-level checks that need the fully-resolved, enriched IR. `validate.ts` is a thin orchestrator (`validateLoomModel`) that fans out to per-theme leaf modules under `src/ir/validate/checks/` (`system-checks` / `query-checks` / `test-checks` / `workflow-checks` / `structural-checks`, plus `shared.ts` helpers and `diagnostic.ts` for the `LoomDiagnostic` type); `firstNonQueryableNode` + `LoomDiagnostic` are re-exported from `validate.ts` so its public surface is unchanged.

A JSON Schema artifact at `<outdir>/.loom/wire-spec.json` is built from `wireShape` by `src/system/wire-spec.ts` (in phase ⑨) for diff-based contract change detection. See [`docs/loom-artifacts.md`](docs/loom-artifacts.md) for the full `.loom/` bundle (mermaid views, LikeC4 model, traceability, verification, provenance snapshots) — every sibling of `index.ts` under `src/system/` emits one of these.

### Per-platform generators (`src/generator/<platform>/`)

Every backend has the same shape:

| File | Role |
|---|---|
| `index.ts` | Orchestrator — `generate<Platform>ForContexts(...) → Map<path, content>` |
| `emit/*.ts` (TS/.NET) or `*-emit.ts` (Phoenix) | Procedural emitters (`render<Thing>(...)`) for regular-shaped fragments — id classes, value-object classes, events, DTOs. Plain TS functions building strings via `lines(...)` from `src/util/code-builder.ts`. **The backend emitters use no Handlebars since the v2 refactor — but Handlebars is still a live runtime dependency for the design-pack rendering layer (`src/generator/_packs/loader.ts` compiles the `.hbs` pack/shared templates under `designs/`, `vite/`, `api/`, `docker/`, `stacks/`).** |
| `*-builder.ts` | Larger procedural builders for per-aggregate-variable content (Hono routes, repositories, React pages, page-objects). |
| `render-expr.ts` / `render-stmt.ts` | IR-expression-/IR-statement-to-source renderers. Present on the five backends that execute domain logic (TS, .NET, Phoenix LiveView, Python, Java). The frontends (React, Vue) skip these — they don't run domain logic, only consume the wire shape. **Each `render-expr.ts` is now a leaf-only `ExprTarget` table** — the 17-arm `ExprIR.kind` dispatch + all recursion live once in `src/generator/_expr/target.ts` (see below). `render-stmt.ts` stays per-backend (flat dispatch, shape-divergent arms — deliberately not extracted). |

The backends (Hono/node, .NET, Phoenix/elixir, Python/FastAPI, Spring Boot/java) and the frontends (react, vue, svelte) — plus their entry points — are registered in `src/platform/registry.ts`; each implements the `PlatformSurface` contract in `src/platform/surface.ts` (`emitProject`, `composeService`, `needsDb`, `defaultPort`, `mountsUi`). Note the layout asymmetry: most platforms are a thin `src/platform/<name>.ts` surface delegating to `src/generator/<name>/`, but Hono is a full versioned-package backend living under `src/platform/hono/v4/` (the `docs/backend-packages.md` pattern). `svelte` follows the thin-surface pattern too, delegating to `src/generator/svelte/` (a frontend host dispatches by the ui's `framework:`, so a svelte host can also serve a `framework: react` bundle).

The five backend expression renderers share one dispatcher: `src/generator/_expr/target.ts` **defines** the `ExprTarget` contract (the eight leaf-divergence axes — operators, naming, money arithmetic, collection ops, `refColl.contains` membership, regex, `ref` role, `callKind` call syntax) and `renderExprWith(e, target, ctx)`, which owns the 17-arm `ExprIR.kind` dispatch + recursion. Each backend's `render-expr.ts` supplies only the leaf table (`TS_TARGET` / `CS_TARGET` / `ELIXIR_TARGET` / `PY_TARGET` / `JAVA_TARGET`); a new domain-logic backend writes one target, not a new dispatcher. Expression-side analogue of the `WalkerTarget` seam below; byte-identical-output gated (PR #843). Per-`ExprIR.kind` arm tests live alongside each backend (`render-expr-kinds.test.ts` for TS/.NET, `phoenix-render-expr.test.ts`).

### React / Vue page rendering — the body walker

Page bodies in the `ui` DSL are written in a closed primitive library (`List`/`Detail`/`Form`/`MasterDetail`/`Stack`/`Heading`/`Button`/`Card`/`Toolbar`/`match`/lambdas/`state := …`). The dispatch registry lives in `src/generator/_walker/registry.ts`; `src/language/walker-stdlib.ts` holds the name-only mirror consumed by the validator (pinned by `walker-stdlib-completeness.test.ts`). Contributors adding a primitive register it in both places — the test gates the mirror. A new primitive carries a `tsx` renderer and *optionally* a `heex` one; `test/generator/elixir/heex-parity.test.ts` freezes the set of TSX-rendered primitives that lack HEEx coverage, so a TSX-only addition fails CI until you either write the `heex` renderer or pin the name with a reason (the parity gap stays a reviewed decision, not silent Phoenix degradation). The shared JSX-family engine is `src/generator/_walker/walker-core.ts` (`walkBody`); React drives it via `src/generator/react/body-walker.ts` and Vue via `src/generator/vue/index.ts`, each dispatching per-primitive through the active **design pack** (`designs/mantine|shadcn|mui|chakra/` for React, `designs/vuetify/` for Vue, plus `designs/ashPhoenix/` for Phoenix HEEx). The `walker-*.test.ts` files (~30 of them) each cover one primitive or rendering concern; if you change the walker, expect to touch one of these.

The framework-specific seams (state read/write syntax, helper imports, navigation, API call lowering, `match` rendering, plus the markup seams — comments, conditional children, style attr, text escaping, children slot, form-runtime imports) are framework-shaped and cannot be expressed as pack templates. `src/generator/_walker/target.ts` **defines** the `WalkerTarget` contract that captures them. Three JSX/markup targets consume the SHARED walker core (`src/generator/_walker/walker-core.ts`, `walkBody`): `src/generator/react/walker/tsx-target.ts`, `src/generator/vue/walker/vue-target.ts`, and `src/generator/svelte/walker/svelte-target.ts` (the old `react/body-walker.ts` is now a thin re-export + `walkBodyToTsx` entry). **Phoenix/HEEx does NOT consume `walkBody`** — `src/generator/elixir/heex-target.ts` runs a parallel engine (`heex-walker-core.ts`) because LiveView's output topology diverges (inline lambdas vs hoisted `handle_event` clauses, `.map` vs `for`-comprehensions, ternary vs `if`-block children); `heexTarget` is mainly a conformance shim. The byte-identical-output gate guarded each extraction (Phase A Item 1 slices: PRs #607–#627; the Svelte-port walker move + seam additions repeated the same gate). Framework-neutral frontend pieces shared across the JSX/markup frontends (zod schema emission, menu derivation, Playwright page objects, the e2e harness, the smoke spec) live under `src/generator/_frontend/`.

### Scaffolding

`scaffold modules: M` / `scaffold aggregates: …` is compile-time sugar. The AST-walker expansion lives in `src/ir/lower/walker-primitive-expander.ts` (~1.0k LOC); the per-shape macro bodies live under `src/macros/stdlib/scaffold/` (`scaffold.macro.ts` plus its siblings `scaffoldAggregate.macro.ts`, `scaffoldContext.macro.ts`, `scaffoldSubdomain.macro.ts`, `scaffoldView.macro.ts`, `scaffoldWorkflow.macro.ts`). Sibling stdlib capabilities (`audit/`, `softDelete/`, `crudish.macro.ts`) sit alongside under `src/macros/stdlib/`. Synthesised pages carry a `scaffoldOrigin` tag, then lower to explicit walker-stdlib bodies.

## Repository layout (non-obvious bits)

| Path | What lives here |
|---|---|
| `src/` | The Loom toolchain (compiler, generators, CLI). |
| `src/language/generated/` | **Committed** `langium generate` output — parser, AST types, reflection. Regenerate and commit after a grammar edit; `langium-generated.yml` guards it against drift. Must exist before `tsc` runs. |
| `src/language/print/` | AST → `.ddd` source printer (`printExpr` / `printStmt` / `printStructural`).  Drives the LSP "unfold macro" code action (`src/language/lsp/unfold-macro.ts`), which rewrites a `with X(...)` clause into its expanded source in place. Each printer dispatches on `node.$type` and throws on an unhandled type; `test/language/print/print-completeness.test.ts` pins all three against the grammar's printable unions (via Langium reflection), so a new member/expr/stmt rule without a printer arm fails CI — add the matching `case` when extending the grammar. Round-trip safety is gated by `print-structural-roundtrip.test.ts`. |
| `src/ir/{types,lower,enrich,validate,util}/` | The phase-revealing IR layout. One subdir per pipeline phase. `lower/` is a thin `lower.ts` orchestrator over sibling leaves: the expr/stmt/type passes (`lower-expr.ts` / `lower-stmt.ts` / `lower-types.ts`), the scaffold expander (`walker-primitive-expander.ts`), and the per-declaration-kind lowerers (`lower-platform` / `-requirements` / `-capabilities` / `-members` / `-view` / `-deployment` / `-ui` / `-workflow`). `validate/` is a thin `validate.ts` orchestrator over `validate/checks/*` (per-theme check leaves + `shared.ts` + `diagnostic.ts`). |
| `src/macros/` | Macro pipeline. `expander.ts` is the Langium `DocumentBuilder` listener; `registry.ts` is the global lookup; `api/` is the macro-authoring surface (`defineMacro`, factories); `stdlib/` ships the built-in macros (`audit/`, `softDelete/`, `scaffold/`, `crudish.macro.ts`). `bootMacros()` from `src/language/ddd-module.ts` registers them once at language-module init. |
| `src/verify/` | `ddd verify` rollup — joins test-execution results onto the traceability graph to produce per-requirement Definition-of-Done verdicts.  Pure, dependency-free; consumed by both the CLI and the browser playground. |
| `src/api/` | **Transport-neutral toolkit** — `validate()` / `generate()` / `applyPatches()` over an in-memory `.ddd` source, returning the `src/diagnostics/contract.ts` wire shapes. One shared core for every surface (CLI, MCP server, LSP adapters, web playground); parses on `EmptyFileSystem` so it stays browser-safe. `report.ts` holds the diagnostic/outline serializers. See [D-API-TOOLKIT](docs/decisions.md). |
| `src/tools/` | **Agent-tool catalog** ([D-AGENT-TOOLS](docs/decisions.md)) — one transport-neutral set of `loom_*` tool defs (name + JSON-Schema input + handler) over `src/api/`. Pure, side-effect-free, browser-safe. `callTool(name, args)` is the single dispatch entry every transport reuses (MCP server, playground chat). |
| `src/mcp/` | **MCP server core** — a Node-only island (like `src/cli/`) that registers the `src/tools/` catalog over the Model Context Protocol via the low-level `@modelcontextprotocol/sdk` `Server` (raw-JSON-Schema `tools/list` + `tools/call` → `callTool`). `main.ts` is the stdio entrypoint (compiled to `out/mcp/main.js`, launched by the `packages/ddd-mcp` bin). Owns no tool logic — only transport wiring. |
| `src/system/` | More than just the orchestrator — siblings of `index.ts` emit the `.loom/` artefact bundle: `mermaid.ts`, `likec4.ts`, `traceability.ts`, `wire-spec.ts`, `loomsnap.ts` (provenance snapshot capture for `ddd snapshot`), `migrations-builder.ts` (derives `MigrationsIR`; the Postgres-SQL renderer it feeds, `sql-pg.ts`, lives under `src/generator/` since only the backends consume it).  See [`docs/loom-artifacts.md`](docs/loom-artifacts.md). |
| `packages/` | **Publish-shaped workspaces** discovered by the plugin resolver: `@loom/core` (the toolchain library + `PlatformSurface` contract), `@loom/backend-hono-v4` (versioned Hono backend), `@loom/ui-test-driver` (the cross-window page-object/locator runtime), `ddd-mcp` (the MCP stdio-server publish wrapper — `bin` + the SDK dep over `src/mcp/`).  Each `package.json` carries a `loom` key (`kind: "core"\|"backend"\|"mcp-server"`, `family`, `loomVersion`, `core` semver range) read by `src/platform/fs-discovery.ts` — this is the out-of-tree backend story. |
| `web/` | Separate package — the browser-side playground. Imports the Loom toolchain straight from `../src` (pure TS, no Node-only APIs except `src/cli/` and `src/language/main.ts`). Has its own `package.json`, `playwright.config.ts`, and Vite shim that swaps `_packs/loader-fs.js` for a VFS-backed loader. |
| `vscode/` | Separate package — VS Code extension (LSP client). Has its own `package.json`; builds against the compiled toolchain. |
| `designs/` | Design packs (Mantine / shadcn / MUI / Chakra for React, Vuetify for Vue, shadcnSvelte / flowbite for Svelte, ashPhoenix for HEEx). Each pack is a tree of templates that the body-walker dispatches into. |
| `api/`, `vite/`, `docker/`, `sveltekit/` | Top-level `.hbs` snippets — boilerplate for generated projects (API client, vite config, dockerfile; `sveltekit/` is the svelte-format packs' shared layer). |
| `designs/` | Design packs (Mantine / shadcn / MUI / Chakra / ashPhoenix, plus the vue packs vuetify / shadcnVue). Each pack is a tree of templates that the body-walker dispatches into. |
| `api/`, `vite/`, `docker/` | Top-level `.hbs` snippets — boilerplate for generated projects (API client, vite config, dockerfile). |
| `stacks/v1/`, `v2/`, `v3/` | Versioned Handlebars templates for generated-project `package.json` dependency / devDependency blocks (`stack-package-deps.hbs`, `stack-package-devdeps.hbs`, `stack.json` manifest).  The active stack version is chosen per generated deployable based on its platform pins. |
| `phoenix/` | Top-level companion docs for the Phoenix backend (README). |
| `examples/`, `web/src/examples/` | Sample `.ddd` files. CI's `generated-react-build.yml` matrix iterates `examples/acme.ddd` + everything under `web/src/examples/` × every design pack. |
| `test/` | Test tree mirrors `src/` phases — `test/language/`, `test/macro/`, `test/ir/`, `test/generator/`, `test/platform/`, `test/system/`, `test/cli/`, `test/conformance/`, `test/playground/`, `test/util/`, with slow opt-in suites under `test/e2e/`. |
| `test/fixtures/` | **Excluded from vitest discovery** in `vitest.config.ts`. These are byte-for-byte snapshots of generated output used as regression fixtures (capture script: `scripts/capture-baseline-fixture.mjs`); the `.test.ts` files inside are not part of this project's test surface. |
| `docs/` | Reference docs (top-level), plus `plans/` (in-flight design notes), `audits/` (snapshot-in-time empirical audits), and `proposals/` (unadopted designs). `docs/README.md` is the canonical index. Build the landing+docs site via `node docs/build.mjs` (recurses into `plans/` + `audits/`). Deployed by `.github/workflows/pages.yml` to GitHub Pages. |
| `experience_gathered.md` | Running retrospective of design decisions and gotchas. **Worth reading before non-trivial changes** — covers Langium grammar gotchas, the Handlebars-removal rationale, Mantine + Playwright findings, IR design trade-offs. |

## Conventions

- **Procedural emission only.** When building generated source in the backend emitters, use `lines(...)` from `src/util/code-builder.ts`. The backend emitters use no template engine. (Handlebars is still used at runtime, but only by the design-pack layer — see the per-platform generator table above.)
- **Pluralisation and casing** flow through `src/util/naming.ts` (`pascal`, `camel`, `snake`, `plural`). Conservative plural rules: `y → ies`, `s/x/z/ch/sh → +es`, else `+s`. Use these instead of hand-cased strings.
- **`STRING` terminal strips its delimiters.** Langium gives `StringLit.value` as `USD` (3 chars) for source `"USD"`. Re-quote on emission with `JSON.stringify` or equivalent.
- **Grammar:** use a discriminator field (`op:`) over `{infer X.field=current}` actions in alternations — the latter generates recursive AST types that fail typecheck. Prefer flat-list rules (`head=ID ('.' tail+=ID)*`) over recursive list rules.
- **Cross-aggregate references must use `X id`.** The custom scope provider in `src/language/ddd-scope.ts` restricts containment partTypes (and bare-name type refs) to entity parts declared in the same aggregate; cross-aggregate links must spell out `X id` (validator code `loom.bare-aggregate-in-type`).
- **Test e2e dispatch (api vs ui) is automatic from the target deployable's platform.** No DSL keyword is needed — `test e2e "x" against <react-deployable>` lowers to Playwright via page objects; against a backend lowers to vitest+fetch.

## Extending — the recipes from `docs/technical.md`

**Adding a language feature:**
1. Edit `src/language/ddd.langium`; `npm run langium:generate`.
2. Update `ddd-scope.ts` / `src/language/validators/<themed>.ts` / `type-system.ts` as needed.
3. Add IR node in `loom-ir.ts`; lower it in the relevant `lower/` module — the matching per-declaration-kind sibling (`lower-members.ts`, `lower-workflow.ts`, …) or `lower-expr.ts` (expr/stmt/type) — and wire the call into the `lower.ts` orchestrator if it's a new structural member.
4. For a new `ExprIR.kind`: add one arm to `renderExprWith` in `src/generator/_expr/target.ts` and one method to the `ExprTarget` interface — the exhaustive switch + interface make every backend's target a compile error until filled. For a new `StmtIR` kind: extend each backend's `render-stmt.ts`.
5. Extend `emit/*.ts` (or `*-emit.ts` on Phoenix) or a `*-builder.ts` per backend.
6. If the feature adds a structural member / expression / statement to the grammar, add the matching arm in `src/language/print/print-structural.ts` (or `print-expr.ts` / `print-stmt.ts`) — `print-completeness.test.ts` fails until you do.
7. Add: one parsing test, one negative validator test, one generator test per backend.
8. Verify with `npm test` and at least one `LOOM_TS_BUILD=1` / `LOOM_REACT_BUILD=1` run.

**Adding a backend:**
1. Two homes are possible:
   - **In-tree (default for new backends):** implement `PlatformSurface` in `src/platform/<backend>.ts`; register in `src/platform/registry.ts`.
   - **Out-of-tree (versioned package, like the `node@v4` backend in `packages/backend-hono-v4/`):** add a workspace under `packages/backend-<family>-v<N>/` with a `package.json` carrying a `loom: { kind: "backend", family, loomVersion, core }` block.  `src/platform/fs-discovery.ts` picks it up via `setBackendSource`; `parseBuiltinPlatformRef` lets a deployable target it by `family@version`.
2. If the backend serves a wire shape, read `agg.wireShape` etc. directly from the IR — do not recompute.
3. If it runs domain logic, implement `render-expr.ts` / `render-stmt.ts` honouring `refKind` / `callKind` / `isCollectionOp`.
4. If a new `platform:` keyword is added, also extend the `Platform` rule in `ddd.langium`, the `Platform` type in `loom-ir.ts`, and `checkDeployable` in `src/language/validators/deployable.ts` (see the `'react'` and `'phoenixLiveView'` additions for the pattern).

## CI surface (what each workflow gates)

- `test.yml` — the fast vitest suite (the same one `npm test` runs); also runs `test:biome-gen` against emitted TS/TSX.
- `langium-generated.yml` — guards that `npm run langium:generate` produces deterministic output (drift between `ddd.langium` and the committed types).
- `k8s-build.yml` — `generate system --k8s` → `helm lint` + `helm template` | `kubeconform` (rendered chart + raw `k8s/`) against the k8s API schemas. Catches Helm/manifest emitter drift. See `docs/kubernetes.md`.
- `k8s-e2e.yml` — heavier cluster smoke, **fanned across backends as a matrix** (one cell per backend, each installing just its workload via the chart's per-deployable `enabled` toggle): hono/dotnet/python/java/phoenix-Ash over `scripts/k8s-e2e/k8s-smoke.ddd` + phoenix-vanilla over `examples/tasks-vanilla.ddd`. Installs into a `kind` cluster (+ throwaway postgres named `db` so each backend's native default URL connects) and asserts the backend boots, reaches `/ready`, and real read (`findAll` `GET`) + write (`POST` a fixture body → `201` → read back) round-trips through the migrated DB. NOT per-PR — runs nightly, on the `e2e-k8s` PR label, or via manual dispatch. See `docs/kubernetes.md`.
- `pages.yml` — typecheck + smoke + build playground + deploy docs/playground to GitHub Pages (main only).
- `generated-react-build.yml` — matrix `{example × pack}`, generates the React project, `npm install`, `tsc --noEmit`. Catches generator drift invisible to IR-level tests.
- `generated-svelte-build.yml` — matrix `{example × svelte pack}`, generates the SvelteKit project, `npm install`, `svelte-check --fail-on-warnings`, `vite build`.
- `generated-vue-build.yml` — the Vue sibling: `{case × vuetify@v3,shadcnVue@v1}`, `vue-tsc --noEmit` + `vite build` per cell.
- `generated-vue-e2e.yml` / `generated-svelte-e2e.yml` — RUNTIME e2e: `vite build` the frontend, `vite preview` the bundle, run the emitted Playwright smoke spec against it (pure client-side, no backend). The runtime sibling of the `-build` gates.
- `hono-build.yml` — fast `tsc --noEmit` + `tsup` gate against the Hono backend output.
- `dotnet-build.yml` — `dotnet build /warnaserror` against the .NET output.
- `java-build.yml` — `gradle testClasses bootJar` (main + emitted JUnit sources) against the Java output.
- `python-build.yml` — `uv sync` + `ruff check` + `mypy --strict` + `pytest` against the Python/FastAPI output.
- `elixir-ash-build.yml` — `mix deps.get && mix compile --warnings-as-errors` against the real Ash 3.x dep set in an Elixir docker image.
- `elixir-vanilla-build.yml` — same, against the vanilla Ecto/Phoenix (non-Ash) foundation.
- `hono-obs-e2e.yml` / `dotnet-obs-e2e.yml` / `elixir-ash-obs-e2e.yml` / `java-obs-e2e.yml` / `python-obs-e2e.yml` — per-backend observability e2e (boots the generated backend, asserts the catalog envelope on stdout).
- `generated-svelte-build.yml` — matrix `{example × svelte pack}`, generates the SvelteKit project and typechecks it (the Svelte analogue of `generated-react-build.yml`). Vue has no dedicated generated-build workflow yet (it rides the fast vitest suite).
- `playground-e2e.yml` — Playwright specs against the production-built playground (editor → generate → bundle → boot → preview).
- `conformance-parity.yml` / `conformance-full.yml` — cross-backend OpenAPI / wire-shape parity (parity is the per-PR gate; full is the broader run).
- `cleanup-artifacts.yml` — scheduled tidy of test artefacts.

### Local enforcement (checked-in Claude Code hooks)

`.claude/settings.json` wires three project hooks so the CI Biome gate (and a clean-merge invariant) can't be forgotten:

- **SessionStart** (`.claude/hooks/session-start.sh`) — runs `npm install` (the `prepare` lifecycle: `langium:generate` + `build`) on a fresh remote container so Biome, the build, and the tests are ready. Idempotent; skips when `node_modules/.bin/biome` and `src/language/generated/` already exist; remote-only (`$CLAUDE_CODE_REMOTE`).
- **Stop** (`.claude/hooks/biome-gate.sh`) — when a turn finishes with work in the tree, runs `npm run lint` (`biome ci .`, the exact `test.yml` step). On failure it **blocks** and feeds the Biome output back so it's fixed before finishing; it releases (with a loud warning) after one fix cycle to avoid a stop loop, and never blocks when Biome isn't installed.
- **PreToolUse(Bash)** (`.claude/hooks/pre-push-merge-check.sh`) — before a `git push`, fetches `origin/main` and runs a `git merge-tree --write-tree` dry-run; **denies** the push (with a rebase hint + the conflicting files) when the branch wouldn't merge cleanly, so upstream drift is caught before it becomes a stale PR. Conservative: only blocks on a *definite* conflict and **fails open** on any uncertainty (not a repo, no `origin/main`, offline, git < 2.38, pushing trunk itself).

`.claude/` stays gitignored except `settings.json` and `hooks/` (see `.gitignore`), so the hooks ship with the repo while worktrees and `settings.local.json` stay local.

## Further reading

`docs/README.md` is the canonical doc index — start there. The most useful entries when working on the toolchain:

- `docs/language.md` — formal language reference (declarations, types, expressions, statements, validation rules).
- `docs/page-metamodel.md` — page DSL surface (pages, components, scaffolding, state, match, lambdas).
- `docs/architecture.md` — system-level composition model (api/storage/ui/deployable layers).
- `docs/generators.md` — per-platform feature matrix — what each backend emits, file-by-file.
- `docs/platforms.md` — the backend registry, `family@version` pinning, `PlatformSurface` contract.
- `docs/design-packs.md` — design-pack authoring guide (manifest, stacks, required emits, recipe for new versions).
- `docs/technical.md` — pipeline architecture (the canonical, detailed version of the summary above).
- `docs/tools.md` — CLI, `.loomignore`, watch mode, Docker workflow, OpenAPI parity check, proxy CAs.

Per-feature reference docs — `docs/auth.md`, `views.md`, `payloads.md` (payload/command/query/response/error records, the `paged`/`envelope` carriers, and discriminated unions — `A or B` / `payload Foo = A | B` / `T option` — with the tagged `type` wire), `inheritance.md` (abstract aggregates / `extends` / TPC vs TPH / polymorphic `find all <Base>`), `workflow.md`, `criterion.md` (reusable predicate specifications), `extern.md`, `capabilities.md` (filter/stamp/implements), `scaffold-macros.md` (the macro stdlib), `provenance.md` (provenanced fields + ddd snapshot), `observability.md`, `traceability.md`, `conformance.md`, `migrations-design.md`.

`docs/plans/` and `docs/audits/` hold in-flight design notes and historical snapshots; do not treat them as authoritative for what ships today. `docs/proposals/` holds proposals not yet adopted.

`experience_gathered.md` — gotchas log; read before non-trivial work.
