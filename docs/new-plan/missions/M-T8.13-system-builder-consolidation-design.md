# M-T8.13 — System-builder v1/v2 consolidation (design)

> **Status: design-in-progress (brief).** The endgame decision flagged as
> wave-3 "structural" work in
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
| 1 | **Shared pane harness** — `web/src/builder/pane-harness.ts`: `useModelSource(ctx)` returning `{ parsed, parseOk, rev, apply, applyOrRefuse, refusal }`, composing the existing `use-live-source-tick` + `refusal` + `edit-engine.ifParses` into the one `rev`/parse-memo/choke-point shape all four panes hand-roll today. | **M** | unconditional |
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
