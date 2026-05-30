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
//
// Empty folders are tracked through the VFS's first-class `mkdir` /
// `rmdir` / `listDirs` surface (introduced in the VFS-directories
// refactor) — no sentinel files leak into the workspace.  A folder
// that contains a `.ddd` file is implicit (no dir entry needed; the
// file's path carries the folder structure); a folder explicitly
// created via the "New folder" UI lives as a real `kind:"dir"` entry
// in the VFS until either the user removes it or a real `.ddd` child
// appears inside it (in which case the explicit dir entry becomes
// redundant — the controller silently drops the "empty" flag on the
// next snapshot).
// ---------------------------------------------------------------------------

import type { GitStore } from "./git/index.js";

const WORKSPACE_PREFIX = "/workspace/";
export const DEFAULT_PATH = "/workspace/main.ddd";

/** Generated output (machine-owned, under `/workspace/generated/`) is
 *  never a `.ddd` source nor a user-created empty folder, so the source
 *  scans prune it — important because it can be the largest subtree and
 *  these scans run on every autosave. */
const GENERATED_SUBTREE = "/workspace/generated";
const SKIP_GENERATED = { skip: [GENERATED_SUBTREE] } as const;

export interface WorkspaceSourcesSnapshot {
  files: ReadonlyMap<string, string>;
  /** Workspace-relative folder paths that exist as empty folders
   *  — folders that have a real VFS dir entry but no `.ddd`
   *  descendants.  Folders that contain at least one `.ddd` file
   *  are NOT listed here — they're already visible via `files`.
   *  Workspace-relative form, no leading slash: `shared`,
   *  `audit/log`, … */
  emptyFolders: ReadonlySet<string>;
  activePath: string;
}

/** True iff `path` is a `.ddd` source under `/workspace/` (not e.g.
 *  a design-pack template under `/workspace/design/...`). */
export function isDddSource(path: string): boolean {
  return path.startsWith(WORKSPACE_PREFIX) && path.endsWith(".ddd");
}

/** Re-derive the `.ddd` source map from the git store.  Pure
 *  projection — the controller holds no state the store doesn't also
 *  hold, so a refresh is always a full re-read (cheap at playground
 *  scale).  Async because the git store's reads are async. */
export async function snapshotSources(store: GitStore): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of await store.list(WORKSPACE_PREFIX, SKIP_GENERATED)) {
    if (!isDddSource(path)) continue;
    const content = await store.readFile(path);
    if (content != null) out.set(path, content);
  }
  return out;
}

/** Re-derive the empty-folder set: every workspace dir entry that
 *  has no `.ddd` descendants.  A folder gains a `.ddd` child →
 *  silently drops out of the set on the next snapshot (the
 *  explicit dir entry stays in the store but is no longer "empty"
 *  from the workspace UI's POV). */
export async function snapshotEmptyFolders(store: GitStore): Promise<Set<string>> {
  // Prune the generated subtree: its dirs aren't user-created empty
  // folders, and its files aren't `.ddd` sources.
  const dirs = await store.listDirs(WORKSPACE_PREFIX, SKIP_GENERATED);
  if (dirs.length === 0) return new Set();
  // Mark every folder that has a `.ddd` descendant — those are not
  // empty for our purposes even though they have a real dir entry.
  const populatedFolders = new Set<string>();
  for (const path of await store.list(WORKSPACE_PREFIX, SKIP_GENERATED)) {
    if (!isDddSource(path)) continue;
    const rel = path.slice(WORKSPACE_PREFIX.length);
    let parent = rel;
    while (true) {
      const slash = parent.lastIndexOf("/");
      if (slash < 0) break;
      parent = parent.slice(0, slash);
      populatedFolders.add(parent);
    }
  }
  const out = new Set<string>();
  for (const dirPath of dirs) {
    const rel = dirPath.slice(WORKSPACE_PREFIX.length);
    // Exclude the bare `/workspace` ancestor that mkdirp materialises
    // implicitly — it's not a user-created empty folder.
    if (rel === "") continue;
    if (!populatedFolders.has(rel)) out.add(rel);
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

/** Listener fired whenever `files`, `emptyFolders`, or `activePath`
 *  changes.  The controller snapshots all of these into the event
 *  so consumers don't have to read the controller getters after
 *  the event fires (avoids inconsistencies if a second change
 *  lands synchronously). */
export type WorkspaceSourcesListener = (snapshot: WorkspaceSourcesSnapshot) => void;

/** Framework-free state container.  Subscribes to a `GitStore` for
 *  external changes and exposes write / delete / set-active
 *  operations.  React shell is `useWorkspaceSources`; consumers
 *  outside React (e2e automation, tests) can drive this directly.
 *
 *  The store is async, but the controller keeps a **resident, sync
 *  snapshot** (`files` / `emptyFolders` / `activePath`) so `snapshot`
 *  and `subscribe` stay synchronous — the LSP sync and the editor read
 *  them on the render path.  Mutators are async (they await the store);
 *  reads of the resident snapshot are not.  `ready` resolves once the
 *  initial async refresh has populated the snapshot. */
export class WorkspaceSourcesController {
  private files: ReadonlyMap<string, string> = new Map();
  private emptyFolders: ReadonlySet<string> = new Set();
  private activePath: string = DEFAULT_PATH;
  private readonly listeners = new Set<WorkspaceSourcesListener>();
  private unsubscribeStore: (() => void) | null = null;
  private disposed = false;
  /** Monotonic refresh ticket.  A mutation kicks an explicit refresh and
   *  the store subscription kicks another; the highest ticket wins, so a
   *  slower earlier read can't clobber the resident snapshot with stale
   *  data (the async-refresh race). */
  private refreshSeq = 0;
  private readonly readyPromise: Promise<void>;

  constructor(private readonly store: GitStore | null) {
    if (store) {
      // External changes (pack imports, another writer) drive a
      // refresh too — the mutators below also refresh explicitly so
      // their post-state is current before they resolve.
      this.unsubscribeStore = store.subscribe(WORKSPACE_PREFIX, () => {
        void this.refresh();
      });
      this.readyPromise = this.refresh();
    } else {
      this.readyPromise = Promise.resolve();
    }
  }

  /** Resolves once the initial snapshot has been read from the store
   *  (immediately when there is no store).  Consumers that need the
   *  resident snapshot populated — tests, mostly — await this. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Re-read the resident snapshot from the store and emit.  Skipped
   *  after dispose so a late-arriving git event can't resurrect a
   *  torn-down controller. */
  private async refresh(): Promise<void> {
    if (!this.store || this.disposed) return;
    const seq = ++this.refreshSeq;
    const [files, emptyFolders] = await Promise.all([
      snapshotSources(this.store),
      snapshotEmptyFolders(this.store),
    ]);
    // Drop this result if a newer refresh started while we were reading —
    // it observed at least as recent a state and will emit.
    if (this.disposed || seq !== this.refreshSeq) return;
    this.files = files;
    this.emptyFolders = emptyFolders;
    this.emit();
  }

  /** Tear down the store subscription.  Idempotent. */
  dispose(): void {
    this.disposed = true;
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
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

  /** Snapshot the current resident state.  Synchronous — the returned
   *  map is the same identity for repeated calls until the next
   *  change. */
  snapshot(): WorkspaceSourcesSnapshot {
    return {
      files: this.files,
      emptyFolders: this.emptyFolders,
      activePath: this.activePath,
    };
  }

  /** Change which file the editor shows.  Pure UI state, no store
   *  touch. */
  setActivePath(path: string): void {
    if (this.activePath === path) return;
    this.activePath = path;
    this.emit();
  }

  /** Write a single file to the store and refresh.  Throws on
   *  non-`.ddd` paths so design-pack writes don't accidentally route
   *  here. */
  async write(path: string, content: string): Promise<void> {
    if (!isDddSource(path)) {
      throw new Error(
        `WorkspaceSourcesController.write: path must be a /workspace/*.ddd path; got "${path}"`,
      );
    }
    if (!this.store) return;
    await this.store.writeFile(path, content);
    await this.refresh();
  }

  /** Create an empty folder via the store's first-class `mkdir`.
   *  `folder` is workspace-relative (no leading slash, e.g.
   *  `shared` or `audit/log`).  `mkdir` is mkdirp + idempotent. */
  async createEmptyFolder(folder: string): Promise<void> {
    const cleaned = folder.replace(/^\/+/, "").replace(/\/+$/, "");
    if (cleaned === "") {
      throw new Error(
        `WorkspaceSourcesController.createEmptyFolder: folder name is required`,
      );
    }
    if (!this.store) return;
    await this.store.mkdir(`${WORKSPACE_PREFIX}${cleaned}`);
    await this.refresh();
  }

  /** Delete a file from the store.  If the active file was deleted,
   *  re-points `activePath` to the fallback after the refresh so
   *  consumers see a consistent snapshot. */
  async delete(path: string): Promise<void> {
    if (!this.store) return;
    const wasActive = this.activePath === path;
    await this.store.deleteFile(path);
    await this.refresh();
    if (wasActive) {
      // Filter the deleted path out explicitly rather than trusting the
      // refresh to have already dropped it — the refresh can be superseded
      // by a concurrent event under the sequence guard.
      const remaining = [...this.files.keys()].filter((p) => p !== path);
      this.activePath = pickFallbackActivePath(remaining);
      this.emit();
    }
  }

  /** Delete an empty folder via the store's `rmdir`.  Throws if the
   *  folder still has `.ddd` content inside (the store enforces
   *  this).  No-op when the folder doesn't exist or is a file path.
   *  Workspace-relative form (`shared`, `audit/log`). */
  async deleteEmptyFolder(folder: string): Promise<void> {
    const cleaned = folder.replace(/^\/+/, "").replace(/\/+$/, "");
    if (cleaned === "") return;
    if (!this.store) return;
    await this.store.rmdir(`${WORKSPACE_PREFIX}${cleaned}`);
    await this.refresh();
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }
}
