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

import { useCallback, useEffect, useRef, useState } from "react";
import { requestPersistentStorage } from "../vfs/legacy-idb.js";
import { DEFAULT_GIT_DB, GitStore, openGitFs } from "./git/index.js";
import { importLegacyIdbWorkspace } from "./git/import-legacy.js";
import {
  activeWorkspace,
  addWorkspace,
  loadRegistry,
  removeWorkspace as removeWorkspaceFromRegistry,
  renameWorkspace as renameWorkspaceInRegistry,
  saveRegistry,
  setActive,
  type WorkspaceMeta,
  type WorkspaceRegistry,
} from "./registry.js";

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
}

export function useWorkspace(): WorkspaceState {
  const [registry, setRegistry] = useState<WorkspaceRegistry>(() => loadRegistry());
  const registryRef = useRef(registry);
  registryRef.current = registry;

  const [store, setStore] = useState<GitStore | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [persistedSource, setPersistedSource] = useState<string | null>(null);

  const active = activeWorkspace(registry);

  // Persist the registry whenever it changes.  Best-effort inside
  // `saveRegistry`, so a hostile-storage failure can't wedge the session.
  useEffect(() => {
    saveRegistry(registry);
  }, [registry]);

  // Open the active workspace's store whenever the active git DB changes
  // (initial mount, switch, create, or delete that re-points active).
  useEffect(() => {
    let cancelled = false;
    setStore(null);
    setLoaded(false);
    setPersistedSource(null);
    void (async () => {
      try {
        const gfs = await openGitFs(active.gitDb);
        const s = new GitStore(gfs);
        // The legacy pre-git IndexedDB workspace only belongs in the
        // original default store; importing it into a freshly-created
        // workspace would duplicate that content.
        if (active.gitDb === DEFAULT_GIT_DB) {
          await importLegacyIdbWorkspace(s);
        }
        if (cancelled) return;
        // Best-effort persistent-storage request — browsers may evict
        // IndexedDB (and thus the git store) under pressure otherwise.
        void requestPersistentStorage();
        const persisted = await s.readFile("/workspace/main.ddd");
        if (cancelled) return;
        setPersistedSource(persisted ?? null);
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
    };
  }, [active.gitDb]);

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
    setRegistry((r) => removeWorkspaceFromRegistry(r, id));
    // Best-effort: drop the deleted workspace's backing IndexedDB so it
    // doesn't linger.  Never touch the legacy DB (it may still back the
    // default workspace under a different id in some migration paths).
    if (removed && removed.gitDb !== DEFAULT_GIT_DB && typeof indexedDB !== "undefined") {
      try {
        indexedDB.deleteDatabase(removed.gitDb);
      } catch {
        /* connection may still be open; harmless to leave */
      }
    }
  }, []);

  return {
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
  };
}
