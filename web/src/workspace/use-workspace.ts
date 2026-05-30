// ---------------------------------------------------------------------------
// `useWorkspace` — React hook owning the git-backed workspace store.
//
// Opens the durable LightningFS + isomorphic-git store, runs the
// one-time legacy-IDB import, requests persistent storage, and reads
// any persisted `/workspace/main.ddd` to surface as the "Workspace
// (autosaved)" example.  Returns React-state values (not refs) so
// consumers re-render when the workspace transitions from "loading" to
// "loaded" and dependent effects fire at the right moment.
//
// The hook does NOT own:
//   - The example-dropdown UX state — that's editor-side, stays in
//     App.tsx.
//   - The replay-to-worker effect — that depends on `buildClientReady`
//     which is a build-pipeline concern, not a workspace concern.
//     App.tsx wires the two together.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { requestPersistentStorage } from "../vfs/idb-vfs.js";
import { GitStore, openGitFs } from "./git/index.js";
import { importLegacyIdbWorkspace } from "./git/import-legacy.js";

export interface WorkspaceState {
  /** The git store once the durable backing has opened.  `null` while
   *  loading; stays `null` indefinitely if storage is unavailable
   *  (Safari private mode, hostile storage policies), in which case
   *  `loaded` flips to `true` and the playground runs ephemerally. */
  store: GitStore | null;
  /** True once the open-or-fail decision has been made.  Consumers
   *  gate workspace-dependent effects on this rather than `store`
   *  directly, so they fire even when persistence is unavailable. */
  loaded: boolean;
  /** Content of `/workspace/main.ddd` if present at boot.  App.tsx
   *  surfaces this as the "Workspace (autosaved)" example. */
  persistedSource: string | null;
}

export function useWorkspace(): WorkspaceState {
  const [store, setStore] = useState<GitStore | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [persistedSource, setPersistedSource] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const gfs = await openGitFs();
        const s = new GitStore(gfs);
        // One-time migration of any pre-git IndexedDB workspace.
        await importLegacyIdbWorkspace(s);
        if (cancelled) return;
        // Best-effort persistent-storage request — browsers may evict
        // IndexedDB (and thus the git store) under pressure otherwise.
        void requestPersistentStorage();
        const persisted = await s.readFile("/workspace/main.ddd");
        if (cancelled) return;
        if (persisted != null) setPersistedSource(persisted);
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
  }, []);

  return { store, loaded, persistedSource };
}
