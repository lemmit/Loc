import { describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import {
  closeGitFs,
  deleteGitDb,
  type GitFs,
  GitStore,
  invalidateGitFsCache,
  openGitFs,
  startAutoCommit,
  WorkspaceReadOnlyError,
} from "../../web/src/workspace/git/index.js";
import {
  acquireWriterLock,
  type LockGrantedCallback,
  type LockManagerLike,
  type LockRequestOptionsLike,
} from "../../web/src/workspace/tab-lock.js";
import {
  OTHER_TAB_MESSAGE,
  WorkspaceSourcesController,
} from "../../web/src/workspace/workspace-sources.js";

// ---------------------------------------------------------------------------
// READ-ONLY ENFORCEMENT + cross-tab invalidation, at the store layer
// (mission M-T8.12, phases 1-2).
//
// The point of these tests is that read-only is a GUARANTEE, not a set of
// disabled buttons: the loss paths that actually corrupted a workspace (the
// debounced autosave, the generated-tree merge, a history restore) never go
// near a button, so every one of them has to be refused at the single choke
// point they share.
//
// The cross-tab half runs two `GitStore`s over the SAME fake-IndexedDB name —
// the closest in-process analogue of two browser tabs — and asserts that a
// `files` invalidation makes the passive store observe the other's write, and
// that applying one NEVER re-publishes (the echo loop).
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `check` until it holds (the controller refresh is fire-and-forget). */
async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await sleep(10);
  }
}

let dbCounter = 0;
const uniqueDbName = (): string => `loom-readonly-test-${++dbCounter}`;

async function freshStore(seed: Record<string, string> = {}): Promise<GitStore> {
  const store = new GitStore(await openGitFs(uniqueDbName()));
  for (const [path, content] of Object.entries(seed)) {
    await store.writeFile(path, content);
  }
  return store;
}

describe("GitStore read-only mode", () => {
  it("refuses every mutator with a WorkspaceReadOnlyError", async () => {
    const store = await freshStore({ "/workspace/main.ddd": "system A {}" });
    await store.commitWorkingTree("seed");
    const head = await store.log(1);
    store.setWritable(false);

    const rejects = async (label: string, run: () => Promise<unknown>): Promise<void> => {
      await expect(run(), label).rejects.toBeInstanceOf(WorkspaceReadOnlyError);
    };
    await rejects("writeFile", () => store.writeFile("/workspace/new.ddd", "x"));
    await rejects("deleteFile", () => store.deleteFile("/workspace/main.ddd"));
    await rejects("mkdir", () => store.mkdir("/workspace/shared"));
    await rejects("rmdir", () => store.rmdir("/workspace/shared"));
    await rejects("stageAll", () => store.stageAll());
    await rejects("commit", () => store.commit("nope"));
    await rejects("commitWorkingTree", () => store.commitWorkingTree("nope"));
    await rejects("writeRef", () => store.writeRef("refs/loom/x", head[0]!.oid));
    await rejects("writeBlobText", () => store.writeBlobText("x"));
    await rejects("restoreCommit", () => store.restoreCommit(head[0]!.oid));
  });

  it("leaves every READ working — a passive tab is still a useful tab", async () => {
    const store = await freshStore({ "/workspace/main.ddd": "system A {}" });
    const oid = await store.commitWorkingTree("seed");
    store.setWritable(false);

    expect(await store.readFile("/workspace/main.ddd")).toBe("system A {}");
    expect(await store.list("/workspace")).toContain("/workspace/main.ddd");
    expect(await store.exists("/workspace/main.ddd")).toBe(true);
    expect((await store.log(10)).length).toBeGreaterThan(0);
    expect(await store.commitChanges(oid!)).not.toHaveLength(0);
    expect(await store.readFileAtRef("/workspace/main.ddd")).toBe("system A {}");
    expect(await store.snapshotEntries("/workspace")).not.toHaveLength(0);
  });

  it("nothing reached the tree — the refusal is not cosmetic", async () => {
    const store = await freshStore({ "/workspace/main.ddd": "system A {}" });
    store.setWritable(false);
    await store.writeFile("/workspace/ghost.ddd", "x").catch(() => {});
    expect(await store.exists("/workspace/ghost.ddd")).toBe(false);
    store.setWritable(true);
    await store.writeFile("/workspace/ghost.ddd", "x");
    expect(await store.exists("/workspace/ghost.ddd")).toBe(true);
  });

  it("startAutoCommit records nothing while read-only, and resumes on take-over", async () => {
    // Real timers on purpose: LightningFS drives its own activation window off
    // `setTimeout`, so faking the clock here wedges the filesystem, not just
    // the debounce under test.
    const store = await freshStore({ "/workspace/main.ddd": "system A {}" });
    const commit = vi.spyOn(store, "commitWorkingTree").mockResolvedValue(undefined);
    const stop = startAutoCommit(store, { debounceMs: 10 });

    store.setWritable(false);
    // A remote invalidation fans out through the SAME notifier the autosave
    // listens to — the passive tab must not turn that into a commit.
    await store.applyRemote(["/workspace/main.ddd"]);
    await sleep(60);
    expect(commit).not.toHaveBeenCalled();

    store.setWritable(true);
    await store.applyRemote(["/workspace/main.ddd"]);
    await sleep(60);
    expect(commit).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("GitStore cross-tab invalidation", () => {
  it("a `files` invalidation makes the passive store see the other tab's write", async () => {
    const name = uniqueDbName();
    const ownerFs = await openGitFs(name);
    const passiveFs: GitFs = await openGitFs(name);
    const owner = new GitStore(ownerFs);
    const passive = new GitStore(passiveFs);
    passive.setWritable(false);

    const controller = new WorkspaceSourcesController(passive);
    await controller.ready();
    expect(controller.snapshot().files.has("/workspace/added.ddd")).toBe(false);
    expect(controller.snapshot().writable).toBe(false);
    expect(controller.snapshot().readOnlyReason).toBe("other-tab");

    await owner.writeFile("/workspace/added.ddd", "system B {}");
    // In the browser the owner's LightningFS activation window closes on its
    // own 500 ms after the last op; in-process we close it explicitly so the
    // passive store can take the filesystem mutex without a poll wait.
    await invalidateGitFsCache(ownerFs);

    // …and this is the phase-2 transport: the passive tab feeds the received
    // message into the store's EXISTING fan-out, so the controller refreshes
    // through machinery that already existed.
    await passive.applyRemote(["/workspace/added.ddd"]);

    // The FS-cache half: the passive store's very next read is fresh, which is
    // the whole reason `applyRemote` drops the activation window first.
    expect(await passive.readFile("/workspace/added.ddd")).toBe("system B {}");
    // …and the app-layer half: the controller's own refresh (async — it is
    // driven by the fan-out, not awaited by it) picks the file up.
    await until(() => controller.snapshot().files.has("/workspace/added.ddd"));
    expect(controller.snapshot().files.get("/workspace/added.ddd")).toBe("system B {}");
    controller.dispose();
  });

  it("applying a remote invalidation never re-publishes (no echo loop)", async () => {
    const store = await freshStore({ "/workspace/main.ddd": "a" });
    const files = vi.fn();
    const commit = vi.fn();
    store.setTabPublisher({ files, commit });

    // A LOCAL write publishes…
    await store.writeFile("/workspace/main.ddd", "b");
    expect(files).toHaveBeenCalledTimes(1);
    const oid = await store.commitWorkingTree("local");
    expect(commit).toHaveBeenCalledTimes(1);

    files.mockClear();
    commit.mockClear();

    // …a REMOTE one does not, or two tabs would bounce invalidations forever.
    await store.applyRemote(["/workspace/main.ddd"]);
    await store.applyRemoteCommit(oid ?? "abc");
    expect(files).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("applyRemote still drives local subscribers (that IS the liveness)", async () => {
    const store = await freshStore({ "/workspace/main.ddd": "a" });
    const seen: string[][] = [];
    store.subscribe("/workspace", (paths) => seen.push([...paths]));
    const commits: string[] = [];
    store.subscribeCommits((oid) => commits.push(oid));

    await store.applyRemote(["/workspace/main.ddd"]);
    await store.applyRemoteCommit("cafebabe");

    expect(seen).toEqual([["/workspace/main.ddd"]]);
    expect(commits).toEqual(["cafebabe"]);
  });

  it("setTabPublisher(null) detaches cleanly", async () => {
    const store = await freshStore({ "/workspace/main.ddd": "a" });
    const files = vi.fn();
    store.setTabPublisher({ files, commit: vi.fn() });
    store.setTabPublisher(null);
    await store.writeFile("/workspace/main.ddd", "b");
    expect(files).not.toHaveBeenCalled();
  });
});

describe("WorkspaceSourcesController under another tab's lock", () => {
  it("reports the other-tab reason and refuses explicit mutations", async () => {
    const store = await freshStore({ "/workspace/main.ddd": "a" });
    const controller = new WorkspaceSourcesController(store);
    await controller.ready();
    expect(controller.snapshot().writable).toBe(true);

    const snapshots: boolean[] = [];
    controller.subscribe((s) => snapshots.push(s.writable));
    store.setWritable(false);
    // The role flip alone must re-emit — the UI's disabled state hangs off it.
    expect(snapshots).toContain(false);

    expect(controller.snapshot().readOnlyReason).toBe("other-tab");
    expect(await controller.createFile("/workspace/new.ddd", "x")).toBe(false);
    expect(controller.snapshot().lastError?.message).toBe(OTHER_TAB_MESSAGE);
    await expect(controller.delete("/workspace/main.ddd")).rejects.toThrow(/another tab/);
    await expect(controller.createEmptyFolder("shared")).rejects.toThrow(/another tab/);

    // `write` is the autosave hot path: suppressed SILENTLY (a rejection per
    // keystroke helps nobody), with the store guard as the hard backstop.
    await expect(controller.write("/workspace/main.ddd", "zzz")).resolves.toBeUndefined();
    expect(await store.readFile("/workspace/main.ddd")).toBe("a");

    // Take-over restores everything without rebuilding the controller.
    store.setWritable(true);
    expect(controller.snapshot().writable).toBe(true);
    expect(await controller.createFile("/workspace/new.ddd", "x")).toBe(true);
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A workspace DELETE issued from the tab that owns the writer lock. The lock
// is never a gate on deletion, so this must not deadlock — and the delete
// itself must still complete rather than hang on `blocked`.
// ---------------------------------------------------------------------------

class SoloLockManager implements LockManagerLike {
  private held = false;
  request(
    _name: string,
    options: LockRequestOptionsLike,
    callback: LockGrantedCallback,
  ): Promise<unknown> {
    if (this.held && options.ifAvailable === true) {
      return Promise.resolve(callback(null));
    }
    this.held = true;
    return Promise.resolve(callback({ name: _name })).finally(() => {
      this.held = false;
    });
  }
}

describe("deleteWorkspace under this tab's own writer lock", () => {
  it("completes the IDB delete and releases afterwards — no self-deadlock", async () => {
    const name = uniqueDbName();
    const manager = new SoloLockManager();
    const lock = await acquireWriterLock(name, { manager });
    expect(lock.owner).toBe(true);

    const gfs = await openGitFs(name);
    const store = new GitStore(gfs);
    await store.writeFile("/workspace/main.ddd", "system A {}");

    // Exactly the ordering `useWorkspace.deleteWorkspace` uses: close this
    // tab's connection, delete, THEN release.  Nothing here awaits the lock.
    await closeGitFs(gfs);
    expect(await deleteGitDb(name, 500)).toBe("deleted");
    lock.release();
    expect(lock.owner).toBe(false);

    // The lock is free for the next tab that opens this workspace name.
    const next = await acquireWriterLock(name, { manager });
    expect(next.owner).toBe(true);
    next.release();
  });
});
