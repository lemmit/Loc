# Phase A: Platform-expansion prerequisites

## Context

We want to add new compilation targets (Vue, Svelte, FastAPI, Rails, Blazor WASM + Server, etc.) over the coming quarters. Before any new platform, four infrastructure gaps in the current toolchain need to close — these are fixes/upgrades we'd want regardless of expansion, and they each unblock multiple downstream platforms.

The four items, with effort and what they unblock:

| # | Item | Effort | Unblocks |
|---|---|---|---|
| 1 | Finish Phase 7 `WalkerTarget` extraction | ~2–3 wks | Every new frontend (Vue/Svelte/Blazor) — without it, each forks `body-walker.ts` again |
| 2 | Multi-backend behavioral conformance harness | ~1–2 wks harness + N wks cleanup | Every new backend (FastAPI/Rails/Django/Blazor Server) — also catches latent bugs in current 3 backends |
| 3 | Test-ID coverage tripwire | ~3 days | Cheap insurance against pack drift; protects e2e tests |
| 4 | Pack required-primitives validation | ~3–5 days | Fail-fast for any new design pack |

All four are independent (zero hard dependencies). Suggested merge order, **least to most churn**: 4 → 3 → 2 → 1. Item 1 carries the highest fixture surface (every walker test + Phoenix mix-compile gate); Item 2 forces a baseline e2e fixture recapture; Items 3 and 4 are purely additive.

**Architectural principle preserved throughout** (from `experience_gathered.md` §13): backends stay idiomatic; shared semantics live in pure IR helpers (`wire-projection.ts`, `invariant-classify.ts`, `enrichments.ts`). No uniform `Platform` flattening interface.

---

## Step 0 — Update branch to latest main

Plan mode blocks state-changing git ops; this is the first action after exiting plan mode.

```bash
git fetch origin main
git rebase origin/main         # OR: git merge origin/main, depending on branch policy
npm install                    # re-runs the `prepare` lifecycle (langium:generate + build)
npm test                       # sanity green-line before any change
```

Current branch is `claude/hopeful-dijkstra-cRcDy`, 27 commits ahead of the last-fetched `origin/main`. If rebase conflicts, resolve and continue; don't proceed to Item 1 until the branch builds and tests pass on top of fresh main.

---

## Item 4 — Pack required-primitives validation

**Goal:** every pack must declare the primitive set it implements; loader fails at load time, not at first generation-time `pack.render(<missing-name>)`.

### Design

- Tiered required set per pack format. TSX and HEEx are intentionally different (HEEx has no `form-*`/`field-input-*` because LiveView uses `AshPhoenix.Form`).
- The diff between Mantine v7 (35 primitives) and ashPhoenix v3 (34 primitives + 17 other-key gap) is **structural by paradigm**, not a coverage hole. Tiers capture that honestly.

### Schema

```ts
// src/generator/_packs/required-primitives.ts (new file, ~80 LOC)
type RequiredTier = "core" | "fieldInput" | "form" | "shell";

export interface RequiredSet {
  core: readonly string[];        // primitive-button, primitive-stack, primitive-card, ...
  shell: readonly string[];       // page-list, page-detail, layout shells, ...
  fieldInput?: readonly string[]; // TSX only — field-input-string, field-input-int, ...
  form?: readonly string[];       // TSX only — form-of-decls, form-default-onsubmit, ...
}

export const REQUIRED_PRIMITIVES: Record<PackFormat, RequiredSet>;
```

Calibrate the lists against the **current intersection** of existing packs (the 4 TSX packs all ship identical primitive surfaces; ashPhoenix is the lone HEEx pack). Pack-private extras (`tailwind-config`, `lib-utils`, `components-ui-*`, chakra's `toaster`) stay in `shellFiles`/`shellGlobs`, not in the required set.

### Files

- **New:** `src/generator/_packs/required-primitives.ts` — exports `REQUIRED_PRIMITIVES`. Includes a top-of-file comment documenting the policy ("to add a primitive to the required set: first ship it in mantine v7, shadcn v3, mui v5, chakra v2; then add to this list").
- **Modified:** `src/generator/_packs/loader.ts:220-322` (`compilePack`). After the templates map is built (~line 307), validate `emits` ∪ `sharedSources` covers the required set for `manifest.format ?? "tsx"`. Throw with the diff: `"loader: pack ${name}: missing required primitives: ${missing.join(', ')}"`.

### Tests

- **New:** `test/platform/pack-required-primitives.test.ts` — iterates every built-in pack (4 TSX + 1 HEEx), asserts each loads cleanly. Uses `loadPack(resolvePackDir(name))` from `src/generator/_packs/loader-fs.ts:6`, following the pattern in `test/platform/pack-manifest.test.ts:46`.
- **One negative case:** synthesize a temp pack missing `primitive-button`, assert load throws with the missing-names message.

### Acceptance

- `npm test` green.
- `LOOM_REACT_BUILD=1` matrix unchanged.
- Manual: add a pack copy with `primitive-button` removed from `emits` → load fails immediately with diff.

### Open question for implementation

Whether `primitive-modal` belongs in HEEx's `core` tier. `heex-walker.ts:487` calls into a Modal primitive and currently emits a placeholder. Recommended: add `primitive-modal` to HEEx's required set, then backfill ashPhoenix v3 to ship it (small follow-up; not part of this item).

---

## Item 3 — Test-ID coverage tripwire

**Goal:** a regression test that catches the day a pack stops emitting `data-testid` on a primitive that should have one.

### Design correction (vs original proposal)

The original "render every primitive with a canned context and assert testid in output" approach **does not work** because:
- Only 2 of 34 ashPhoenix templates contain `data-testid` literals — Phoenix testid emission happens in walker *code* (`heex-walker.ts:763,862,914`), not in templates.
- Mantine v7 has 34 of 35 primitives with testid in templates (`primitive-query-view` is a legitimate structural exemption).
- Canned-context rendering requires mocking 35 non-trivial template contexts (e.g., `primitive-form-of.hbs` needs `aggregateName, fields[], idTargets[], defaultValuesTs, testidNamespace, slug, humanAgg` — see `walker/page-shell.ts:340-357`).

### Static-scan approach (lighter, honest)

Read pack files as text; assert presence of either `data-testid` (template-side) or known partial-include (`{{testidAttr}}`) for TSX packs. For HEEx packs, scan the small *current* observed set and lock that in as the baseline; don't try to enforce parity with TSX (it's an open work item, not a regression).

### Files

- **New:** `test/conformance/pack-testid-coverage.test.ts` (~50 LOC). Pattern follows `test/conformance/showcase-completeness.test.ts` (165 LOC, registry-iteration shape).
- Logic:
  - For each pack, list its `primitive-*.hbs` / `primitive-*.heex.hbs` files.
  - For TSX packs: assert every primitive *except* an explicit allowlist (`primitive-query-view`, anything structural) contains `data-testid` or a known testid-emitting partial reference.
  - For HEEx packs: assert the *current observed list* (the ~2 that emit testid) still does; comment that broader HEEx coverage is a follow-up.
  - Negative case: a pack with `primitive-button.hbs` missing `data-testid` should fail.

### Tests / Acceptance

- `npm test` green.
- Manual: edit `designs/mantine/v7/primitive-button.hbs` to remove `data-testid="{{testId}}"` → test fails loudly.
- The allowlist is the contract surface: adding a primitive that intentionally doesn't emit testid means adding it to the allowlist (forces a deliberate decision).

---

## Item 2 — Multi-backend behavioral conformance harness

**Goal:** when a `test e2e "..." against <deployable> { ... }` block runs in CI, it executes the same assertions against **every backend in the system that serves the aggregates the test uses** — not only the named one. Catches the class of bug the retro records (Hono returning `{ id }` while .NET returned full DTO; OpenAPI parity diff was blind to it).

### Approach (Option A, rigorous)

Extend `src/system/e2e-render.ts:renderE2EFile()` so each `test e2e` block emits one `it(<name> against <backend>)` per **compatible** backend, where "compatible" = "every aggregate the test body references is in `deployable.moduleNames`."

The decision was made (per AskUserQuestion) to use the **rigorous match**: walk the test's `ExprIR` to collect referenced aggregates, then replay against every deployable whose `moduleNames` covers them. ~30 LOC of expression-walk + lookup, no IR changes.

### Why no hidden coupling

`e2e-render.ts` was audited end-to-end. The only per-platform branch is `apiBasePath()` (lines 59-61, returns `/api` for Phoenix, `""` for the rest). `ENDPOINTS` already enumerates every deployable's port (lines 73-80). `findAggregateBySlug` (402-411) and `findRepoQuery` (413-421) walk per-deployable `contexts`, which is recomputed per backend in the inner loop. `serviceSlug` (423-425) keys the right `ENDPOINTS.<slug>` per `it()`.

### Files

- **Modified:** `src/system/e2e-render.ts:63-101` (`renderE2EFile`). For each `apiTest`, before emitting `renderTest`, compute the set of compatible deployables by:
  1. New helper `collectReferencedAggregates(test.statements): Set<string>` — walks every `ExprIR` reachable from `expect`/`expect-throws`/`let`/`expression`/`call`, finds every `matchApiCall` (the existing helper at lines 313-323), extracts `aggregateSlug`. Same shape as `collectUsedLetNames` (131-163).
  2. New helper `compatibleDeployables(test, referenced, sys, modulesByName)` — returns deployables whose `moduleNames` cover every referenced aggregate's owning context.
  3. Loop body: for each compatible deployable, build the `RenderCtx` against that deployable and call `renderTest`. Test name is suffixed: `it("<name> against <slug>", ...)`.
- **Modified:** `test/fixtures/baseline-output/e2e/Acme.e2e.test.ts` — recaptured via `scripts/capture-baseline-fixture.mjs`. Acme has only one `api` deployable serving Catalog; expansion is no-op for that fixture in practice, but the recapture is good hygiene.
- **Modified:** `test/system/system.test.ts:184-197` — regex assertions over the emitted e2e file. Adjust to expect multi-deployable output where applicable (use `.toMatch` with multiple captures, or assert occurrence count explicitly).

### Tests

- **New:** `test/generator/e2e-render-multi-backend.test.ts`. Uses a fixture (or `showcase.ddd`) with 3 backends serving identical module sets. Asserts:
  - Each `test e2e` block emits 1 `it()` per compatible backend.
  - Each `it()` uses the right `ENDPOINTS.<slug>` and `apiBasePath` prefix.
  - A test that references only an aggregate from one backend does NOT replay against backends without that module.
- **Negative case:** a test referencing an aggregate not owned by any backend should still fail at generation (existing `findAggregateBySlug` error path; verify still triggers).

### Acceptance

- `npm test` green after fixture recapture.
- `LOOM_E2E=1 LOOM_E2E_PARITY_ONLY=` (i.e., behavioral mode, not parity-only) against `examples/showcase.ddd` runs every `test e2e` block against all 3 backends. If any backend disagrees, CI fails with the specific assertion that diverged.
- No changes to `.github/workflows/conformance-full.yml` — it already starts all backends and runs the behavioral suite; the expanded `it()` blocks just produce more test cases inside the same run.

### Expected discovery surface

This will surface real behavioral disagreements between Hono/.NET/Phoenix that have shipped under OpenAPI-parity-only gating. **Budget for cleanup is unbounded a priori** — the count of divergences is the calibration number for "how much cleanup does each new backend imply." Likely candidates from the retro:
- Response shape parity (already largely closed, but newer aggregates may have re-drifted).
- Error response format (RFC 7807 vs custom) on 422/400/404.
- Validation order / which field fails first when multiple invariants violate.

Treat these as **separate follow-up PRs**, not part of Item 2's merge. The harness lands first; the cleanup follows.

---

## Item 1 — Finish Phase 7 (`WalkerTarget` extraction)

**Goal:** extract React's inlined seams and HEEx's inlined seams into the existing `WalkerTarget` contract. Both walkers consume the contract; future frontends (Vue/Svelte/Blazor) implement a `WalkerTarget` and reuse the shared walker core.

### Contract scope decision

**Keep at 8 methods.** (Per AskUserQuestion: Option A.) Position-dependent refs, toast, user-component invocation, collection-op rendering, and lambda hoisting stay in each walker's framework-private code. Rationale: of those 5 gaps, 4 are HEEx oddities (React/Vue/Svelte/Blazor all use JSX-like syntax + native collection ops + inlined lambdas + identical `this`/`id` rendering). Extending the contract for HEEx-only concerns would add interface surface for zero new-frontend benefit and partly violates the retro's "backends stay idiomatic" principle.

Document this scope explicitly in the header of `src/generator/_walker/target.ts` — the contract is for **cross-framework lowering seams** (state mutation, API call shape, match, navigation, helper imports, default-init), not for every per-framework rendering difference.

### Files

- **Modified:** `src/generator/_walker/target.ts:1-40` — update the header comment to document the scope decision and what's explicitly out of scope.
- **New:** `src/generator/react/walker/tsx-target.ts` (~150 LOC). Implements `WalkerTarget` by lifting verbatim:
  - `renderStateWrite` from `body-walker.ts:1064-1075` (case `"assign"`)
  - `renderStateRead` / `renderStateInit` from `walker/page-shell.ts:630-735` (`renderUseState`, `zeroValueForType`)
  - `renderApiCall` + `renderApiHoisting` from `walker/api-hooks.ts:60-103` (hook detection + page-top declaration)
  - `renderMatch`, `renderNavigate`, `renderHelperImports`, `defaultInitFor` from their existing inline locations in `body-walker.ts`
- **New:** `src/generator/phoenix-live-view/heex-target.ts` (~150 LOC). Same shape, lifting from:
  - `heex-walker.ts:1505-1512` (`renderStateWrite`)
  - `heex-walker.ts:256-258` (`renderStateRead` — note position param)
  - `heex-walker.ts:1565-1594` (`defaultInitFor`)
  - `heex-walker.ts:647-683` (`renderApiCall`)
  - `heex-walker.ts:686+` (`renderNavigate`)
- **Modified:** `src/generator/react/body-walker.ts:315 walkBodyToTsx`. Add `target: WalkerTarget` as first parameter (with `tsxTarget` as the default at callsites for backward compat during refactor). Thread into `WalkContext` (`:439-485` and `:519`). Replace inline seam logic with `target.*` delegation at each of the 5–6 callsites identified above. Keep `testidAttr()` (lines 1164-1180) where it is — framework-neutral.
- **Modified:** `src/generator/react/walker/page-shell.ts:142,497,630-735` — route state init through the target.
- **Modified:** `src/generator/react/walker/api-hooks.ts:60-103` — route hook hoisting through the target.
- **Modified:** `src/generator/phoenix-live-view/heex-walker.ts:190 walkBodyToHeex`. Same shape: add `target: WalkerTarget` parameter, thread into `WalkContext` at `:144-184`, delegate at every inline seam location.
- **Modified:** `heex-walker.ts:1541 renderRequiresGuard` builds its own ad-hoc ctx — needs target threaded too.

### Caller-site changes

- React entry point at `src/generator/react/pages-emitter.ts:400` and `walker/page-shell.ts:142,497` — pass `tsxTarget`.
- Phoenix entry point at `src/generator/phoenix-live-view/index.ts` and `liveview-emit.ts` — pass `heexTarget`.

### Tests

- **All 31 `test/generator/walker-*.test.ts`** must remain byte-identical. This is the primary gate.
- **New:** `test/generator/walker-target-contract.test.ts` (~30 LOC, type-only). Asserts both `tsxTarget` and `heexTarget` exported and conform to the `WalkerTarget` interface. Catches future drift if a method is removed from one impl.

### Acceptance

1. `npm test` green — especially all `walker-*.test.ts`.
2. `LOOM_REACT_BUILD=1` matrix green for `examples/showcase.ddd` × every TSX pack.
3. `LOOM_PHOENIX_BUILD=1` (`mix compile --warnings-as-errors`) green.
4. Baseline fixture diff: capture before and after, expect empty.
   ```bash
   # before
   node bin/cli.js generate system examples/showcase.ddd -o /tmp/before
   # land Item 1
   node bin/cli.js generate system examples/showcase.ddd -o /tmp/after
   diff -r /tmp/before /tmp/after          # must be empty
   ```

### Suggested sub-step order within Item 1

1. Document scope in `target.ts` header (no code change yet).
2. Implement `heexTarget` first. Phoenix walker is more intricate, but the seams are more obviously framework-shaped — extracting first validates the contract against the harder case. Refactor `heex-walker.ts` to delegate. Verify `LOOM_PHOENIX_BUILD=1` green.
3. Implement `tsxTarget`. Refactor `body-walker.ts` to delegate. Verify all walker tests + `LOOM_REACT_BUILD=1` matrix green.
4. Add the contract-conformance test.

### Risks

- **`position: RenderPosition` asymmetry.** Currently only `renderStateRead` carries `position`. HEEx also needs position-awareness for `this`/`id`/`current_user`/`renderToast` — but those stay framework-private per the scope decision, so the asymmetry doesn't leak into the interface. `position` stays on HEEx's `WalkContext` as walker-internal state.
- **The interface is currently dead code.** Now is the cheapest time to refine its shape; once two consumers exist, changes ripple. Treat the header comment in Step 1 as part of the API surface.

---

## Verification (end-to-end, after all four items land)

Run in order:

```bash
# 1. Fast unit + IR + generator tests
npm test

# 2. Per-{example × pack} React tsc gate
LOOM_REACT_BUILD=1 npm run test:react-build

# 3. .NET compile gate
LOOM_DOTNET_BUILD=1 npm run test:dotnet

# 4. Phoenix mix compile gate
LOOM_PHOENIX_BUILD=1 npm run test:phoenix

# 5. Full behavioral conformance (boots docker stack, runs new multi-backend
#    suite). This is the load-bearing check for Item 2 — and the most
#    likely place latent backend behavioral drift surfaces.
LOOM_E2E=1 npm run test:e2e

# 6. OpenAPI parity (existing, should remain green)
LOOM_E2E=1 LOOM_E2E_PARITY_ONLY=1 LOOM_E2E_STRICT_PARITY=1 npx vitest run test/e2e/e2e.test.ts

# 7. Byte-identical fixture diff for Item 1 (must be empty unless Item 2's
#    fixture recapture is in the same branch)
node bin/cli.js generate system examples/showcase.ddd -o /tmp/phaseA-final
diff -r test/fixtures/baseline-output /tmp/phaseA-final
```

**Expected discovery:** step 5 will likely surface behavioral disagreements between Hono/.NET/Phoenix that have shipped under OpenAPI-only parity. These are the calibration data for what new platforms cost; treat them as separate follow-up PRs. The Phase A landing criterion is the harness running and reporting cleanly — not that every backend agrees on every test (that's the *next* effort, and a useful calibration number to put on the platform-expansion roadmap).

## Out of scope for Phase A (deferred to later phases)

- **ashPhoenix primitive backfill** (Form/List/Detail archetypes; bring HEEx pack closer to TSX parity) — separate work item, blocks fullstack Phoenix from being the conformance reference.
- **Shared-contracts emission for typed-pair systems** — relevant when adding Blazor; not blocking Phase A.
- **Behavioral parity cleanup** — the bugs Item 2's harness surfaces. Each becomes its own PR.
- **Project-shell abstraction** — deferred; not needed for any of the Phase A items.
