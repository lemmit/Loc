# Loom proposals — index

This directory is the live design corpus for Loom. Each doc is a
single self-contained proposal (problem → proposed surface → grammar
additions → lowering semantics → open questions). Some are shipped,
some are partial, most are still on paper.

**Authoritative ordering lives in
[`global-implementation-plan.md`](./global-implementation-plan.md)** —
rewritten 2026-06-10 from a code-verified audit of `origin/main`. It
owns the gap inventory, the tiered roadmap, and the cross-proposal
ordering, and it absorbed the former `remaining-work-plan.md`
carry-over digest (that file is deleted). The phase summary in this
README is a précis; the plan doc is the source of truth for
**ordering**. For the live per-proposal status, this table is the
refresh point.

**Pinned decisions live in [`../decisions.md`](../decisions.md)** —
when a D-tag (e.g. D-STORAGE-SPLIT, D-GRANULARITY, D-RENAME,
D-LIFECYCLE-VERB, …) is referenced from a proposal or plan, the
decisions log is where the binding answer lives. Proposal text that
predates a pinned decision is annotated with a "Pinned decisions
affecting this proposal" block at its top.

This README is hand-maintained and was previously stale. If you
spot drift between a proposal's actual status and the table here,
update both the entry and `global-implementation-plan.md`.

## Status legend

| Tag | Meaning |
|---|---|
| **SHIPPED** | Lives on `origin/main`. Deltas only from here. |
| **PARTIAL** | Some phases shipped; remaining phases tracked in the doc. |
| **PROPOSED** | No code yet. Grammar/IR/semantics specified. |
| **SUPERSEDED** | Replaced or reframed by a newer proposal. Read for background only. |
| **DEFERRED** | Design recorded, implementation not scheduled. |
| **REFERENCE** | Cross-cutting plan or overview, not itself a feature. |

Status reflects `origin/main` as of the last refresh of
`global-implementation-plan.md`'s audit. **Last refreshed: 2026-06-10**
— this pass was **code-verified** (every status checked against the
grammar / IR / emitters / validator gates, not against prior doc text)
and reconciled the #1024–#1064 wave: the elixir platform rename
(#1043), the vanilla Elixir foundation slices 0–6 (#1046–#1062),
workflow instances as view sources on all backends (#1035/#1037),
root-level payload declarations (#1024), the `?` propagation surface
(#1030 — since **dropped**, see `exception-less.md`), Phoenix `errors[]`
(#836), TPH emission on .NET + Phoenix, and the realization-axes
alignment slices (#1061–#1064).

## Every proposal in this directory

### Reference & planning

| Doc | Status | Role |
|---|---|---|
| [`global-implementation-plan.md`](./global-implementation-plan.md) | REFERENCE | The **code-verified gap inventory + tiered roadmap** across the whole corpus (rewritten 2026-06-10; supersedes both its previous self and the deleted `remaining-work-plan.md`). Owns ordering, dependencies, and the coordinated single-PR moments. Start here for "what's next". |
| [`implementation-plan.md`](./implementation-plan.md) | REFERENCE | Stacked delivery plan for the type-system family (aggregate-inheritance + payload-transport + exception-less + criterion). Phase-by-phase, dependency-explicit. Consumed by Phase 2 of the global plan. |
| [`type-system-overview.md`](./type-system-overview.md) | REFERENCE | 10-minute orientation across the type-system family. Read first if you're picking up any of P/A/Crit. |
| [`platform-parity-debt.md`](./platform-parity-debt.md) | REFERENCE (debt register) | Single roll-up of every feature that works on some backends but not others (node/Hono, .NET, Phoenix, React) — the cross-backend gate inventory, each row linking the proposal that owns the fix. Code-verified detail in [`../audits/gated-features-inventory.md`](../audits/gated-features-inventory.md). |
| [`dependency-upgrades.md`](./dependency-upgrades.md) | NOTE (backlog) | Deferred dependency upgrades + the `npm audit` picture. vitest 2→4 done (#951, cleared both criticals); the **langium 3→4** migration (foundational; clears the remaining build-time lodash/chevrotain advisories) is the one pending item, with a checklist of what it touches. All outstanding findings are build/dev-time — none ship. |
| [`production-readiness.md`](./production-readiness.md) | REFERENCE | Roadmap naming the scaffold→system gap (bounded reads, deny-by-default, async messaging/outbox, caching, search projections, account management, i18n, k8s emit, ops surface, inter-service calls). Cross-references the per-feature proposals and flags which still need one. |
| [`storage-and-platform-config-plan.md`](./storage-and-platform-config-plan.md) | REFERENCE | 14-phase, 17–19 PR build order for the storage proposal. Consumed by Phase 1A. |
| [`storage-and-platform-config-micro-plan.md`](./storage-and-platform-config-micro-plan.md) | REFERENCE | Foundation-first sub-plan (skeleton-only delivery, ~22 days serialised, F1 broken into 6 small PRs). Consumed by Phase 1A. |

### AI generation platform

| Doc | Status | Role |
|---|---|---|
| [`ai-generation-platform.md`](./ai-generation-platform.md) | PROPOSED (strategy) | **Reframes Loom as an AI generation platform, engine-first.** Vision (the `.ddd` model as the narrow waist; "the model is the AI's memory" → no context rot as the app grows; one model / three editors / four stacks; governance as the enterprise unlock) + strategy (competitive whitespace, the on-ramp inversion, platform-first across mass-market-land + regulated-expand with IR-embedding deferred — pinned [D-AI-EMPHASIS](../decisions.md#d-ai-emphasis--loom-leads-as-a-platform-mass-market-land--regulated-expand-ir-embedding-deferred), open-core business model). No grammar/IR change — the platform is integration + UX over existing assets. Start here. |
| [`ai-authoring-loop.md`](./ai-authoring-loop.md) | PROPOSED (spec) | The mechanics: an LLM authors/evolves a `.ddd` model through Loom's compiler as a tool set; the validate→repair→verify loop and **why it converges** (two structured oracles — phases ②③④⑦ diagnostics + `ddd verify`/conformance); the **model-patch protocol** (node-addressed, canonical-print splice, exactly-derivable diffs); grammar-constrained decoding + context-pack for `.ddd` authoring; in-browser runtime wiring (`web/` imports `../src` → client-side repair oracle); the wedge build plan. |
| [`ai-diagnostics-contract.md`](./ai-diagnostics-contract.md) | PARTIAL (slices 1–5 shipped) | The machine-readable interface the loop consumes: `ddd parse/generate --json`. Located, coded (`loom.*`), phase-attributed diagnostics with a `fixHint` (carrying a model patch, so the agent repairs without reading generated code); always-valid envelope; deterministic ordering; the `outline` address book shared with the patch protocol. Compile-time analogue of the shipped runtime `errors[]` format ([`validation-error-extension.md`](./validation-error-extension.md)). |
| [`agent-tools-and-mcp.md`](./agent-tools-and-mcp.md) | PARTIAL — catalog (10 tools) + MCP stdio server (#934) + read trio (#937) + rewrite trio (#940) + transport-neutral agent loop (#946) shipped; LSP-provider correctness + playground chat UI remain | How the toolkit operations become **agent-callable tools**: one transport-neutral **tool catalog** (`src/tools/`) over `src/api/`, surfaced by an **MCP stdio server** (`packages/ddd-mcp`, external hosts) and **direct/in-memory dispatch** in the in-browser playground chat. Tools are pure + stateless (model passed in; no fs side effect), so the server is safe by default and the playground reuses the identical catalog. Pinned [D-AGENT-TOOLS](../decisions.md#d-agent-tools--one-tool-catalog-over-the-toolkit-mcp-and-in-browser-are-transports). |

### Structural & layout

| Doc | Status | Aspect |
|---|---|---|
| [`bounded-context-model.md`](./bounded-context-model.md) | PROPOSED | **Reframes the structural model.** Promotes the bounded context to the central organising unit; adds a subdomain layer; clarifies BC vs module vs deployable. **Supersedes the per-aggregate-storage granularity of the three `storage-and-platform-config*.md` docs** (the grammar work mostly survives — the *granularity* is what changes; persistence binds at BC level, not per-aggregate). |
| [`src-ir-phase-reveal.md`](./src-ir-phase-reveal.md) | SHIPPED | Restructured `src/ir/` into `types/` / `lower/` / `enrich/` / `validate/`; moved `migrations-builder.ts` to `src/system/`. |
| [`test-layout-and-macro-consolidation.md`](./test-layout-and-macro-consolidation.md) | SHIPPED | Test tree mirrors `src/` phases; macros consolidated under `src/macros/`. |
| [`implicit-system-composition.md`](./implicit-system-composition.md) | PARTIAL — Tiers 1 & 2 shipped | Top-level domain members (`subdomain`/`context` + the deployment shape `deployable`/`storage`/`resource`/`channelSource`/`ui`/`theme`/`user`/`api`/`layout`/`test e2e`) may be declared at the top level of any file in the import graph; `lowerProject` composes them into the project's single `system`. Lets a project split file-per-subdomain with the deployment in its own file. Stage of [`../plans/multi-file-source.md`](../plans/multi-file-source.md). |
| [`platform-directory-layout.md`](./platform-directory-layout.md) | PROPOSED | Framework-version axis for backend code (`hono@v4`→`v5`, `net8`→`net10`, Ash 3→4). **Option A (reverse the hono hoist) is rejected per [D-BACKEND-PKG](../decisions.md#d-backend-pkg--per-version-backend-packages-are-canonical).** The surviving direction is per-`<family>/v<N>/` homes that stage toward the packaging-split's per-version packages; adapters move to the backend surface per [D-ADAPTER-HOME](../decisions.md#d-adapter-home--persistencestylelayout-adapters-live-on-the-backend-surface). |
| [`per-package-output-tree.md`](./per-package-output-tree.md) | PROPOSED (deferred) | Per-layer **output** packages (`-domain`/`-dal`/`-api`/`-contracts`/`-ui`) — the "Loom as ORM" enabler. Output-side twin of the packaging split; expressible as a `LayoutAdapter` extension. Right direction, deferred on one-time fixture/CI cost + the playground-workspace prerequisite — not on value. |

### Storage & platform config

| Doc | Status | Core addition |
|---|---|---|
| [`storage-and-platform-config.md`](./storage-and-platform-config.md) | PARTIAL | Shipped: top-level `storage <name> { type }`; deployable role-keyed slots; per-aggregate persistence strategy as `persistedAs(state \| eventLog)` (D-DOCUMENT-AXIS); the adapter contracts; **and per-deployable `style:` / `layout:` / `persistence:` selection with capability gates** (D-REALIZATION-AXES phases 5a–5d — .NET `efcore`/`dapper`, hono `drizzle`/`mikroorm`, `cqrs` style, `byLayer`/`byFeature` layout; backends read `deployable.persistence` directly and the `loom.dapper-unsupported` / `loom.mikroorm-unsupported` gates in `src/ir/validate/checks/system-checks.ts` reject unsupported model features). Remaining: logical `dataSource` bindings (`dataSources:` per [D-STORAGE-SPLIT](../decisions.md#d-storage-split--split-the-overloaded-storage-keyword)), the `STORAGE_CAPABILITIES` matrix, the reserved `marten` / `layered` stubs, outbox emission + per-deployable overrides. Granularity is per-context, not per-aggregate ([D-GRANULARITY](../decisions.md#d-granularity--storage-bindings-are-per-context-not-per-aggregate)); per-aggregate `for:` deferred to v2 override. |
| [`platform-realization-axes.md`](./platform-realization-axes.md) | PARTIAL — pinned [D-REALIZATION-AXES](../decisions.md#d-realization-axes--the-deployable-platform-config-axes-and-the-foundation-amendment); decomposes `platform:` into independent realization axes (`transport`/`foundation`/`style`/`layout`/`persistence`). Phases 1–5a (#809) + 5b real Hono/node + .NET `byFeature` layouts (#825, #830) shipped; `node`-is-the-platform / `hono`-is-a-`transport:`-value pinned [D-NODE-PLATFORM](../decisions.md#d-node-platform--node-is-the-js-runtime-platform-hono-is-a-transport-value) | Naming review + cross-axis gating matrix (with validator codes) + worked examples + grammar sketch for the homeless platform-config axes. Amends D-PHOENIX-SURFACE: the domain-framework axis gets its own keyword `foundation:` rather than folding into `persistence:`. |
| [`resource-model-and-source-types.md`](./resource-model-and-source-types.md) | PROPOSED | Generalises the data layer into a clean split of *logical need* / *configured binding* / *built-in technology descriptor* (`kind` + `capability` + context-selected `interface`), so relational stores, event logs, caches, **object stores, queues, and external APIs** are all first-class and new technologies need no grammar change. Parent of the workflow-resource-consumption note. |
| [`workflow-resource-consumption.md`](./workflow-resource-consumption.md) | PROPOSED | Phase 4 of the resource model: how domain logic *uses* a `resource` — the call surface that turns object-store / queue / external-API resources (and their generated clients) into something a workflow can invoke. Consumer of the `ResourceAdapter` clients + activator of the `need ⊆ sourceType` capability check. |

### Deployment & infrastructure

| Doc | Status | Core addition |
|---|---|---|
| [`kubernetes-helm.md`](./kubernetes-helm.md) | PROPOSED | Emit a Helm chart (+ the raw k8s manifests it renders to) alongside `docker-compose.yml`, as a new `src/system/` artifact sibling. **Emitter-only** (no grammar/IR change in v1); database assumed **external/managed** (connection `Secret`, no in-cluster postgres); tuning lives in `values.yaml`. Reverses the stated non-goal in `docs/tools.md:324` / `docs/generators.md:764`. Defers infra-in-DSL (`replicas`/`resources`/`ingress` clauses) and a per-platform `workloadShape` surface method to follow-ups. |
| [`terraform-iac-target.md`](./terraform-iac-target.md) | PROPOSED (research) | Where an Infrastructure-as-Code target fits in the pipeline. **Not a new `PlatformSurface`** (the four platforms are application-code generators); IaC is a `src/system/` artifact sibling consuming compose/topology data. Assesses what IR already supports it, what's missing, and a phased recommendation. Nothing implemented. |
| [`deployable-networking.md`](./deployable-networking.md) | PROPOSED (unadopted) | How deployables expose apis on the wire — port allocation, per-api routing prefixes (`serves … at`), frontend wiring, compose emission, and playground topology. Out of scope (yet): backend-to-backend service discovery (peer URLs / peer auth), designed-around not designed-in. |
| [`multi-target-proxy.md`](./multi-target-proxy.md) | PROPOSED (approved, impl pending) | Same-origin proxy story for a UI deployable that targets **more than one** backend (today `targets:` is a single ref). Sibling of [`../plans/backend-packages.md`](../plans/backend-packages.md) — gateway platforms reuse the out-of-tree package story. Vocabulary scope (open question #1) re-decided during slice 6. |

### Backends & code generation

| Doc | Status | Core addition |
|---|---|---|
| [`elixir-platform-rename.md`](./elixir-platform-rename.md) | SHIPPED (#1043, R1–R6) | Renamed `platform: phoenix` → `platform: elixir` and `transport: phoenixRouter` → `transport: phoenix`, completing the **D-NODE-PLATFORM** rename pattern (platform names the language-ecosystem; transport names the web framework). Generator now at `src/generator/elixir/`, platform module at `src/platform/elixir.ts`; back-compat aliases (`phoenix`, `phoenixLiveView`) keep existing sources working. D-ELIXIR-PLATFORM / D-PHOENIX-TRANSPORT / D-PHOENIX-DIR pinned. Original rationale: D-NODE-PLATFORM's own text justifies itself by claiming *"`dotnet`/`phoenix` name the language-ecosystem"* — a rationalisation, since `phoenix` is a web framework, not a language-ecosystem (the actual ecosystem is **Elixir**). This proposal closes the loop. Lands **before P2** of `vanilla-phoenix-foundation.md` so the vanilla emit subtree lands at `src/generator/elixir/vanilla/` instead of the nonsensical `src/generator/phoenix-live-view/vanilla/`. Absorbs three sibling renames already owed since `phoenixLiveView` → `phoenix`: generator directory `src/generator/phoenix-live-view/` → `src/generator/elixir/`; platform module `src/platform/phoenix-live-view.ts` → `src/platform/elixir.ts`; CI workflows `phoenix-*.yml` → `elixir-ash-*.yml`. The design pack rename (`ashPhoenix` → `phoenix`, foundation-aware internally) is **deferred to P2** since it needs the vanilla emit shape to design the foundation branching. Back-compat aliases (`platform: phoenix` → `platform: elixir { transport: phoenix }`, mirroring `hono` → `node`) keep every existing `.ddd` source working. Pins **D-ELIXIR-PLATFORM** / **D-PHOENIX-TRANSPORT** / **D-PHOENIX-DIR**. Reword pass on six PINNED decisions (D-PHOENIX-SURFACE, D-NODE-PLATFORM, D-VANILLA-PHOENIX-FOUNDATION, D-VANILLA-ES-HOME, D-NO-MIXED-FOUNDATION, D-VANILLA-DEFAULT, D-REALIZATION-AXES). ~4–5 days focused single PR; ~325 files reference `phoenix`/`Phoenix` but most are docs/examples/strings — the IR/validator/registry plumbing is ~10 files. Mechanical with back-compat aliases; no behavioural change. |
| [`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md) | PARTIAL — **state-based emitter SHIPPED** (slices 0–6, #1046–#1062); remaining: workflow body lowering beyond `factory-let`/`op-call`, event sourcing under vanilla (D-VANILLA-ES-HOME), per-field validators, first-class adapter integration, `or`-union returns, the D-VANILLA-DEFAULT flip | `foundation: vanilla` on the `elixir` platform emits a real second project from `src/generator/elixir/vanilla/`: plain `Phoenix.Endpoint` + `Phoenix.Router` over plain `Ecto.Schema` / `Ecto.Changeset` / `Ecto.Repo` — no `Ash.Resource`, no `AshPhoenix.Form` — with CRUD, enums/VOs/relations, RFC 7807 parity, views, workflow instances, and workflow execution. Two independent motivations, either of which would carry it alone: (1) **exception-less alignment** — vanilla Ecto's `{:ok, _} \| {:error, changeset}` is the natural carrier for `exception-less.md` A4's typed `or`-union returns, replacing the `Plug.ErrorHandler` rescue tower with per-variant `with`-block dispatch (the shape TS/.NET adopt post-A4); (2) **pure event sourcing on Phoenix** — option 3 of `workflow-and-applier.md` (plain `<Agg>Fold` + `<agg>_events` Ecto table + thin `Repository`) is the only Phoenix path that matches Loom's per-aggregate-stream / fold-on-load contract without re-implementing AshCommanded. Frames the gap correctly: an **Ash-foundation limitation, not a Phoenix-platform limitation** — Phoenix itself is domain-layer-agnostic; what doesn't fit is `Ash.Resource`'s changeset-shaped action model + `Ash.DataLayer`'s queryable-store callbacks. Four decisions now pinned in `decisions.md`: **D-VANILLA-PHOENIX-FOUNDATION** (add vanilla as first-class second adapter), **D-VANILLA-ES-HOME** (ES lands only under vanilla; AshEvents/AshCommanded/custom Ash.DataLayer explicitly not pursued), **D-NO-MIXED-FOUNDATION** (one foundation per deployable — confirmed as structural consequence of D-REALIZATION-AXES, not new policy; per-aggregate override not added), **D-VANILLA-DEFAULT** (vanilla becomes Phoenix default after stabilisation — opt-in initially; warn-then-flip after one minor-release cycle of green CI + no obs-e2e regressions). Concentrates work in a sibling `vanilla/` emitter subtree; the HEEx walker, migrations renderer, OpenAPI emitter, Jason camel renderer, and design packs are reused verbatim. Form binding is the `AshPhoenix.Form` → stock `to_form(changeset)` swap (~10–20 LOC per command). |
| [`elixir-ecto-and-api-only-backends.md`](./elixir-ecto-and-api-only-backends.md) | PROPOSED (§4 superseded) | Effort/shape study for three backend-matrix additions: a non-Ash Elixir/Phoenix/**Ecto** full-stack generator, plus **API-only** flavours of both the Ash and Ecto backends (JSON surface consumed by the React frontend). Grounds each in the `PlatformSurface`/adapter/conformance machinery: the **Ecto domain layer** is the dominant cost (hand-built `Ecto.Schema`/`Ecto.Changeset`/context modules vs Ash's declarative resources); the HEEx walker, `MigrationsIR`→Ecto migrations, and the existing JSON+OpenAPI surface are **reuse**; API-only is a cheap *UI-absent strip* of a full backend. **§4 (Ash/Ecto axis modelling) is superseded by D-REALIZATION-AXES + `vanilla-phoenix-foundation.md`** — the axis is now the `foundation:` keyword, not a sibling platform name (Option B) or an adapter-style flag (Option A); §3 (Ecto domain layer shape), §5 (conformance parity), §6 (phasing) remain live. **Investigation (§2.1) resolves D-API-ONLY**: the generator already emits a clean API-only project when no `ui` is bound (`liveview-emit.ts:61`), so API-only is absence-of-a-`ui`-mount, not a new platform — the only gap is React's `apiBaseUrl` needing an `/api` branch for a Phoenix target + a CORS plug. |
| [`embedded-frontend-composition.md`](./embedded-frontend-composition.md) | PROPOSED | Decouples the served UI from the backend platform. Today the UI framework is **derived from the host** and the embed is hardwired to React at three layers (generator `dotnet/index.ts:274`; validator `expectedFrameworkFor` `platform-rules.ts:94`; grammar `Framework` enum), so `dotnet`-embeds-Angular / `phoenix`-embeds-React are **inexpressible**. Fix: move **framework/design/stack onto the `ui` declaration** (no separate `frontend` citizen — folded in per the chat decision), and make hosting an explicit relation — a `deployable` **`hosts:`** a `ui`, with **embedded-vs-standalone derived from the host's `needsDb`** (vite/static serve standalone + `targets:` a backend; dotnet/phoenix/hono embed). Host-compatibility is a principled capability, not a lookup table: a host can serve a `ui` **iff it provides the runtime that framework requires** (react → static assets, hostable anywhere; liveview → phoenix runtime only). Unmasks `platform: react` as "Vite hosts React" and retires it as a platform. The rare one-ui-two-frameworks case is deferred to the host edge (`hosts+=[Ui]` is a list from day one). Success test: adding a host×framework pairing touches the framework generator + a capability set, **never** the host's serving code. **Phoenix is the keystone (§6):** `phoenixLiveView` froze *two* axes — domain (Ash/Ecto, freed by the Ecto note) **and** hosted framework (LiveView/React, freed here) — so it decomposes to `phoenix` × domain × framework. Phoenix gets the richest `hostableFrameworks` (`{liveview} ∪ {react,…}`) *derived* from being the only platform that's both a render runtime and a static-asset host (`priv/static`), which unlocks **Phoenix-embeds-React** (the `wwwroot` twin) for free. Complementary to the Ecto note on the same keyword; both converge on `react/index.ts:48–52`. |
| [`java-backend.md`](./java-backend.md) | DEFERRED (vision) | Effort/shape study for a fourth domain-logic backend (Spring Boot / JPA). No grammar/IR change — purely additive codegen on the `PlatformSurface` contract. **Deliberately sequenced behind `criterion-everywhere.md`/`reified-criteria.md`**: its headline differentiator (reusable `Specification<T>` emission) consumes the selectability model those define. Not scheduled. |
| [`render-expr-target-unification.md`](./render-expr-target-unification.md) | SHIPPED | Unified the three structurally-identical `render-expr.ts` dispatchers (TS / .NET / Phoenix — same 17 `ExprIR.kind` arms, leaf-divergent only) behind an **`ExprTarget`** contract + shared `renderExprWith` dispatcher (`src/generator/_expr/target.ts`), mirroring the body-walker's `WalkerTarget` extraction (PRs #607–#627). Each backend is now a leaf-only target table; the dispatch + all recursion live once. Brought **forward of A4** (byte-identical-output gated) so A4 authors its new arms once behind the contract. The contract captures the eight real divergence axes (operators, naming, money arithmetic, collection ops, `refColl.contains` membership, regex, `ref` role, `callKind` call syntax); the 17-arm dispatch + recursion go shared. Payoff: a 5th domain-logic backend writes **one target table**, not a 4th hand-rolled dispatcher. Verified byte-identical by regenerating every `examples/*.ddd` across all backends (1221 files, sha256 before == after) + the full fast suite. The earlier A4-independent slice (`refCollectionFieldName` → `ir/util`) had already landed (#793). |

### Documents & JSON hierarchies

| Doc | Status | Core addition |
|---|---|---|
| [`document-and-json-hierarchies.md`](./document-and-json-hierarchies.md) | PARTIAL — surface + IR (Slices A/B/C, #703/#711/#713) + shape-emission: **.NET and TS emit all three shapes** (TS `embedded` via `repository-embedded-builder.ts`), **Phoenix emits `relational` + `embedded`**; per-backend `supportedShapes` gate live (`loom.saving-shape-unsupported`); value-object arrays (`Money[]`) flatten to child tables across backends (#908/#891). Remaining: `shape(document)` on Phoenix | Persisting hierarchies as JSON documents (Marten / EF Core `.ToJson()` / Mongo-embedding analogues) instead of normalised tables. Separates open-shape `json` field (need A) from document-mapped typed hierarchy (need B). **Chosen direction:** two orthogonal per-aggregate header axes — a **truth kind** `persistedAs(eventLog | state)` (renamed from the shipped body `persistenceStrategy:`; values aligned to the `dataSource` `kind` set; carries the validated apply-always body contract) × a **saving shape** `normalised(true | false)` (new; `false` = document) — so the required **`persistedAs(eventLog)` + `normalised(false)`** (stream + document snapshot, Marten's sweet spot) is expressible. Wired via `normalised: false` on the `snapshot`/`state` `dataSource` + a Marten `PersistenceAdapter`. Plus a `json` primitive for open-shape data. Header-syntax reconciliation: all aggregate config on the header as paren modifiers, nothing in the body; amends D-RENAME (`inheritanceStrategy` → `inheritanceUsing`, colon→paren) and relocates/renames the shipped body `persistenceStrategy:`. Drops the per-containment hint; rejects "document as aggregate peer". Requests **D-DOCUMENT-AXIS**. |

### Type-system family — state, transport, exception-less, criterion

> **Start here**: [`type-system-overview.md`](./type-system-overview.md).
> The proposals total ~3000 lines; the overview is 10 minutes.

| Doc | Status | Core addition |
|---|---|---|
| [`aggregate-inheritance.md`](./aggregate-inheritance.md) | PARTIAL — **I1–I3 shipped**: surface + IR + validators, TPC (`ownTable`) on all backends, TPH (`sharedTable`) on all three DB backends (see [`dotnet-tph-emission.md`](./dotnet-tph-emission.md) / [`phoenix-tph-emission.md`](./phoenix-tph-emission.md)); reference-documented in [`../inheritance.md`](../inheritance.md) | Abstract aggregates with single inheritance; storage strategies `sharedTable`/`ownTable` (the `inheritanceUsing(…)` header modifier per D-RENAME). Nominal, no generics. Remaining: I4 — per-concrete storage override / mixed strategy (gated `loom.inheritance` checks; needs the UNION-ALL read), polymorphic `<Base> id` refs, TPT-via-`contains` docs. |
| [`payload-transport-layer.md`](./payload-transport-layer.md) | PARTIAL — **most of P1–P4 shipped** (code-verified): P1 `payload`/`error` kinds + file-scope declarations (#1024) + per-error `httpStatus`; P2 synthesised `<Agg>Wire`; P3b `Paged<T>` + paged finds on all 4 backends (#898/#916/#925/#933); P4 named + anonymous `or` unions emit on node/dotnet/elixir. Union-find producer path implemented on Hono + .NET (absence shape pinned by `loom.union-find-shape-unsupported`). Remaining: P3 full (nested carriers), P5 (`validate for X`), the elixir union-find absence producer, `unpaged` opt-out | `payload` umbrella over events/commands/queries/responses/errors. Carrier-bounded generics with ML-postfix syntax (`customer page`). Named (`payload Foo = A \| B`) and anonymous `or` unions. Auto-synthesised aggregate wire payloads. Foundation for the whole family. |
| [`exception-less.md`](./exception-less.md) | PROPOSED — partially landed, partially walked back: `error` payloads, operation `or`-union returns (node/dotnet; gated on elixir) and per-error `httpStatus` mapping are shipped; **the `?` propagation operator is DROPPED and its surface removed** (#1030 shipped surface-only; since deleted — do not re-introduce) | `error` payloads (HTTP-blind in the domain). `option` ML-postfix sugar. `Repo.getById` re-shape to `T or NotFound`. Per-api `status` mapping + stdlib defaults driving auto-generated RFC 7807 ProblemDetails. Two-regime split (aggregate-throws vs boundary-returns-carrier). No `Result<T, E>` wrappers. Read with [`failure-taxonomy.md`](./failure-taxonomy.md) for the current direction. |
| [`failure-taxonomy.md`](./failure-taxonomy.md) | DESIGN NOTE — revisits `exception-less.md` | Step-back rethink of the whole error story. Keeps the structural core (errors-as-data, HTTP-blind domain + edge `httpStatus`, two-regime throw/return, dependency-direction layer visibility, inline opt-in translation); reconsiders the ergonomics (`?` operator, carrier-monad stdlib — likely drop); grounds **validation** in the shipped value-object `invariant` (the only new work is routing a construction failure to 422 — *not* a new `validate` keyword). Reframes "exception-less" as a five-kind **failure taxonomy** (absence / validation / expected-domain / bug / integration), each getting the lightest mechanism, and maps the four shipped guard constructs (VO `invariant`→422, `precondition`→400, `requires`→403, aggregate `invariant`→500) to status. Settles error placement on three constructs (`operation` / `workflow` / `api`) + a declarative policy bucket. |
| [`domain-service.md`](./domain-service.md) | SUPERSEDED by [`domain-services.md`](./domain-services.md) | Exploratory options-menu (six design axes, three assembled shapes — A pure-calculator, B coordinator, C unified function family) for the missing third construct. Kept as the design-space record; the successor pins answers and adds spec. The cross-reference distinctions added in #1052 (vs `criterion`, the `authorization.md` `policy {}` block, and `workflow`) carry over unchanged. |
| [`domain-services.md`](./domain-services.md) | PROPOSED — pinned design | The missing **third construct** between `operation` (single-aggregate domain) and `workflow` (application orchestration): a stateless cross-aggregate **domain rule** that can fail with a domain error (the `transfer → InsufficientFunds` case). Adopts the six-axis framework from the superseded options-menu and **commits**: v1 = Shape A (pure calculator, no mutation, callable anywhere); Shape B (coordinator, with persistence contract) = Phase 2; Shape C deferred as north star. Naming = `domainService` (multi-word keyword; narrowly disagrees with the options-menu's lean toward `service`). Errors mirror operation/workflow two-regime (`throw` for bug regime, `or`-union for expected). Strict no-infra (no repo / extern / api / workflow-start / emit / mutation in v1) enforced by phase-⑦ checks. Adds grammar / IR (`DomainServiceIR`, new `Call.callKind: "domain-service"`, `OperationIR.mutating` flag) / per-backend emitter / test plan. Anemic-domain validator warning for single-aggregate services. |
| [`validation-error-extension.md`](./validation-error-extension.md) | SHIPPED — Hono (#782), .NET (#829), Phoenix (#836, both foundations: Ash `Ash.Error.Invalid` + vanilla `Ecto.Changeset`), OpenAPI lockstep | RFC 7807 §3.2 `errors[]` on the wire. **Decoupled from `exception-less.md`** — a pure wire-format extension, no language surface change; the format is what exception-less would emit anyway. Lands the per-field `errors[]` that `frontend-acl.md`'s `applyServerErrors` decoder already routes (its `applied` path was dormant until this). |
| [`criterion.md`](./criterion.md) | PARTIAL | `criterion <Name>(args) of T = <bool expr>` (Spring-Data / Evans style). **Core shipped**: declaration, body validation (purity / queryable / cycle / arity), and compile-time inline into every existing boolean-expression position (`view`/`find` `where`, invariants, operation preconditions) — composition via `&&`/`||`/`!` for free, no backend query-engine change. **Also shipped**: criterion filter-capability targeting on Hono/Drizzle (#760) and Phoenix/Ash (#762). See [`docs/criterion.md`](../criterion.md). **Deferred** (need exception-less + payload-transport): `from <Criterion>(args)`, `when <Criterion>` + auto-exposed `can-<op>`, built-in `Repo.findAll(criterion, sort?, page?, loads?)`, `private workflow`. Resolves D23. |
| [`criterion-everywhere.md`](./criterion-everywhere.md) | SUPERSEDED (mechanism) / DRAFT | The **selectability model** — sharpens criterion's under-specified `when`/`from`/auto-`can-<op>` corner. Its *inline* mechanism (substitute the body per use-site; bind `currentUser` per use-site) is **superseded by [`reified-criteria.md`](./reified-criteria.md)** (construct a Specification object; `currentUser` is a constructor arg). Its *semantics* — selectability + use-site enforcement rules — **survive** into reification. Read for the model, not the mechanism. |
| [`reified-criteria.md`](./reified-criteria.md) | PARTIAL — **retrieval *and* find criteria reified on all four backends**: .NET/EF in slices (`Criterion<T>`+`IsSatisfiedBy` #890, `ToExpression` #901, retrieval/find consume it #910/#926, Ardalis `Specification<T>` bundle #936), Dapper parameterised SQL (#943), Hono module-level predicate fn (retrieval #952, find #963), Phoenix/Ash `:boolean` calculation (retrieval #955, find #964). Remaining: anonymous capability `filter` predicates + the principal/tenancy factory still inline (see the proposal's remaining-work register). | **Reverses "inline everything" for criteria.** A criterion is a **constructed Specification object** (spec + factory + consumer), not a use-site-substituted `ExprIR`; backends consume `CriterionIR` directly. `currentUser.<field>` becomes an ordinary **constructor argument** resolved from the principal at construction — removing the two-mechanisms smell (find-param threading vs injected accessor). Makes selection↔validation **structural** (`toExpression()` + `isSatisfiedBy()` on one object). Supersedes the *mechanism* of the inline criterion work (its selectability + enforcement semantics survive); the Java `Specification<T>` emission is this on a 4th backend. |
| [`retrieval.md`](./retrieval.md) | PARTIAL — surface + IR + lowering + validation shipped (#794); `Run<Name>Async` emission + workflow `foreach` on .NET (#810); Hono `run<Name>` (#952) + Phoenix/Ash read action (#955) shipped; `loads` plan remaining | The **named query bundle**: `retrieval <Name>(args) of T { where: <criteria> sort: … loads: … }`, run via `Repo.run(R(args), page?)`. `criterion` is the predicate atom; `retrieval` is the bundle (predicate + sort + loads). `where`/`sort`/`loads` are the named rule; **`page` is call-site only**. Deliberately avoids the name "Specification" (the atom on JPA, the bundle on .NET/Ardalis) — lowers to `RetrievalIR` + `LoadPlanIR` (default `whole(agg)`). Graduates the seam from `reified-criteria.md`. |
| [`partial-update.md`](./partial-update.md) | PROPOSED | `command` + `T option` fields for PATCH semantics. Supersedes the v0 `Optional<T>` proposal. **Folded into A1** of the implementation plan. |
| [`load-specifications.md`](./load-specifications.md) | PROPOSED | `loads` clause + compiler-inferred load plans + shape (loadedness) typing. **Folded into P3** of the implementation plan. |
| [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md) | PROPOSED | Four-layer model (**domain / contract / application / api**) replacing the implicit `api X from Subdomain` derivation. Routes register against contract types and the mediator dispatches to handlers (`commandHandler` / `queryHandler`; workflow stays its own peer). Every layer is **macro-scaffolded by default, unfoldable to literal source** — one `apiSurface(Sales)` expands through `scaffoldContext` / `scaffoldAggregate` / `scaffoldOperation` aggregators down to per-output leaves (`scaffoldCommand` / `scaffoldQuery` / `scaffoldResponse` / `scaffoldHandler` / `scaffoldRoute`); polymorphic over source kind. **Retires `wireShape` from the IR** — the projection logic was pure access-modifier filtering, which scaffolds do once at expansion time per the existing `wire-projection.ts` matrix. Retires `.loom/wire-spec.json` in favour of contract source as the diffable artefact (with `ddd snapshot --wire` as the on-demand escape hatch). Coordinates with `payload-transport-layer.md` (supersedes its "auto-synthesised `<Agg>Wire payload`" Phase 2 in favour of literal contract source) and `aggregate-inheritance.md` (I2 emission needs to read contract source rather than inherited wireShape once retirement lands). |

### Aggregate lifecycle + forms

Tightly coupled pair: aggregate action surface and the form-generation
layer that consumes it.

| Doc | Status | Core addition |
|---|---|---|
| [`lifecycle-operations.md`](./lifecycle-operations.md) | PROPOSED | Three keywords on aggregates (`create [name]`, `operation name`, `destroy [name]`) with kind-tagged typed actions; framework-owned persistence; body operating on pre-bound `this`. Drops PATCH (POST for body-carrying actions, DELETE only for canonical destroy). API-layer `urlStyle: literal \| resource`. Reframes `crudish` to emit the canonical lifecycle trio. Rejects: lifecycle-on-service, per-operation route alias, generic action kind, `delete` keyword. |
| [`lifecycle-url-style.md`](./lifecycle-url-style.md) | **SHIPPED** ([D-URLSTYLE](../decisions.md#d-urlstyle--lifecycle-url-style-on-the-api-body--per-action-routeslug)) — Phase 1 #722; `urlStyle:` parses + lowers, enrichment stamps `routeSlug`, and **every backend route emitter consumes it** (verified 2026-06-10; the earlier "no backend reads it yet" note was a stale loom-ir comment) | Reconciles `lifecycle-operations.md` Phase 2 with the **actual** `api` grammar (which differs from that proposal's assumption). `urlStyle: literal \| resource` on the api body + per-action `routeSlug`. |
| [`loom-forms.md`](./loom-forms.md) | PROPOSED | `CreateForm` / `OperationForm` / `DestroyForm` walker primitives binding strictly to typed actions defined by `lifecycle-operations.md`. The action's param list IS the form's field list — no field-walking fallback. Submission dispatches via the generated API client. Fixes the layering bug where form walker + API generators independently synthesise the create contract. |
| [`frontend-acl.md`](./frontend-acl.md) | PARTIAL | Frontend Anti-Corruption Layer: two shared utility files emitted into every React project (`src/lib/strict-field-map.ts` — compile-time `StrictFieldMap<P, F>`; `src/lib/apply-server-errors.ts` — runtime decoder that returns `ServerErrorOutcome` `applied`/`global`/`unhandled`). Generated form catch blocks across all 8 pack/versions (mantine v7+v9, shadcn v3+v4, mui v5+v7, chakra v2+v3) call `applyServerErrors` with `setError` + an empty (identity) FieldMap, then switch on the outcome for pack-native toasts. Behaviourally additive — the `applied` per-field path is dormant until backends grow the RFC 7807 §3.2 `errors[]` extension (lands with `exception-less.md`). **Shipped Phases 1+2 in #769**. Deferred: schema restructure (flat-key + `.transform()` + `<Action>FormState` ≠ `<Action>Payload`) and per-action FieldMap instances (meaningless until the restructure), `option`-field rendering (gated on `partial-update.md`). |
| [`extern-component-escape-hatch.md`](./extern-component-escape-hatch.md) | PARTIAL | **Tier 1 (React) shipped** on `claude/extern-component-escape-hatch-4vobH` (grammar + IR/lower + validator + props-emit + re-export shim + tests; Tier 2 `action` / LiveView / framework-guard deferred per §4). UI-side analogue of `operation … extern` (`docs/extern.md`): an `extern` modifier on `component` lets users drop a **hand-written React/TSX (or HEEx) component** into a page body, type-checked against the domain via a `wireShape`-derived props interface that Loom regenerates every run. **No stub, no write-once** — the user's component is *never* generated, only imported (like an `import helper` target), so `tsc` on a missing/mismatched component is the fail-fast gate and there is no first-run magic (`tools.md:119`). Opens the closed walker library (`page-metamodel.md` §9) at one controlled, typed seam — extern components are typed *leaves* the walker renders but never descends into, not new primitives. **Interactive from v0 via `slot`** (not a read-only widget): the caller passes a fully-wired `Action{…}` into a slot param, handed to the hand-written component as a `ReactNode` — a real domain-wired control with no new machinery. **Recommended delivery is staged** (see the proposal's §4): ship **Tier 1 (slot), React only**, gated on a `LOOM_REACT_BUILD` test proving a domain rename breaks the user's `.tsx` at the props boundary (the feature's whole point); **defer Tier 2** — `action` behaviour params (`o => { o.confirm() }` lowered to a `(args)=>void` callback, the element-vs-callback sibling of `slot`) — until a concrete widget pulls it, because it adds Loom's *first function type*; **defer LiveView** likewise. No op-specific binding form; no call-site inference (Loom types declarations, checks uses — `type-system.ts:417`), so the eventual `action` token is `action(Order)` (preferred) vs `(Order) => action`. Don't ship import-only (A) as the end state — it discards the `wireShape` type that is the reason to do this in a typed DSL. **`extern page` is explicitly declined** (§10): a page is a composition point (route+params+auth+menu+body), not a leaf — its body already escapes via an extern component, and owning the whole route module is what the file-level `.loomignore` hatch is for. Composes with `embedded-frontend-composition.md` (framework on `ui`). |

**Read order:** lifecycle-operations first (foundation); forms second; frontend-acl third (form runtime); extern-component-escape-hatch alongside (the open-library seam, independent of the form family); extern-function-hook-escape-hatch after it (its logic twin).

### Frontend escape hatches (the `extern` family)

| Doc | Status | Aspect |
|---|---|---|
| [`extern-component-escape-hatch.md`](./extern-component-escape-hatch.md) | PARTIAL | The **render** hatch — `component … extern from "<path>"` drops a hand-written React/TSX (or HEEx) component into a page body, type-checked against the domain via a `wireShape`-derived props interface Loom regenerates; the user owns the module (never written), `tsc` on a missing/mismatched component is the fail-fast. No stub/write-once/first-run-magic; call sites import a stable `components/<Name>` re-export shim, walker untouched. Interactive via `slot` (element) and `action` (behaviour, a passed lambda — Tier 2, deferred). `extern page` declined (a page is a composition point, not a leaf). **Tier 1 React shipped (PR #802).** |
| [`extern-function-hook-escape-hatch.md`](./extern-function-hook-escape-hatch.md) | PROPOSED | The **logic** twin of the component hatch, extending the `extern` family to foreign *functions* and React *hooks* — the typed replacement for the removed `import helper`. `function name(params): T extern from "<path>"` (framework-neutral) generates a `signature.ts` (wire-typed) + a **conformance shim** (`export const f: Fn = _impl`) so a missing/mismatched function or a domain rename fails `tsc` at the shim; aggregate params use the wire DTO so the contract bites in the user's file. `hook useX(...): T extern` (React-only) registers a foreign hook into the walker's existing `useXxx` hoisting pass (hoist-to-top + bind), with rules-of-hooks + framework-mismatch validators. Effects = void functions callable only in `action`/handler position (a rule, not a keyword). Unifying invariant lifted from backend `operation … extern`: generated typed contract + foreign impl + compile-time fail-fast; `import` stays for Loom files, no `helper` keyword. Staged: `function` (TS) first, Phoenix `@spec` next, `hook` when a real use-case pulls it. |


### Workflow

| Doc | Status | Core addition |
|---|---|---|
| [`workflow-and-applier.md`](./workflow-and-applier.md) | PARTIAL — appliers (A1) + event-sourced emission shipped on Hono (A2.1/A2.2a), **.NET/EF (A2.2b, #914)** and the second-persistence adapters Dapper + MikroORM (A2.2c, #941); members-only workflow body + `create()` starter (#889); **workflow instances as view sources shipped on all backends** (#1035/#1037). Phoenix ES (via `foundation: vanilla`, D-VANILLA-ES-HOME) + projections/snapshots remain | Reframes today's `workflow Name(params) [transactional]`. Introduces appliers (`apply(...)`) for event-sourced aggregates and workflows. Three concepts split out of today's overloaded `workflow`: single-tx command handler, multi-tx command-triggered process, event-triggered process. Sagas (compensation contract) deferred to a v2 amendment. |
| [`dispatch-delivery-semantics.md`](./dispatch-delivery-semantics.md) | PROPOSED — design note (in-process dispatch shipped Hono #970 / .NET #1012 / Phoenix #1020; outbox tier unstarted) | Records the **delivery property** of the in-process dispatcher that now ships on all three backends — **at-most-once**, synchronous, unsupervised, event not persisted (only correlation is) — and designs the reliability upgrade `channels.md` only *names*: a **transactional outbox** (persist `emit` in the producer's tx → relay drains it through the existing `dispatch` seam, at-least-once) + **idempotent consumers** (a processed-marker on the saga-state row). The relay is the seam `channelSource` swaps for an external broker; the emitted shapes don't change. Opens: reuse `retention: log/work` as the durability knob, relay placement, ordering vs `channel{key}`, dead-letter + `event_dead_lettered` obs event. |
| [`channels.md`](./channels.md) | PARTIAL — Slice 1 (`channel` + `channelSource` surface → `ChannelIR`/`ChannelSourceIR`) shipped (#797); realtime wire + caching unstarted | **Channels, realtime & caching** (two halves in one doc). **Part I — Channels** fills the "async messaging/outbox" gap: a context-member `channel { carries / delivery / retention / key }` (many per context, like a `view`) unifies pub/sub, work-queue, and durable stream via orthogonal `delivery`×`retention` knobs; `channelSource` binds it to a `storage{type: redis/kafka/rabbitmq/nats}` (mirrors `persistedAs(eventLog)`/`dataSource`, [D-STORAGE-SPLIT](../decisions.md#d-storage-split--split-the-overloaded-storage-keyword)) — the contract names no transport. Reuses the pinned `on(e: Event)` / `projection` consumer surface; producer `emit` unchanged (`DomainEventDispatcher`). Also owns **realtime delivery to the browser**: the SSE/WebSocket wire, the two-hop **edge relay** (cross-DU), and the policy-derived **router** (`publishRoomsFor`/`roomOf` → off-the-shelf relays: Phoenix Channels / SignalR / Centrifugo / NATS). **Part II — Reads, freshness & caching** fills §3.4: the cache/invalidation/routing key is the **React Query key** (interest), *not* `DataKey` (visibility); **invalidation-based** caching (surrogate-key/cache-tag purge keyed by a derived **dependency set**) driven by one `save→query-keys` map (`InvalidationRuleIR`); the cache **tier** is gated by authz shape (per-user → in-handler read-through below the gate, not OutputCache). DX: `cached: none|tagged` + a `live` opt-in defaulting to **safe over-send** (refetch is the gate; tightening is a free/opt-in optimization). |

### Provenance & governance family

> The umbrella term is **value provenance** — "explain where a
> computed value came from", aligned with W3C PROV. Classic
> requirements-tracing was considered and set aside in favour of
> this.

| Doc | Status | Core addition |
|---|---|---|
| [`provenance.md`](./provenance.md) | SHIPPED (TS/Hono v1) | `derived … provenanced` + compiler-inferred lineage + snapshot/trace split. .NET/Phoenix parity is Phase 5 deferred tail. |
| [`execution-context.md`](./execution-context.md) | PROPOSED | Compiler-emitted scope frames (`correlationId`/`scopeId`/`parentId`/…) shared by provenance, audit, and logging. Tier 0 of Phase 3 — backbone for everything that follows. |
| [`audit-and-logging.md`](./audit-and-logging.md) | PARTIAL | `audited` boolean shipped; Hono emits load→mutate→save→audit. Remaining: promote to `audited(actions \| access \| events \| off)`, `AuditRecord` shape, before/after snapshots, .NET Mediator behaviour, access-audit query pipeline. |
| [`observability.md`](./observability.md) | SHIPPED | Structured logging via IR-neutral event catalog. Catalog + 3 backends + `LOOM_OBS_E2E_*` gates green on main. Complementary to `audited` — observability is the structured-log channel, `audited` is the transactional append-only one. |
| [`sensitivity-and-compliance.md`](./sensitivity-and-compliance.md) | PARTIAL | `sensitive(<tag>)` as a type-system property; sensitivity propagates through expressions. Phases 1 + 2-lite shipped. Remaining: Phase 2 full (`authorized(<tag>, …)` declassification), Phase 3 (`mask:` DTOs + React), Phase 4 (sink-call classification — log/error/trace/metric reject sensitive values). |
| [`encrypted-at-rest.md`](./encrypted-at-rest.md) | DEFERRED | Reserved sibling of `sensitive` — governs *persistence*, not *flow*. Final phase of Phase 5; gated on storage capability matrix. |
| [`policies-supplementary-note.md`](./policies-supplementary-note.md) | SUPERSEDED | Background only. Superseded by `authorization.md`. |

### Authorization & tenancy

| Doc | Status | Core addition |
|---|---|---|
| [`authorization.md`](./authorization.md) | PROPOSED | `DataKey` hierarchical scoping; `policy { data { … } operations { … } fields { … } }` reachability, operation/view/workflow gates, field masking. Pinned per D-POLICY-STYLE over the function-style alternative. Phases 1–4 in Phase 3.2; phases 5–7 (`exists`, field rules, `implies`) in Phase 5. |
| [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) | PROPOSED | `tenancy by user.tenantId` at system level; `crossTenant` / `platform` aggregate modifiers; auto-stamped `TenantId` column + EF/Drizzle/Ash query filter. Ships before authorization phase 1 (DataKey leftmost = TenantId). |

### On-ramp & day-one runtime

| Doc | Status | Core addition |
|---|---|---|
| [`quickstart-and-day-one-batteries.md`](./quickstart-and-day-one-batteries.md) | PROPOSED | Collapses zero-to-running into `ddd new` + npm publish + a quick-start stack default; adds a unified `ddd dev` watch/regenerate/live loop and a one-command `ddd deploy <target>` (Fly/Render/Railway) over the existing Dockerfiles + compose + per-deployable DBs; and the universal runtime constructs the model can't express today — turnkey `auth` via **OIDC delegation** (`auth { oidc { … } }`; Keycloak as the self-hosted default + a bundled dev IdP, completing `auth.md`'s verifier hook rather than building a password runtime — D-AUTH-OIDC), `job` (scheduled/event-triggered), `email`, object `storage` + `File`/`Upload`, and `seed`. Strictly additive; opt-in models emit byte-identically. |
| [`database-seeding.md`](./database-seeding.md) | PARTIAL — Phase 1 surface→IR→lowering (#803) + all three per-backend emitters: Hono/Drizzle `db/seed.ts` (#804), .NET/EF `Seed.cs` (#805), Phoenix/Ash `seeds.exs` (#806), CI build gates (#808), `D-SEED-XREF` explicit-id cross-refs (#828), and the `__loom_seed` ship-once marker + `raw` direct-INSERT path on all three backends. Remaining: imperative (workflow-shaped) body, per-row natural-key upsert, create-shape validation | **Graduates the `seed {}` sketch from quickstart §5.4** into a full pipeline that mirrors migrations: a `seed <dataset>` ContextMember (declarative typed records *or* a workflow-shaped body) → a platform-neutral `SeedIR` (the data twin of `MigrationsIR`) → per-backend emitters (Drizzle `db/seed.ts`, EF `ISeeder`, Ash `seeds.exs`) → per-deployable distribution reusing the `migrationsOwner` gate → a `.loom/seed-spec.json` artifact. Declarative-first (rows lower through the aggregate's canonical `create`, so invariants hold), **idempotent** (ship-once `__loom_seed` dataset marker in v1; per-row natural-key upsert deferred), **dataset-scoped** (`dev`/`demo`/`test` gated by `LOOM_SEED`), forward-only. Requests **D-SEED-PATH** (domain-create vs raw insert) + **D-SEED-IDEMPOTENCY** (ship-once marker). Strictly additive. |

### UX / output

| Doc | Status | Core addition |
|---|---|---|
| [`pagination-design-note.md`](./pagination-design-note.md) | SHIPPED (offset paging, all 4 backends — #898/#916/#925, #933 wire-parity gate); `unpaged` opt-out + page-aware hooks remain | `Paged<T>` response envelope; offset/limit defaults; `unpaged` opt-out for small reference lists. Phase 4.2. |
| [`i18n-strings.md`](./i18n-strings.md) | PROPOSED | String composition: template literals, ICU, concatenation ban in user-visible slots. Closes `i18n.md` open question #4. Companion — must read with `i18n.md`. |
| [`i18n.md`](./i18n.md) | PROPOSED | First-class i18n: ICU catalogs, content-hash keys, named `text { }` entries, `ddd i18n sync` three-way merge, per-backend adapters. 7-phase build, ~4 weeks. Phase 4.1. |

### Quality / tooling

| Doc | Status | Core addition |
|---|---|---|
| [`cross-stack-static-analysis.md`](./cross-stack-static-analysis.md) | PARTIAL — Phoenix `@spec` emission (#902/#904/#906/#911) + Dialyzer CI (`LOOM_PHOENIX_DIALYZER`, #907/#918) + `LOOM_DOTNET_FORMAT`/`LOOM_PHOENIX_FORMAT` gates (#903) shipped; **C# `<Nullable>enable</Nullable>` ships in the csproj templates** with `dotnet build /warnaserror` as the CI gate; repo-content lint remains | Extends the `LOOM_BIOME=1` gate to the other emission targets (.NET, Phoenix, repo content) and has the generator *emit type metadata* (C# nullable annotations, Elixir `@spec`s) so downstream analyzers have more to chew on. |
| [`playground-git-vfs.md`](./playground-git-vfs.md) | SHIPPED | Browser playground filesystem is git-native: LightningFS + isomorphic-git durable store, async workspace layer over it (sync resident snapshot for LSP/editor), one-time legacy-IDB import, generated code versioned under `/workspace/generated/**` with regeneration as a per-file 3-way merge, debounced commit-on-save. Plus a visible **History** tab (commits + per-commit files), **restore to a past commit**, and an Output-panel **conflict indicator**. `web/`-only. Landed in #748 (+ preview-from-workspace), #757, #761 (cleanup), #766 (history), #773 (restore), #778 (conflict indicator), #814 (e2e). Plan: [`../plans/playground-git-vfs-implementation.md`](../plans/playground-git-vfs-implementation.md). |
| [`mutation-testing.md`](./mutation-testing.md) | PROPOSED (OUT OF SCOPE) | IR-level `ExprIR → ExprIR[]` operators; gated instrumented emit mode preserving byte-identical fixtures; staged runner plan. Excluded from the global plan per maintainer. |

## Tier summary (précis of the global plan, 2026-06-10)

The rewritten [`global-implementation-plan.md`](./global-implementation-plan.md)
replaces the old Phase-0…5 structure with four code-verified tiers:

```
Tier 1 — broken or misleading surface — DONE
  [`?` operator removed; union-find producer path on Hono+.NET;
  MultilineField/SelectField implemented (Switch dropped per
  page-metamodel.md); docs-honesty maintenance rule stays live]

Tier 2 — nearly done (per-backend completion)
  Elixir track: vanilla workflow stmt kinds → event sourcing under
  vanilla (D-VANILLA-ES-HOME) → or-union returns → first-class
  adapters → HEEx primitive backfill. Plus:
  reified-criteria tail (capability filters + principal factory),
  shape(document) on elixir, IR field-constraint metadata, principal
  context filters on node/elixir, provenance/audit runtimes on
  dotnet/elixir.

Tier 3 — partially-shipped families
  loads: plans; criterion selectability tail; payload P3-full + P5;
  exception-less remainder per failure-taxonomy (A4 = the one
  coordinated rebaseline); channels realtime wire; outbox;
  dapper/mikroorm scope decision; storage dataSource tail; F5d +
  MVC transport; sensitivity 2–4; audit promotion; React/forms/
  extern remainders; resource-kind codegen; seeding tail;
  inheritance I4.

Tier 4 — unstarted families (dependency spine)
  execution-context → multi-tenancy → authorization 1–4;
  domain-services; loom-forms + lifecycle Phase 2+;
  i18n-strings → i18n; quickstart batteries (ddd dev/deploy, OIDC);
  networking/proxy/helm/terraform; structural reframes; java backend.
```

Surviving coordinated single-PR moments: the **A4 rebaseline**
(`Repo.getById` → `T or NotFound`), **Tier-0** (execution-context
before any governance tier), **Auth-gate** (multi-tenancy before
authorization Phase 1), **ES-vanilla** (event sourcing on elixir lands
as one slice). The old M1/M2 milestones are retired — P4 and most of
A1/A3 shipped independently, and A2 (`?`) is dropped.


## Cross-proposal coordination notes

- **bounded-context-model.md vs storage proposals.** Pinned via
  [D-STORAGE-SPLIT](../decisions.md#d-storage-split--split-the-overloaded-storage-keyword)
  + [D-GRANULARITY](../decisions.md#d-granularity--storage-bindings-are-per-context-not-per-aggregate):
  three keywords (`storage` physical, `dataSource` per-context+kind,
  `deployable.dataSources:` binding clause); per-context for v1,
  per-aggregate deferred. The storage proposal's grammar work
  largely survives; per-aggregate `for:` does not land in v1.

- **aggregate-inheritance.md ↔ storage.** Original
  `storage: shared | own` for inheritance table layout collides
  lexically with the storage proposal's `storage` keyword. Pinned
  rename (D-RENAME, amended by D-DOCUMENT-AXIS §4): the header paren
  modifier `inheritanceUsing(sharedTable | ownTable)`. A
  `persistedAs(eventLog)` concrete subtype of a `sharedTable` abstract
  is forced to `inheritanceUsing(ownTable)` (D-ES-TPH).

- **Storage foundation positioning.** The storage micro-plan's
  foundation phases are positioned to land **before** the type-system
  family's exception-less A4 phase. The
  `PersistenceAdapter.emitRepository(...)` contract is stable under
  A4 — landing the seam first reduces A4's per-backend monolithic
  edits to per-adapter file edits.

- **Authorization vs multi-tenancy.** They overlap on the
  `crossTenant` keyword and tenancy primitives; reconciliation is
  tracked in §0 of `authorization.md`. `policies-supplementary-note.md`
  is retained as background but superseded by `authorization.md`.

- **Sensitivity / audit / load-spec ↔ authorization.** Sensitivity
  tags drive a policy-presence lint; audit records reference a
  policy decision id; the load-spec layer and any data-policy
  filtering both wrap `Repo.load`.

- **lifecycle-operations ↔ workflow-and-applier.** Both touch the
  action surface. Lifecycle-operations covers aggregate-local typed
  actions; workflow-and-applier reframes context-level orchestration
  and adds appliers. Read the lifecycle doc first; the workflow doc
  builds on its `OperationIR.kind` tagging.

- **unfoldable-api-derivation ↔ payload-transport-layer ↔
  aggregate-inheritance.** Three docs touch the wire-shape pipeline.
  `payload-transport-layer.md` proposes naming the wireShape
  projection (`<Agg>Wire payload`) as a first-class type;
  `unfoldable-api-derivation.md` goes further and **retires
  wireShape from the IR**, replacing the named projection with literal
  contract source produced by scaffolds at expansion time.
  `aggregate-inheritance.md`'s I2 (TPH emission) currently walks the
  extends-chain to build wireShape for inherited fields; under
  unfoldable-api-derivation it walks the chain to emit literal contract
  fields into the response payload of the concrete instead. Read
  payload-transport-layer first for the original framing;
  unfoldable-api-derivation for the simplification; aggregate-inheritance
  alongside for its I2 dependency. Coordinated landing not strictly
  required — payload-transport-layer can ship first with `<Agg>Wire`
  as a transitional name that retires when scaffolds take over.

- **platform-directory-layout / per-package-output-tree ↔
  packaging-split.** Backend layout is governed by
  [`docs/plans/packaging-split.md`](../plans/packaging-split.md)
  (per-version installable backend packages), pinned canonical by
  [D-BACKEND-PKG](../decisions.md#d-backend-pkg--per-version-backend-packages-are-canonical).
  This **rejects** `platform-directory-layout.md`'s Option A (reversing
  the `src/platform/hono/v4/` hoist) — that hoist is the package-staging
  shape, guarded by the live `package → shared` invariant
  (`test/platform/backend-packages-layering.test.ts`). Adapters move
  onto the backend surface and the central `adapter-registry.ts`
  dissolves per
  [D-ADAPTER-HOME](../decisions.md#d-adapter-home--persistencestylelayout-adapters-live-on-the-backend-surface);
  the F5d/F6d orchestrator rewire already decentralised the emit half.
  `per-package-output-tree.md` is the output-side twin — deferred, not
  rejected.

## Parking lot

[`maybe-one-day/`](./maybe-one-day/) holds captured architecture
conversations that are **most probably won't-do**, filed so the path is
recoverable if the question resurfaces:

| Doc | Status | Role |
|---|---|---|
| [`maybe-one-day/dotnet-in-playground.md`](./maybe-one-day/dotnet-in-playground.md) | DEFERRED (won't-do) | Running the generated .NET backend in the browser playground (WASM). Captured for recoverability; not pursued. |
