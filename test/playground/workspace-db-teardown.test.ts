import { describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { closeGitFs, deleteGitDb, GitStore, openGitFs } from "../../web/src/workspace/git/index.js";

// ---------------------------------------------------------------------------
// Workspace-delete teardown (defect #18 of the 2026-07 review's register — the
// `deleteWorkspace` IDB race).  `indexedDB.deleteDatabase` against a database
// whose connection is still open never completes: it fires `blocked` and the
// DB is orphaned forever.  The fix is the close-before-delete ordering plus an
// awaited, `blocked`-aware delete; both halves are asserted here against
// fake-indexeddb, which implements the real blocking semantics.
// ---------------------------------------------------------------------------

let dbCounter = 0;
function uniqueDbName(): string {
  return `loom-teardown-test-${++dbCounter}`;
}

/** True when opening `name` runs `onupgradeneeded` — i.e. the database did
 *  not exist (so a preceding delete really took effect). */
function isGone(name: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    let fresh = false;
    req.onupgradeneeded = () => {
      fresh = true;
    };
    req.onsuccess = () => {
      req.result.close();
      resolve(fresh);
    };
    req.onerror = () => reject(req.error);
  });
}

describe("deleteGitDb", () => {
  it("reports `blocked` while a store connection is still open", async () => {
    const name = uniqueDbName();
    const store = new GitStore(await openGitFs(name));
    await store.writeFile("/workspace/main.ddd", "system X {}");

    // No close first — the old fire-and-forget behaviour.  The delete is
    // blocked by the live LightningFS connection and must be REPORTED, not
    // silently assumed to have worked.
    // (The request itself stays pending in the browser until whatever holds
    // the connection lets go — which is exactly the orphan the caller needs
    // told about, since in the app nothing else ever closes it.)
    expect(await deleteGitDb(name, 50)).toBe("blocked");
  });

  it("completes once the connection is closed first", async () => {
    const name = uniqueDbName();
    const gfs = await openGitFs(name);
    const store = new GitStore(gfs);
    await store.writeFile("/workspace/main.ddd", "system X {}");

    await closeGitFs(gfs);
    expect(await deleteGitDb(name, 500)).toBe("deleted");
    expect(await isGone(name)).toBe(true);
  });

  it("closeGitFs is idempotent and leaves the store usable", async () => {
    const name = uniqueDbName();
    const gfs = await openGitFs(name);
    const store = new GitStore(gfs);
    await store.writeFile("/workspace/main.ddd", "a");
    await closeGitFs(gfs);
    await closeGitFs(gfs);
    // LightningFS transparently re-activates on the next operation.
    expect(await store.readFile("/workspace/main.ddd")).toBe("a");
  });

  it("resolves `deleted` for a database that never existed", async () => {
    expect(await deleteGitDb(uniqueDbName(), 200)).toBe("deleted");
  });
});
