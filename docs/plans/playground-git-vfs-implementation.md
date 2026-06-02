# Implementation plan — playground git-backed VFS

> **Status:** SHIPPED — core landed across #748 / #757 / #761 (PR 0–5
> below map to that merged work); UX follow-ups landed in #766 (visible
> History tab), #773 (restore to a commit), #778 (Output conflict
> indicator), and #814 (Playwright e2e). Kept as the historical record.
> Implements
> [`../proposals/playground-git-vfs.md`](../proposals/playground-git-vfs.md).
> Scope is **`web/`-only** at the source layer (plus the playground
> unit tests under `test/playground/`, which run in the root vitest
> gate). The toolchain (`src/`) and Node CLI are untouched. Chosen for
> implementation because it is orthogonal to the two active
> compiler-core tracks (storage/type-system/auth and
> lifecycle/forms/inheritance/governance/i18n) and therefore carries
> near-zero rebase risk against them.

## Why this is low-collision

- The proposal reshapes only `web/src/vfs/`, `web/src/build/`,
  `web/src/workspace/`, `web/src/lsp/`, and `web/src/App.tsx`. None of
  the compiler hot files (`ddd.langium`, `loom-ir.ts`, `lower/*`,
  `enrich`, `validate`, generators, `src/system/`) are touched.
- Recent `main` churn in those playground directories: **zero** in the
  last 40 commits (only a docs-template PR brushed `web/`). The `web/`
  activity that does show up is all example `.ddd` files under
  `web/src/examples/`, a different subtree.
- The only cross-dependency on the active work is a *runtime* property
  — clean 3-way merges of regenerated code lean on byte-identical
  generator output — which is a behavioural concern, not a source-file
  collision. It cannot produce a rebase.

## Current-state anchors (verified against the branch)

| Concern | Where today |
|---|---|
| `Vfs` interface (sync) | `web/src/vfs/types.ts:72` (+ `RestorableVfs` at `:184`) |
| In-memory impl | `web/src/vfs/memory-vfs.ts` |
| IDB persistence decorator | `web/src/vfs/idb-vfs.ts` (DB `loom-workspace`, store `entries`) |
| Worker-local VFS singleton | `web/src/build/worker-vfs.ts:25` (`get/setWorkerVfs`) |
| Sync pack loader (worker) | `web/src/build/loader-vfs.ts` (reads `getWorkerVfs()` sync) |
| Built-in pack seed | `web/src/build/template-bundled.ts` (`seedBuiltinPacks`) |
| Build RPC + protocol | `web/src/build/client.ts`, `build.worker.ts`, `protocol.ts` (`vfs.write/delete/list/snapshot`) |
| Respawn seed (sync!) | `web/src/build/client.ts:43` — `seedWorkspace?: () => VfsEntry[]` |
| Workspace controller | `web/src/workspace/workspace-sources.ts:115` (subscribes `/workspace/` prefix) |
| Workspace React hooks | `web/src/workspace/use-workspace.ts`, `use-workspace-sources.ts`, `use-workspace-files.ts` |
| LSP sync to Monaco | `web/src/lsp/workspace-lsp-sync.ts:37` |
| App persistence/restore | `web/src/App.tsx` (~179–253: `useWorkspace`, persistedSource, EngineSnapshot) |
| Preview bundler / runtime | `web/src/engine/npm/vfs-bundler.worker.ts`, `web/src/runtime/runtime.worker.ts` (receive files by postMessage; do not read the workspace VFS directly) |
| Vite loader shim | `web/vite.config.ts` `loomLoaderShim` (`loader-fs` → `loader-vfs`; also in `worker.plugins`) |

## CI gates that must stay green per-PR

- **`test.yml`** runs root `npm test` (vitest), which **includes**
  `test/playground/**/*.test.ts` (`vitest.config.ts:5`). The VFS unit
  tests (`memory-vfs`, `idb-vfs`, `workspace-sources`,
  `build-worker-protocol`, `loader-vfs`, `build-client-respawn`,
  `multifile-vfs-loader`, …) gate every PR.
- **`pages.yml`** typechecks the playground (`web/` tsc) + Node-side
  smoke + builds it; triggers on `web/**`.
- **`playground-e2e.yml`** (Playwright) — per-PR trigger was removed;
  runs on merge-to-main + daily. Won't gate PRs, but a coordinated
  local Playwright run is the acceptance check for PR 4.

Test harness note: `fake-indexeddb/auto` is already a root devDep
(`package.json:55`) and is used by `idb-vfs.test.ts`. LightningFS is
IndexedDB-backed, so the git-store unit tests reuse the exact same
harness — no new test infra.

## Design constraint that shapes the sequence

`compilePack` is sync and pure; the entire generator depends on its
sync-ness (`web/src/vfs/types.ts:15`). Therefore **async lives on the
main thread, ahead of a generate run; the worker stays sync.** The RPC
boundary collapses the async git result into a resident sync snapshot
inside the worker's `MemoryVfs`. The generator never awaits git.

The one friction point: `seedWorkspace` (the respawn re-seed) is sync
(`client.ts:43`) but the source of truth becomes async git. Resolution
chosen: the workspace controller already holds a resident
`files: Map<path,content>` mirror of the working tree; the sync seed
callback reads that mirror. This keeps the build-worker contract
unchanged across the whole migration. (Alternative — make the seed
async — is rejected: it widens the worker RPC surface for no gain.)

---

## PR sequence

Each PR is independently green (`npm test` + `web` tsc) and preserves
byte-identical generator output. PRs 0–1 are pure-additive and de-risk
the dependency/refactor before any behavioural change; PR 5 is the
cleanup the proposal's "Removed" list describes and lands last so
nothing breaks mid-flight.

### PR 0 — Interface segregation (no behaviour change)

The "do regardless" step. Split the fat `Vfs` into capability
interfaces in `web/src/vfs/types.ts`:

```
ReadableVfs   = read, readRequired, exists, isFile, isDirectory,
                kindOf, list, listDirs, listAll
MutableVfs    = write, delete, mkdir, rmdir
ObservableVfs = subscribe
BulkVfs       = hydrate, snapshot   (+ restore on RestorableVfs)
Vfs = ReadableVfs & MutableVfs & ObservableVfs & BulkVfs   // unchanged shape
```

- `MemoryVfs` / `IdbVfs` implement `Vfs` exactly as today.
- Narrow the worker loader to `ReadableVfs`: `worker-vfs.ts`
  `getWorkerVfs(): ReadableVfs`; `loader-vfs.ts` depends on
  `ReadableVfs`. This makes the worker's read-only nature a type fact
  and unlocks the PR 5 removals.
- **Risk:** none. Pure type refactor. **Tests:** existing suite green
  unchanged.

### PR 1 — Git store module (additive, not yet wired)

Add deps to `web/package.json`: `isomorphic-git`,
`@isomorphic-git/lightning-fs`. New `web/src/workspace/git/`:

- `git-fs.ts` — bootstraps a single LightningFS instance (DB name
  `loom-workspace-git`, distinct from the legacy `loom-workspace` IDB
  so the two coexist during migration). `/workspace/**` and `.git/**`
  are ordinary files in it.
- `git-store.ts` — async file API over `fs.promises`
  (`readFile/writeFile/deleteFile/list/exists/mkdir/rmdir`) + git ops
  (`init/add/commit/log/statusMatrix/checkout/merge/resolveRef`) + the
  **reactive notifier**: every `writeFile` and post-`checkout/merge`
  diff `emit("changed", paths)`. This is the one thing the libraries
  don't provide (neither emits change events).
- Composed helpers (policy, not primitives): `commitOnSave`
  (`add`+`commit`), `regenerateMerge` (3-way `merge` against
  `refs/loom/generated-base`), `diffForDisplay` (computed from
  `statusMatrix` + blob compare; isomorphic-git has no one-shot
  unified diff).

`test/playground/git-store.test.ts` under `fake-indexeddb/auto`:
init → write → commit → log; checkout round-trip; change-event fan-out;
a clean and a conflicting `regenerateMerge`. No consumer is wired yet.
**Risk:** dependency bloat in the playground bundle — verify the
`pages.yml` build still succeeds and chunk sizes are acceptable.

### PR 2 — Async workspace controller behind the same API

Rewrite `WorkspaceSourcesController`
(`web/src/workspace/workspace-sources.ts`) to read/write through
`git-store` and the change-event seam instead of the sync VFS
subscription. Public method names stay; signatures go async
(`write/delete/createEmptyFolder/deleteEmptyFolder` return Promises).
The controller keeps its resident `files`/`emptyFolders` snapshot
(re-derived on each `changed` event) — this is also the sync mirror the
seed callback reads.

- Update `use-workspace-sources.ts` / `use-workspace-files.ts` to await
  + subscribe to git change events.
- **Build worker untouched** — still sync `MemoryVfs`, still seeded via
  the (now mirror-fed) sync `seedWorkspace`. Worker contract unchanged.
- Migrate `test/playground/workspace-sources.test.ts` to the async API.
- **Risk:** async ordering in the React hooks; cover with the existing
  controller tests + a debounce-on-save check.

### PR 3 — Boot from git, App shell, LSP sync, one-time IDB import

- Replace `use-workspace.ts` (`IdbVfs.open`) with a git-store open that
  ensures an initialised repo at first load.
- **One-time migration:** if the legacy `loom-workspace` IDB exists,
  read it (reuse the existing `IdbVfs` read path purely as an importer)
  and write its `/workspace/**` entries into an initial git commit;
  then the legacy IDB is dead. Keep the importer as a small, isolated
  module so PR 5 can decide whether to retain or drop it.
- `App.tsx` (~179–253): `persistedSource` becomes "read
  `/workspace/main.ddd` from the git working tree"; the EngineSnapshot
  tab-suspension path is largely subsumed (workspace state survives by
  being committed / working-tree-resident) — only ephemeral runtime/DB
  state keeps a suspension story.
- `workspace-lsp-sync.ts` moves to the async change-event seam (same
  controller subscription, now event-driven off git).
- Hide `.git/` from the workspace tree UI and from share-URL encoding.
- **Risk:** highest-touch PR. Mitigation: the worker/preview path is
  unchanged here; this PR only swaps the durable backing + consumers.

### PR 4 — Generated code as versioned content + regenerate-as-merge

The payload feature.

- On a successful generate, write the generated tree into `/workspace`
  next to the `.ddd`, then update `refs/loom/generated-base` to that
  tree.
- Regeneration = `regenerateMerge`: `base = refs/loom/generated-base`,
  `ours = /workspace`, `theirs = fresh output` → `git.merge`; conflicts
  surface as standard conflict markers.
- Preview: `vfs-bundler.worker.ts` already receives files by
  postMessage; wire its input to the workspace generated tree so the
  preview reflects hand edits.
- Decide generated-code `.gitignore` scope (bundler scratch /
  node_modules-equivalents stay ignored).
- **Acceptance:** a coordinated local Playwright run
  (`playground-e2e`) — edit → generate → hand-edit generated file →
  regenerate → confirm the edit survives via clean merge. This is where
  the byte-identical-output dependency is exercised.

### PR 5 — Removals + tightening (cleanup)

Land last, once nothing depends on the removed surface:

- Remove `web/src/vfs/idb-vfs.ts` (or reduce to the read-only importer
  if PR 3 keeps it).
- Remove the sync main-thread `Vfs` surface; all UI/LSP consumers are
  async after PRs 2–3.
- Remove `MemoryVfs` methods the worker never calls now that it is
  `ReadableVfs` + bulk only: single `write`, `mkdir`, `rmdir`,
  `listDirs`, `listAll`, `subscribe`, `restore`.
- Remove build-RPC `vfs.delete` and `vfs.snapshot` ops + their handlers
  in `build.worker.ts` + message types in `protocol.ts` (the worker
  re-seeds wholesale from git instead of taking incremental deltas).
- Trim/retire `test/playground/idb-vfs.test.ts`; trim
  `build-worker-protocol.test.ts` to the surviving ops.

## Risks & mitigations (summary)

| Risk | Mitigation |
|---|---|
| Sync→async cut touches many consumers | Migrate behind the controller facade; worker stays sync throughout (PRs 2–3) |
| Sync `seedWorkspace` vs async git | Feed it from the controller's resident `files` mirror; worker contract unchanged |
| Noisy regenerate merges if output churns | Depends on the existing byte-identical-output gate; surfaces in PR 4 as UX, never as a rebase |
| Playground bundle weight (new deps) | Verified in PR 1 against `pages.yml` build + chunk split |
| LightningFS under vitest/node | Reuses `fake-indexeddb/auto` (already a devDep) |
| e2e not per-PR gated | Coordinated local Playwright run is PR 4's acceptance check |

## Open questions inherited from the proposal

Merge-conflict UX in generated code; `refs/loom/generated-base` as ref
vs stored tree; commit cadence (debounced working-tree writes +
intentional commits — per-keystroke is out); push/pull auth + CORS
proxy (out of v1); OPFS vs IndexedDB at scale (IndexedDB for v1);
generated-code `.gitignore` scope. These are resolved inline at the PR
that first hits them (cadence in PR 2, generated `.gitignore` in PR 4,
remotes deferred).
