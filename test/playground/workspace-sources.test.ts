import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { GitStore, openGitFs } from "../../web/src/workspace/git/index.js";
import {
  DEFAULT_PATH,
  isDddSource,
  pickFallbackActivePath,
  snapshotSources,
  WorkspaceSourcesController,
  type WorkspaceSourcesSnapshot,
} from "../../web/src/workspace/workspace-sources.js";

// ---------------------------------------------------------------------------
// WorkspaceSourcesController over the async git store.  The controller
// keeps a resident sync snapshot (so `snapshot`/`subscribe` stay sync
// for the LSP/editor) refreshed from async git reads; mutators are
// async.  Tests `await controller.ready()` after construction and await
// each mutator before asserting the resident snapshot.
// ---------------------------------------------------------------------------

let dbCounter = 0;
function uniqueDbName(): string {
  return `loom-ws-test-${++dbCounter}`;
}

/** Open a fresh git store, optionally seeding `.ddd`/other files. */
async function freshStore(seed: Record<string, string> = {}): Promise<GitStore> {
  const store = new GitStore(await openGitFs(uniqueDbName()));
  for (const [path, content] of Object.entries(seed)) {
    await store.writeFile(path, content);
  }
  return store;
}

/** Construct a controller and wait for its initial refresh. */
async function makeController(store: GitStore | null): Promise<WorkspaceSourcesController> {
  const c = new WorkspaceSourcesController(store);
  await c.ready();
  return c;
}

describe("workspace sources — pure helpers", () => {
  it("isDddSource accepts /workspace/*.ddd and rejects anything else", () => {
    expect(isDddSource("/workspace/main.ddd")).toBe(true);
    expect(isDddSource("/workspace/nested/orders.ddd")).toBe(true);
    expect(isDddSource("/workspace/design/mantine/foo.hbs")).toBe(false);
    expect(isDddSource("/elsewhere/main.ddd")).toBe(false);
    expect(isDddSource("/workspace/main.txt")).toBe(false);
  });

  it("snapshotSources filters to .ddd files under /workspace/", async () => {
    const store = await freshStore({
      "/workspace/main.ddd": "context A {}",
      "/workspace/sub/orders.ddd": "context B {}",
      "/workspace/design/mantine/pack.json": "{}",
      "/workspace/notes.txt": "ignored",
    });
    const snap = await snapshotSources(store);
    expect([...snap.keys()].sort()).toEqual(["/workspace/main.ddd", "/workspace/sub/orders.ddd"]);
  });

  it("pickFallbackActivePath prefers main.ddd, else lexicographically-first", () => {
    expect(pickFallbackActivePath(["/workspace/a.ddd", DEFAULT_PATH, "/workspace/b.ddd"])).toBe(
      DEFAULT_PATH,
    );
    expect(pickFallbackActivePath(["/workspace/b.ddd", "/workspace/a.ddd"])).toBe(
      "/workspace/a.ddd",
    );
    expect(pickFallbackActivePath([])).toBe(DEFAULT_PATH);
  });
});

describe("WorkspaceSourcesController", () => {
  it("initial snapshot reflects existing store contents", async () => {
    const store = await freshStore({
      "/workspace/main.ddd": "main",
      "/workspace/sub/orders.ddd": "orders",
      "/workspace/ignored.txt": "should not appear",
    });
    const controller = await makeController(store);
    const snap = controller.snapshot();
    expect([...snap.files.entries()].sort()).toEqual([
      ["/workspace/main.ddd", "main"],
      ["/workspace/sub/orders.ddd", "orders"],
    ]);
    expect(snap.activePath).toBe(DEFAULT_PATH);
    controller.dispose();
  });

  it("null store yields an empty snapshot and working (no-op) mutators", async () => {
    const c = await makeController(null);
    expect(c.snapshot().files.size).toBe(0);
    expect(c.snapshot().activePath).toBe(DEFAULT_PATH);
    await expect(c.write("/workspace/main.ddd", "x")).resolves.toBeUndefined();
    await expect(c.delete("/workspace/main.ddd")).resolves.toBeUndefined();
    c.dispose();
  });

  it("setActivePath emits a snapshot with the new active file", async () => {
    const store = await freshStore({
      "/workspace/main.ddd": "m",
      "/workspace/orders.ddd": "o",
    });
    const c = await makeController(store);
    const listener = vi.fn<(s: WorkspaceSourcesSnapshot) => void>();
    c.subscribe(listener);
    c.setActivePath("/workspace/orders.ddd");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0].activePath).toBe("/workspace/orders.ddd");
    listener.mockClear();
    c.setActivePath("/workspace/orders.ddd");
    expect(listener).not.toHaveBeenCalled();
    c.dispose();
  });

  it("write persists to the store and re-emits", async () => {
    const store = await freshStore();
    const c = await makeController(store);
    const listener = vi.fn<(s: WorkspaceSourcesSnapshot) => void>();
    c.subscribe(listener);
    await c.write("/workspace/main.ddd", "context A {}");
    expect(await store.readFile("/workspace/main.ddd")).toBe("context A {}");
    expect(listener).toHaveBeenCalled();
    const latest = listener.mock.calls.at(-1)![0];
    expect(latest.files.get("/workspace/main.ddd")).toBe("context A {}");
    c.dispose();
  });

  it("rejects writes to non-.ddd paths", async () => {
    const c = await makeController(await freshStore());
    await expect(c.write("/workspace/notes.txt", "x")).rejects.toThrow(
      /must be a \/workspace\/\*\.ddd/,
    );
    await expect(c.write("/elsewhere/main.ddd", "x")).rejects.toThrow(
      /must be a \/workspace\/\*\.ddd/,
    );
    c.dispose();
  });

  it("delete removes from the store and re-emits", async () => {
    const store = await freshStore({
      "/workspace/main.ddd": "m",
      "/workspace/orders.ddd": "o",
    });
    const c = await makeController(store);
    const listener = vi.fn<(s: WorkspaceSourcesSnapshot) => void>();
    c.subscribe(listener);
    await c.delete("/workspace/orders.ddd");
    expect(await store.exists("/workspace/orders.ddd")).toBe(false);
    expect(listener).toHaveBeenCalled();
    const latest = listener.mock.calls.at(-1)![0];
    expect([...latest.files.keys()]).toEqual(["/workspace/main.ddd"]);
    c.dispose();
  });

  it("deleting the active file re-points activePath to main.ddd when present", async () => {
    const store = await freshStore({
      "/workspace/main.ddd": "m",
      "/workspace/orders.ddd": "o",
    });
    const c = await makeController(store);
    c.setActivePath("/workspace/orders.ddd");
    await c.delete("/workspace/orders.ddd");
    expect(c.snapshot().activePath).toBe(DEFAULT_PATH);
    c.dispose();
  });

  it("deleting the active file with no main.ddd falls back to the first remaining", async () => {
    const store = await freshStore({
      "/workspace/orders.ddd": "o",
      "/workspace/shipping.ddd": "s",
      "/workspace/billing.ddd": "b",
    });
    const c = await makeController(store);
    c.setActivePath("/workspace/orders.ddd");
    await c.delete("/workspace/orders.ddd");
    expect(c.snapshot().activePath).toBe("/workspace/billing.ddd");
    c.dispose();
  });

  it("deleting a non-active file leaves activePath untouched", async () => {
    const store = await freshStore({
      "/workspace/main.ddd": "m",
      "/workspace/orders.ddd": "o",
    });
    const c = await makeController(store);
    c.setActivePath("/workspace/main.ddd");
    await c.delete("/workspace/orders.ddd");
    expect(c.snapshot().activePath).toBe("/workspace/main.ddd");
    c.dispose();
  });

  it("external store writes propagate through the subscription", async () => {
    const store = await freshStore({ "/workspace/main.ddd": "old" });
    const c = await makeController(store);
    const listener = vi.fn<(s: WorkspaceSourcesSnapshot) => void>();
    c.subscribe(listener);
    // Simulate another writer touching the same store directly. The
    // controller's store subscription drives an async refresh, so wait
    // for the snapshot to reflect it.
    await store.writeFile("/workspace/main.ddd", "new");
    await vi.waitFor(() => expect(c.snapshot().files.get("/workspace/main.ddd")).toBe("new"));
    c.dispose();
  });

  it("design-pack writes under /workspace/design/ don't appear in `files`", async () => {
    const store = await freshStore();
    const c = await makeController(store);
    await store.writeFile("/workspace/design/mantine/pack.json", "{}");
    await vi.waitFor(() => {
      // refresh ran; files stays empty (design packs aren't .ddd)
      expect([...c.snapshot().files.keys()]).toEqual([]);
    });
    expect(await store.exists("/workspace/design/mantine/pack.json")).toBe(true);
    c.dispose();
  });

  describe("empty folders (via first-class git dir entries)", () => {
    it("createEmptyFolder calls mkdir and surfaces in `emptyFolders`", async () => {
      const store = await freshStore({ "/workspace/main.ddd": "m" });
      const c = await makeController(store);
      await c.createEmptyFolder("shared");
      const snap = c.snapshot();
      expect(await store.isDirectory("/workspace/shared")).toBe(true);
      expect([...snap.emptyFolders]).toEqual(["shared"]);
      expect([...snap.files.keys()]).toEqual(["/workspace/main.ddd"]);
      c.dispose();
    });

    it("nested folder names round-trip", async () => {
      const store = await freshStore();
      const c = await makeController(store);
      await c.createEmptyFolder("audit/log");
      const snap = c.snapshot();
      expect(await store.isDirectory("/workspace/audit")).toBe(true);
      expect(await store.isDirectory("/workspace/audit/log")).toBe(true);
      expect([...snap.emptyFolders].sort()).toEqual(["audit", "audit/log"]);
      c.dispose();
    });

    it("a folder that has .ddd content is NOT in `emptyFolders`", async () => {
      const store = await freshStore({
        "/workspace/main.ddd": "m",
        "/workspace/shared/money.ddd": "valueobject Money { v: int }",
      });
      const c = await makeController(store);
      const snap = c.snapshot();
      expect([...snap.emptyFolders]).toEqual([]);
      expect([...snap.files.keys()].sort()).toEqual([
        "/workspace/main.ddd",
        "/workspace/shared/money.ddd",
      ]);
      c.dispose();
    });

    it("deleteEmptyFolder calls rmdir", async () => {
      const store = await freshStore({ "/workspace/main.ddd": "m" });
      const c = await makeController(store);
      await c.createEmptyFolder("shared");
      expect([...c.snapshot().emptyFolders]).toEqual(["shared"]);
      await c.deleteEmptyFolder("shared");
      expect(await store.exists("/workspace/shared")).toBe(false);
      expect([...c.snapshot().emptyFolders]).toEqual([]);
      c.dispose();
    });

    it("rejects an empty folder name", async () => {
      const c = await makeController(await freshStore());
      await expect(c.createEmptyFolder("")).rejects.toThrow(/folder name is required/);
      await expect(c.createEmptyFolder("/")).rejects.toThrow(/folder name is required/);
      c.dispose();
    });
  });

  it("dispose unsubscribes from the store and stops emitting", async () => {
    const store = await freshStore({ "/workspace/main.ddd": "m" });
    const c = await makeController(store);
    const listener = vi.fn<(s: WorkspaceSourcesSnapshot) => void>();
    c.subscribe(listener);
    c.dispose();
    listener.mockClear();
    await store.writeFile("/workspace/main.ddd", "post-dispose");
    // Give any (incorrectly) scheduled refresh a chance to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(listener).not.toHaveBeenCalled();
  });
});
