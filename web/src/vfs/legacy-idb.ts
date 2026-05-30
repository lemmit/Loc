// ---------------------------------------------------------------------------
// Legacy workspace reader + persistent-storage request.
//
// Before the git-backed store, the playground persisted `/workspace/**`
// in the `loom-workspace` IndexedDB (object store `entries`, one value
// per path) via the now-removed `IdbVfs`.  This is the small read-only
// slice of that machinery kept alive for the one-time migration: read
// the old store into `VfsEntry[]` so `import-legacy.ts` can replay it
// into git.  No writer, no flush queue, no in-memory cache.
//
// The schema tolerated two value shapes: v2 tagged
// `{kind:"file",content} | {kind:"dir"}` and v1 bare strings (implied
// file).  Both coerce to the tagged `VfsEntry`.
// ---------------------------------------------------------------------------

import type { VfsEntry, VfsPath } from "./types.js";

const DEFAULT_DB_NAME = "loom-workspace";
const STORE = "entries";
const DB_VERSION = 1;

type IdbValue = { kind: "file"; content: string } | { kind: "dir" } | string;

/** Read the legacy workspace IndexedDB store as `VfsEntry[]`.  Returns
 *  `[]` when IndexedDB is unavailable or the store is empty (including a
 *  fresh install with no prior data). */
export async function readLegacyWorkspace(
  dbName: string = DEFAULT_DB_NAME,
): Promise<VfsEntry[]> {
  let db: IDBDatabase;
  try {
    db = await openDb(dbName);
  } catch {
    return [];
  }
  try {
    return await readAllEntries(db);
  } finally {
    db.close();
  }
}

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

function readAllEntries(db: IDBDatabase): Promise<VfsEntry[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const cursorReq = store.openCursor();
    const out: VfsEntry[] = [];
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        const entry = coerceStoredValue(cursor.key as VfsPath, cursor.value as IdbValue);
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
  // v1: bare string content → file entry.
  if (typeof value === "string") {
    return { kind: "file", path, content: value };
  }
  if (value && typeof value === "object") {
    if (value.kind === "file") return { kind: "file", path, content: value.content };
    if (value.kind === "dir") return { kind: "dir", path };
  }
  return null; // unrecognised — skip rather than crash the migration
}

/** Best-effort request for persistent storage (so the browser doesn't
 *  evict the workspace under storage pressure).  Idempotent; safe to
 *  call on every boot. */
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
