import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";

import { IdbVfs } from "../../web/src/vfs/idb-vfs.js";

// ---------------------------------------------------------------------------
// IdbVfs — IndexedDB-backed decorator over MemoryVfs.  Persistence
// is best-effort: reads/writes still work when IDB is unavailable
// (hostile-storage fallback verification).  These tests
// cover the round-trip + the debounced-flush contract the worker
// rehydrate flow will rely on.
// ---------------------------------------------------------------------------

beforeAll(() => {
  // fake-indexeddb/auto wires globalThis.indexedDB; nothing else to do.
  expect(typeof indexedDB).toBe("object");
});

let dbCounter = 0;
function uniqueDbName(): string {
  // One DB per test so cross-test state doesn't leak.  fake-indexeddb's
  // in-memory store persists across `IdbVfs.open` calls within a test
  // run, which is what we want for round-trip assertions.
  return `loom-test-${++dbCounter}`;
}

describe("IdbVfs: basic read/write delegates to MemoryVfs", () => {
  let vfs: IdbVfs;
  beforeEach(async () => {
    vfs = await IdbVfs.open(uniqueDbName());
  });

  it("round-trips a single entry in memory", () => {
    vfs.write("/workspace/main.ddd", "system X {}");
    expect(vfs.read("/workspace/main.ddd")).toBe("system X {}");
    expect(vfs.exists("/workspace/main.ddd")).toBe(true);
  });

  it("delete removes the entry from memory", () => {
    vfs.write("/x", "1");
    vfs.delete("/x");
    expect(vfs.exists("/x")).toBe(false);
  });

  it("list / snapshot mirror MemoryVfs", () => {
    vfs.write("/a/1", "x");
    vfs.write("/a/2", "y");
    vfs.write("/b", "z");
    expect(vfs.list("/a/")).toEqual(["/a/1", "/a/2"]);
    expect(vfs.snapshot().size).toBe(3);
  });

  it("reports persistent: true when IDB is available", () => {
    expect(vfs.persistent).toBe(true);
  });
});

describe("IdbVfs: persistence round-trip", () => {
  it("survives a close-and-reopen cycle (writes flushed)", async () => {
    const name = uniqueDbName();
    const a = await IdbVfs.open(name);
    a.write("/workspace/main.ddd", "// hello");
    a.write("/workspace/notes.txt", "todo");
    // Force the debounced flush to drain before reopening.
    await a.flush();

    const b = await IdbVfs.open(name);
    expect(b.read("/workspace/main.ddd")).toBe("// hello");
    expect(b.read("/workspace/notes.txt")).toBe("todo");
  });

  it("survives delete across reopen", async () => {
    const name = uniqueDbName();
    const a = await IdbVfs.open(name);
    a.write("/x", "1");
    await a.flush();
    a.delete("/x");
    await a.flush();

    const b = await IdbVfs.open(name);
    expect(b.exists("/x")).toBe(false);
  });

  it("hydrate persists every entry", async () => {
    const name = uniqueDbName();
    const a = await IdbVfs.open(name);
    a.hydrate([
      ["/workspace/a.ddd", "1"],
      ["/workspace/b.ddd", "2"],
      ["/workspace/c.ddd", "3"],
    ]);
    await a.flush();

    const b = await IdbVfs.open(name);
    expect(b.snapshot().size).toBe(3);
    expect(b.read("/workspace/c.ddd")).toBe("3");
  });
});

describe("IdbVfs: directories survive persistence", () => {
  it("mkdir + reopen round-trips the dir entry", async () => {
    const name = uniqueDbName();
    const a = await IdbVfs.open(name);
    a.mkdir("/workspace/shared");
    await a.flush();

    const b = await IdbVfs.open(name);
    expect(b.isDirectory("/workspace/shared")).toBe(true);
    // mkdirp materialises both `/workspace` and `/workspace/shared`;
    // both survive the reopen.
    expect(b.listDirs("/workspace/")).toEqual(["/workspace", "/workspace/shared"]);
  });

  it("rmdir + reopen confirms the dir entry is gone", async () => {
    const name = uniqueDbName();
    const a = await IdbVfs.open(name);
    a.mkdir("/workspace/temp");
    await a.flush();
    a.rmdir("/workspace/temp");
    await a.flush();

    const b = await IdbVfs.open(name);
    expect(b.exists("/workspace/temp")).toBe(false);
  });

  it("mkdirp persists every created ancestor", async () => {
    const name = uniqueDbName();
    const a = await IdbVfs.open(name);
    a.mkdir("/workspace/audit/log");
    await a.flush();

    const b = await IdbVfs.open(name);
    expect(b.isDirectory("/workspace/audit")).toBe(true);
    expect(b.isDirectory("/workspace/audit/log")).toBe(true);
  });
});

describe("IdbVfs: legacy v1 → v2 migration", () => {
  // Pre-this-PR IdbVfs wrote bare strings as the IDB value;
  // this-PR writes `{kind, content?}` objects.  Defensive read on
  // `open()` coerces v1 strings into file entries so a fresh build
  // can open a DB seeded by an old build.  No `DB_VERSION` bump —
  // a rollback to an older build must also be able to open the DB.
  function seedRawV1Store(name: string, entries: Array<[string, string]>): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("entries")) {
          db.createObjectStore("entries");
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("entries", "readwrite");
        const store = tx.objectStore("entries");
        for (const [path, content] of entries) {
          // Critical: bare string value, no `{kind, content}` wrapper.
          store.put(content, path);
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  it("opens a DB seeded with v1 (bare string) values and coerces them to file entries", async () => {
    const name = uniqueDbName();
    await seedRawV1Store(name, [
      ["/workspace/main.ddd", "old content"],
      ["/workspace/shared.ddd", "more old content"],
    ]);

    const vfs = await IdbVfs.open(name);
    expect(vfs.read("/workspace/main.ddd")).toBe("old content");
    expect(vfs.kindOf("/workspace/main.ddd")).toBe("file");
    expect(vfs.isFile("/workspace/shared.ddd")).toBe(true);
  });

  it("v1 entries survive a subsequent write of an unrelated path", async () => {
    const name = uniqueDbName();
    await seedRawV1Store(name, [["/workspace/main.ddd", "old"]]);

    const a = await IdbVfs.open(name);
    a.write("/workspace/orders.ddd", "new");
    await a.flush();

    // Reopen — v1 entry untouched (still string in IDB), v2 entry
    // is the new shape.  Both readable.
    const b = await IdbVfs.open(name);
    expect(b.read("/workspace/main.ddd")).toBe("old");
    expect(b.read("/workspace/orders.ddd")).toBe("new");
  });
});

describe("IdbVfs: flush behavior", () => {
  it("explicit flush drains the queue immediately", async () => {
    const name = uniqueDbName();
    const a = await IdbVfs.open(name);
    a.write("/x", "1");
    // Don't wait for the 250ms debounce — flush() should drain now.
    await a.flush();
    const b = await IdbVfs.open(name);
    expect(b.read("/x")).toBe("1");
  });

  it("flush is a no-op when the queue is empty", async () => {
    const name = uniqueDbName();
    const a = await IdbVfs.open(name);
    await a.flush();
    await a.flush();
    expect(a.snapshot().size).toBe(0);
  });
});
