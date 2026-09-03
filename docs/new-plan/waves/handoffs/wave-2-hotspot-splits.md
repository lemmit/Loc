# Wave 2 hand-off — 2.6 hotspot-splits

*Branch: `claude/wave-2-hotspot-splits`. Originally built on top of
`claude/wave-2` (packet fold order required 2.6 to land last, after
2.1–2.5/2.7 folded there). Mid-session the coordinator moved this packet
**off** the wave PR: the other six packets (#2770) went green and merge on
their own, so this split lands as its **own PR**, rebased onto fresh
`origin/main` (single commit, cherry-picked off the original
`claude/wave-2`-based commit `2eaa7d8e3`).*

## Deliverable

A purely mechanical split of three hotspot files — code moved, not
rewritten: no renames of exported symbols, no signature changes, no logic
edits, no reordering of checks that could change diagnostic ORDER (order is
governed entirely by call sites in `validate.ts` / `mikroorm.ts`'s callers,
none of which changed).

### Before → after file map

**`src/ir/validate/checks/system-checks.ts`** (4313 lines) → a thin
re-export barrel + 13 per-theme leaves:

| leaf | lines | contents |
|---|---|---|
| `projection-backend-checks.ts` | 440 | query-time / grouped / columnless / document-agg / paged / workflow-source / projection-source projection backend gates |
| `ui-framework-checks.ts` | 533 | data grid, HEEx host state, chart, projection-read framework, current-user-needs-auth-ui, realtime, flutter primitive, auth-ui-framework |
| `default-deny-checks.ts` | 270 | default-deny enforcement (auth.md §4.3) |
| `react-id-reference-checks.ts` | 170 | `X id` React deployable validation |
| `system-compose-channel-checks.ts` | 276 | system reachability, compose port/slug uniqueness, channel wiring |
| `datasource-checks.ts` | 615 | dataSource coverage, file-field object storage, saving-shape support, vanilla-document op-body gate, unwired-knobs honest-note pass |
| `backend-syntax-checks.ts` | 241 | elixir op self-call position, java reserved identifiers |
| `principal-guard-checks.ts` | 224 | principal-stamp / `requires`-guard-without-auth rejections |
| `context-filter-checks.ts` | 306 | capability query-filter support, `ignoring` filter-bypass gates |
| `orm-adapter-checks.ts` | 379 | Dapper / MikroORM / find-predicate adapter support |
| `resource-capability-checks.ts` | 342 | derived-need capability check, remote-call support, api resource bindings, `config` map validation |
| `storage-inheritance-checks.ts` | 620 | inheritance storage (TPC/TPH), event-sourced storage, provenanced storage, `mask unless` + laundering, audited-operation support |
| `auth-permission-checks.ts` | 82 | system-wide auth shape + `currentUser` scope, `permissions {}` registration |

**`src/ir/validate/checks/ui-checks.ts`** (2985 lines) → `validateUiBodies`
(the orchestrator — 272 lines of real dispatch logic, analogous to
`validate.ts`'s `validateLoomModel`) stays in place, plus a small shared hub
and 5 per-theme leaves:

| leaf | lines | contents |
|---|---|---|
| `ui-checks-shared.ts` | 43 | `VIEW_EFFECT_BUILTINS`, `walkerRenderedExprs`, `namedArg` — the 3 helpers used across ≥2 themes |
| `ui-page-structure-checks.ts` | 661 | page-routing / page-reference / scaffold-filter-param checks |
| `ui-collection-display-checks.ts` | 767 | frontend collection-op, table-filter, controlled-modal-op-form, data-grid, chart checks |
| `ui-action-body-checks.ts` | 869 | page action-body / statement checks, toast messages |
| `ui-component-deferral-checks.ts` | 301 | Feliz/Angular lazy-component-deferral support |
| `ui-page-identity-checks.ts` | 100 | page/slot identity checks |

**`src/generator/typescript/emit/mikroorm.ts`** (3487 lines) → a thin
re-export barrel + split by persistence shape, plus the layers every shape
draws on:

| leaf | lines | contents |
|---|---|---|
| `mikroorm-shared.ts` | 72 | `usesRawFragment`, `maskUserImport`, `tsParamType` — used by all 4 shapes |
| `mikroorm-entities.ts` | 848 | `@Entity` row-class emission (column derivation, part/join/record rows, system tables) — the schema layer every shape rides |
| `mikroorm-config.ts` | 133 | CLI config, outbox-drain/save-tx line builders, connection setup + deps |
| `mikroorm-filter.ts` | 619 | `ExprIR` → `FilterQuery` where-clause rendering, context filters, `ignoring` bypass, get-by-id predicates |
| `mikroorm-relational.ts` | 1003 | relational-shape repository (default shape): join/value-collection loads, containment hydration + cascade delete, TPC/TPH base readers |
| `mikroorm-embedded.ts` | 359 | embedded-shape repository |
| `mikroorm-document.ts` | 309 | document-shape repository |
| `mikroorm-event-sourced.ts` | 270 | event-sourced-shape repository |

Every previously-exported name is still exported from the same original
module path (`system-checks.js` / `ui-checks.js` / `mikroorm.js`) — either
defined there directly (`validateUiBodies` + 2 small orchestrator-only
consts) or re-exported from its new leaf. No downstream import site
(`validate.ts`, tests, `src/platform/hono/**`) needed an edit.

**Non-mechanical touch-ups, named per the brief's "anything you had to
change beyond a pure move" instruction:**

- A handful of private, non-exported helpers were physically relocated
  alongside their sole caller (e.g. `coverageGapReason` next to
  `validateDataSourceCoverage`; `UnwiredKnob`/`UNWIRED_KNOBS` next to
  `validateDataSourceUnwiredKnobs`) — they were originally hundreds of lines
  away from their only consumer. Pure position change, same file-local
  visibility, no signature/logic change.
- Two orphaned section-header comments (each sitting well above the
  function they actually document, apparently displaced by earlier
  accretion) were moved with their subject: the `X id` validation header
  (originally above `AUTH_UI_FRAMEWORKS`, ~1200 lines from
  `validateReactIdReferences`) and the capability-filter header (originally
  above `PRINCIPAL_NOUN`, ~350 lines from `validateContextFilterSupport`).
  Comment-only, no code change.
- A few previously-unexported private helpers gained the `export` keyword
  at their new leaf location because a sibling leaf now needs to import
  them (e.g. `partRowClassOf`, `joinRowClassOf`, `rowClassOf`,
  `eventRowClassOf` in `mikroorm-entities.ts`; `AMBIENT_PRINCIPAL`,
  `whereToMikroFilter`, `mikroContextFilters` etc. in `mikroorm-filter.ts`).
  Visibility widening only — same value, same call sites, still
  module-private in spirit (not re-exported from the public barrel unless
  they were exported before).

**Grouping method**: for each file, every top-level declaration's
cross-reference graph was extracted with the TypeScript compiler API
(non-exported symbols force co-location unless the visibility is widened as
above), then bucketed by theme. `ui-checks.ts`'s ~70 private `checkXxx`
helpers were almost entirely reachable from one hub (`walkerRenderedExprs`,
`BodyCheckCtx`, `namedArg`, …) via `validateUiBodies`'s own dispatch, so
that hub became `ui-checks-shared.ts` and each `checkXxx` cluster its own
leaf, mirroring the `shared.ts` convention `checks/` already uses.

## Hard gate 1 — diagnostic set byte-identical

`node bin/cli.js parse` over every `.ddd` under `test/fixtures/**` (60,
including `test/fixtures/corpus/**`, 58 of those 60), `test/e2e/fixtures/**`
(202), `examples/` (23) and `web/src/examples/` (63) — **348 files total** —
on a fresh `origin/main` worktree (`/tmp/base-main`) and on this branch's
tip, output normalized only for the absolute repo-root path (a fresh
worktree lives at a different filesystem path):

```
diff <(sed 's#/tmp/base-main/##g' base/all-diagnostics.txt) \
     <(sed 's#<this-worktree>/##g' head/all-diagnostics.txt)
```

**0 lines of diff.** Every diagnostic — code, severity, message text,
location, and firing ORDER — is byte-identical across all 348 fixtures,
including the negative/invalid ones.

`test/system/diagnostic-firing-census.test.ts` (M-T9.33): **104/104 pass**
on this branch's tip — every `loom.*` diagnostic still fires at exactly the
fixture lines the census pins.

## Hard gate 2 — emitted output byte-identical

`node bin/cli.js generate system <f> -o <scratch>/<base|head>/<name>` for
every `test/fixtures/corpus/*.ddd` (58), `examples/*.ddd` (23), and
`web/src/examples/*.ddd` (47) fixture — **128 total** — on both trees.

Not every fixture generates on this base (some fail for pre-existing
reasons unrelated to this packet): **55 of 128 generate successfully on
BOTH trees, and it is the same 55** (`only base ok: []`, `only head ok:
[]` — confirmed by comparing the per-fixture exit-code sets before
diffing).

`diff -rq base/gen head/gen` over those 55 fixtures' full multi-deployable
output trees: **35 files reported as differing, 0 "Only in" lines** (no
file added, removed, or renamed by the split). Every one of the 35 is
explained by exactly the two known non-determinisms the packet brief names:

1. **31 files** — .NET `#line (...) "<path>"` pragmas in generated
   `Domain/**/*.cs` files embed the absolute path of the source `.ddd` file;
   the fresh-clone base worktree lives at a different filesystem path than
   this worktree.
2. **4 files** — `docker-compose.yml`'s `SECRET_KEY_BASE` is a fresh random
   hex string on every `generate system` run, by design, unrelated to any
   code change.

A normalization pass (strip each tree's own absolute root path; mask the
`SECRET_KEY_BASE` hex value) reduces all 35 differing files to **0 real
mismatches** (verified programmatically, file by file, not by eyeballing).

## Hard gate 3 — build + lint + focused suites

- `npx tsc -b` — clean, no errors, on the rebased tree.
- `npm run lint` (`biome ci .`, the exact CI step) — exit 0; the 12 warnings
  it reports are all in files this packet never touched (pre-existing on
  `origin/main`: `generator/dotnet/dto-mapping.ts`,
  `generator/elixir/auth-emit.ts`, `generator/flutter/index.ts`,
  `generator/java/emit/dto.ts`, `generator/python/routes-builder.ts`,
  `ir/types/loom-ir.ts`, `language/model-patch.ts`,
  `macros/stdlib/auto-paged-table.ts`, and four `test/generator/**` files).
- `test/ir`, `test/system`, `test/generator/typescript`, `test/platform` —
  green on the rebased tree.

## Hard gate 4 — mutation proof

`test/system/ir-walk-census.test.ts` — the census this packet's HOTSPOT_
SPLIT_REASON waivers referred to — **does not exist on `origin/main` yet**
(it's packet 2.3's file, still in flight on #2770, the sibling PR carrying
the rest of Wave 2). Cherry-picking this packet's single commit onto fresh
`main` therefore hit a modify/delete conflict on that file; resolved by
DROPPING the census-file edit from this commit entirely (there is nothing
in this base for it to update) — see "Reconciliation left for whichever PR
merges second" below.

Since the census gate this packet was originally going to lean on for its
mutation proof isn't available on this base, the mutation proof instead
targets a check with a direct, dedicated unit test —
`validateComposeUniqueness`, moved into `system-compose-channel-checks.ts`:

1. Saved the leaf file aside (`cp`, not `git stash`).
2. Neutered the moved function's body (`return;` as its first statement).
3. Ran `test/ir/compose-uniqueness.test.ts` — **2 of 5 tests failed**:
   ```
   FAIL  test/ir/compose-uniqueness.test.ts > compose uniqueness — host ports (B24) > rejects two deployables sharing a default host port
   AssertionError: expected [] to include 'loom.duplicate-host-port'
   FAIL  test/ir/compose-uniqueness.test.ts > compose uniqueness — service slugs (B24) > rejects case-variant deployable names that slug-collide
   AssertionError: expected [] to include 'loom.duplicate-service-slug'
   ```
4. Restored the leaf file from the saved copy (file copy, never
   `git checkout --`) — `diff` against the saved copy confirmed a clean,
   byte-identical restore.
5. Re-ran the test — **5/5 pass** again.

This confirms the moved function is genuinely wired into the pipeline at
its new location (imported by the barrel, called from `validate.ts`), not
silently dropped by the split.

## Reconciliation left for whichever PR merges second

`test/system/ir-walk-census.test.ts` (packet 2.3, on #2770) carries a
`HOTSPOT_SPLIT_REASON` waiver list keyed to the **pre-split** file/function
pairs this packet's original commit (built on `claude/wave-2`) already
updated to their **post-split** leaf locations:

```
system-checks.ts#docExprUnsupported       -> datasource-checks.ts#docExprUnsupported
system-checks.ts#docFunctionUnsupported   -> datasource-checks.ts#docFunctionUnsupported
system-checks.ts#docStmtUnsupported       -> datasource-checks.ts#docStmtUnsupported
system-checks.ts#eachStmtExpr             -> backend-syntax-checks.ts#eachStmtExpr
ui-checks.ts#checkBody                    -> ui-action-body-checks.ts#checkBody
ui-checks.ts#directlyRenderedRefs         -> ui-page-structure-checks.ts#directlyRenderedRefs
ui-checks.ts#namesReadByBody              -> ui-page-structure-checks.ts#namesReadByBody
ui-checks.ts#toastMessageProblem          -> ui-action-body-checks.ts#toastMessageProblem
ui-checks.ts#visitExpr                    -> ui-action-body-checks.ts#visitExpr
ui-checks.ts#visitStmt                    -> ui-action-body-checks.ts#visitStmt
mikroorm.ts#filterValue                   -> mikroorm-filter.ts#filterValue
```

That update (verified passing, including a mutation-proof of the
"waivers ratchet" assertion — reverting one entry to its old
`system-checks.ts` location fails the census with `no such site found any
more (delete the waiver)`) is preserved on the `claude/wave-2-hotspot-splits-
old-base` ref (the pre-rebase tip, `2eaa7d8e3`) for whoever merges second to
pull the eleven-line diff from. **Whichever of this PR and #2770 merges
second must apply that waiver-key update** — otherwise the census either
references dead file paths (if this PR merges first, #2770 brings the stale
`system-checks.ts#docExprUnsupported`-shaped keys back and the "waivers
ratchet" check fails on merge) or the eleven sites are simply unwaived (if
#2770 merges first and this PR's split then moves them without updating the
keys — the "every offending site is exhaustive or waived" check would fail
instead). Either failure mode is exactly the ratchet working as designed;
it just needs one five-minute manual step from the second mover.

## Local gate results (summary)

| gate | result |
|---|---|
| diagnostic byte-identical (348 fixtures, incl. negative) | **0 diff** |
| M-T9.33 firing census | **104/104 pass** |
| emission byte-identical (55/128 fixtures generate on both trees, same 55) | **35 files differ, 0 real mismatches after normalization** |
| `npx tsc -b` | clean |
| `npm run lint` | exit 0 (12 pre-existing warnings, none in touched files) |
| `test/ir` `test/system` `test/generator/typescript` `test/platform` | green |
| mutation proof (`validateComposeUniqueness`, file-copy revert) | fails as expected when neutered, passes when restored |
