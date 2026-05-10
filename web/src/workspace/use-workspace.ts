// ---------------------------------------------------------------------------
// `useWorkspace` — React hook owning the IDB-backed workspace VFS.
//
// Encapsulates the "open IDB → request persistent storage → read
// any persisted source → expose the VFS for downstream consumers"
// flow that App.tsx used to spell out inline.  Returns React-state
// values (not refs) so consumers can reliably re-render when the
// workspace transitions from "loading" to "loaded", and so dependent
// `useEffect` hooks fire at the right moment.
//
// The hook does NOT own:
//   - The example-dropdown UX state — that's editor-side, stays in
//     App.tsx.
//   - The replay-to-worker effect — that depends on `buildClientReady`
//     which is a build-pipeline concern, not a workspace concern.
//     App.tsx wires the two together.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { IdbVfs, requestPersistentStorage } from "../vfs/idb-vfs.js";

export interface WorkspaceState {
  /** The IdbVfs instance once the IDB connection has resolved.
   *  `null` while loading; stays `null` indefinitely if IDB is
   *  unavailable (Safari private mode, hostile storage policies),
   *  in which case `loaded` flips to `true` and the playground
   *  runs in ephemeral-only mode. */
  vfs: IdbVfs | null;
  /** True once the open-or-fail decision has been made.  Consumers
   *  gate workspace-dependent effects on this rather than `vfs`
   *  directly, so they fire even when persistence is unavailable. */
  loaded: boolean;
  /** Content of `/workspace/main.ddd` if present in IDB at boot.
   *  App.tsx surfaces this as the "Workspace (autosaved)" example. */
  persistedSource: string | null;
}

export function useWorkspace(): WorkspaceState {
  const [vfs, setVfs] = useState<IdbVfs | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [persistedSource, setPersistedSource] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const opened = await IdbVfs.open();
        if (cancelled) return;
        // Best-effort persistent-storage request — browsers may
        // evict IDB under storage pressure otherwise.  Fire-and-
        // forget; the grant prompt (if any) is the user's call.
        void requestPersistentStorage();
        const persisted = opened.read("/workspace/main.ddd");
        if (persisted) setPersistedSource(persisted);
        setVfs(opened);
        setLoaded(true);
      } catch (err) {
        // Hostile-storage fallback: surface the failure once and
        // let the playground keep running in ephemeral mode.  The
        // PackPicker / WorkspaceTree gracefully no-op when `vfs`
        // is null; auto-save typing still works (just doesn't
        // persist across reload).
        // eslint-disable-next-line no-console
        console.warn("workspace VFS unavailable:", err);
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { vfs, loaded, persistedSource };
}
