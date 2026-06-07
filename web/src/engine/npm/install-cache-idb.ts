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
//
// Bounded by an LRU byte cap (`MAX_BYTES`): the cache used to hydrate
// *every* cached tarball into memory on open and grow IDB without limit,
// so a long-lived browser profile carried an ever-larger startup-memory and
// storage-quota cost — both of which hurt most on mobile (memory pressure +
// storage-eviction reloads).  Now the least-recently-used entries are evicted
// once the total extracted size exceeds the cap, on both `open` (trimming a
// previously-unbounded store) and `set`.  The in-memory mirror equals what's
// persisted, so the cap bounds startup memory too.

import type { InstallCache } from "./install.js";
import type { TarEntry } from "./targz.js";

const DB = "loom-npm-cache";
const STORE = "tarballs";
const META = "meta";
const ORDER_KEY = "order";
/** Total extracted-bytes budget for the cache.  ~64 MB comfortably holds a
 *  few backend + design-pack dependency sets while staying well under typical
 *  mobile origin quotas. */
const MAX_BYTES = 64 * 1024 * 1024;

interface Stored {
  name: string;
  data: Uint8Array;
}

/** Extracted byte size of one cache value (tar payloads + names). */
function sizeOf(entries: TarEntry[]): number {
  let n = 0;
  for (const e of entries) n += (e.data?.byteLength ?? 0) + e.name.length;
  return n;
}

export class IdbInstallCache implements InstallCache {
  private mem = new Map<string, TarEntry[]>();
  private sizes = new Map<string, number>();
  /** LRU order, oldest-first.  Mirrored to IDB so recency survives reloads. */
  private order: string[] = [];
  private total = 0;
  private db: IDBDatabase | null = null;
  private orderTimer: ReturnType<typeof setTimeout> | null = null;

  /** Open IDB and hydrate the in-memory mirror.  Resolves even when
   *  IDB is unavailable — the cache then behaves as memory-only. */
  async open(): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    this.db = await new Promise<IDBDatabase | null>((resolve) => {
      // v2 adds the `meta` store for the persisted LRU order.
      const req = indexedDB.open(DB, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (!this.db) return;

    // Hydrate values + sizes.
    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(STORE, "readonly");
      const cur = tx.objectStore(STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        const key = String(c.key);
        const entries = c.value as TarEntry[];
        this.mem.set(key, entries);
        const sz = sizeOf(entries);
        this.sizes.set(key, sz);
        this.total += sz;
        c.continue();
      };
      cur.onerror = () => resolve();
    });

    // Restore the persisted LRU order, then reconcile with the keys actually
    // present: keep known order, append any unlisted keys at the *front*
    // (treated as oldest — e.g. entries written by a pre-LRU build).
    const persisted = await this.readOrder();
    const present = new Set(this.mem.keys());
    const known = persisted.filter((k) => present.has(k));
    const knownSet = new Set(known);
    const extras = [...present].filter((k) => !knownSet.has(k));
    this.order = [...extras, ...known];

    // Trim a store that may have grown unbounded under the old code.
    if (this.evictToFit()) this.persistOrderNow();
    else void this.writeOrder();
  }

  get(key: string): TarEntry[] | undefined {
    const v = this.mem.get(key);
    if (v) this.touch(key);
    return v;
  }

  set(key: string, entries: TarEntry[]): void {
    const sz = sizeOf(entries);
    const prev = this.sizes.get(key) ?? 0;
    this.mem.set(key, entries);
    this.sizes.set(key, sz);
    this.total += sz - prev;
    this.touchOrder(key);
    // Evict LRU entries (never the one just written) to get back under cap.
    const evicted = this.evictToFit(key);

    if (!this.db) return;
    try {
      this.db.transaction(STORE, "readwrite").objectStore(STORE).put(entries, key);
    } catch {
      // Quota / transaction failure — memory cache still serves this
      // session; next reload just re-fetches.
    }
    if (evicted) this.persistOrderNow();
    else this.persistOrderSoon();
  }

  // -- LRU internals --------------------------------------------------------

  /** Mark `key` most-recently-used (cheap path for cache hits). */
  private touch(key: string): void {
    this.touchOrder(key);
    this.persistOrderSoon();
  }

  private touchOrder(key: string): void {
    const i = this.order.indexOf(key);
    if (i !== -1) this.order.splice(i, 1);
    this.order.push(key);
  }

  /** Drop oldest entries until total ≤ cap.  Never evicts `protect` (the
   *  just-written key).  Returns true if anything was evicted. */
  private evictToFit(protect?: string): boolean {
    let evicted = false;
    while (this.total > MAX_BYTES) {
      const victim = this.order.find((k) => k !== protect);
      if (victim === undefined) break; // only the protected key remains
      this.removeKey(victim);
      evicted = true;
    }
    return evicted;
  }

  private removeKey(key: string): void {
    this.total -= this.sizes.get(key) ?? 0;
    this.mem.delete(key);
    this.sizes.delete(key);
    const i = this.order.indexOf(key);
    if (i !== -1) this.order.splice(i, 1);
    if (!this.db) return;
    try {
      this.db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
    } catch {
      // best-effort — the in-memory accounting is already consistent
    }
  }

  // -- order persistence ----------------------------------------------------

  private async readOrder(): Promise<string[]> {
    if (!this.db) return [];
    return new Promise<string[]>((resolve) => {
      try {
        const req = this.db!.transaction(META, "readonly")
          .objectStore(META)
          .get(ORDER_KEY);
        req.onsuccess = () => {
          const v = req.result as unknown;
          resolve(Array.isArray(v) ? (v as string[]) : []);
        };
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  private writeOrder(): void {
    if (!this.db) return;
    try {
      this.db
        .transaction(META, "readwrite")
        .objectStore(META)
        .put([...this.order], ORDER_KEY);
    } catch {
      // best-effort — recency just won't survive this reload
    }
  }

  private persistOrderNow(): void {
    if (this.orderTimer) {
      clearTimeout(this.orderTimer);
      this.orderTimer = null;
    }
    this.writeOrder();
  }

  /** Debounced order flush — cache hits bump recency frequently; we don't
   *  need an IDB write per hit. */
  private persistOrderSoon(): void {
    if (this.orderTimer) clearTimeout(this.orderTimer);
    this.orderTimer = setTimeout(() => {
      this.orderTimer = null;
      this.writeOrder();
    }, 1000);
  }
}

export type { Stored };
