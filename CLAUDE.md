# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Loom** — a Langium-based DSL for Domain-Driven Design. A `.ddd` source describes a `system` of `module`s, `aggregate`s, `valueobject`s, `event`s, `repository`s, `api`s, `storage`s, `ui`s, and `deployable`s; the toolchain generates a runnable multi-project tree (TypeScript/Hono, .NET/ASP.NET+EF+Mediator, React/Vite+Mantine, Phoenix LiveView/Ash) wired together as one `docker compose` stack.

The package name in `package.json` is `loc-ddd-dsl`; the CLI binary is `ddd`; the working name everywhere in docs and code is "Loom".

## Build & test commands

```bash
npm install                  # also runs the `prepare` lifecycle (below)
npm run langium:generate     # regenerate parser/AST from src/language/ddd.langium
npm run build                # tsc -b (composite project)
npm run watch                # tsc -b --watch
npm run prepare              # = langium:generate && build; runs on `npm install`
```

`src/language/generated/` is **gitignored** and produced by `npm run langium:generate`. You must run `prepare` (or at least `langium:generate`) once after a fresh clone or any grammar edit before `tsc` will succeed — many imports resolve into the generated dir.

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
npm run test:dotnet       # LOOM_DOTNET_BUILD=1 — `dotnet build /warnaserror` against generated .NET projects
npm run test:phoenix      # LOOM_PHOENIX_BUILD=1 — `mix compile --warnings-as-errors` against real Ash 3.x in Elixir docker
npm run test:obs          # LOOM_OBS_E2E=1 — boots generated Hono backend, asserts catalog envelope on stdout
npm run test:obs-dotnet   # LOOM_OBS_E2E_DOTNET=1 — same for the .NET backend (postgres sidecar via docker)
npm run test:obs-phoenix  # LOOM_OBS_E2E_PHOENIX=1 — same for the Phoenix backend (postgres sidecar via docker)
npm run test:biome-gen    # LOOM_BIOME=1 — Biome lint against emitted TS/TSX (already run in `test.yml`)
```

`LOOM_E2E_CA_DIR=<dir-of-*.crt>` injects custom CAs when running the e2e suite behind a TLS-intercepting proxy.

### CLI

```bash
node bin/cli.js parse <file.ddd>                       # parse + validate, exit non-zero on errors
node bin/cli.js generate ts     <file.ddd> -o <out>    # single Hono project (legacy single-context mode)
node bin/cli.js generate dotnet <file.ddd> -o <out>    # single .NET project (legacy)
node bin/cli.js generate system <file.ddd> -o <out>    # full multi-deployable tree + docker-compose.yml
node bin/cli.js snapshot        <file.ddd> -o <out>    # capture immutable .loom/snapshots/<ts>-<guid>.loomsnap.json (provenance rule snapshot — like `ef migrations add`, run deliberately)
node bin/cli.js verify          <file.ddd> -o <out>    # run the generated test suites + join results onto the traceability graph → .loom/verification.{json,md}
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

**Loom IR (`src/ir/types/loom-ir.ts`) is platform-neutral and fully resolved.** Every name carries a `refKind` (`param`/`let`/`this-prop`/`enum-value`/…), every member access carries `receiverType` and `memberType`, every call carries `callKind`, every find filter is a typed `ExprIR`. Backends never re-resolve. This is the architectural payoff for phase ⑤'s complexity — adding a backend means writing emitters, not redoing name resolution.

The lowering phase has three sub-passes, all driven by `lowerModel`:

- **⑤a** `src/ir/lower/lower.ts` — structural walk (`lowerSystem`, `lowerAggregate`, etc.). Never descends into expressions.
- **⑤b** `src/ir/lower/lower-expr.ts` + `lower-stmt.ts` + `lower-types.ts` — expressions, statements, types, name resolution, member typing. `lower.ts` imports from these; they never import from `lower.ts`.
- **⑤c** `src/ir/lower/walker-primitive-expander.ts` — inline scaffold expansion (`scaffoldDetails(of:)` / `scaffoldOperations(of:)` in page bodies → full walker-stdlib `ExprIR`). Called from `lower.ts:552` as the last statement of `lowerSystem`; downstream phases never see the un-expanded form.

After lowering, `src/ir/enrich/enrichments.ts` runs **one pure pass** (phase ⑥) that derives:

1. **`wireShape`** on every aggregate / part / value object — the canonical ordered field list every backend's DTO emitter consumes (`id`, then declared properties, then containments, then derived). Cross-backend wire compatibility is structural, not coincidental.
2. **Auto-`findAll`** on every aggregate's repository.
3. **Associations** for `X id[]` collection fields (join-table metadata).
4. **React `targets:` module inheritance** — react deployables inherit their target backend's `moduleNames`.
5. **Per-module `migrationsOwner`** — picks one backend deployable per module to own schema-migration emission; consumed by `buildMigrations` in phase ⑨.

The output is a branded `EnrichedLoomModel` — the validator, system orchestrator, and generators all take `EnrichedLoomModel` / `EnrichedBoundedContextIR` / `EnrichedAggregateIR` at their entry points, so an un-enriched IR fails to type-check rather than getting silently passed through with a `wireShape!` cast.

Then `src/ir/validate/validate.ts` runs phase ⑦ — cross-aggregate / multi-file IR-level checks that need the fully-resolved, enriched IR.

A JSON Schema artifact at `<outdir>/.loom/wire-spec.json` is built from `wireShape` by `src/system/wire-spec.ts` (in phase ⑨) for diff-based contract change detection. See [`docs/loom-artifacts.md`](docs/loom-artifacts.md) for the full `.loom/` bundle (mermaid views, LikeC4 model, traceability, verification, provenance snapshots) — every sibling of `index.ts` under `src/system/` emits one of these.

### Per-platform generators (`src/generator/<platform>/`)

Every backend has the same shape:

| File | Role |
|---|---|
| `index.ts` | Orchestrator — `generate<Platform>ForContexts(...) → Map<path, content>` |
| `emit/*.ts` (TS/.NET) or `*-emit.ts` (Phoenix) | Procedural emitters (`render<Thing>(...)`) for regular-shaped fragments — id classes, value-object classes, events, DTOs. Plain TS functions building strings via `lines(...)` from `src/util/code-builder.ts`. **The backend emitters use no Handlebars since the v2 refactor — but Handlebars is still a live runtime dependency for the design-pack rendering layer (`src/generator/_packs/loader.ts` compiles the `.hbs` pack/shared templates under `designs/`, `vite/`, `api/`, `docker/`, `stacks/`).** |
| `*-builder.ts` | Larger procedural builders for per-aggregate-variable content (Hono routes, repositories, React pages, page-objects). |
| `render-expr.ts` / `render-stmt.ts` | IR-expression-/IR-statement-to-source renderers. Present on platforms that execute domain logic (TS, .NET, Phoenix LiveView). React skips these — the frontend doesn't run domain logic, only consumes the wire shape. |

The four backends and their entry points are registered in `src/platform/registry.ts`; each implements the `PlatformSurface` contract in `src/platform/surface.ts` (`emitProject`, `composeService`, `needsDb`, `defaultPort`, `mountsUi`).

### React page rendering — the body walker

Page bodies in the `ui` DSL are written in a closed primitive library (`List`/`Detail`/`Form`/`MasterDetail`/`Stack`/`Heading`/`Button`/`Card`/`Toolbar`/`match`/lambdas/`state := …`). The dispatch registry lives in `src/generator/_walker/registry.ts`; `src/language/walker-stdlib.ts` holds the name-only mirror consumed by the validator (pinned by `walker-stdlib-completeness.test.ts`). Contributors adding a primitive register it in both places — the test gates the mirror. The renderer lives in `src/generator/react/body-walker.ts` and dispatches per-primitive through the active **design pack** (`designs/mantine|shadcn|mui|chakra/`, plus `designs/ashPhoenix/` for Phoenix HEEx). The `walker-*.test.ts` files (~30 of them) each cover one primitive or rendering concern; if you change the walker, expect to touch one of these.

The framework-specific seams (state read/write syntax, helper imports, navigation, API call lowering, `match` rendering) are framework-shaped and cannot be expressed as pack templates. `src/generator/_walker/target.ts` **defines** the `WalkerTarget` contract that captures them. Both targets are now implemented and consumed: `src/generator/react/walker/tsx-target.ts` (consumed by `body-walker.ts`) and `src/generator/phoenix-live-view/heex-target.ts` (consumed by `heex-walker.ts`). The byte-identical-output gate guarded each per-seam extraction (Phase A Item 1 slices; see PRs #607, #610, #612, #616, #622, #623, #624, #625, #627).

### Scaffolding

`scaffold modules: M` / `scaffold aggregates: …` is compile-time sugar. The AST-walker expansion lives in `src/ir/walker-primitive-expander.ts` (~1.1k LOC); the per-shape macro bodies live under `src/stdlib/scaffold/` (`scaffold.macro.ts` plus its siblings `scaffoldAggregate.macro.ts`, `scaffoldContext.macro.ts`, `scaffoldModule.macro.ts`, `scaffoldView.macro.ts`, `scaffoldWorkflow.macro.ts`). Synthesised pages carry a `scaffoldOrigin` tag, then lower to explicit walker-stdlib bodies.

## Repository layout (non-obvious bits)

| Path | What lives here |
|---|---|
| `src/` | The Loom toolchain (compiler, generators, CLI). |
| `src/language/generated/` | **Gitignored.** `langium generate` output — parser, AST types, reflection. Must exist before `tsc` runs. |
| `src/language/print/` | AST → `.ddd` source printer (`printExpr` / `printStmt` / `printStructural`).  Drives the LSP "unfold macro" code action (`src/language/lsp/unfold-macro.ts`), which rewrites a `with X(...)` clause into its expanded source in place. |
| `src/verify/` | `ddd verify` rollup — joins test-execution results onto the traceability graph to produce per-requirement Definition-of-Done verdicts.  Pure, dependency-free; consumed by both the CLI and the browser playground. |
| `src/system/` | More than just the orchestrator — siblings of `index.ts` emit the `.loom/` artefact bundle: `mermaid.ts`, `likec4.ts`, `traceability.ts`, `wire-spec.ts`, `loomsnap.ts` (provenance snapshot capture for `ddd snapshot`), `sql-pg.ts`, `migrations-builder.ts`.  See [`docs/loom-artifacts.md`](docs/loom-artifacts.md). |
| `packages/` | **Publish-shaped workspaces** discovered by the plugin resolver: `@loom/core` (the toolchain library + `PlatformSurface` contract), `@loom/backend-hono-v4` (versioned Hono backend), `@loom/ui-test-driver` (the cross-window page-object/locator runtime).  Each `package.json` carries a `loom` key (`kind: "core"\|"backend"`, `family`, `loomVersion`, `core` semver range) read by `src/platform/fs-discovery.ts` — this is the out-of-tree backend story. |
| `web/` | Separate package — the browser-side playground. Imports the Loom toolchain straight from `../src` (pure TS, no Node-only APIs except `src/cli/` and `src/language/main.ts`). Has its own `package.json`, `playwright.config.ts`, and Vite shim that swaps `_packs/loader-fs.js` for a VFS-backed loader. |
| `vscode/` | Separate package — VS Code extension (LSP client). Has its own `package.json`; builds against the compiled toolchain. |
| `designs/` | Design packs (Mantine / shadcn / MUI / Chakra / ashPhoenix). Each pack is a tree of templates that the body-walker dispatches into. |
| `api/`, `vite/`, `docker/` | Top-level `.hbs` snippets — boilerplate for generated projects (API client, vite config, dockerfile). |
| `stacks/v1/`, `v2/`, `v3/` | Versioned Handlebars templates for generated-project `package.json` dependency / devDependency blocks (`stack-package-deps.hbs`, `stack-package-devdeps.hbs`, `stack.json` manifest).  The active stack version is chosen per generated deployable based on its platform pins. |
| `phoenix/` | Top-level companion docs for the Phoenix backend (README). |
| `examples/`, `web/src/examples/` | Sample `.ddd` files. CI's `generated-react-build.yml` matrix iterates `examples/acme.ddd` + everything under `web/src/examples/` × every design pack. |
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
3. Add IR node in `loom-ir.ts`; lower it in `lower.ts` (structure) or `lower-expr.ts` (expr/stmt/type).
4. Extend `render-expr.ts` / `render-stmt.ts` for every domain-logic backend.
5. Extend `emit/*.ts` (or `*-emit.ts` on Phoenix) or a `*-builder.ts` per backend.
6. Add: one parsing test, one negative validator test, one generator test per backend.
7. Verify with `npm test` and at least one `LOOM_TS_BUILD=1` / `LOOM_REACT_BUILD=1` run.

**Adding a backend:**
1. Two homes are possible:
   - **In-tree (default for new backends):** implement `PlatformSurface` in `src/platform/<backend>.ts`; register in `src/platform/registry.ts`.
   - **Out-of-tree (versioned package, like `hono@v4`):** add a workspace under `packages/backend-<family>-v<N>/` with a `package.json` carrying a `loom: { kind: "backend", family, loomVersion, core }` block.  `src/platform/fs-discovery.ts` picks it up via `setBackendSource`; `parseBuiltinPlatformRef` lets a deployable target it by `family@version`.
2. If the backend serves a wire shape, read `agg.wireShape` etc. directly from the IR — do not recompute.
3. If it runs domain logic, implement `render-expr.ts` / `render-stmt.ts` honouring `refKind` / `callKind` / `isCollectionOp`.
4. If a new `platform:` keyword is added, also extend the `Platform` rule in `ddd.langium`, the `Platform` type in `loom-ir.ts`, and `checkDeployable` in `src/language/validators/deployable.ts` (see the `'react'` and `'phoenixLiveView'` additions for the pattern).

## CI surface (what each workflow gates)

- `pages.yml` — typecheck + smoke + build playground + deploy docs/playground to GitHub Pages (main only).
- `generated-react-build.yml` — matrix `{example × pack}`, generates the React project, `npm install`, `tsc --noEmit`. Catches generator drift invisible to IR-level tests.
- `playground-e2e.yml` — Playwright specs against the production-built playground (editor → generate → bundle → boot → preview).
- `phoenix-build.yml` — `mix deps.get && mix compile --warnings-as-errors` against the real Ash 3.x dep set in an Elixir docker image.

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

Per-feature reference docs — `docs/auth.md`, `views.md`, `workflow.md`, `extern.md`, `capabilities.md` (filter/stamp/implements), `scaffold-macros.md` (the macro stdlib), `provenance.md` (provenanced fields + ddd snapshot), `observability.md`, `traceability.md`, `conformance.md`, `migrations-design.md`.

`docs/plans/` and `docs/audits/` hold in-flight design notes and historical snapshots; do not treat them as authoritative for what ships today. `docs/proposals/` holds proposals not yet adopted.

`experience_gathered.md` — gotchas log; read before non-trivial work.
