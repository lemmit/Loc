import { describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { readLegacyWorkspace } from "../../web/src/vfs/legacy-idb.js";

// ---------------------------------------------------------------------------
// readLegacyWorkspace — the read-only slice of the old IdbVfs kept for the
// one-time migration into git.  Correctness-sensitive (a wrong read loses
// returning users' autosaved work), so it's tested against raw IndexedDB
// seeded in both the v2 tagged and v1 bare-string shapes — independent of
// the removed IdbVfs writer.
// ---------------------------------------------------------------------------

let dbCounter = 0;

/** Seed a `loom-workspace`-shaped IDB (store `entries`, one value per
 *  path key) directly, simulating data written by the old IdbVfs. */
function seedLegacyDb(name: string, entries: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("entries");
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("entries", "readwrite");
      const store = tx.objectStore("entries");
      for (const [path, value] of Object.entries(entries)) store.put(value, path);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

describe("readLegacyWorkspace", () => {
  it("reads v2 file/dir entries and coerces v1 bare strings", async () => {
    const name = `legacy-${++dbCounter}`;
    await seedLegacyDb(name, {
      "/workspace/main.ddd": { kind: "file", content: "system X {}" },
      "/workspace/empty": { kind: "dir" },
      "/workspace/legacy.ddd": "v1-bare-string", // v1 form → file
      "/workspace/design/p.json": { kind: "file", content: "{}" },
    });
    const byPath = Object.fromEntries((await readLegacyWorkspace(name)).map((e) => [e.path, e]));
    expect(byPath["/workspace/main.ddd"]).toEqual({
      kind: "file",
      path: "/workspace/main.ddd",
      content: "system X {}",
    });
    expect(byPath["/workspace/empty"]).toEqual({ kind: "dir", path: "/workspace/empty" });
    expect(byPath["/workspace/legacy.ddd"]).toEqual({
      kind: "file",
      path: "/workspace/legacy.ddd",
      content: "v1-bare-string",
    });
    expect(byPath["/workspace/design/p.json"]).toEqual({
      kind: "file",
      path: "/workspace/design/p.json",
      content: "{}",
    });
  });

  it("skips unrecognised values rather than crashing", async () => {
    const name = `legacy-${++dbCounter}`;
    await seedLegacyDb(name, {
      "/workspace/ok.ddd": { kind: "file", content: "x" },
      "/workspace/weird": { kind: "bogus" }, // unknown shape → skipped
      "/workspace/num": 42, // non-string/object → skipped
    });
    const paths = (await readLegacyWorkspace(name)).map((e) => e.path);
    expect(paths).toEqual(["/workspace/ok.ddd"]);
  });

  it("returns [] for an empty / absent store", async () => {
    expect(await readLegacyWorkspace(`legacy-empty-${++dbCounter}`)).toEqual([]);
  });
});
