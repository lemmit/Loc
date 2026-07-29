# Playground file/data management & modeller — review (2026-07)

Snapshot-in-time audit of the playground's weakest area, triggered by three
user reports: **(1)** history rollback appeared to change nothing, **(2)**
adding files didn't work, **(3)** intermittent full-app crashes "around the
modeller". Three perspectives: functionality (business), architecture
(tech), QA. Verified against `main` @ `4a89061`; all 54 unit tests of the
git layer pass — every reported bug lives *above* the tested layer.

## Executive summary

All three reports are confirmed, explainable, and share one systemic root:
**the store layer is solid and unit-tested, but the store→UI direction of
the sync is unbuilt, and every failure on the mutation surface is silent
(console-only).** The user experiences a correct git layer as a broken
product because nothing that happens *in* the store is ever pushed back
*to* the screen, and nothing that fails ever says so.

| Report | Verdict | Root cause |
|---|---|---|
| Rollback shows no changes | **Real bug, worse than reported** | Restore rewrites the git working tree correctly, but the Monaco editor only reads content at mount and nothing remounts/resyncs it (`HistoryPanel.tsx:109-124`; remount key `EditorPane.tsx:73` is restore-insensitive). The next keystroke then writes the **stale buffer back**, silently undoing the restore. |
| Adding files didn't work | **Multiple silent-failure paths** | Fire-and-forget write with console-only error handling; no regenerate scheduled after create (unlike rename/delete); new file has no observable effect unless imported from `main.ddd`; multi-tab LightningFS clobber; ghost LSP models after delete/re-add can suppress auto-generate. |
| Modeller crashes | **Confirmed crash path** | `BuilderPane` dereferences partially-recovered AST in `useMemo`s *before* its syntax-error guard (`BuilderPane.tsx:184-226` vs guard at `:252`); the pane stays mounted in the background and re-parses 350 ms after every keystroke, so typing a transiently-broken `body:`/`state {}` block in the Source tab throws in render — and the only ErrorBoundary is at the app root, so the whole playground white-screens. |

None of this is visible to CI: file-add has zero e2e coverage, the history
e2e asserts only that a "restore to" commit row *appears* (never that
content reverted), and all builder Playwright coverage runs post-merge /
nightly — plus there is no crash telemetry at all (static-Pages, no beacon).

---

## 1. Functionality review (business perspective)

What ships is genuinely strong on paper — multi-file workspace, isomorphic-git
versioning with autosave commits + milestones, history browsing with per-commit
diffs, restore, workspace switching, zip export, share URLs, legacy import.
The gap is that several of these features **complete correctly at the data
layer while producing no user-visible outcome**, which reads as "broken":

- **Restore is invisible.** The one action whose entire point is "make my
  files look like they did before" changes nothing on screen: editor buffer,
  generated Files pane, and preview all stay stale (no `setSource`, no
  `scheduleAutoGenerate` on the restore path). Compare the agent/chat path,
  which does call `editorHandleRef.setSource(...)` (`App.tsx:1488-1495`).
- **Restore is then silently undone** by the first keystroke (stale Monaco
  buffer written back via `onSourceChange`, auto-committed 1.5 s later).
  This is a data-integrity defect, not just UX.
- **Creating a file has no observable consequence.** `createSourceFile`
  doesn't schedule a regenerate (`App.tsx:1598-1603`; rename and folder-delete
  do), and a new file affects generation only once `main.ddd` imports it —
  nothing tells the user that. "It didn't work" is the rational reading.
- **Failure is always silent.** Every mutator no-ops when the store is null
  (ephemeral mode) and every rejection lands in `console.*` only
  (`use-workspace-sources.ts:25-28`, `HistoryPanel.tsx:117`,
  `auto-commit.ts:39-42`). Only the History panel explains ephemeral mode;
  the file-create UI shows a phantom row that later evaporates.
- **Crash recovery is all-or-nothing.** Any modeller render throw replaces
  the entire app (editor included) with the crash panel; unsaved perception
  is "the playground ate my work" even though IDB content survives.
- **Foot-guns without confirmation semantics:** picking an example deletes
  every user-added `.ddd` not in the example's file set (`App.tsx:675-677`);
  restore is hidden for HEAD even when uncommitted edits make it meaningful
  (`HistoryPanel.tsx:127`).

**Business read:** the file/versioning layer's *promise* (safe experimentation
— "you can always go back") is exactly what the silent-restore and
silent-undo bugs break. This is the trust-critical surface of the playground;
it should fail loudly and succeed visibly.

## 2. Architecture review (tech perspective)

### File/data management

- **Source of truth is 4 layers deep for the active file** — LightningFS/git
  working tree → `WorkspaceSourcesController` snapshot → React state mirror →
  Monaco model + `sourceRef` — and the sync is **one-way (editor→store)**.
  The only store→editor path is a full remount keyed on *identity*
  (`workspace.activeId:loaded:exampleId:activeSourcePath`), never on
  *content*. Any external mutation of the active file — restore, second tab,
  legacy import — is structurally invisible. This asymmetry is the single
  root of bug 1 and should be fixed as a mechanism (a content-generation
  counter in the remount key, or an explicit `setSource` on external writes),
  not as a per-call patch.
- **The change notifier only covers file ops.** Commits, `writeRef`, and
  restore-side deletions bypass it (`git-store.ts:337-344`), so an open
  History panel shows a stale list until an unrelated file event (autosave
  lands 1.5 s after the last event; the panel's reload debounce is 400 ms).
  Restore-deleting the active file also bypasses `controller.delete`, so
  `activePath` dangles and the next keystroke **recreates the deleted file**
  from the stale buffer (`git-store.ts:544-549`).
- **`restoreCommit` doesn't restore `refs/loom/generated-base`**
  (`git-store.ts:519`, `helpers.ts:16`) — after rollback, the 3-way
  regenerate merge still uses the *newer* base and sprays spurious conflict
  markers over `/workspace/generated/**`.
- **No cross-tab story.** One LightningFS/IDB per workspace, superblock
  cached per tab, flushed wholesale; no BroadcastChannel/storage listener
  anywhere in `web/src`. Two tabs = last-flush-wins data loss ("added, then
  gone").
- **Persistence layering itself is clean** (isomorphic-git + LightningFS per
  workspace DB, registry in localStorage, idempotent legacy import,
  serialised commit chain). The store is not the problem; its integration
  contract is.
- Smaller: folder-create validation checks duplicates at root level only,
  ignoring the parent (`SourceFilesTree.tsx:137`,
  `source-file-tabs-validation.ts:64-73`); `stageAll`'s walk isn't serialised
  against concurrent writes (a mid-walk delete rejects the whole autosave);
  `deleteWorkspace` can race an open IDB connection and orphan the DB.

### Modeller (`src/builder/`)

- **Crash #1 (verified):** `BuilderPane.tsx` runs `pageEnumFields` /
  `bodyDiagnostics` / `seedNodes` / `annotatedNodes` memos on every parse
  *before* the `parserErrors` guard at `:252`. Langium error recovery
  produces exactly the shapes that throw: `BodyProp.expr === undefined`
  (`current?.expr.$cstNode` — the `?.` guards the wrong link, `:193`) and
  `StateField.type === undefined` (`page/model.ts:594`). Because the pane
  stays mounted in the background on desktop (`DesktopShell.tsx:280-286`)
  and re-parses on a 350 ms debounce, *typing in the Source tab* triggers it
  intermittently — matching "sometimes crashes."
- **Crash amplifier:** one root ErrorBoundary (`main.tsx:21`), zero per-pane
  boundaries. Every builder throw takes down the whole app.
- **v2 dropped v1's safety rail:** `SystemBuilderV2Pane.tsx:370` builds its
  graph with **no parse-error gate** (v1 gates at `SystemBuilderPane.tsx:299`),
  renders a silently-partial model on broken source, and some delete handlers
  splice CST ranges of a recovered AST without `ifParses` validation. Latent
  unguarded derefs remain (`deployable-bindings.ts:62`, `body.ts:100-111`,
  `aggregate-edges.ts:139`).
- **Write-back discipline is inconsistent.** Best practice exists in-tree
  (surgical splice + full re-parse validation in `body.ts`/`expr-slots.ts`/
  `rename.renameMember`) but the page-builder Apply regenerates the whole
  `body:` and splices it with **no re-parse check** (`BuilderPane.tsx:259-267`),
  and `renameConstruct` doesn't validate its output either — the builders can
  write a non-parsing source.
- **Perf/stability debt that reads as crashes on mobile:** v1/v2/requirements
  panes memo on `[ctx, rev]` where `ctx` is a fresh object literal every App
  render (`App.tsx:1582`) → full main-thread re-parse + graph rebuild on any
  app state tick; `RequirementsPane` runs `lowerModel`+`enrich` synchronously
  on the render path; every rename/coverage/hint call builds a **fresh
  Langium services instance** (`system/linked-doc.ts:27`); the expr-hint
  promise cache caches rejections (`expr-slots.ts:532-536`). The
  ErrorBoundary's own comment names mobile memory pressure as a known crash
  vector — this churn feeds it.
- **v1/v2 coexistence is drifting, not transitioning.** Both are mounted
  side-by-side; v2 reuses v1's edit helpers (good) but triplicates the
  kind→AST-type map and re-implements AST walkers — the parse-gate omission
  is the first real drift casualty.

## 3. QA review

### What exists (and is good)

- **Unit tier (per-PR, `test/playground/`, 43 files):** git store, restore,
  auto-commit, commit diffs, sources controller, workspace registry/isolation,
  VFS, generated-tree 3-way merge, share, system-v2 graph (6 suites),
  requirements edit engine, page-builder model + live-sync.
- **E2E tier (`web/e2e/`, 30 Playwright specs):** editor/LSP, generate,
  bundle/boot/preview, workspace persistence, history browse, all four
  builders incl. mobile variants.

### The three structural holes

1. **The blind layer is the UI wiring** — precisely where all three bugs
   live. Pure helpers are unit-tested and store ops are unit-tested, but
   nothing in any tier exercises the glue: no test anywhere that restore is
   *visible* (the e2e asserts only that a "restore to" row appears,
   `workspace-history.spec.ts:74-95`); zero e2e references to the file-create
   UI (`rg 'source-files-tree|New file' web/e2e/` → no hits); no test renders
   any builder pane against a syntax-error source (the confirmed crash
   shapes have zero coverage); `ErrorBoundary.tsx` and
   `workspace-lsp-sync.ts` have zero tests. There is no component/jsdom tier
   at all in the repo.
2. **Everything browser-level is post-merge.** `playground-e2e.yml` runs on
   main-push / nightly / `run-e2e` label only (per-PR trigger deliberately
   removed for network flake). A PR that breaks restore, the file tree, or
   crashes a builder merges green and surfaces hours later on a
   `cancel-in-progress`, retry-tolerant nightly. Both reported bug classes
   sit exactly in this window — but note the no-network specs (workspace,
   history, builders, editor-minus-boot) don't share the flake rationale and
   could run per-PR.
3. **Zero crash signal.** Telemetry is a 12-entry localStorage ring buffer
   readable via `window.__loomDiag()`; no beacon (deliberate — static Pages).
   A user crash produces no team-visible signal unless the user pastes the
   buffer, and `restore()` failures are `console.warn`-only. "Sometimes
   crashes" reports are currently unfalsifiable.

### Highest-value missing tests (ranked)

1. E2E: restore actually reverts the visible Monaco content (+ unit:
   restore → notifier → controller snapshot).
2. E2E: create a file through the real UI → appears in tree/tabs → survives
   reload → participates in Generate.
3. Unit/render: every builder pane fed recovered-AST shapes
   (`expr === undefined`, `type === undefined`, empty system) renders its
   error message instead of throwing; ErrorBoundary + per-pane isolation.
4. CI: a per-PR `pull_request` lane in `playground-e2e.yml` running only the
   no-network specs.
5. Unit suites for `system/` (v1) graph-build mirroring v2's
   `view-graph.test.ts`.
6. Restore-failure surfacing + share-URL-open e2e.

---

## 4. Defect register

Severity: **P0** data loss / crash, **P1** feature broken as experienced,
**P2** correctness/robustness, **P3** polish.

| # | Sev | Where | Defect |
|---|---|---|---|
| 1 | P0 | `layout/HistoryPanel.tsx:109-124`, `layout/EditorPane.tsx:73` | Restore never reaches the editor/preview; next keystroke writes the stale buffer back, silently undoing the restore (data integrity). |
| 2 | P0 | `builder/BuilderPane.tsx:184-226` vs `:252` | Recovered-AST deref before the parse-error guard; background-mounted pane + 350 ms live re-parse → intermittent whole-app white screen while typing. |
| 3 | P0 | `main.tsx:21` | Single root ErrorBoundary; any builder throw unmounts the entire app. |
| 4 | P1 | `App.tsx:1598-1603` | `createSourceFile` fire-and-forget, no regenerate scheduled, errors console-only → "adding files didn't work". |
| 5 | P1 | `workspace-sources.ts:231-277`, `use-workspace-sources.ts:25-28` | All file mutators silently no-op on null store / swallow rejections; no UI error surface anywhere on the mutation path. |
| 6 | P1 | `builder/system-v2/SystemBuilderV2Pane.tsx:370` | No parse-error gate; silently-partial graph + unvalidated CST splices on recovered ASTs. |
| 7 | P1 | `workspace/git/git-store.ts:519` | `restoreCommit` doesn't restore `refs/loom/generated-base` → spurious regenerate conflicts after rollback. |
| 8 | P1 | `workspace/git/git-fs.ts:61-72` | No multi-tab coordination; LightningFS superblock last-flush-wins → files vanish with two tabs open. |
| 9 | P2 | `git-store.ts:544-549`, `workspace-sources.ts:254-267` | Restore-deleting the active file bypasses the active-path fallback; dangling `activePath` recreates the deleted file on the next keystroke. |
| 10 | P2 | `git-store.ts:337-344`, `HistoryPanel.tsx:78-81` | Commits emit no notification; open History panel shows a stale list (autosave lands after the reload debounce). |
| 11 | P2 | `lsp/workspace-lsp-sync.ts:53-72` | Pre-existing Monaco models never adopted into `owned` → deleted files live on in the LSP; duplicate-symbol errors suppress auto-generate after delete/re-add. |
| 12 | P2 | `builder/BuilderPane.tsx:259-267`, `builder/system/rename.ts:36-83` | Page-builder Apply and `renameConstruct` splice without re-parse validation → builders can write a non-parsing source. |
| 13 | P2 | `builder/page/PageBuilder.tsx:158-181` | craft.js live re-seed can deserialize a user-defined `component` name against a stale resolver → effect throw (medium confidence). |
| 14 | P2 | `App.tsx:1582` + `SystemBuilderPane.tsx:298` / v2 `:370` / `RequirementsPane.tsx:237` | Fresh `ctx` identity every render → full main-thread re-parse/rebuild on every app tick; sync `lowerModel`+`enrich` in render; fresh Langium services per rename/hint call (mobile OOM feeder). |
| 15 | P2 | `layout/SourceFilesTree.tsx:137`, `layout/source-file-tabs-validation.ts:64-73` | Folder-duplicate validation ignores the parent folder — false positives at root, silent no-op on real duplicates. |
| 16 | P3 | `HistoryPanel.tsx:116-118` | Restore failure is `console.warn`-only. |
| 17 | P3 | `git-store.ts:292-322` | `stageAll` walk not serialised vs writes; concurrent delete rejects the whole autosave (skipped silently). |
| 18 | P3 | `workspace/use-workspace.ts:146-152` | `deleteWorkspace` can race an open connection; blocked IDB delete orphans the DB. |
| 19 | P3 | `App.tsx:675-677` | Example switch deletes user-added files without confirmation. |
| 20 | P3 | `builder/system/expr-slots.ts:532-536` | Size-1 hint cache caches rejected promises → hints stay broken until source changes. |
| 21 | P3 | `HistoryPanel.tsx:22-24` | Module comment claims "no restore/checkout" — contradicts the code below it. |

## 5. Recommended remediation (ordered)

**Wave 1 — restore trust (small diffs, big effect):** fix the store→editor
sync as a mechanism (content-generation counter in the editor remount key,
bumped by external writes: restore, import, agent, second tab), and have
restore schedule a regenerate + restore `generated-base` (#1, #7). Hoist
`BuilderPane`'s parse gate above the memos / null-guard `collectBodies` and
`enumStateFields`, add the same gate to v2, and wrap each builder pane in
its own ErrorBoundary (#2, #3, #6). Surface mutation errors + ephemeral
mode in the files UI; schedule regenerate on create (#4, #5).

**Wave 2 — pin it in QA:** the six missing tests in §3, especially the
restore-visibility e2e, the file-create e2e, and recovered-AST render tests;
add the per-PR no-network e2e lane.

**Wave 3 — structural:** notifier coverage for git-level ops; multi-tab
guard (BroadcastChannel invalidation or an explicit "another tab has this
workspace open" lock); LSP model adoption fix; stabilise `ctx` identity and
move v1/v2/requirements parsing off the render path; re-parse-validate all
builder write-backs; decide v2's endgame (either finish the migration and
retire v1 or extract the shared safety rails so they can't drift apart).

*Method note: findings compiled from three parallel deep-read audits
(git/file layer, builder, QA surface) plus direct verification of the two
headline root causes; the git-layer unit suites (54 tests) were run and
pass, confirming the bugs live above the tested layer.*
