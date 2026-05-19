// IndexedDB-backed install cache (Phase B3c).
//
// Keyed name@version → extracted tar entries, so a dependency set
// installs once and replays on subsequent prepares / cold tabs.
// This is the warm-boot seam P4's snapshot work plugs into.
//
// Synchronous `InstallCache` surface (install.ts calls get/set
// inline), backed by an async IDB store hydrated up-front and
// written through.  Falls back to a pure in-memory cache when IDB
// is unavailable (private mode, hostile-storage policies) — the
// engine still works, it just doesn't persist across reloads.

import type { InstallCache } from "./install.js";
import type { TarEntry } from "./targz.js";

const DB = "loom-npm-cache";
const STORE = "tarballs";

interface Stored {
  name: string;
  data: Uint8Array;
}

export class IdbInstallCache implements InstallCache {
  private mem = new Map<string, TarEntry[]>();
  private db: IDBDatabase | null = null;

  /** Open IDB and hydrate the in-memory mirror.  Resolves even when
   *  IDB is unavailable — the cache then behaves as memory-only. */
  async open(): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    this.db = await new Promise<IDBDatabase | null>((resolve) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (!this.db) return;
    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(STORE, "readonly");
      const cur = tx.objectStore(STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        this.mem.set(String(c.key), c.value as TarEntry[]);
        c.continue();
      };
      cur.onerror = () => resolve();
    });
  }

  get(key: string): TarEntry[] | undefined {
    return this.mem.get(key);
  }

  set(key: string, entries: TarEntry[]): void {
    this.mem.set(key, entries);
    if (!this.db) return;
    try {
      this.db
        .transaction(STORE, "readwrite")
        .objectStore(STORE)
        .put(entries, key);
    } catch {
      // Quota / transaction failure — memory cache still serves this
      // session; next reload just re-fetches.
    }
  }
}

export type { Stored };
