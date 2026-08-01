# M-T8.13 — System-builder v1/v2 consolidation (design)

> **Status: DONE — all phases landed.** The owner-gated decision below went to
> **alternative 4**: v2 is the single editing pane, v1's flat canvas survives
> inside it as a read-only **Overview** mode. Phase 1 (shared harness) landed
> first; phases 2–4 (feature ports → Overview mode → default flip → delete)
> landed together — see "Phases 2–4 — as landed" at the end of this doc.
> Originally flagged as wave-3 "structural" work in
> `docs/audits/playground-file-mgmt-review-2026-07.md` §2 and left explicitly
> out of scope by PR #2287.
> Sources: that review (defect #6), `docs/audits/playground-modeller-audit-2026-07.md`
> (capability inventory), `web/src/builder/system/`, `web/src/builder/system-v2/`,
> PRs #2290 / #2295 / #2299 (the three modeller investment waves since).

## Problem

Two system-builder panes ship side by side and both are mounted in
`DesktopShell` **and** `MobileShell`: **v1** (`builder/system/`, "Model" tab —
one flat React Flow canvas of the whole model + a side inspector) and **v2**
(`builder/system-v2/`, "Model v2" tab — a drill-down navigator where the canvas
*is* the breadcrumb). Neither is the default centre view (`source` is); v1 sits
first in the segmented control, so it reads as primary.

The coupling is asymmetric. v2 imports **12 modules from v1** — `body.ts`,
`fields.ts`, `expr-slots.ts`, `expr-model.ts`, `op-surface.ts`, `rename.ts`,
`deployable-bindings.ts`, `emit-event.ts`, `linked-doc.ts`, `add.ts`, plus the
`BodyEditor`/`ExpressionEditor` components — so `builder/system/` is already the
*de facto* shared edit library (5 944 of its 8 335 lines have a v2 or page-builder
consumer; only **2 391 lines are v1-pane-only**). What is genuinely duplicated is
the *graph* layer: v1's `buildSystemGraph` switch (11 `$type` arms) +
`NODE_KIND_TO_REF` vs v2's per-level collectors + `AST_TYPE_BY_VIEW` (45 kinds);
`renameConstruct` vs `renameByAstType` (near-verbatim); `positions.ts` vs
`persisted-positions.ts`; and — the drift casualty — the **safety rails**, which
#2287 had to fix *twice* because v2 shipped without v1's parse gate.

Meanwhile the rot is one-directional: v1's `infra-props.ts` still offers
`PLATFORMS = ["node","dotnet","react","static","elixir"]` — **5 of the 12**
platforms in `src/platform/registry.ts`.

## The feature matrix (verified against code, 2026-07-30)

| Capability | v1 | v2 | Note |
|---|:--:|:--:|---|
| Construct kinds rendered | 11 | **45** | v2 covers projection/channel/payload/criterion/policy/resource/timer/migration/permissions/create/destroy/apply… |
| Construct add templates | 11 | **27** | v2 adds field/operation/stmt/permissions + `add-extra.ts`'s 12 kinds (#2295) |
| Whole-system flat overview | **yes** | no | v2 shows one level at a time |
| Drill-down + breadcrumb | no | **yes** | incl. entity/containment, invariants, derived |
| Statement editing | rows | **flow graph** | v2 = `StmtNode` with add / reorder / delete |
| Lifecycle bodies (`create`/`destroy`/`apply`) + member picker | no | **yes** | #2299 |
| Operation surface (params, return, `private`/`extern`/`audited`, `requires`, `when`) | no | **yes** | `op-surface.ts` (#2295) has **only** a v2 consumer |
| Find `requires` / `ignoring` gates | no | **yes** | |
| Find params + return type editing | **yes** | no | `find-params.ts` is pure + tested |
| Field add / rename / delete | yes | yes | |
| Field **retype** + modifiers (default / check / message / `mask unless` / sensitive / access) | **yes** | no | mutators all exist in `fields.ts` |
| Infra props (storage `type:`, deployable `platform:`/`port:`) | **yes** (stale list) | no | |
| Traceability **coverage overlay** | **yes** | no | lower+enrich off the render path |
| **Wire-shape** (DTO field list) inspector | **yes** | no | `wireShapeOf` |
| Search + kind filter | **yes** | no | single-canvas dimming |
| Grouped module/context nesting | **yes** | n/a | superseded by drill-down |
| Staged **preview diff** before apply | **yes** | no | lives entirely in `apply` |
| Expression editor (structured ƒx) | yes | yes | shared component |
| Parse gate / refusal line / live+external ticks | yes | yes | **parallel copies** |
| E2E tests | **36** | 12 + 2 mobile | v1 spec is the browser-level coverage of the *shared* helpers |
| Unit tests (`test/playground/system-builder/`) | 2 pane-bound | 10 | the other 8 suites test shared helpers |

**Investment direction is unambiguous.** Across #2290 → #2295 → #2299 every *new*
construct kind, every *new* editing surface (`op-surface.ts`, `add-extra.ts`) and
both new views (lifecycle flow, workflow member picker) landed in v2 or in shared
helpers v2 alone consumes. v1 gained only what it shares.

## Alternatives

1. **Status quo — two full editing panes.** Rejected. It has already produced one
   shipped P1 (missing parse gate) and taxes every modeller wave twice.
2. **Consolidate onto v1.** Rejected: v1 would need the whole 45-kind renderer,
   the drill-down, and the wave-4/5 editing surfaces rebuilt — i.e. rewrite v2
   inside v1 to reach parity.
3. **Keep both forever as different views.** The honest case: a flat whole-system
   canvas serves a task drill-down cannot (see everything at once, heat-map
   coverage, search). But that argues for a *view mode*, not a second **editing**
   pane with its own write-back paths, positions store, rename impl and rails.
4. **Consolidate onto v2, folding v1's genuinely-different-task features in as a
   root-level "Overview" mode.** ← recommended.

## Recommended direction

**v2 survives as the single editing pane; v1's flat canvas returns as a
read-only Overview mode at the root of the drill-down** (coverage heatmap +
search + wire-shape, no write-back). Rationale: v2 has the feature ceiling
(45 vs 11 kinds), all recent investment, the mobile story (2 passing mobile
specs), and retiring v1 costs only **~2 391 lines** because the helper library
survives under a neutral home. The Overview mode keeps the one thing the flat
graph is actually better at without keeping a second mutation surface.

> **Owner-gated decision point (blocking phase 2+):** *does v1's flat canvas
> survive as a read-only Overview mode inside v2, or is it deleted outright?*
> Everything after phase 1 branches on that answer; phase 1 is unconditional.

## Slices

| # | Slice | Size | Gate |
|---|---|:--:|---|
| 1 | ✅ **Shared pane harness** — `web/src/builder/pane-harness.ts`: `usePaneHarness(ctx)` returning `{ parsed, parseOk, rev, bumpRev, liveTick, externalTick, refusal, apply, applyOrRefuse, applyOrSkip, commit }`, composing the existing `use-live-source-tick` + `refusal` + `edit-engine.ifParses` into the one `rev`/parse-memo/choke-point shape all four panes hand-rolled. | **M** | unconditional |
| 2 | Port **wire shape** + **infra props** (fixing the 5-of-12 `PLATFORMS` list) + **find params/return** to v2's node-detail panel — all three ride pure, already-tested modules. | S ×3 | decision |
| 3 | Port **field retype + modifiers** (`fields.ts` mutators exist; this is v2 node-detail UI). | **M** | decision |
| 4 | Port **coverage overlay** + **search** to a v2 **Overview** mode (search must cross levels → a jump-to-path result list, not dimming). | **M–L** | decision |
| 5 | **Preview/staged-diff** as a harness option (post-slice-1 it is a flag on `apply`, inherited by every pane). | **S** | decision |
| 6 | **Flip + deprecate** — v2 takes the `doc-tab-model` label/testid, v1 moves behind a dev toggle, e2e migrated (below). | **M** | decision |
| 7 | **Delete** — remove the 7 v1-pane-only modules; move the 13 shared modules to `web/src/builder/model-edit/` and update imports (mechanical; `system-v2/` renames to `system/`). | **S–M** | decision |

**Acceptance criteria.** Slice 1: no pane declares its own `rev` state, parse
`useMemo`, or `apply`/`applyOrRefuse`; a unit test proves the harness refuses a
non-parsing write *and* returns `parseOk: false` on a recovered AST; a
completeness-style pin (the `walker-stdlib-completeness.test.ts` pattern) fails
CI if a `builder/**Pane.tsx` calls `parseDdd` without the harness — that is what
makes the #2287 drift class *unrepeatable*. Slices 2–5: each ported feature keeps
its v1 e2e assertion, re-pointed at v2 testids. Slice 6: the label flip lands with
the spec rename in one PR. Slice 7: `rg 'builder/system/'` returns no hits outside
the new home.

## Phase 1 — as landed

Two modules, mirroring the `live-source-tick.ts` / `use-live-source-tick.ts`
split (the root vitest suite has no `web/node_modules`, so the react-free half
has to be importable on its own):

- **`web/src/builder/pane-write.ts`** — the pure decisions. `isParseOk(parsed)`
  is the READ gate (false on a recovered AST); `writeDecision(next, gate,
  nullMeans)` is the WRITE gate, folding `edit-engine.ifParses` and the
  "helper returned null" case into `"commit" | "refuse" | "skip"`.
- **`web/src/builder/pane-harness.ts`** — `usePaneHarness(ctx, options?)`, the
  react composition: the `[getSource, rev, liveTick, externalTick]` parse memo,
  `parseOk`, `useRefusal`, and the `apply` / `applyOrRefuse` / `applyOrSkip` /
  `commit` choke-point. `ctx` is the narrow structural `PaneSourceCtx`
  (`getSource`, `onSourceChange`, `editorSourceTick`, `initialSource`,
  `activeSourcePath`, `sourceEpoch`) rather than the whole `LayoutCtx`.

The two genuine pane divergences became **options**, not parallel copies:

| Pane | Divergence | How the harness carries it |
|---|---|---|
| `BuilderPane` | must not re-derive on an external reseed (a new `liveNodes` reference echoes into a craft `deserialize` that clobbers in-flight settings-panel edits) | `externalReseed: false` — the tick hook still runs, fed frozen inputs, so it never bumps |
| v1 `SystemBuilderPane` | preview mode stages an edit's diff instead of committing; the staged write carries a `keepSelection` flag | `onCommit(next, commitNow, ...args)` override + `usePaneHarness<[keepSelection?: boolean]>` |

`RequirementsPane`'s `apply(node, text)` / `append(text)` and v1/v2's per-handler
wrappers survive as 1–3-line pane-local shims over the harness — they carry
pane semantics (which node to splice, whether to clear the selection), not
rails. v1's coverage-overlay and wire-shape effects stay in the pane; only the
rails moved.

The pin lives in `test/playground/builder-pane-harness.test.ts`: it *discovers*
`web/src/builder/**/*Pane.tsx` (so a new pane is covered the day it lands),
asserts each takes `usePaneHarness`, and fails on any of the hand-rolled rails
reappearing (`useLiveSourceTick(`, `useExternalSourceTick(`, `useRefusal(`,
`parseDdd(getSource())`, `parseDdd(ctx.getSource())`, `parsed.parserErrors`).

One latent bug fell out: v1 called `useRefusal()` *after* its
`parserErrors` early return, so the render that first saw a syntax error
dropped a hook — React's "rendered fewer hooks than expected". Hoisting the
rails to the top of the component removes it.

## Test / e2e migration strategy

- **The 36-test v1 spec is not v1 coverage** — roughly two-thirds of it drives the
  *shared* helpers (expression editor, statement editing, rename, field edit,
  emit repoint, deployable bindings) through v1's chrome, and is their only
  browser-level gate. Those tests must be **re-pointed at v2 testids, never
  deleted**; only the ~6 pane-unique ones (search/kind-filter, coverage overlay,
  preview diff, wire shape, grouped nesting, infra props) follow their feature in
  slices 2–5, or get deleted with an explicit note if the owner drops it.
- **Unit tier is nearly free:** of the 18 suites in `test/playground/system-builder/`,
  only `model-context.test.ts` (v1 `model.ts`) and `infra-props-lossless.test.ts`
  are v1-pane-bound; 10 already import v2 and 8 test shared helpers — slice 7
  touches their import paths only.
- **CI has a tripwire:** `playground-e2e-no-network.yml` lists spec files
  explicitly and fails the job if a listed spec goes missing, so every spec
  rename/delete in slices 6–7 must update that list in the same PR.
- Add `system-builder-v2.spec.ts` cases *before* retiring the v1 equivalents, so
  no window exists where a shared helper has zero browser coverage.

## Phases 2–4 — as landed

The owner picked **alternative 4**. The end state is one pane: `Model` mounts
`system-v2/SystemBuilderV2Pane`, on desktop **and** mobile; there is no
`Model v2` tab and no second mutation surface.

**Slice re-cut.** The brief's slices 2–7 collapsed into one commit because they
are not independently shippable once the flip is in it: deleting v1 without the
ports loses features, and porting without deleting leaves the duplication the
mission exists to remove. Order inside the commit was still the brief's:
port → Overview → flip → delete → e2e → docs.

### Overview mode (`system-v2/OverviewCanvas.tsx`)

Reached from the breadcrumb's **Overview** button, offered only at the drill
root (Overview *is* the root, seen flat). The pane shell owns the drill `path`
and the mode, so the round-trip is lossless; each mode gets its own keyed
`ReactFlowProvider` (two React Flow instances must never share a store, and
only one is mounted at a time).

| Ported | How |
|---|---|
| Flat whole-model graph | `buildSystemGraph` + the same column-per-kind layout, diagnostics attributed by `nodeDiagnostics` (border + count) |
| Coverage heatmap | `Coverage` toggle → async linked build → `lowerModel` + `enrichLoomModel` → `coverageByNode`, tinting every node; legend + a per-selection `coverage:` line |
| Search + kind filter | `matchNodes` → non-matching nodes/edges dim in place; match count + `Focus` (fitView over the matched set) |
| Group nesting | `groupedLayout` → module / context container nodes, edges remapped to the group |
| Persisted layout | `positions.ts` (`loadPositions`/`savePositions`), drag-end persisted, `Reset layout` restores the derived arrangement |
| Wire shape | selecting an aggregate / value object runs the same async lower+enrich and lists `wireShapeOf` in the detail panel |

**Read-only by construction**: no add palette, no rename/delete/`ƒx`, no
write-back path — `usePaneHarness` is taken for the READ gate (`parseOk`) and
the shared refusal line only.

**Deviation from the brief.** The brief said "clicking a node drills into it".
A single click also has to serve the wire-shape inspector, which needs a
selection, so: **click selects** (detail panel opens), **`Open ↳` or a
double-click drills**. The drill target is not a bare one-step path — the
construct's `System` / `Subdomain` / `BoundedContext` ancestors are read off
the AST container chain, so the navigator lands with the breadcrumb it would
have had if you had drilled there by hand. Kinds `buildViewGraph` has no view
for (value object, event, api, storage, ui, deployable) open their CONTAINER
instead of an empty leaf, so the node is shown in situ with its affordances.

### Feature ports (so the delete costs nothing)

| v1-only surface | Where it landed |
|---|---|
| Infra props | Storage node's `type:` select, deployable node's `platform:` select + `port:` input. `PLATFORMS` corrected from 5 barewords to the 12 the grammar's `Platform` rule accepts |
| Field retype + modifiers | Field node's collapsed `ƒ` block: `type`, `= default`, `check`, `check message`, `mask unless`, `sensitive`, plus the `access` select (with the keyword-less `editable` default as its own option) |
| Find params + return | Find node: `returns`, one `name: Type` row per parameter with `×`, and a `+ param` action |
| Repository / api rebind | `⇄`-collapsed select on the node (`for` / `from`) — collapsed because a repository is drillable and an always-open select would sit under the drill click |
| Preview / staged diff | **Dropped.** It was v1-pane-only chrome over `lineDiff`; every v2 write is already parse-gated and refusal-visible, and the brief itself listed it as owner-droppable |
| Edge drag-rebind (`edge-rebind.ts`) | **Dropped** with its unit suite — v2 has `deployable-edge-rebind.ts` for the deployable edges, and the repository/api reference it also covered is now a select |

`ConstructNode` gained exactly three affordances to carry these: single-value
`selects`, node `actions` (buttons), and a `detailsLabel` that collapses the
whole detail block behind a per-node toggle. `retypeField` / `retypeFindParam`
/ `setFindReturnType` were widened from `TypeSpec` to the shared
`TypeInput = TypeSpec | string` that `op-surface.ts` already used (moved to
`fields.ts`, re-exported), so a node's text input and the old pickers splice
identically.

### What was deleted

`web/src/builder/system/SystemBuilderPane.tsx` (1 511 lines),
`web/src/builder/system/edge-rebind.ts` (58) and
`test/system/system-edge-rebind.test.ts` (82). Nothing else: every other module
under `builder/system/` has a v2 or page-builder importer and stays exactly
where it is — the brief's slice-7 move to `builder/model-edit/` was **not**
done (a pure rename with no consumer benefit, and it would have churned every
import in the same commit as the behaviour change).

### E2e migration

| v1 spec case(s) | Disposition |
|---|---|
| search + kind filter, coverage overlay, group nesting, wire shape, dragged-position persistence + reset | **ported** → `system-builder-overview.spec.ts` (plus a new case: opening a construct jumps the drill-down to it) |
| infra props, find params, repository rebind, field retype + modifiers | **ported** → `system-builder-v2.spec.ts` (4 new cases against the node-level surfaces) |
| add/delete construct, rename construct, add/rename/delete field, palette kinds, workflow + operation body statements, emit repoint, deployable bindings, every expression-editor case (~26) | **dropped as duplicates** — `system-builder-v2.spec.ts` already drives the same shared helpers through v2's chrome |
| staged preview diff | **dropped with the feature** |
| `mobile-model-builder.spec.ts` (v1 drawer FAB) | **repurposed** — the mobile Overview toolbar |
| `mobile-builder.spec.ts` "mobile Model" | **migrated** to the v2 palette |

`playground-e2e-no-network.yml`'s `SPECS` list swaps `system-builder.spec.ts`
for `system-builder-overview.spec.ts`; the existence guard passes.
