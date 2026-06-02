# Playground git-backed VFS — versioned workspace, preview, and regeneration

> Status: **SHIPPED.** Implemented on `origin/main` across #748
> (store + async workspace layer + generated-as-merge + preview-from-
> workspace), #757 (debounced commit-on-save, refresh race guard,
> scoped source scan), and #761 (dead-code cleanup). The durable store
> is LightningFS + isomorphic-git under `web/src/workspace/git/`; the
> legacy IndexedDB workspace is imported once via
> `web/src/vfs/legacy-idb.ts`. The toolchain (`src/`) and the Node CLI
> are untouched — this was a `web/`-only change. Build order:
> [`../plans/playground-git-vfs-implementation.md`](../plans/playground-git-vfs-implementation.md).
>
> **Follow-ups shipped** (beyond the original design note below): the
> workspace history is now visible — a **History** dock/mobile tab
> listing commits + per-commit file changes (#766); **restore to a past
> commit** via `GitStore.restoreCommit` (#773); an **in-editor conflict
> indicator** — the Output panel's "Conflicts" stream/dot when a
> regenerated file carries `<<<<<<<` markers (#778, closing the deferral
> noted in earlier revisions); and Playwright **e2e** for history,
> restore, and conflicts (#814).
>
> **Still out of scope:** remotes (clone/push/pull), per the design
> below.
>
> The text below is the original design note, preserved for context.

## Problem

The playground has no history. A `.ddd` edit is autosaved
last-write-wins to IndexedDB (`web/src/vfs/idb-vfs.ts`); the only
"snapshots" are share-URL hashes and a single tab-suspension
before/after pair. There is no commit log, no diff, no branch, no undo
across sessions — and no clean story for a workflow people actually
want: **scaffold code, hand-edit it, regenerate selectively, keep
source and generated output side by side.**

We want to track changes to files in the playground's Virtual File
System (VFS) with real version control, and to make generated code a
first-class, editable, versioned citizen of the workspace.

## Decisions locked

These were settled in the design thread and are binding for the
implementation:

1. **Git is the single persistent source of truth**, on the main
   thread. Everything else is ephemeral and reproducible.
2. **Pure git — no main-thread `MemoryVfs` cache.** The main-thread
   workspace store is async, backed directly by **LightningFS +
   isomorphic-git**. The old sync `Vfs`/`IdbVfs` surface on the main
   thread is removed; UI/LSP consumers go async.
3. **Use the libraries directly.** File CRUD comes from LightningFS's
   `fs.promises`; git operations come from isomorphic-git. We do **not**
   build a parallel VFS abstraction over them.
4. **The build worker keeps an ephemeral `MemoryVfs` with no storage.**
   It owns no source of truth; it is re-seeded every boot. No IDB, no
   git, no persistence in the worker.
5. **Built-in design packs are compiler internals** — bundled, seeded
   into the worker, never versioned. **Custom imported packs are user
   content** under `/workspace/design/`, versioned in git for free.
6. **Generated code lives in the workspace**, side by side with source,
   and is versioned. **Regeneration is a git 3-way merge, not an
   overwrite.**
7. **Remotes are local-first but additive.** No push/pull in v1, but the
   store is a real git repo from day one so `clone`/`push`/`pull` are
   later wiring (CORS proxy + auth), not a re-architecture.

## Why this is feasible — the load-bearing facts

Three facts about the existing code make this clean, and each was
verified against the source:

- **`compilePack` is pure** (`src/generator/_packs/loader.ts:221`,
  *"Pure: no I/O"*). It takes already-read template strings and compiles
  them with Handlebars. Its sync-ness is a property of **purity**, not of
  storage — so a git/async store cannot make it async.
- **The IR core reads no files.** `lower`/`enrich`/`validate`
  (`src/ir/`) are pure in-memory transforms. The only VFS reader in the
  generator is the pack loader, called from one site
  (`src/generator/react/index.ts`).
- **Workers are isolated realms.** A Web Worker cannot see the main
  thread's memory; it receives data only by `postMessage`. The build
  worker therefore *must* hold its own copy of what it reads, and that
  copy arrives by RPC — which is why the worker's `MemoryVfs` is
  mandatory and why async git on the main thread never reaches it.

The key consequence: **async lives on the main thread, ahead of a
generate run; sync lives in the worker. The RPC boundary collapses the
async result into a resident sync snapshot.** The generator never
awaits git.

## Architecture — four layers

```
┌─ MAIN THREAD ──────────────────────────────────────────────────────┐
│ ① SOURCE OF TRUTH — git workspace (LightningFS + isomorphic-git)    │
│    /workspace/**  =  .ddd source  +  custom packs  +  generated code │
│    • the ONLY persistent store                                       │
│    • commit / log / diff / status / branch (+ push/pull later)       │
│    • regenerate = 3-way merge against refs/loom/generated-base       │
└───────────────┬────────────────────────────────────────────────────┘
                │  await read source  →  RPC postMessage(entries)
                │  ▲ write-back merged generated tree
                ▼
┌─ BUILD WORKER ─────────────────────────────────────────────────────┐
│ ② COMPILER INPUTS — ephemeral MemoryVfs (NO storage)               │
│    built-in packs (bundle-seeded)  ∪  /workspace (RPC-projected)     │
│    • sync, throwaway, re-seeded every boot                           │
│    • read by compilePack (sync, pure)  →  generated output           │
└───────────────┬────────────────────────────────────────────────────┘
                ▼  generated tree (RPC back to main thread → merge)
┌─ MAIN THREAD (git) ── generated code merged into /workspace ────────┐
                ▼
┌─ RUNTIME WORKER + IFRAME ──────────────────────────────────────────┐
│ ③ PREVIEW — bundle /workspace generated code (incl. user edits)     │
│    → Hono + PGlite (runtime.worker.ts) → iframe via preview bridge   │
│    runtime/DB state ephemeral; orthogonal to git                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Layer ① — git workspace (main thread)

The durable store is **LightningFS over IndexedDB**; **isomorphic-git**
runs on it. `/workspace/**` and `.git/*` are ordinary files in the same
LightningFS instance. The store is single-writer (main thread only), so
there is no cross-realm IndexedDB contention.

What lives here, all versioned:

- `/workspace/*.ddd` — user source.
- `/workspace/design/<name>/...` — **custom imported packs** (already
  written here today by `web/src/workspace/pack-picker.ts`); versioned
  for free, so a shared/cloned project carries its design system.
- generated code (TS/Hono, React, .NET, Phoenix) — **see Layer ③ note
  and the regeneration section.**

**"Durable backing"** = the layer where bytes survive a reload.
isomorphic-git persists nothing itself; it reads/writes through the
`fs` you hand it, and that `fs`'s storage *is* the durable backing.
LightningFS = an `fs` whose data lives in IndexedDB. (OPFS is a future
performance option for git's many small loose objects; not v1.)

### Layer ② — build worker (ephemeral `MemoryVfs`)

Unchanged in spirit, narrowed in surface. The worker is a **stateless
transform**: `(built-in packs ∪ projected /workspace) → generated
output`. It owns no source of truth, so it persists nothing.

- Built-ins are seeded from the Vite bundle (`web/src/build/
  template-bundled.ts` → `seedBuiltinPacks`).
- `/workspace` content (source + custom packs) is projected over the
  existing build RPC (`web/src/build/client.ts` ↔
  `web/src/build/build.worker.ts`).
- `web/src/build/loader-vfs.ts` reads the worker's `MemoryVfs`
  synchronously for `compilePack`.

Ephemeral is a feature: a fresh worker is a deterministic clean slate;
on crash/restart the main thread re-projects from git. No durable state
to corrupt or migrate.

### Layer ③ — preview (runtime worker + iframe)

Preview bundles the generated code **from `/workspace`** — including any
hand edits — via `web/src/engine/npm/vfs-bundler.worker.ts`, runs it in
`web/src/runtime/runtime.worker.ts` (Hono + PGlite), and renders it in
the iframe through the preview bridge. Because generated code is now
versioned workspace content, the preview reflects the user's edits, which
is what people expect.

## Generated code in the workspace + regeneration as merge

The artificial "source is sacred, generated is ephemeral" split is
dropped. Generated output is **first-class, editable, versioned**, living
in `/workspace` next to the `.ddd`. This is the scaffold-then-own model
(Rails generators / `dotnet new` / shadcn).

The one hard problem it creates — *regeneration must not clobber hand
edits* — is exactly what git solves:

```
base   = refs/loom/generated-base   (the tree generated last time)
ours   = /workspace                 (user edits on top of generated)
theirs = freshly generated tree     (this run's output)
       → git 3-way merge → conflicts surface as standard conflict markers
```

On every successful generate, update `refs/loom/generated-base` to the
new generated tree. Regeneration then merges, never overwrites.

Two dependencies, both already favoured by Loom:

1. **Deterministic, stable output.** Merges are only clean if
   regeneration doesn't churn formatting/ordering. Loom's
   **byte-identical-output gate** (the walker-target extraction work,
   PRs #607/#610/#612/#616/#622–#627) is precisely this discipline; it
   becomes load-bearing here.
2. **A persisted merge base** — the `refs/loom/generated-base` ref.

## What changes in the code

### Removed

- **`web/src/vfs/idb-vfs.ts`** — the main-thread IDB persistence
  decorator. Replaced by the git-backed store.
- **The sync `Vfs` surface on the main thread.** UI/LSP consumers
  (`web/src/workspace/use-workspace-files.ts`,
  `workspace-sources.ts`, `WorkspaceTree.tsx`,
  `web/src/lsp/workspace-lsp-sync.ts`, and the `App.tsx`
  snapshot/restore paths) move to the async git API + change events.
- **`MemoryVfs` methods the worker never calls** — once `MemoryVfs` is
  worker-only, delete single `write`, `mkdir`, `rmdir`, `listDirs`,
  `listAll`, `subscribe`, `restore`.
- **Build-RPC ops `vfs.delete` and `vfs.snapshot`** (+ handlers in
  `build.worker.ts`, + message types in `web/src/build/protocol.ts`) —
  once the worker re-seeds wholesale from git instead of taking
  incremental deltas, and the worker-rehydrate flow reseeds from git
  rather than snapshotting a dead worker.

### Kept

- **`MemoryVfs`** — but only in the build worker, as ephemeral scratch.
- **The `Vfs` interface** — narrowed (see below) and used by the worker.
- **The build RPC** for projecting `/workspace` into the worker
  (`hydrate`).

### Added — a thin reactive seam, not an abstraction

isomorphic-git and LightningFS are request/response: **neither emits
change events, and neither has a watch API.** That is the one thing the
playground must add, because the editor, tree, and LSP are event-driven:

```
writeFile(...)           → after write, emit("changed", [path])
git.checkout/merge(...)  → after, diff working tree, emit changed paths
```

Plus a few **composed helpers** (policy, not primitives):

- **commit-on-save** = `git.add` + `git.commit`.
- **regenerate-merge** = compose `git.merge` against
  `refs/loom/generated-base`.
- **diff-for-display** — isomorphic-git has no one-shot unified-diff;
  compute from `statusMatrix`/`git.walk` + blob compares, or a small
  diff lib.

UI and LSP call `fs.promises` / `git.*` through this thin module so all
mutations funnel through the notifier and nobody re-implements file ops.

### Interface segregation (do regardless)

Split the fat `Vfs` into capability interfaces so the worker depends only
on what it uses:

```
ReadableVfs   = read, readRequired, exists, isFile, isDirectory, kindOf,
                list, listDirs, listAll
MutableVfs    = write, delete, mkdir, rmdir
ObservableVfs = subscribe
+ bulk        = hydrate / snapshot / restore
```

The build worker depends on `ReadableVfs` + a bulk-load; this makes its
read-only nature a type-level fact and unlocks the removals above.

## Pack classification (resolves the "weird loading")

| | Built-in packs | Custom imported packs | User `.ddd` | Generated code |
|---|---|---|---|---|
| Classification | compiler internal | user content | user content | user content |
| Lives at | `/designs/<family>/<ver>` | `/workspace/design/<name>/` | `/workspace/*.ddd` | `/workspace/...` |
| Source | Vite bundle → worker seed | user import | user edits | generator → merge |
| In git? | **no** | **yes** | **yes** | **yes** |
| Versioned/editable | no | yes | yes | yes |

Built-ins are toolchain internals, like the parser or macro stdlib; the
bundled `/designs` seed is correct for them and never enters the git
store. The loader reads the worker mirror regardless of a pack's tier.

## Migration

1. On first load after the change, import the existing `loom-workspace`
   IndexedDB contents into an initial git commit.
2. Hide `.git/` from the workspace tree UI and from share-URL encoding.
3. Decide example-loading behaviour: loading an example seeds an initial
   commit vs stays uncommitted-until-touched.

## Open questions

- **Merge-conflict UX in generated code.** If output isn't perfectly
  stable, regenerate gets noisy. How much of conflict resolution do we
  surface in-editor vs auto-resolve? The byte-identical gate mitigates
  but does not eliminate this.
- **Merge-base storage.** `refs/loom/generated-base` as a git ref vs a
  separate stored tree vs regenerate-from-scratch-and-diff. Ref is the
  natural git-native choice.
- **Commit cadence.** Explicit user commits vs periodic auto-commit vs
  debounced working-tree writes with manual commit points. Per-keystroke
  commits are out; debounced working-tree writes + intentional commits
  are in.
- **Push/pull auth + CORS proxy** when remotes land — token vs OAuth;
  isomorphic-git's hosted proxy vs self-hosted.
- **OPFS vs IndexedDB** for the durable backing at scale (many small git
  objects). IndexedDB/LightningFS for v1; OPFS as a later perf option.
- **Generated-code `.gitignore` scope.** With generated code tracked,
  what (if anything) stays ignored (node_modules-equivalents, bundler
  scratch)?

## Relationship to existing playground pieces

- `web/vite.config.ts`'s `loomLoaderShim` (swaps `loader-fs` →
  `loader-vfs`) is unaffected — the worker loader still reads its
  `MemoryVfs`.
- The dedicated LSP worker (`web/src/lsp/ddd-server.worker.ts`) consumes
  workspace source via the controller subscription; it moves to the async
  change-event seam like the other consumers.
- Tab-suspension `EngineSnapshot` (`App.tsx`) is largely subsumed: with
  git as the durable store, workspace state survives by virtue of being
  committed/working-tree-resident; only ephemeral runtime/DB state needs
  a separate suspension story.
