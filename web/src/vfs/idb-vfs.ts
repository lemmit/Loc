// ---------------------------------------------------------------------------
// IndexedDB-backed VFS for the playground main thread.
//
// Decorates a `MemoryVfs` with transparent IDB persistence.  Reads
// hit the in-memory cache (sync, same contract as MemoryVfs);
// writes/deletes/hydrates queue an IDB write that flushes after a
// short debounce.  Workers stay in-memory and receive deltas from
// the main thread via the build worker's mutate-RPC; persistence
// stays main-thread-only so workers don't fight for IDB locks.
//
// Phase 3 of the IDE refactor.  After this lands, the workspace
// (`/workspace/main.ddd` and any user-supplied `/workspace/design/`
// packs from Phase 4) survives reload.  Built-in themes still seed
// the worker's local VFS at boot via the Vite eager-glob — they
// don't go through IDB because they're already part of the bundle.
//
// Failure model: when IDB is unavailable (Safari private mode,
// hostile storage policies, etc.) `IdbVfs.open` falls back to
// in-memory only and logs a one-shot warning.  Reads/writes still
// work; persistence just doesn't happen.  Callers that need to
// distinguish persistent vs ephemeral check `vfs.persistent`.
//
// Schema note: the store carries `{kind, content?}` objects per
// path now (directories are first-class).  Pre-this-PR builds wrote
// bare strings.  On `open()` we defensive-read both shapes — v1
// strings become `{kind:"file", content}` in memory; subsequent
// writes flush in the new shape, so the DB drifts to v2 organically.
// We deliberately do NOT bump `DB_VERSION` — a rollback to an
// older build must still be able to open the DB (a bump would
// raise `VersionError`).
// ---------------------------------------------------------------------------

import { MemoryVfs } from "./memory-vfs.js";
import type {
  RestorableVfs,
  VfsEntry,
  VfsEntryKind,
  VfsListener,
  VfsPath,
} from "./types.js";

/** Default DB name — namespaced under `loom-` so multiple Loom
 *  apps on the same origin don't collide.  Test code passes a
 *  unique name per test to avoid cross-test contamination. */
const DEFAULT_DB_NAME = "loom-workspace";
const STORE = "entries";
const DB_VERSION = 1;

/** Flush debounce — short enough that a user reload mid-edit picks
 *  up the latest source, long enough that bursty typing collapses
 *  into one IDB write per natural pause. */
const FLUSH_DEBOUNCE_MS = 250;

/** Stored shape in the IDB object store going forward — a tagged
 *  union mirroring `VfsEntry` minus the `path` field (the IDB key
 *  carries it).  The dir variant has no content. */
type IdbValue =
  | { kind: "file"; content: string }
  | { kind: "dir" }
  | string; // legacy v1 — bare-string content, implies file

export class IdbVfs implements RestorableVfs {
  /** True iff the underlying IDB connection succeeded.  When false,
   *  the VFS still works but writes don't survive reload. */
  readonly persistent: boolean;

  private readonly mem: MemoryVfs;
  private readonly db: IDBDatabase | null;
  /** Per-path queued write.  Value semantics:
   *    - `IdbValue` (file or dir):  upsert
   *    - `null`:                    delete
   *  Reset on each flush; merging multiple mutations on the same
   *  path before flush collapses to the last write (correct for
   *  IDB, which is last-writer-wins anyway). */
  private writeQueue = new Map<VfsPath, IdbValue | null>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inflightFlush: Promise<void> | null = null;

  private constructor(mem: MemoryVfs, db: IDBDatabase | null) {
    this.mem = mem;
    this.db = db;
    this.persistent = db != null;
  }

  /** Open (or create) the IDB-backed VFS, hydrating the in-memory
   *  cache from any persisted entries.  Returns an instance that
   *  works identically to `MemoryVfs` from the caller's POV — the
   *  IDB persistence is invisible at the read/write API.  Defensive
   *  read tolerates both v1 (bare string) and v2 (`{kind, ...}`)
   *  stored values so a rollback-then-reopen sequence keeps
   *  working. */
  static async open(dbName: string = DEFAULT_DB_NAME): Promise<IdbVfs> {
    const mem = new MemoryVfs();
    let db: IDBDatabase | null = null;
    try {
      db = await openDb(dbName);
      const entries = await readAllEntries(db);
      // Hydrate without re-queueing IDB writes: the entries already
      // came from IDB.  `mem.hydrate` fans out one notification to
      // listeners, which is fine — at the time of `IdbVfs.open` we
      // have no subscribers yet.
      mem.hydrate(entries);
    } catch (err) {
      console.warn(
        `idb-vfs: persistence unavailable (${err instanceof Error ? err.message : String(err)}).  ` +
          `Falling back to in-memory only — writes won't survive reload.`,
      );
    }
    return new IdbVfs(mem, db);
  }

  // -- Pure read delegation: everything below mirrors MemoryVfs sync. --

  read(path: VfsPath): string | undefined {
    return this.mem.read(path);
  }

  readRequired(path: VfsPath): string {
    return this.mem.readRequired(path);
  }

  exists(path: VfsPath): boolean {
    return this.mem.exists(path);
  }

  isFile(path: VfsPath): boolean {
    return this.mem.isFile(path);
  }

  isDirectory(path: VfsPath): boolean {
    return this.mem.isDirectory(path);
  }

  kindOf(path: VfsPath): VfsEntryKind | undefined {
    return this.mem.kindOf(path);
  }

  list(prefix: VfsPath): ReadonlyArray<VfsPath> {
    return this.mem.list(prefix);
  }

  listDirs(prefix: VfsPath): ReadonlyArray<VfsPath> {
    return this.mem.listDirs(prefix);
  }

  listAll(prefix: VfsPath): ReadonlyArray<VfsPath> {
    return this.mem.listAll(prefix);
  }

  subscribe(prefix: VfsPath, listener: VfsListener): () => void {
    return this.mem.subscribe(prefix, listener);
  }

  snapshot(): ReadonlyMap<VfsPath, VfsEntry> {
    return this.mem.snapshot();
  }

  // -- Mutations: write through to mem, queue IDB persistence. --

  write(path: VfsPath, content: string): void {
    this.mem.write(path, content);
    this.queueFlush(path, { kind: "file", content });
  }

  delete(path: VfsPath): void {
    // Memory layer enforces file-only delete (no-op on dirs).  Only
    // queue an IDB delete when the mem layer actually removed
    // something — otherwise we'd flush a stray delete for a path
    // the user never touched.
    const before = this.mem.exists(path);
    if (!before) return;
    this.mem.delete(path);
    if (!this.mem.exists(path)) this.queueFlush(path, null);
  }

  mkdir(path: VfsPath): void {
    this.mem.mkdir(path);
    // mkdir is mkdirp: queue a flush for every dir along the path
    // that the mem layer just created.  Simplest correct approach
    // is to walk the path, query mem for kind=="dir", and queue
    // each — duplicates collapse in the writeQueue map.
    const segments = normalisePathLike(path).split("/").filter((s) => s.length > 0);
    let cur = "";
    for (const seg of segments) {
      cur = `${cur}/${seg}`;
      if (this.mem.isDirectory(cur)) {
        this.queueFlush(cur, { kind: "dir" });
      }
    }
  }

  rmdir(path: VfsPath): void {
    const before = this.mem.isDirectory(path);
    if (!before) return;
    this.mem.rmdir(path); // throws if non-empty — propagate
    this.queueFlush(path, null);
  }

  hydrate(entries: Iterable<VfsEntry | readonly [VfsPath, string]>): void {
    const list = [...entries];
    this.mem.hydrate(list);
    for (const item of list) {
      if (Array.isArray(item)) {
        this.queueFlush(item[0] as VfsPath, {
          kind: "file",
          content: item[1] as string,
        });
      } else {
        const entry = item as VfsEntry;
        const val: IdbValue =
          entry.kind === "file"
            ? { kind: "file", content: entry.content }
            : { kind: "dir" };
        this.queueFlush(entry.path, val);
      }
    }
  }

  restore(entries: Iterable<VfsEntry | readonly [VfsPath, string]>): void {
    const before = new Set(this.mem.snapshot().keys());
    this.mem.restore(entries);
    // Work off the post-restore snapshot so paths are normalised
    // consistently with `before`: write everything kept, delete
    // whatever the snapshot dropped.
    const after = this.mem.snapshot();
    for (const [path, entry] of after) {
      const val: IdbValue =
        entry.kind === "file"
          ? { kind: "file", content: entry.content }
          : { kind: "dir" };
      this.queueFlush(path, val);
    }
    for (const path of before) {
      if (!after.has(path)) this.queueFlush(path, null);
    }
  }

  /** Force any pending IDB writes to flush immediately and resolve
   *  when the IDB transaction completes.  Useful for tests, for
   *  graceful shutdown (`beforeunload`), and for `await flush()`-
   *  before-snapshot patterns the worker rehydrate flow uses. */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    return this.doFlush();
  }

  private queueFlush(path: VfsPath, value: IdbValue | null): void {
    this.writeQueue.set(path, value);
    if (this.flushTimer || !this.db) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.inflightFlush = this.doFlush().catch((err) => {
        console.warn(
          `idb-vfs: flush failed (${err instanceof Error ? err.message : String(err)}); ` +
            `keeping in-memory state, will retry on next write.`,
        );
      });
    }, FLUSH_DEBOUNCE_MS);
  }

  private doFlush(): Promise<void> {
    if (!this.db || this.writeQueue.size === 0) return Promise.resolve();
    // Serialise concurrent flushes — if a previous flush is still
    // in flight, chain after it so write-ordering matches mutate-
    // ordering.  IDB transactions are atomic but consecutive
    // transactions run in the order they're opened; chaining
    // through `inflightFlush` keeps that guarantee at the JS layer.
    const queue = this.writeQueue;
    this.writeQueue = new Map();
    const previous = this.inflightFlush ?? Promise.resolve();
    const next = previous.then(() => writeQueueToDb(this.db!, queue));
    this.inflightFlush = next;
    return next;
  }
}

/** Quick normalisation for `mkdir`'s path-walk loop without
 *  importing the private `normalize` from memory-vfs.  Matches
 *  MemoryVfs.normalize for the leading-slash + collapse case;
 *  doesn't need the full root-escape protection because the path
 *  has already been validated by `mem.mkdir` above. */
function normalisePathLike(path: VfsPath): VfsPath {
  if (path.startsWith("/")) return path;
  return "/" + path.replace(/^\/+/, "");
}

// -- Raw IDB helpers (kept private, no `idb` package dependency). --

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB not available in this environment"));
      return;
    }
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
  });
}

/** Read every entry out of the store, coercing v1 bare strings to
 *  `{kind:"file", content}` so the in-memory layer always sees the
 *  tagged shape.  Returns the entries in the shape `MemoryVfs.hydrate`
 *  accepts (mixed). */
function readAllEntries(db: IDBDatabase): Promise<Array<VfsEntry>> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const cursorReq = store.openCursor();
    const out: Array<VfsEntry> = [];
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        const path = cursor.key as VfsPath;
        const value = cursor.value as IdbValue;
        const entry = coerceStoredValue(path, value);
        if (entry) out.push(entry);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

function coerceStoredValue(path: VfsPath, value: IdbValue): VfsEntry | null {
  // v1: bare string content.  Wrap to a file entry.
  if (typeof value === "string") {
    return { kind: "file", path, content: value };
  }
  if (value && typeof value === "object") {
    if (value.kind === "file") {
      return { kind: "file", path, content: value.content };
    }
    if (value.kind === "dir") {
      return { kind: "dir", path };
    }
  }
  // Unrecognised — skip rather than crashing the whole hydrate.
  return null;
}

function writeQueueToDb(
  db: IDBDatabase,
  queue: Map<VfsPath, IdbValue | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const [path, value] of queue) {
      if (value === null) store.delete(path);
      else store.put(value, path);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("idb tx failed"));
    tx.onabort = () => reject(tx.error ?? new Error("idb tx aborted"));
  });
}

/** Best-effort request for persistent storage (so the browser
 *  doesn't evict the workspace under storage pressure).  Idempotent;
 *  safe to call on every boot. */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) {
    return false;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
