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
// ---------------------------------------------------------------------------

import { MemoryVfs } from "./memory-vfs.js";
import type { Vfs, VfsListener, VfsPath } from "./types.js";

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

export class IdbVfs implements Vfs {
  /** True iff the underlying IDB connection succeeded.  When false,
   *  the VFS still works but writes don't survive reload. */
  readonly persistent: boolean;

  private readonly mem: MemoryVfs;
  private readonly db: IDBDatabase | null;
  private writeQueue = new Map<VfsPath, string | null>();
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
   *  IDB persistence is invisible at the read/write API. */
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

  list(prefix: VfsPath): ReadonlyArray<VfsPath> {
    return this.mem.list(prefix);
  }

  subscribe(prefix: VfsPath, listener: VfsListener): () => void {
    return this.mem.subscribe(prefix, listener);
  }

  snapshot(): ReadonlyMap<VfsPath, string> {
    return this.mem.snapshot();
  }

  // -- Mutations: write through to mem, queue IDB persistence. --

  write(path: VfsPath, content: string): void {
    this.mem.write(path, content);
    this.queueFlush(path, content);
  }

  delete(path: VfsPath): void {
    this.mem.delete(path);
    this.queueFlush(path, null);
  }

  hydrate(entries: Iterable<readonly [VfsPath, string]>): void {
    const list = [...entries];
    this.mem.hydrate(list);
    for (const [path, content] of list) {
      this.queueFlush(path, content);
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

  private queueFlush(path: VfsPath, contentOrNull: string | null): void {
    this.writeQueue.set(path, contentOrNull);
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

function readAllEntries(db: IDBDatabase): Promise<Array<[VfsPath, string]>> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const cursorReq = store.openCursor();
    const out: Array<[VfsPath, string]> = [];
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        out.push([cursor.key as VfsPath, cursor.value as string]);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

function writeQueueToDb(
  db: IDBDatabase,
  queue: Map<VfsPath, string | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const [path, content] of queue) {
      if (content === null) store.delete(path);
      else store.put(content, path);
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
