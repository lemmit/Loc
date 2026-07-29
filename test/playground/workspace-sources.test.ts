import { describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { GitStore, openGitFs } from "../../web/src/workspace/git/index.js";
import { NEW_FILE_SEED, pickInitialSource } from "../../web/src/workspace/initial-source.js";
import {
  DEFAULT_PATH,
  EPHEMERAL_MESSAGE,
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

  // Ephemeral mode (hostile storage / private browsing).  `write` stays a
  // silent no-op — it's the autosave hot path and fires on every keystroke
  // — but every EXPLICIT mutation now says why it did nothing instead of
  // letting the user watch a file row appear and evaporate.
  it("null store yields an empty snapshot, a silent no-op write, and explaining explicit mutators", async () => {
    const c = await makeController(null);
    expect(c.snapshot().files.size).toBe(0);
    expect(c.snapshot().activePath).toBe(DEFAULT_PATH);
    expect(c.snapshot().persistent).toBe(false);
    expect(c.snapshot().hydrated).toBe(false);

    await expect(c.write("/workspace/main.ddd", "x")).resolves.toBeUndefined();
    expect(c.snapshot().lastError).toBeNull();

    await expect(c.delete("/workspace/main.ddd")).rejects.toThrow(/ephemeral mode/);
    expect(c.snapshot().lastError).toMatchObject({ op: "delete", message: EPHEMERAL_MESSAGE });
    await expect(c.createEmptyFolder("shared")).rejects.toThrow(/ephemeral mode/);
    expect(c.snapshot().lastError?.op).toBe("create-folder");
    await expect(c.deleteEmptyFolder("shared")).rejects.toThrow(/ephemeral mode/);
    expect(c.snapshot().lastError?.op).toBe("delete-folder");
    c.dispose();
  });

  it("a store-backed controller reports itself persistent and hydrated", async () => {
    const store = await freshStore({ "/workspace/main.ddd": "m" });
    const c = await makeController(store);
    expect(c.snapshot().persistent).toBe(true);
    expect(c.snapshot().hydrated).toBe(true);
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

  // The store→editor direction of the sync: the editor holds its own copy
  // of the active file's text and only reseeds on remount, so an external
  // write (history restore, import, another tab) is invisible unless the
  // controller says "this content moved under you".
  describe("external-content epoch", () => {
    it("an external write to the ACTIVE file bumps the epoch", async () => {
      const store = await freshStore({ "/workspace/main.ddd": "old" });
      const c = await makeController(store);
      const before = c.snapshot().epoch;
      await store.writeFile("/workspace/main.ddd", "restored");
      await vi.waitFor(() => {
        expect(c.snapshot().files.get("/workspace/main.ddd")).toBe("restored");
        expect(c.snapshot().epoch).toBeGreaterThan(before);
      });
      c.dispose();
    });

    it("the controller's OWN write does not bump the epoch", async () => {
      const store = await freshStore({ "/workspace/main.ddd": "old" });
      const c = await makeController(store);
      const before = c.snapshot().epoch;
      await c.write("/workspace/main.ddd", "typed by the user");
      // Let the store notification's refresh land too — it must agree.
      await new Promise((r) => setTimeout(r, 20));
      expect(c.snapshot().files.get("/workspace/main.ddd")).toBe("typed by the user");
      expect(c.snapshot().epoch).toBe(before);
      c.dispose();
    });

    it("a burst of own writes does not bump the epoch", async () => {
      const store = await freshStore({ "/workspace/main.ddd": "old" });
      const c = await makeController(store);
      const before = c.snapshot().epoch;
      await Promise.all([
        c.write("/workspace/main.ddd", "a"),
        c.write("/workspace/main.ddd", "ab"),
        c.write("/workspace/main.ddd", "abc"),
      ]);
      await new Promise((r) => setTimeout(r, 20));
      expect(c.snapshot().epoch).toBe(before);
      c.dispose();
    });

    it("an external write to a NON-active file does not bump the epoch", async () => {
      const store = await freshStore({
        "/workspace/main.ddd": "m",
        "/workspace/orders.ddd": "o",
      });
      const c = await makeController(store);
      const before = c.snapshot().epoch;
      await store.writeFile("/workspace/orders.ddd", "changed elsewhere");
      await vi.waitFor(() =>
        expect(c.snapshot().files.get("/workspace/orders.ddd")).toBe("changed elsewhere"),
      );
      expect(c.snapshot().epoch).toBe(before);
      c.dispose();
    });

    it("hydrating the initial snapshot is not an external change", async () => {
      const store = await freshStore({ "/workspace/main.ddd": "seeded" });
      const c = await makeController(store);
      expect(c.snapshot().files.get("/workspace/main.ddd")).toBe("seeded");
      expect(c.snapshot().epoch).toBe(0);
      c.dispose();
    });
  });

  it("an external delete of the active file re-points activePath", async () => {
    // A restore that drops the open file bypasses `delete`, so the
    // fallback has to run from the refresh — otherwise `activePath`
    // dangles and the next editor write recreates the deleted file.
    const store = await freshStore({
      "/workspace/main.ddd": "m",
      "/workspace/orders.ddd": "o",
    });
    const c = await makeController(store);
    c.setActivePath("/workspace/orders.ddd");
    await store.deleteFile("/workspace/orders.ddd");
    await vi.waitFor(() => expect(c.snapshot().activePath).toBe(DEFAULT_PATH));
    c.dispose();
  });

  it("an external delete of a NON-active file leaves activePath alone", async () => {
    const store = await freshStore({
      "/workspace/main.ddd": "m",
      "/workspace/orders.ddd": "o",
    });
    const c = await makeController(store);
    await store.deleteFile("/workspace/orders.ddd");
    await vi.waitFor(() => expect([...c.snapshot().files.keys()]).toEqual(["/workspace/main.ddd"]));
    expect(c.snapshot().activePath).toBe(DEFAULT_PATH);
    c.dispose();
  });

  it("does not re-point activePath at a file that never existed yet", async () => {
    // The create flow flips the active path before the seed write lands;
    // a refresh in that window must not steal it back.
    const store = await freshStore({ "/workspace/main.ddd": "m" });
    const c = await makeController(store);
    c.setActivePath("/workspace/brand-new.ddd");
    await store.writeFile("/workspace/other.ddd", "unrelated");
    await vi.waitFor(() => expect(c.snapshot().files.has("/workspace/other.ddd")).toBe(true));
    expect(c.snapshot().activePath).toBe("/workspace/brand-new.ddd");
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

  // Creating a file used to be fire-and-forget: an unawaited `write`
  // followed by an immediate `setActivePath`, with every rejection
  // swallowed to `console.error`.  A failed create left the editor parked
  // on a file that didn't exist and the tree showing a row the next
  // refresh erased — "adding files didn't work" (audit #4/#5).
  describe("createFile", () => {
    it("writes the seed, makes the file active, and reports success", async () => {
      const store = await freshStore({ "/workspace/main.ddd": "m" });
      const c = await makeController(store);
      await expect(c.createFile("/workspace/orders.ddd", NEW_FILE_SEED)).resolves.toBe(true);
      expect(await store.readFile("/workspace/orders.ddd")).toBe(NEW_FILE_SEED);
      const snap = c.snapshot();
      expect(snap.files.get("/workspace/orders.ddd")).toBe(NEW_FILE_SEED);
      expect(snap.activePath).toBe("/workspace/orders.ddd");
      expect(snap.lastError).toBeNull();
      c.dispose();
    });

    it("a failing store write surfaces on the error channel and leaves activePath alone", async () => {
      const store = await freshStore({ "/workspace/main.ddd": "m" });
      const c = await makeController(store);
      store.writeFile = () => Promise.reject(new Error("QuotaExceededError"));
      await expect(c.createFile("/workspace/orders.ddd", NEW_FILE_SEED)).resolves.toBe(false);
      const snap = c.snapshot();
      expect(snap.activePath).toBe(DEFAULT_PATH);
      expect(snap.files.has("/workspace/orders.ddd")).toBe(false);
      expect(snap.lastError).toMatchObject({
        op: "create",
        path: "/workspace/orders.ddd",
        message: "QuotaExceededError",
      });
      c.dispose();
    });

    it("refuses in ephemeral mode and says why", async () => {
      const c = await makeController(null);
      await expect(c.createFile("/workspace/orders.ddd", NEW_FILE_SEED)).resolves.toBe(false);
      expect(c.snapshot().activePath).toBe(DEFAULT_PATH);
      expect(c.snapshot().lastError).toMatchObject({
        op: "create",
        message: EPHEMERAL_MESSAGE,
      });
      c.dispose();
    });

    it("refuses to overwrite an existing file", async () => {
      const store = await freshStore({ "/workspace/main.ddd": "hand-written" });
      const c = await makeController(store);
      await expect(c.createFile(DEFAULT_PATH, NEW_FILE_SEED)).resolves.toBe(false);
      expect(c.snapshot().files.get(DEFAULT_PATH)).toBe("hand-written");
      expect(c.snapshot().lastError?.op).toBe("create");
      c.dispose();
    });

    it("refuses a non-.ddd path", async () => {
      const c = await makeController(await freshStore());
      await expect(c.createFile("/workspace/notes.txt", "x")).resolves.toBe(false);
      expect(c.snapshot().lastError?.op).toBe("create");
      c.dispose();
    });

    it("is an OWN write — it must not bump the epoch", async () => {
      const store = await freshStore({ "/workspace/main.ddd": "m" });
      const c = await makeController(store);
      const before = c.snapshot().epoch;
      await c.createFile("/workspace/orders.ddd", NEW_FILE_SEED);
      await new Promise((r) => setTimeout(r, 20));
      expect(c.snapshot().epoch).toBe(before);
      c.dispose();
    });

    it("does not re-point activePath until the write has landed", async () => {
      // Slice A's `refresh` fallback re-points `activePath` when the active
      // file disappears.  Flipping the active path BEFORE the write landed
      // (the old create flow) raced that; the write-then-flip order can't.
      const store = await freshStore({ "/workspace/main.ddd": "m" });
      const c = await makeController(store);
      const seen: string[] = [];
      c.subscribe((s) => seen.push(s.activePath));
      await c.createFile("/workspace/orders.ddd", NEW_FILE_SEED);
      const firstNew = seen.indexOf("/workspace/orders.ddd");
      expect(firstNew).toBeGreaterThan(-1);
      // Every emit before the flip still names the old active path, i.e.
      // nothing observed the editor pointing at a file the store lacked.
      expect(seen.slice(0, firstNew).every((p) => p === DEFAULT_PATH)).toBe(true);
      c.dispose();
    });
  });

  describe("mutation error channel", () => {
    it("clearError dismisses and re-emits", async () => {
      const c = await makeController(null);
      await c.createFile("/workspace/orders.ddd", NEW_FILE_SEED);
      expect(c.snapshot().lastError).not.toBeNull();
      const listener = vi.fn<(s: WorkspaceSourcesSnapshot) => void>();
      c.subscribe(listener);
      c.clearError();
      expect(c.snapshot().lastError).toBeNull();
      expect(listener).toHaveBeenCalledTimes(1);
      // Idempotent — a second clear is not a change.
      listener.mockClear();
      c.clearError();
      expect(listener).not.toHaveBeenCalled();
      c.dispose();
    });

    it("the next EXPLICIT mutation clears a stale error, an autosave write does not", async () => {
      const store = await freshStore({ "/workspace/main.ddd": "m" });
      const c = await makeController(store);
      await c.createFile(DEFAULT_PATH, NEW_FILE_SEED); // duplicate → error
      expect(c.snapshot().lastError).not.toBeNull();
      // The autosave hot path must not wipe the message the user is reading.
      await c.write(DEFAULT_PATH, "typed by the user");
      expect(c.snapshot().lastError).not.toBeNull();
      // An explicit create does — the banner reflects the last thing asked for.
      await c.createFile("/workspace/orders.ddd", NEW_FILE_SEED);
      expect(c.snapshot().lastError).toBeNull();
      c.dispose();
    });

    it("a failed delete lands on the channel and still rejects", async () => {
      const store = await freshStore({ "/workspace/main.ddd": "m" });
      const c = await makeController(store);
      store.deleteFile = () => Promise.reject(new Error("locked"));
      await expect(c.delete(DEFAULT_PATH)).rejects.toThrow(/locked/);
      expect(c.snapshot().lastError).toMatchObject({
        op: "delete",
        path: DEFAULT_PATH,
        message: "locked",
      });
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

// The other half of slice A's store→editor direction: the editor's SEED.
// `workspace.persistedSource` is read once at store-open and never
// refreshed, so anything that consults it after the controller has read
// the store can hand Monaco pre-restore text — which the next keystroke
// writes straight back over the restored tree.
describe("editor seed precedence (pickInitialSource)", () => {
  const base = {
    activePath: DEFAULT_PATH,
    hydrated: true,
    persistedSource: "PRE-RESTORE main.ddd",
    exampleSource: "EXAMPLE",
  };

  it("prefers the controller's live content for the active file", () => {
    expect(
      pickInitialSource({
        ...base,
        files: new Map([[DEFAULT_PATH, "RESTORED"]]),
      }),
    ).toBe("RESTORED");
  });

  it("uses the open-time persistedSource only BEFORE the controller hydrates", () => {
    expect(pickInitialSource({ ...base, hydrated: false, files: new Map() })).toBe(
      "PRE-RESTORE main.ddd",
    );
  });

  it("cannot reseed stale content once the store says main.ddd is gone", () => {
    // A restore deleted main.ddd; the controller has hydrated and the
    // fallback active path is main.ddd again.  Before the fix this
    // resurrected the open-time read.
    const seed = pickInitialSource({ ...base, files: new Map() });
    expect(seed).not.toBe("PRE-RESTORE main.ddd");
    expect(seed).toBe("EXAMPLE");
  });

  it("falls back to the example for a brand-new workspace with no persisted read", () => {
    expect(
      pickInitialSource({ ...base, hydrated: false, persistedSource: null, files: new Map() }),
    ).toBe("EXAMPLE");
  });

  it("seeds a not-yet-written non-main file with the new-file stub", () => {
    expect(
      pickInitialSource({ ...base, activePath: "/workspace/orders.ddd", files: new Map() }),
    ).toBe(NEW_FILE_SEED);
  });

  it("survives the full external-delete round trip against a real controller", async () => {
    const store = await freshStore({
      "/workspace/main.ddd": "PRE-RESTORE main.ddd",
      "/workspace/orders.ddd": "o",
    });
    const c = await makeController(store);
    // A restore drops every file, exactly as `restoreCommit` would.
    await store.deleteFile("/workspace/orders.ddd");
    await store.deleteFile("/workspace/main.ddd");
    await vi.waitFor(() => expect(c.snapshot().files.size).toBe(0));
    const snap = c.snapshot();
    expect(snap.activePath).toBe(DEFAULT_PATH); // the dangling-path fallback
    expect(
      pickInitialSource({
        files: snap.files,
        activePath: snap.activePath,
        hydrated: snap.hydrated,
        persistedSource: "PRE-RESTORE main.ddd",
        exampleSource: "EXAMPLE",
      }),
    ).toBe("EXAMPLE");
    c.dispose();
  });
});
