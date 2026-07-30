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

/** Why the playground can't persist anything.  Shown verbatim by the
 *  files UI, and mirrors the wording the History panel already uses for
 *  the same condition. */
export const EPHEMERAL_MESSAGE =
  "Persistent storage isn't accessible in this browser, so the playground is " +
  "running in ephemeral mode — file changes can't be saved.";

/** Why this tab can't write even though storage works: another tab holds the
 *  workspace's writer lock (M-T8.12).  Shown by the same disabled affordances
 *  the ephemeral case already drives — the read-only CONCEPT is shared, only
 *  the reason differs. */
export const OTHER_TAB_MESSAGE =
  "This workspace is open in another tab, which is the one making changes — " +
  "so this tab is read-only. Use \u201cTake over\u201d to make this tab the writer.";

/** Why the workspace is read-only, or `null` when it isn't.  Generalises the
 *  old boolean `persistent`: the UI needs to say WHICH read-only it is. */
export type WorkspaceReadOnlyReason = "ephemeral" | "other-tab";

/** The sentence the UI shows for a read-only reason. */
export function readOnlyMessage(reason: WorkspaceReadOnlyReason): string {
  return reason === "ephemeral" ? EPHEMERAL_MESSAGE : OTHER_TAB_MESSAGE;
}

/** The operation a failed mutation was attempting.  Kept coarse (one
 *  value per user-visible affordance) — the UI titles the error with it. */
export type WorkspaceSourcesOp = "write" | "create" | "create-folder" | "delete" | "delete-folder";

/** Last failed mutation, held on the controller so the UI can SAY what
 *  broke.  Before this every rejection was swallowed to `console.error`
 *  in the hook and the user just watched a new file row evaporate. */
export interface WorkspaceSourcesError {
  op: WorkspaceSourcesOp;
  /** The path / folder the operation targeted, when it had one. */
  path?: string;
  message: string;
}

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
  /** Monotonic counter bumped whenever the ACTIVE file's content
   *  changed underneath us — a restore, a pack/legacy import, another
   *  tab.  Own writes (`write`) don't bump it: they land in the
   *  resident snapshot before the store is touched, so the refresh
   *  their notification triggers sees no diff.
   *
   *  Consumers that hold their own copy of the active file's text
   *  (the Monaco buffer) key their reseed on this — without it an
   *  external write is structurally invisible and the next keystroke
   *  writes the stale buffer back over it. */
  epoch: number;
  /** False until the first store read has populated `files`.  Consumers
   *  that hold a SEPARATE, earlier read of the same content (App's
   *  `workspace.persistedSource`, captured once at store-open) must only
   *  fall back to it while this is false — afterwards the controller's
   *  snapshot is authoritative, and an absent file there means deleted,
   *  not "not loaded yet".  Always false without a store. */
  hydrated: boolean;
  /** Whether mutations actually land.  False in ephemeral mode (no store:
   *  hostile storage policies, Safari private mode) AND while another tab
   *  owns the workspace's writer lock — the file UI disables its
   *  create/rename/delete affordances and says why instead of painting rows
   *  that evaporate on the next refresh. */
  writable: boolean;
  /** Which read-only condition applies, or `null` when writable.  The UI
   *  keys its explanatory sentence off this. */
  readOnlyReason: WorkspaceReadOnlyReason | null;
  /** Last failed mutation, or null.  Cleared by `clearError` and by the
   *  next explicit (non-autosave) mutation. */
  lastError: WorkspaceSourcesError | null;
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
  private unsubscribeWritable: (() => void) | null = null;
  private disposed = false;
  /** Monotonic refresh ticket.  A mutation kicks an explicit refresh and
   *  the store subscription kicks another; the highest ticket wins, so a
   *  slower earlier read can't clobber the resident snapshot with stale
   *  data (the async-refresh race). */
  private refreshSeq = 0;
  private epoch = 0;
  /** False until the first refresh has populated the snapshot.  That
   *  first read isn't an external CHANGE (nobody has seen the previous,
   *  empty snapshot as content yet), so it must not bump the epoch — a
   *  boot-time bump would remount the editor over its own seed. */
  private hydrated = false;
  /** Own writes still awaiting the store, per path.  A refresh that
   *  lands inside that window is our own echo, never an external
   *  change — see `write`. */
  private readonly inFlightWrites = new Map<string, number>();
  private lastError: WorkspaceSourcesError | null = null;
  private readonly readyPromise: Promise<void>;

  constructor(private readonly store: GitStore | null) {
    if (store) {
      // External changes (pack imports, another writer) drive a
      // refresh too — the mutators below also refresh explicitly so
      // their post-state is current before they resolve.
      this.unsubscribeStore = store.subscribe(WORKSPACE_PREFIX, () => {
        void this.refresh();
      });
      // A take-over (either direction) changes nothing about the CONTENT but
      // everything about whether the UI may offer to change it — re-emit so
      // the disabled affordances and their explanation flip with the role.
      this.unsubscribeWritable = store.subscribeWritable(() => {
        this.emit();
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
    const before = this.files.get(this.activePath);
    this.files = files;
    this.emptyFolders = emptyFolders;
    const after = files.get(this.activePath);
    if (this.hydrated && after !== before && !this.inFlightWrites.has(this.activePath)) {
      this.epoch++;
    }
    // Externally deleted (restore, another tab): run the same fallback
    // `delete` runs, or `activePath` dangles and the next editor write
    // recreates the file that was just removed.
    if (before !== undefined && after === undefined) {
      this.activePath = pickFallbackActivePath(files.keys());
    }
    this.hydrated = true;
    this.emit();
  }

  /** Tear down the store subscription.  Idempotent. */
  dispose(): void {
    this.disposed = true;
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }
    if (this.unsubscribeWritable) {
      this.unsubscribeWritable();
      this.unsubscribeWritable = null;
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
      epoch: this.epoch,
      hydrated: this.hydrated,
      writable: this.readOnlyReason === null,
      readOnlyReason: this.readOnlyReason,
      lastError: this.lastError,
    };
  }

  /** Why mutations can't land right now, or `null` when they can.  Derived
   *  on demand from the store (never stamped) — the store's writable flag is
   *  flipped by the writer lock and this must not go stale behind it. */
  private get readOnlyReason(): WorkspaceReadOnlyReason | null {
    if (!this.store) return "ephemeral";
    return this.store.writable ? null : "other-tab";
  }

  /** Throw the right explanatory error when a mutation can't land. */
  private assertWritable(): void {
    const reason = this.readOnlyReason;
    if (reason !== null) throw new Error(readOnlyMessage(reason));
  }

  /** Dismiss the last mutation error (the Alert's close button). */
  clearError(): void {
    if (this.lastError === null) return;
    this.lastError = null;
    this.emit();
  }

  /** Record a failed mutation and emit.  Callers still throw (or return
   *  a failure) — this channel REPORTS, it doesn't swallow. */
  private recordError(op: WorkspaceSourcesOp, err: unknown, path?: string): void {
    this.lastError = { op, path, message: err instanceof Error ? err.message : String(err) };
    this.emit();
  }

  /** Run a mutation with the error channel attached.  Every op except
   *  `write` is an explicit user action, so it also clears the previous
   *  error up front — the banner then reflects the LAST thing the user
   *  asked for.  `write` is the autosave hot path and must not, or a
   *  single keystroke would wipe the create failure the user is reading. */
  private async guard<T>(
    op: WorkspaceSourcesOp,
    path: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (op !== "write") this.clearError();
    try {
      return await fn();
    } catch (err) {
      this.recordError(op, err, path);
      throw err;
    }
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
    // Read-only (ephemeral OR another tab owns the writer lock) → drop it
    // silently.  This is the autosave hot path: throwing here would spray a
    // rejection per keystroke, and the banner already says why nothing sticks.
    // The store's own `assertWritable` is the hard backstop for anything that
    // reaches it by another route.
    if (this.readOnlyReason !== null) return;
    return this.guard("write", path, async () => {
      if (!isDddSource(path)) {
        throw new Error(
          `WorkspaceSourcesController.write: path must be a /workspace/*.ddd path; got "${path}"`,
        );
      }
      await this.writeThrough(path, content);
    });
  }

  /** The store-touching half of `write`, without the error-channel
   *  wrapper — shared with `createFile` so each reports under its own op. */
  private async writeThrough(path: string, content: string): Promise<void> {
    if (!this.store) return;
    // Record our own write in the resident snapshot BEFORE touching the
    // store: `writeFile` notifies synchronously, and the refresh that
    // notification drives must see no content diff or it would read our
    // own write as an external change and bump the epoch.  The in-flight
    // count covers the rest of that window — with two writes racing, a
    // refresh can observe the store mid-way and disagree with the
    // resident snapshot without anything external having happened.
    this.files = new Map(this.files).set(path, content);
    this.inFlightWrites.set(path, (this.inFlightWrites.get(path) ?? 0) + 1);
    try {
      await this.store.writeFile(path, content);
    } finally {
      await this.refresh();
      const left = (this.inFlightWrites.get(path) ?? 1) - 1;
      if (left > 0) this.inFlightWrites.set(path, left);
      else this.inFlightWrites.delete(path);
    }
  }

  /** Create a new `.ddd` source seeded with `seed`, then make it active.
   *  Resolves to whether the file was actually created.
   *
   *  Deliberately not "`write` + `setActivePath`" at the call site: a
   *  create is an explicit user action, so it (a) waits for the write to
   *  LAND before re-pointing `activePath` — a failed create must not park
   *  the editor on a file that doesn't exist — (b) refuses in ephemeral
   *  mode instead of painting a tree row the next refresh erases, and
   *  (c) reports either failure on the error channel.  The boolean lets
   *  the caller schedule a regenerate only when something really changed. */
  async createFile(path: string, seed: string): Promise<boolean> {
    if (!isDddSource(path)) {
      this.recordError("create", new Error(`"${path}" is not a /workspace/*.ddd path`), path);
      return false;
    }
    if (this.files.has(path)) {
      this.recordError("create", new Error(`"${path}" already exists`), path);
      return false;
    }
    const reason = this.readOnlyReason;
    if (reason !== null) {
      this.recordError("create", new Error(readOnlyMessage(reason)), path);
      return false;
    }
    try {
      await this.guard("create", path, () => this.writeThrough(path, seed));
    } catch {
      return false; // already on the error channel
    }
    this.setActivePath(path);
    return true;
  }

  /** Create an empty folder via the store's first-class `mkdir`.
   *  `folder` is workspace-relative (no leading slash, e.g.
   *  `shared` or `audit/log`).  `mkdir` is mkdirp + idempotent. */
  async createEmptyFolder(folder: string): Promise<void> {
    return this.guard("create-folder", folder, async () => {
      const cleaned = folder.replace(/^\/+/, "").replace(/\/+$/, "");
      if (cleaned === "") {
        throw new Error(
          `WorkspaceSourcesController.createEmptyFolder: folder name is required`,
        );
      }
      this.assertWritable();
      if (!this.store) return;
      await this.store.mkdir(`${WORKSPACE_PREFIX}${cleaned}`);
      await this.refresh();
    });
  }

  /** Delete a file from the store.  If the active file was deleted,
   *  re-points `activePath` to the fallback after the refresh so
   *  consumers see a consistent snapshot. */
  async delete(path: string): Promise<void> {
    return this.guard("delete", path, async () => {
      this.assertWritable();
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
    });
  }

  /** Delete an empty folder via the store's `rmdir`.  Throws if the
   *  folder still has `.ddd` content inside (the store enforces
   *  this).  No-op when the folder doesn't exist or is a file path.
   *  Workspace-relative form (`shared`, `audit/log`). */
  async deleteEmptyFolder(folder: string): Promise<void> {
    return this.guard("delete-folder", folder, async () => {
      const cleaned = folder.replace(/^\/+/, "").replace(/\/+$/, "");
      if (cleaned === "") return;
      this.assertWritable();
      if (!this.store) return;
      await this.store.rmdir(`${WORKSPACE_PREFIX}${cleaned}`);
      await this.refresh();
    });
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }
}
