# T8 — DX, tooling & the AI platform

*Diagnostics (123 stable codes + machine-applyable fix-hints) and the LSP are best-in-class; interactive debugging is essentially absent; the AI-platform loop (validate→repair→verify) is mostly built and needs its last mile + the wedge demo.*

## M-T8.1 — Delegating DAP debugger — `open` · **XL** · P2
The shipped DAP server is a remap shim (breakpoint/stack-trace translation only; no stepping/variables; VS Code has no `debuggers` contribution). Build the delegating proxy: spawn js-debug (node first), forward launch/attach/continue/stepIn, remap both directions; register the debugger in the extension; the manual VS Code breakpoint confirmation. Then coreclr/JDWP per backend.
Sources: [source-map-and-debugging](../old/proposals/source-map-and-debugging.md) §6E, [dap-node-debug](../old/plans/dap-node-debug.md) frontier list.

## M-T8.2 — Sourcemap fan-out — `partial` · **M** · P3
Column-accurate span tracking shipped on TS/Hono (slices 3–4 incl. `ddd trace` columns); fan out `renderExprWithMarks` to the other four backends when a consumer exists (DAP or per-backend crash remap). Deliberately deferred — re-check the consumer question first.
Sources: [span-tracking-emission](../old/plans/span-tracking-emission.md), [source-map-debug-kickoff](../old/plans/source-map-debug-kickoff.md).

## M-T8.3 — Agent-loop last mile: chat UI + context pack + wedge demo — `partial` · **L** · P1
The strategic demo: prose → `.ddd` → multi-backend generate → conformance green, driven by an agent in the playground. Remaining: the LIVE chat UI (`Complete` transport decision, streaming), the model context-pack (system-prompt bundle; gate: frontier model zero-shots valid systems), `loom_verify` tool, next fix-hint batch, `rename` patch op.
- **Shipped (agent tools):** the `loom_read_model` (resolved wire-shape projection over the enriched IR — the semantic contract `loom_outline` omits) and `loom_list_primitives` (the closed walker page-body vocabulary) agent tools — both over `src/api/`, browser-safe, in the shared catalog (MCP + playground). `loom_verify` still open (it joins test-results, so it's coupled to the runtime/chat loop).
- **Shipped (deterministic demo):** the **Agent dock tab** (`web/src/layout/ChatPanel.tsx`) plays a SCRIPTED wedge demo — prose → authored `.ddd` (into the editor) → `loom_validate` → `loom_generate` (real browser-safe `callTool`) → real playground generate → green — with no live LLM, so it's reproducible and doubles as a Playwright e2e (`web/e2e/agent-demo.spec.ts`). Driver + authored source are headless-gated (`test/playground/agent-demo.test.ts` validates + generates the model). This decouples the wedge demo from the still-open `Complete` transport/provider decision (the LIVE variant).
Sources: [ai-authoring-loop](../old/proposals/ai-authoring-loop.md) items 7+9, [agent-tools-and-mcp](../old/proposals/agent-tools-and-mcp.md) §8-5, [ai-generation-platform](../old/proposals/ai-generation-platform.md) §6, D-AI-EMPHASIS, D-AGENT-TOOLS.

## M-T8.4 — LSP correctness tail — `open` · **S** · P2
The LValue blind spot (rename-from-call-site, member-call highlighting in statement position), uninferrable-receiver rename miss; the `Fold to macro` inverse code action.
Sources: [agent-tools-and-mcp](../old/proposals/agent-tools-and-mcp.md) §4c.

## M-T8.5 — Diagnostics contract completion — `partial` · **M** · P3
`related[]`, IR-diagnostic ranges + fixHints (needs CST provenance through lowering), GenerateReport file counts + `.loom` paths, multi-file generate, code-registry single-sourcing, `contractVersion`.
Sources: [ai-diagnostics-contract](../old/proposals/ai-diagnostics-contract.md).

## M-T8.6 — Playground sandbox completion — `partial` · **M** · P2
The cross-origin flip (`SANDBOX_ORIGIN` → distinct origin — no real isolation until then; gates untrusted user expressions), Phase 3 API test runner, Phase 4 UI driver + `page` shim, Phase 5 console/screenshots, CSP pack-render confirmation.
Sources: [playground-sandbox-redesign](../old/plans/playground-sandbox-redesign.md).

## M-T8.7 — Packaging split unblock — `blocked(browser discovery)` · **L** · P3
P3-s5 (move `src/platform/hono/v*` into `packages/`) is blocked on browser-capable backend discovery for the playground worker (`ResolutionStrategy` seam, esbuild-wasm spike → RegistryStrategy → WorkspaceStrategy). P4 publish follows. Related: [per-package-output-tree](../old/proposals/per-package-output-tree.md) (output-side twin, deferred), [server-side-generation](../old/proposals/server-side-generation.md) (fills the same worker seam with a server call — evaluate together).
Sources: [packaging-split](../old/plans/packaging-split.md), [backend-packages](../old/plans/backend-packages.md) B3+.

## M-T8.8 — Mutation testing — `open` · **XL** · P3 (explicitly parked)
IR-level mutation testing (mutate `ExprIR`, render via the shared dispatcher, kill/survive against emitted suites → `VERIFIED_WEAK` verdicts in `ddd verify`). The old global plan marked it out-of-scope; the proposal is complete. Revisit after T9's runtime tiers mature.
Sources: [mutation-testing](../old/proposals/mutation-testing.md).

## M-T8.9 — Static-analysis breadth — `open` · **S** · P3
markdownlint + biome JSON/JSONC extension; Credo; `ddd fmt` stays a separate future proposal.
Sources: [static-analysis-followups](../old/plans/…) — see [cross-stack-static-analysis](../old/proposals/cross-stack-static-analysis.md).

## M-T8.10 — Playground preview breadth — `open` · **M** · P3
In-browser preview boots Hono+React only; Vue/Svelte previews need their compilers in the VFS bundler; multi-backend mounting ties to M-T7.4 slice 4. Nice-to-have; the builder already edits all frontends' source.
Sources: [vue-frontend-plan](../old/plans/vue-frontend-plan.md)/[svelte-frontend-plan](../old/plans/svelte-frontend-plan.md) deferrals, [playground.md](../playground.md).

## M-T8.11 — Playground evolution-lifecycle surfacing — `partial` · **M** · P2
The playground regenerates statelessly (keyed by a source hash) and holds no "previous version of my system", so migrations/snapshots/wire-contract *changes* are invisible side effects — the git-VFS versions source, but nothing diffs derived artifacts against a pinned baseline. Three deliverables, all riding shipped pure cores: a **snapshot capture button + `.loom/snapshots` browser** (`captureSnapshots` is already imported by the build worker; the `snapshot` RPC + client method exist but no UI calls them); a **Migrations & Contract dock tab** driven by a pinned git baseline through `memorySnapshotStore` + `diffSchema`/`buildMigrations` (surfacing the destructive gate + `MigrationDestructiveError` instead of today's read-only "schema migrated" badge); and a **breaking-change panel** over the new pure `diffWireSpec` (replacing eyeball `git diff .loom/wire-spec.json`). The **baseline concept is the crux** — every diff needs a pinned prior version, which the git workspace can supply. Web-side counterpart to the T2 data-evolution track: `checkMigrationBaseline` (M-T2.2) shipped fs-backed/CLI-only and the playground deliberately omits it. Ties to M-T8.6 (real sandbox isolation) and M-T8.3 (agent loop — an agent editing a model wants the same evolution signals).
- **Shipped (#2017):** all three deliverables — the Migrations dock tab (`web/src/layout/MigrationsPanel.tsx`), the `evolution` RPC + `diffWireSpec` breaking-change core, the snapshot capture button, a git-baseline picker, and a Download-.zip export of the generated tree.
- **Shipped (#2048):** the noted follow-ups — **multi-file / import baselines** (both trees now seed the worker VFS and lower via the project loader, so `import` graphs resolve; the single-file gate is gone), a **mobile Download-.zip** button, a **History → "Diff as baseline"** one-click pin (dock-tab state lifted to the ctx), and an edit-driven + multi-file Migrations e2e. Remaining under this mission: nothing structural — the evolution-signals-for-the-agent-loop tie-in lives with M-T8.3.
Sources: [playground.md](../playground.md), [source-map-and-debugging](../old/proposals/source-map-and-debugging.md) (provenance/`.loom` bundle), T2 track ([T2-data-evolution](T2-data-evolution.md) M-T2.1/M-T2.2/M-T2.3).
