// ---------------------------------------------------------------------------
// `WorkspaceSourcesController` — the framework-free core of the
// multi-file `.ddd` editing state.  React-only thin shell lives in
// `use-workspace-sources.ts`.
//
// Pulling the logic out of the hook gives us a unit-testable surface
// (no `renderHook` / `@testing-library/react` needed) and keeps the
// hook's body to "wire controller events to setState".  The contract
// is identical either way — see `use-workspace-sources.ts` for the
// consumer-facing documentation.
// ---------------------------------------------------------------------------

import type { Vfs } from "../vfs/types.js";

const WORKSPACE_PREFIX = "/workspace/";
export const DEFAULT_PATH = "/workspace/main.ddd";

export interface WorkspaceSourcesSnapshot {
  files: ReadonlyMap<string, string>;
  activePath: string;
}

/** True iff `path` is a `.ddd` source under `/workspace/` (not e.g.
 *  a design-pack template under `/workspace/design/...`). */
export function isDddSource(path: string): boolean {
  return path.startsWith(WORKSPACE_PREFIX) && path.endsWith(".ddd");
}

/** Re-derive the `.ddd` source map from the VFS.  Pure projection —
 *  the controller holds no state the VFS doesn't also hold, so a
 *  refresh is always a full re-read (cheap at playground scale). */
export function snapshotSources(vfs: Vfs): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of vfs.list(WORKSPACE_PREFIX)) {
    if (!isDddSource(path)) continue;
    const content = vfs.read(path);
    if (content != null) out.set(path, content);
  }
  return out;
}

/** Pick the next `activePath` when the currently-active file has
 *  been deleted.  Prefers `/workspace/main.ddd` if it still exists,
 *  otherwise the lexicographically-first remaining file, otherwise
 *  `DEFAULT_PATH` (so the editor always has a target even with an
 *  empty workspace). */
export function pickFallbackActivePath(remainingPaths: Iterable<string>): string {
  const sorted = [...remainingPaths].sort();
  if (sorted.includes(DEFAULT_PATH)) return DEFAULT_PATH;
  return sorted[0] ?? DEFAULT_PATH;
}

/** Listener fired whenever `files` or `activePath` changes.  The
 *  controller snapshots both into the event so consumers don't have
 *  to read the controller getters after the event fires (avoids
 *  inconsistencies if a second change lands synchronously). */
export type WorkspaceSourcesListener = (snapshot: WorkspaceSourcesSnapshot) => void;

/** Framework-free state container.  Subscribes to a `Vfs` for
 *  external changes and exposes write / delete / set-active
 *  operations.  React shell is `useWorkspaceSources`; consumers
 *  outside React (e2e automation, tests) can drive this directly. */
export class WorkspaceSourcesController {
  private files: ReadonlyMap<string, string>;
  private activePath: string = DEFAULT_PATH;
  private readonly listeners = new Set<WorkspaceSourcesListener>();
  private unsubscribeVfs: (() => void) | null = null;

  constructor(private readonly vfs: Vfs | null) {
    this.files = vfs ? snapshotSources(vfs) : new Map();
    if (vfs) {
      this.unsubscribeVfs = vfs.subscribe(WORKSPACE_PREFIX, () => {
        this.files = snapshotSources(vfs);
        this.emit();
      });
    }
  }

  /** Tear down the VFS subscription.  Idempotent. */
  dispose(): void {
    if (this.unsubscribeVfs) {
      this.unsubscribeVfs();
      this.unsubscribeVfs = null;
    }
    this.listeners.clear();
  }

  /** Subscribe to changes.  Returns an unsubscribe function. */
  subscribe(listener: WorkspaceSourcesListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot the current state.  Immutable — the returned map is
   *  the same identity for repeated calls until the next change. */
  snapshot(): WorkspaceSourcesSnapshot {
    return { files: this.files, activePath: this.activePath };
  }

  /** Change which file the editor shows.  Pure UI state, no VFS
   *  touch. */
  setActivePath(path: string): void {
    if (this.activePath === path) return;
    this.activePath = path;
    this.emit();
  }

  /** Write a single file to the VFS.  Throws on non-`.ddd` paths so
   *  design-pack writes don't accidentally route here. */
  write(path: string, content: string): void {
    if (!this.vfs) return;
    if (!isDddSource(path)) {
      throw new Error(
        `WorkspaceSourcesController.write: path must be a /workspace/*.ddd path; got "${path}"`,
      );
    }
    this.vfs.write(path, content);
    // The VFS subscription will fire and refresh `files`; the emit
    // happens there, not here, to coalesce with any other writes
    // batched into the same notification.
  }

  /** Delete a file from the VFS.  If the active file was deleted,
   *  re-points `activePath` to the fallback before emitting so
   *  consumers see a consistent snapshot. */
  delete(path: string): void {
    if (!this.vfs) return;
    const wasActive = this.activePath === path;
    this.vfs.delete(path);
    if (wasActive) {
      const remaining = [...this.files.keys()].filter((p) => p !== path);
      this.activePath = pickFallbackActivePath(remaining);
      // Emit immediately so the activePath update lands at the same
      // time as the files update (the VFS-driven refresh fires
      // synchronously inside vfs.delete, so files is already
      // current).
      this.emit();
    }
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }
}
