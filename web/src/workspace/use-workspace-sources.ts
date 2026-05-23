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
import type { Vfs } from "../vfs/types.js";
import {
  WorkspaceSourcesController,
  type WorkspaceSourcesSnapshot,
} from "./workspace-sources.js";

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
}

export function useWorkspaceSources(vfs: Vfs | null): WorkspaceSourcesApi {
  // Construct a fresh controller whenever the VFS identity changes
  // (typically: null → IdbVfs at boot).  The cleanup tears down its
  // VFS subscription so we don't leak when the parent unmounts.
  const controller = useMemo(() => new WorkspaceSourcesController(vfs), [vfs]);
  useEffect(() => () => controller.dispose(), [controller]);

  const [snapshot, setSnapshot] = useState<WorkspaceSourcesSnapshot>(() =>
    controller.snapshot(),
  );

  useEffect(() => {
    setSnapshot(controller.snapshot());
    return controller.subscribe(setSnapshot);
  }, [controller]);

  const setActivePath = useCallback(
    (path: string) => controller.setActivePath(path),
    [controller],
  );
  const write = useCallback(
    (path: string, content: string) => controller.write(path, content),
    [controller],
  );
  const del = useCallback((path: string) => controller.delete(path), [controller]);
  const createEmptyFolder = useCallback(
    (folder: string) => controller.createEmptyFolder(folder),
    [controller],
  );
  const deleteEmptyFolder = useCallback(
    (folder: string) => controller.deleteEmptyFolder(folder),
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
    }),
    [snapshot, setActivePath, write, del, createEmptyFolder, deleteEmptyFolder],
  );
}
