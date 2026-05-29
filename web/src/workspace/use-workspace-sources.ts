// ---------------------------------------------------------------------------
// `useWorkspaceSources` — React hook owning the multi-file editing
// state for `.ddd` sources under `/workspace/`.
//
// Phase 2a of the playground multi-file work.  Today's playground
// edits exactly one file (`/workspace/main.ddd`); this hook is the
// machinery that Phase 2b's tabs UI will drive.  Wiring App.tsx
// through this is deliberately deferred — Phase 2a ships only the
// hook + tests so the state model + VFS-sync contract is locked
// down before the visible UI lands.
//
// The interesting state lives in `WorkspaceSourcesController`
// (framework-free, unit-tested in `test/playground/workspace-sources.test.ts`).
// This hook is a thin shell that owns the controller's lifetime and
// pumps its snapshots into React state.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitStore } from "./git/index.js";
import {
  WorkspaceSourcesController,
  type WorkspaceSourcesSnapshot,
} from "./workspace-sources.js";

function reportWorkspaceError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.error("workspace operation failed:", err);
}

export interface WorkspaceSourcesState extends WorkspaceSourcesSnapshot {}

export interface WorkspaceSourcesApi extends WorkspaceSourcesState {
  /** Change which file the editor shows.  Pure UI state — does not
   *  touch the VFS. */
  setActivePath(path: string): void;
  /** Write a single file to the VFS.  Subscription will re-emit and
   *  `files` will update on the next render. */
  write(path: string, content: string): void;
  /** Delete a file from the VFS.  If the active file was deleted,
   *  the hook re-points `activePath` to a fallback so the editor
   *  always has a valid target. */
  delete(path: string): void;
  /** Create an empty folder via the VFS's first-class `mkdir`.
   *  `folder` is workspace-relative (no leading slash, e.g.
   *  `shared`).  `mkdir` is mkdirp + idempotent. */
  createEmptyFolder(folder: string): void;
  /** Delete an empty folder via the VFS's `rmdir`.  Throws if the
   *  folder still has `.ddd` content inside (VFS enforces non-empty
   *  protection); no-op when the folder doesn't exist. */
  deleteEmptyFolder(folder: string): void;
  /** The underlying controller — exposed for non-React consumers that
   *  need to subscribe outside the React render cycle (e.g. the LSP
   *  workspace sync, which pushes every workspace `.ddd` into Monaco
   *  models so the language server sees the full project). */
  controller: WorkspaceSourcesController;
}

export function useWorkspaceSources(store: GitStore | null): WorkspaceSourcesApi {
  // Construct a fresh controller whenever the store identity changes
  // (typically: null → GitStore at boot).  The cleanup tears down its
  // store subscription so we don't leak when the parent unmounts.
  const controller = useMemo(() => new WorkspaceSourcesController(store), [store]);
  useEffect(() => () => controller.dispose(), [controller]);

  const [snapshot, setSnapshot] = useState<WorkspaceSourcesSnapshot>(() =>
    controller.snapshot(),
  );

  useEffect(() => {
    setSnapshot(controller.snapshot());
    return controller.subscribe(setSnapshot);
  }, [controller]);

  // The controller's mutators are async (they await the git store);
  // the hook exposes fire-and-forget void wrappers so existing call
  // sites (autosave, example seed) stay synchronous.  Errors surface
  // via the console rather than an unhandled rejection.
  const setActivePath = useCallback(
    (path: string) => controller.setActivePath(path),
    [controller],
  );
  const write = useCallback(
    (path: string, content: string) => {
      void controller.write(path, content).catch(reportWorkspaceError);
    },
    [controller],
  );
  const del = useCallback(
    (path: string) => {
      void controller.delete(path).catch(reportWorkspaceError);
    },
    [controller],
  );
  const createEmptyFolder = useCallback(
    (folder: string) => {
      void controller.createEmptyFolder(folder).catch(reportWorkspaceError);
    },
    [controller],
  );
  const deleteEmptyFolder = useCallback(
    (folder: string) => {
      void controller.deleteEmptyFolder(folder).catch(reportWorkspaceError);
    },
    [controller],
  );

  return useMemo(
    () => ({
      files: snapshot.files,
      emptyFolders: snapshot.emptyFolders,
      activePath: snapshot.activePath,
      setActivePath,
      write,
      delete: del,
      createEmptyFolder,
      deleteEmptyFolder,
      controller,
    }),
    [snapshot, setActivePath, write, del, createEmptyFolder, deleteEmptyFolder, controller],
  );
}
