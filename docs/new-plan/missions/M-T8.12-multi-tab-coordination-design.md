# M-T8.12 — Playground multi-tab write coordination (design)

> **Status: design brief (no claim PR yet).**
> Source: `docs/audits/playground-file-mgmt-review-2026-07.md` defect **#8**
> (P1, `workspace/git/git-fs.ts`) and its wave-3 line ("multi-tab guard").
> Verified against `main` @ `7938c9b` (the remediation merge) and the
> `@isomorphic-git/lightning-fs@4.6.2` source in `node_modules`.

## Problem — and how it actually fails

Each workspace is one LightningFS over one IndexedDB (`openGitFs(gitDb)`,
`registry.ts:gitDbForId`). The audit's headline ("superblock last-flush-wins")
is **half right, and the wrong half is the dangerous one**: LightningFS *does*
already hold a cross-tab mutex. `DefaultBackend.init` picks
`Mutex2` (real **Web Locks**, name `` `${dbName}_lock` ``) when `navigator.locks`
exists, else an IDB-keyval TTL lease; `activate()` waits on it, loads the `!root`
superblock, `deactivate()` flushes + releases. But its scope is an **activation
window**, not an operation — `PromisifiedFS._wrap`'s `finally` schedules
`_deactivate` **500 ms** after the last fs call, so every idle gap hands the lock
over mid-*git*-operation. The real loss paths are therefore:

- (a) **higher-level read-modify-write interleave** — `stageAll` → `commit` →
  `writeRef` spans hundreds of fs ops with release windows between them, and
  `GitStore.commitChain` serialises commits **within one tab only**;
- (b) **stale app-layer caches** — the passive tab's
  `WorkspaceSourcesController` snapshot and Monaco buffer are never invalidated,
  so its next keystroke writes yesterday's text over the other tab's file and
  autosaves it 1.5 s later;
- (c) genuine superblock clobber, but **only on the no-`navigator.locks`
  fallback**, whose 5 s TTL lease can expire under a slow activation and let two
  caches go live at once.

(b) is the "file added, then gone" report. It survives *any* fix at the FS layer,
because nothing in `web/src` listens for anything cross-tab: `rg 'navigator.locks|BroadcastChannel'
web/src` → zero hits. Two tabs also both run `startAutoCommit` (`App.tsx:484`)
and both write the generated tree (`applyGeneratedTree`, `App.tsx:1150`).

## Rejected alternatives

- **Fix it at the FS layer** (fork LightningFS, hold its mutex longer, `defer`).
  Wrong altitude: it cannot see git-operation boundaries and does nothing for
  (b) — plus it vendors a fork of a transitive dep.
- **CRDT / operational merge of two live writers.** Real concurrent editing
  needs presence, cursors and conflict UI — a product, not a defect fix.
- **localStorage heartbeat / `storage`-event polling.** Reinvents Web Locks with
  worse liveness: no auto-release on tab crash, the property we most want.
- **SharedWorker-owned FS / leader election** — costed and rejected in §Phase 3.

## Direction — one writer, live readers

### Phase 1 — safety: a per-workspace writer lock

New leaf `web/src/workspace/tab-lock.ts` (framework-free, node-testable):

```ts
export const writerLockName = (gitDb: string) => `loom.workspace.${gitDb}.writer`;
export interface LockManagerLike { request(name, opts, cb): Promise<unknown>; }
export interface WorkspaceLock { readonly owner: boolean; steal(): Promise<void>; release(): void; }
export function acquireWriterLock(
  gitDb: string,
  opts: { onLost(): void; manager?: LockManagerLike },   // manager injectable → fake in tests
): Promise<WorkspaceLock>;
```

`{ ifAvailable: true }` at open; the held promise stays pending for the session,
so the lock auto-releases on tab death/crash — that *is* the recovery story. A
lost lock (another tab's `{ steal: true }`) rejects our request with `AbortError`
→ `onLost()`. **The name must not collide with LightningFS's own
`` `${gitDb}_lock` ``** — reusing it would deadlock the filesystem.

Wiring goes in `use-workspace.ts`'s open effect, which already owns
`openGitFs`/`closeGitFs` per `gitDb` — so acquire/release ride the same
lifecycle, `switchWorkspace` included, and two tabs on *different* workspaces
both stay writable. **Owner** → today's behaviour exactly. **Passive** →
`new ReadOnlyGitStore(store)` (`web/src/workspace/git/read-only.ts`): mutators
reject with `WorkspaceReadOnlyError("other-tab")`, reads pass through, no
`startAutoCommit` (`App.tsx:484`), no `applyGeneratedTree` (`App.tsx:1150` —
regenerate keeps its files in memory). **UI**: slice C's affordances exist but
key off a boolean `persistent` (snapshot → `SourceFilesTree` `disabled=` +
`EPHEMERAL_MESSAGE`); generalise to `writable` + `readOnlyReason: "ephemeral" |
"other-tab" | null` so the same disabled controls carry the right sentence, plus
a banner and a **"Take over"** button (`lock.steal()`) beside the ephemeral
notice. This alone kills the data-loss class: only one tab ever writes.

### Phase 2 — liveness: invalidation broadcast

New leaf `web/src/workspace/tab-channel.ts` — one `BroadcastChannel` per
workspace, name `loom.workspace.<gitDb>`, messages
`{kind:"files", paths}` | `{kind:"commit", oid}` | `{kind:"role", owner}` |
`{kind:"deleted"}`. The owner publishes from `GitStore.notify` / `notifyCommit`
(`git-store.ts:302-313`); the passive tab feeds received messages back into the
**same** fan-out (`store.applyRemote(paths)`), so
`WorkspaceSourcesController.refresh` runs unchanged, the **external-content
`epoch`** bumps (it already documents "another tab" as its case,
`workspace-sources.ts:70-77`), the editor remounts on fresh content, and History
reloads on the commit channel. No new UI machinery — phase 2 is a *transport*.
On takeover the roles swap by message + `onLost()`; no reload.

`deleteWorkspace` (`use-workspace.ts:157-186`): the owner releases its lock
**after** `closeGitFs` + `deleteGitDb`, and broadcasts `{kind:"deleted"}` first
so passive tabs `closeGitFs` too — otherwise their open IDB connection makes the
delete `blocked` (what `workspace-db-teardown.test.ts` pins). The lock is never a
*gate* on deletion; the owning tab already holds it. Bonus: the registry lives in
localStorage (`REGISTRY_KEY`), so its cross-tab `storage` event is free and
currently unlistened — a small follow-up inside this mission.

### Phase 3 — true multi-writer: **rejected (scoped out)**

A SharedWorker owning the FS makes every `fs` call a postMessage round-trip:
`isomorphic-git`'s `FsClient` is per-file-op, so one commit is hundreds of RPCs
and `stageAll` hashes the whole tree. That is a rewrite of the `GitStore`
boundary plus a proxy `FsClient`, for a **single-user playground** where two
tabs are an edge — and SharedWorker support is still uneven on mobile. Leader
election *without* a SharedWorker buys nothing over Phase 1 (Web Locks *is*
leader election, with free crash recovery). Revisit only if collaborative
editing becomes a product goal.

## Slices

| # | Slice | Size | Acceptance |
|---|---|---|---|
| 1 | `tab-lock.ts` + injectable `LockManagerLike` + unit suite | **S** | Second acquirer reports `owner:false`; `steal()` fires the first's `onLost`; release on dispose; absent manager → documented fallback stance |
| 2 | `ReadOnlyGitStore` + `writable`/`readOnlyReason` on the sources snapshot; owner-only `startAutoCommit` / `applyGeneratedTree` | **M** | Passive tab's every mutator rejects with `WorkspaceReadOnlyError`; no commit and no generated write reaches IDB from it |
| 3 | Banner + "Take over" in `SourceFilesTree`/`HistoryPanel`; wire acquire/release into `use-workspace.ts` | **M** | Two tabs: 2nd shows "open in another tab", create/rename/delete disabled with that reason; takeover swaps both banners |
| 4 | `tab-channel.ts` + `GitStore.applyRemote` publish/consume | **M** | Owner's write → passive tab's `epoch` bumps and Monaco reseeds; commit → History list refreshes; no self-echo |
| 5 | `deleteWorkspace` broadcast + release ordering; localStorage registry `storage`-event sync | **S** | Delete from the owner completes (`deleted`, not `blocked`) with a second tab open; the second tab drops the workspace from its switcher |

## Test strategy

- **Unit (vitest, node, `fake-indexeddb/auto` — the idiom in
  `test/playground/workspace-db-teardown.test.ts`).** `navigator.locks` does not
  exist in node, which is *why* the manager is injected: `workspace-lock.test.ts`
  ships a ~60-line fake implementing `ifAvailable`/`steal`/`AbortError`;
  `workspace-tab-channel.test.ts` an in-process channel bus keyed by name (no
  self-delivery, gitDb isolation); `workspace-readonly-store.test.ts` pins every
  mutator's rejection. The integration shape that matters — two `GitStore`s over
  the *same* fake-IDB name plus the fake channel, B writes, A's controller
  refreshes and bumps `epoch` — extends `workspace-sources.test.ts` directly.
- **Per-PR Playwright, no-network lane** (`playground-e2e-no-network.yml`; add
  `e2e/workspace-multi-tab.spec.ts` to `SPECS` — the guard step keeps it honest).
  `context.newPage()` gives a second tab in the **same** context — same origin,
  same IDB, same Web Locks manager — so the whole mission is per-PR-testable
  without network: banner on tab 2; edit in tab 1 → tab 2's Monaco follows;
  "Take over" flips both banners; edit in tab 2 → reload tab 1 → the edit is
  there, not clobbered; `page1.close()` → tab 2's banner clears within seconds
  (the crash-recovery property, tested as a plain close).
- **Not covered per-PR:** the no-`navigator.locks` fallback (manual; plus a unit
  test with the injected manager forced to `undefined`). Support floor for both
  APIs is the same — Chrome 69/Firefox 96/**Safari 15.4** — so a browser without
  Web Locks also has no BroadcastChannel, and the fallback must be *one*
  coherent stance, not two.

## Open decision points

1. **Fallback stance** (no Web Locks): keep today's both-writable behaviour with
   a one-time warning, or force read-only-on-second-open off LightningFS's own
   IDB lease? Recommendation: the former — a false read-only on a *single* tab
   is worse than the status quo.
2. **Steal vs. cooperative handoff.** `{steal:true}` is one line and works when
   the owner is wedged, but discards its pending 1.5 s autosave. Option: the
   stealer waits ≤1 s for a `{kind:"yielding"}` ack (owner flushes
   `commitWorkingTree` + `fs.flush()`), then steals regardless.
3. **Session-long lock vs. per-burst.** Session-hold gives a stable owner
   identity and simple UI, but a page holding a Web Lock is **bfcache-ineligible**
   in Chrome. Recommendation: accept it; revisit if back-nav cost shows up.
4. **Passive-tab default:** live read-only (this design) vs. "open a copy" (fork
   via `createWorkspace` + tree copy) — additive, could land later in the banner.
5. Passive tab: keep Generate/preview running locally (pure, in-memory — yes per
   slice 2), or go fully inert to save the mobile main thread?
