import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";

import { IdbVfs } from "../web/src/vfs/idb-vfs.js";

// ---------------------------------------------------------------------------
// IdbVfs — IndexedDB-backed decorator over MemoryVfs.  Persistence
// is best-effort: reads/writes still work when IDB is unavailable
// (Phase 3 verification: hostile-storage fallback).  These tests
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
