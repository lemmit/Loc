// ---------------------------------------------------------------------------
// `useWorkspace` — React hook owning the active git-backed workspace store
// AND the multi-workspace registry on top of it.
//
// Each workspace is its own isolated, IndexedDB-backed git repo (one
// LightningFS DB per workspace).  Content inside every workspace still lives
// at `/workspace/...`, so switching workspaces is just "open a different
// store" — every existing path-based consumer is untouched.  The registry
// (workspace list + active id) persists separately in localStorage; the
// active workspace's store opens (and re-opens) here.
//
// Switching workspaces drops `store` to `null` while the new one opens.
// `useWorkspaceSources` rebuilds its controller on store identity change, so
// this single transition cleanly reseats the editor, VFS, and (via App's
// build-client respawn) the generation pipeline — no cross-workspace bleed.
//
// The hook does NOT own:
//   - The example-dropdown / import UX — that's editor-side, in App.tsx.
//   - The replay-to-worker effect — that depends on `buildClientReady`,
//     a build-pipeline concern.  App.tsx wires the two together.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VfsPath } from "../vfs/types.js";
import { requestPersistentStorage } from "../vfs/legacy-idb.js";
import {
  closeGitFs,
  DEFAULT_GIT_DB,
  deleteGitDb,
  type GitFs,
  GitStore,
  openGitFs,
} from "./git/index.js";
import { importLegacyIdbWorkspace } from "./git/import-legacy.js";
import {
  activeWorkspace,
  addWorkspace,
  loadRegistry,
  REGISTRY_KEY,
  removeWorkspace as removeWorkspaceFromRegistry,
  renameWorkspace as renameWorkspaceInRegistry,
  saveRegistry,
  setActive,
  type WorkspaceMeta,
  type WorkspaceRegistry,
} from "./registry.js";
import {
  openWorkspaceChannel,
  postWorkspaceMessage,
  type WorkspaceTabChannel,
  type WorkspaceTabMessage,
} from "./tab-channel.js";
import { acquireWriterLock, type WorkspaceWriterLock } from "./tab-lock.js";
import type { WorkspaceReadOnlyReason } from "./workspace-sources.js";

/** Fan-out target for a whole-tree invalidation (a role flip, where we know
 *  *something* may have moved but not what).  Normalises to `/workspace`, so
 *  every `/workspace`-prefixed subscriber matches. */
const WORKSPACE_ROOT: VfsPath = "/workspace";

/** True when two registry workspace LISTS are the same.  Load-bearing for the
 *  cross-tab `storage` sync below: `activeId` is deliberately per-tab, so
 *  adopting a remote registry unconditionally would make two tabs ping-pong
 *  `activeId` writes forever.  Re-emitting only on a real list change breaks
 *  that cycle (the second tab sees an identical list and writes nothing). */
function sameWorkspaceList(a: WorkspaceMeta[], b: WorkspaceMeta[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((w, i) => {
    const o = b[i];
    return o !== undefined && o.id === w.id && o.name === w.name && o.gitDb === w.gitDb;
  });
}

export interface WorkspaceState {
  /** The active workspace's git store once it has opened.  `null` while
   *  loading / switching; stays `null` indefinitely if storage is
   *  unavailable (Safari private mode, hostile storage policies), in which
   *  case `loaded` flips to `true` and the playground runs ephemerally. */
  store: GitStore | null;
  /** True once the open-or-fail decision for the active workspace has been
   *  made.  Consumers gate workspace-dependent effects on this rather than
   *  `store` directly, so they fire even when persistence is unavailable. */
  loaded: boolean;
  /** Content of the active workspace's `/workspace/main.ddd` at open time.
   *  App.tsx uses it to seed the editor for the active workspace. */
  persistedSource: string | null;

  // -- multi-workspace surface ------------------------------------------
  /** All known workspaces, in creation order. */
  workspaces: WorkspaceMeta[];
  /** The active workspace's id. */
  activeId: string;
  /** The active workspace's display name. */
  activeName: string;
  /** Make `id` the active workspace (opens its store). */
  switchWorkspace(id: string): void;
  /** Create a new (empty) workspace and switch to it.  Returns its meta. */
  createWorkspace(name: string): WorkspaceMeta;
  /** Rename a workspace by id. */
  renameWorkspace(id: string, name: string): void;
  /** Delete a workspace by id (no-op for the last remaining one). */
  deleteWorkspace(id: string): void;

  // -- multi-tab write coordination (M-T8.12) ---------------------------
  /** Whether THIS tab may write to the active workspace.  False when the
   *  workspace is open in another tab that holds its writer lock, and while
   *  storage is unavailable entirely. */
  writable: boolean;
  /** Which read-only condition applies, or `null` when writable. */
  readOnlyReason: WorkspaceReadOnlyReason | null;
  /** Take the writer lock from the tab that currently holds it.  That tab
   *  flips to read-only (it does NOT keep writing) and this one becomes the
   *  writer, with no reload on either side. */
  takeOver(): void;
}

export interface UseWorkspaceOptions {
  /** A `#view=1` render (M-T8.23 slice 2).  The hook then opens NO store and
   *  acquires NO writer lock, so following a shared link cannot take a
   *  colleague's session away from them or persist anything into their
   *  browser — the read-only mode is structural, not a disabled button.
   *  `readOnlyReason` reads `"view"` so the UI says which read-only it is. */
  viewOnly?: boolean;
}

export function useWorkspace({ viewOnly = false }: UseWorkspaceOptions = {}): WorkspaceState {
  const [registry, setRegistry] = useState<WorkspaceRegistry>(() => loadRegistry());
  const registryRef = useRef(registry);
  registryRef.current = registry;

  const [store, setStore] = useState<GitStore | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [persistedSource, setPersistedSource] = useState<string | null>(null);
  /** Does this tab hold the ACTIVE workspace's writer lock?  Optimistically
   *  true so the very first render (before the lock resolves) never flashes a
   *  read-only banner at the overwhelmingly common single-tab user. */
  const [owner, setOwner] = useState(true);

  const active = activeWorkspace(registry);

  // The active workspace's lock + broadcast channel, so `takeOver` and
  // `deleteWorkspace` (both outside the open effect) can reach them.
  const lockRef = useRef<WorkspaceWriterLock | null>(null);
  const channelRef = useRef<WorkspaceTabChannel | null>(null);
  const storeRef = useRef<GitStore | null>(null);
  storeRef.current = store;
  const activeGitDbRef = useRef(active.gitDb);
  activeGitDbRef.current = active.gitDb;

  // Every LightningFS this tab has opened, keyed by IDB name.  A workspace
  // delete must CLOSE the connection before `indexedDB.deleteDatabase`
  // (an open one makes the delete `blocked` — it then never completes and
  // the DB is orphaned), and the open effect's cleanup closes the one it
  // opened when the active workspace switches away.
  const openFsRef = useRef(new Map<string, GitFs>());

  // Persist the registry whenever it changes.  Best-effort inside
  // `saveRegistry`, so a hostile-storage failure can't wedge the session.
  useEffect(() => {
    saveRegistry(registry);
  }, [registry]);

  // Open the active workspace's store whenever the active git DB changes
  // (initial mount, switch, create, or delete that re-points active).
  //
  // This effect also owns the workspace's MULTI-TAB COORDINATION, because it
  // already owns the per-`gitDb` open/close lifecycle: the writer lock and the
  // broadcast channel are acquired and released on exactly the same edges, so
  // `switchWorkspace` hands the lock over for free and two tabs sitting on
  // DIFFERENT workspaces both stay writable.
  useEffect(() => {
    let cancelled = false;
    setStore(null);
    setLoaded(false);
    setPersistedSource(null);
    setOwner(true);
    // A view link opens nothing: no IndexedDB connection, no writer lock, no
    // broadcast channel.  `loaded` still flips so every consumer that gates on
    // "the open-or-fail decision has been made" proceeds.
    if (viewOnly) {
      setLoaded(true);
      return;
    }
    const dbName = active.gitDb;
    // Mutable, because the async open below and the sync cleanup both need to
    // reach whatever has been created SO FAR (the cleanup can run mid-open).
    const held: {
      lock: WorkspaceWriterLock | null;
      channel: WorkspaceTabChannel | null;
      store: GitStore | null;
    } = { lock: null, channel: null, store: null };
    let torn = false;
    const teardown = (): void => {
      if (torn) return;
      torn = true;
      held.store?.setTabPublisher(null);
      held.channel?.close();
      held.lock?.release();
      if (lockRef.current === held.lock) lockRef.current = null;
      if (channelRef.current === held.channel) channelRef.current = null;
      // Switching away: release this workspace's IDB connection so a later
      // delete of it isn't blocked (LightningFS re-activates transparently
      // if anything still holds the store and touches it).
      const gfs = openFsRef.current.get(dbName);
      if (gfs) {
        openFsRef.current.delete(dbName);
        void closeGitFs(gfs);
      }
    };

    const onMessage = (message: WorkspaceTabMessage): void => {
      const s = held.store;
      if (s === null || cancelled) return;
      switch (message.kind) {
        case "files":
          void s.applyRemote(message.paths as VfsPath[]);
          break;
        case "commit":
          void s.applyRemoteCommit(message.oid);
          break;
        case "role":
          // Somebody took (or released) the lock — our view may predate
          // whatever they wrote on the way, so re-read the whole tree.
          void s.applyRemote([WORKSPACE_ROOT]);
          break;
        case "deleted": {
          // The owner is about to `indexedDB.deleteDatabase` this workspace;
          // an open connection here would make that fire `blocked` forever.
          const gfs = openFsRef.current.get(dbName);
          if (gfs) {
            openFsRef.current.delete(dbName);
            void closeGitFs(gfs);
          }
          held.store = null;
          setStore(null);
          break;
        }
      }
    };

    void (async () => {
      try {
        // Lock FIRST, before the filesystem is touched: `openGitFs` itself
        // writes (`git.init` + the `/workspace` mkdir) on a fresh DB.
        const lock = await acquireWriterLock(dbName, {
          onOwnerChange: (isOwner) => {
            if (cancelled) return;
            held.store?.setWritable(isOwner);
            setOwner(isOwner);
            // Tell the other tabs the role moved so they re-read; the tab
            // that just LOST the lock announces it too, which is how the new
            // owner learns to refresh before its first write.
            held.channel?.post({ kind: "role", owner: isOwner });
          },
        });
        held.lock = lock;
        lockRef.current = lock;
        if (cancelled) {
          teardown();
          return;
        }
        const gfs = await openGitFs(dbName);
        openFsRef.current.set(dbName, gfs);
        const s = new GitStore(gfs);
        s.setWritable(lock.owner);
        held.store = s;
        const channel = openWorkspaceChannel(dbName, { onMessage });
        held.channel = channel;
        channelRef.current = channel;
        // Publish LOCAL changes to the other tabs.  Installed regardless of
        // role: only the owner can produce writes, and `applyRemote*`
        // bypasses the publisher, so a received invalidation can never echo.
        s.setTabPublisher({
          files: (paths) => channel.post({ kind: "files", paths: [...paths] }),
          commit: (oid) => channel.post({ kind: "commit", oid }),
        });
        if (cancelled) {
          teardown();
          return;
        }
        // The legacy pre-git IndexedDB workspace only belongs in the
        // original default store; importing it into a freshly-created
        // workspace would duplicate that content.  A read-only tab must not
        // run it at all — it is a write.
        if (active.gitDb === DEFAULT_GIT_DB && s.writable) {
          await importLegacyIdbWorkspace(s);
        }
        if (cancelled) return;
        // Best-effort persistent-storage request — browsers may evict
        // IndexedDB (and thus the git store) under pressure otherwise.
        void requestPersistentStorage();
        const persisted = await s.readFile("/workspace/main.ddd");
        if (cancelled) return;
        setPersistedSource(persisted ?? null);
        setOwner(lock.owner);
        setStore(s);
        setLoaded(true);
      } catch (err) {
        // Hostile-storage fallback: surface once and keep running in
        // ephemeral mode.  Consumers no-op when `store` is null.
        // eslint-disable-next-line no-console
        console.warn("workspace git store unavailable:", err);
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
      teardown();
    };
  }, [active.gitDb, viewOnly]);

  /** "Take over": steal the writer lock.  The old holder's held request
   *  rejects with `AbortError`, which flips IT to read-only — the point of
   *  stealing over asking is that it also works when that tab is wedged. */
  const takeOver = useCallback((): void => {
    const lock = lockRef.current;
    if (lock === null || lock.owner) return;
    void lock.steal().then((got) => {
      if (!got) return;
      // Our LightningFS view can be a whole git sequence behind the tab we
      // just took over from — re-read before anything here writes.
      void storeRef.current?.applyRemote([WORKSPACE_ROOT]);
    });
  }, []);

  const switchWorkspace = useCallback((id: string): void => {
    setRegistry((r) => setActive(r, id));
  }, []);

  const createWorkspace = useCallback((name: string): WorkspaceMeta => {
    const { reg, meta } = addWorkspace(registryRef.current, name);
    setRegistry(reg);
    return meta;
  }, []);

  const renameWorkspace = useCallback((id: string, name: string): void => {
    setRegistry((r) => renameWorkspaceInRegistry(r, id, name));
  }, []);

  const deleteWorkspace = useCallback((id: string): void => {
    const removed = registryRef.current.workspaces.find((w) => w.id === id);
    const wasActive = registryRef.current.activeId === id;
    // Drop the store BEFORE the registry update so consumers stop issuing
    // reads against the workspace we're about to tear down (the open effect
    // would clear it anyway once the new active workspace opens, but that
    // is a render later — the teardown below starts on this microtask).
    if (wasActive) setStore(null);
    setRegistry((r) => removeWorkspaceFromRegistry(r, id));
    // Best-effort: drop the deleted workspace's backing IndexedDB so it
    // doesn't linger.  Never touch the legacy DB (it may still back the
    // default workspace under a different id in some migration paths).
    if (!removed || removed.gitDb === DEFAULT_GIT_DB) return;
    // Our own writer lock for this workspace, captured NOW: the registry
    // update above re-points `active`, so by the time the async teardown runs
    // `lockRef` may already hold the NEXT workspace's lock.
    const ownLock = removed.gitDb === activeGitDbRef.current ? lockRef.current : null;
    void (async () => {
      // Tell every OTHER tab holding this workspace to drop its IndexedDB
      // connection.  Without this the delete below only ever fires `blocked`
      // (what `workspace-db-teardown.test.ts` pins) and the DB is orphaned.
      postWorkspaceMessage(removed.gitDb, { kind: "deleted" });
      // Close this tab's connection first: `deleteDatabase` against an
      // open one only fires `blocked`, leaving an orphan DB forever.
      const gfs = openFsRef.current.get(removed.gitDb);
      if (gfs) {
        openFsRef.current.delete(removed.gitDb);
        await closeGitFs(gfs);
      }
      const result = await deleteGitDb(removed.gitDb);
      if (result === "blocked" || result === "error") {
        // eslint-disable-next-line no-console
        console.warn(`workspace database "${removed.gitDb}" not deleted (${result})`);
      }
      // The writer lock is never a GATE on deletion — this tab already holds
      // it, so nothing here ever waits on it (no self-deadlock).  It is
      // simply released LAST, once the database it guarded is gone.
      ownLock?.release();
    })();
  }, []);

  // Cross-tab registry sync.  The registry lives in localStorage, so its
  // `storage` event is free — and until now unlistened, which is why a
  // workspace created or deleted in one tab stayed invisible in the other.
  //
  // Only the LIST is adopted: `activeId` is per-tab in spirit (syncing it
  // would yank this tab to whatever the other one is looking at), and
  // re-emitting only on a real list change is what stops two tabs from
  // ping-ponging `activeId` writes at each other forever.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== null && e.key !== REGISTRY_KEY) return;
      const remote = loadRegistry();
      setRegistry((cur) => {
        const keepActive = remote.workspaces.some((w) => w.id === cur.activeId)
          ? cur.activeId
          : remote.activeId;
        if (sameWorkspaceList(cur.workspaces, remote.workspaces) && keepActive === cur.activeId) {
          return cur;
        }
        return { workspaces: remote.workspaces, activeId: keepActive };
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Read-only is one CONCEPT with two reasons: no store at all (ephemeral)
  // or another tab holding the writer lock.  Derived, never stamped.
  const readOnlyReason: WorkspaceReadOnlyReason | null = viewOnly
    ? "view"
    : store === null
      ? loaded
        ? "ephemeral"
        : null
      : owner
        ? null
        : "other-tab";
  const writable = !viewOnly && store !== null && owner;

  // Memoised so the returned object has a STABLE identity between renders that
  // changed nothing here.  App.tsx hands this straight through as
  // `ctx.workspace`; a fresh object per render would defeat the `ctx` memo (and
  // with it every consumer's re-render bailout) no matter how careful the dep
  // list there is.  All four actions are already `useCallback`-stable.
  return useMemo(
    () => ({
      store,
      loaded,
      persistedSource,
      workspaces: registry.workspaces,
      activeId: registry.activeId,
      activeName: active.name,
      switchWorkspace,
      createWorkspace,
      renameWorkspace,
      deleteWorkspace,
      writable,
      readOnlyReason,
      takeOver,
    }),
    [
      store,
      loaded,
      persistedSource,
      registry.workspaces,
      registry.activeId,
      active.name,
      switchWorkspace,
      createWorkspace,
      renameWorkspace,
      deleteWorkspace,
      writable,
      readOnlyReason,
      takeOver,
    ],
  );
}
