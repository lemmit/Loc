// ---------------------------------------------------------------------------
// OPFS data-island garbage collection.
//
// Each unique `.ddd` source boots its PGlite into its own OPFS island
// (`opfs-ahp://loom-<source-hash>`, see App.runBootStep) so switching sources
// never clobbers another's data.  Nothing ever removed them, so islands
// accumulate forever — every example a user opens, every edit that changes the
// source hash.  Beyond wasted space, unbounded OPFS growth pushes the origin
// toward the browser's storage quota, and quota pressure is exactly what makes
// mobile browsers evict storage and reload tabs — the "refreshed during work"
// event we're hardening against.
//
// This keeps a small most-recently-used set and drops the rest on each boot.
// The active island is always in the keep set (we just recorded it), so we
// never try to remove a DB with open access handles.  Best-effort throughout:
// OPFS access can be unavailable (private mode) or an individual remove can
// fail (locked) — neither is fatal.
// ---------------------------------------------------------------------------

const LRU_KEY = "loom.opfs.lru";
/** How many islands to retain (the current source + recent ones, so flipping
 *  back to a just-edited source still finds its data). */
const KEEP = 4;
/** Cap on the persisted LRU list so it can't grow without bound itself. */
const LRU_MAX = 30;
const PREFIX = "loom-";

function readLru(): string[] {
  try {
    const raw = localStorage.getItem(LRU_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as string[]).filter((h) => typeof h === "string") : [];
  } catch {
    return [];
  }
}

function writeLru(list: string[]): void {
  try {
    localStorage.setItem(LRU_KEY, JSON.stringify(list.slice(-LRU_MAX)));
  } catch {
    // storage disabled — GC still runs against the in-memory keep set.
  }
}

/** Record `hash` as most-recently-used and return the ordered LRU list. */
function recordHash(hash: string): string[] {
  const list = readLru().filter((h) => h !== hash);
  list.push(hash);
  const capped = list.slice(-LRU_MAX);
  writeLru(capped);
  return capped;
}

/** Minimal OPFS shape — lib.dom's FileSystemDirectoryHandle typings for
 *  `entries()` / `removeEntry(recursive)` are uneven across TS versions, so we
 *  pin just what we use. */
interface OpfsHandle {
  kind: "file" | "directory";
}
interface OpfsDir extends OpfsHandle {
  entries(): AsyncIterableIterator<[string, OpfsHandle]>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

async function getOpfsRoot(): Promise<OpfsDir | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
      return null;
    }
    return (await navigator.storage.getDirectory()) as unknown as OpfsDir;
  } catch {
    return null;
  }
}

/** Remove every `loom-*` OPFS directory whose hash isn't in `keepHashes`.
 *  Returns the number of islands removed. */
async function gcIslands(keepHashes: Iterable<string>): Promise<number> {
  const root = await getOpfsRoot();
  if (!root) return 0;
  const keep = new Set<string>();
  for (const h of keepHashes) keep.add(`${PREFIX}${h}`);

  const stale: string[] = [];
  try {
    for await (const [name, handle] of root.entries()) {
      if (handle.kind === "directory" && name.startsWith(PREFIX) && !keep.has(name)) {
        stale.push(name);
      }
    }
  } catch {
    // entries() iteration unsupported / failed — nothing safe to remove.
    return 0;
  }

  let removed = 0;
  for (const name of stale) {
    try {
      await root.removeEntry(name, { recursive: true });
      removed++;
    } catch {
      // In use / locked / racing another tab — skip it; next boot retries.
    }
  }
  return removed;
}

/** Record the just-booted source hash and GC every island outside the
 *  most-recent `KEEP`.  Fire-and-forget from the boot path; never throws. */
export async function recordAndGcOpfs(hash: string): Promise<void> {
  try {
    const lru = recordHash(hash);
    const keep = lru.slice(-KEEP); // includes `hash` (just pushed)
    await gcIslands(keep);
  } catch {
    // best-effort housekeeping — never let it affect a successful boot
  }
}
