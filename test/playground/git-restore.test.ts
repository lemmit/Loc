import { describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { GitStore, openGitFs } from "../../web/src/workspace/git/index.js";

// ---------------------------------------------------------------------------
// GitStore.restoreCommit — content-based restore of the /workspace tree to
// a past commit (overwrite/add its files, delete the rest), without moving
// HEAD.  Backs the History panel's "Restore this version".
// ---------------------------------------------------------------------------

let dbCounter = 0;
async function freshStore(): Promise<GitStore> {
  return new GitStore(await openGitFs(`loom-restore-${++dbCounter}`));
}

describe("GitStore.restoreCommit", () => {
  it("restores files to a past commit's state (overwrite, re-add, delete)", async () => {
    const store = await freshStore();
    await store.writeFile("/workspace/a.ddd", "v1");
    await store.writeFile("/workspace/b.ddd", "keep");
    const c1 = (await store.commitWorkingTree("c1"))!;

    // Diverge: modify a, delete b, add c.
    await store.writeFile("/workspace/a.ddd", "v2");
    await store.deleteFile("/workspace/b.ddd");
    await store.writeFile("/workspace/c.ddd", "new");
    await store.commitWorkingTree("c2");

    const changed = await store.restoreCommit(c1);

    expect(await store.readFile("/workspace/a.ddd")).toBe("v1"); // reverted
    expect(await store.readFile("/workspace/b.ddd")).toBe("keep"); // re-added
    expect(await store.exists("/workspace/c.ddd")).toBe(false); // removed
    expect(changed.sort()).toEqual(["/workspace/a.ddd", "/workspace/b.ddd", "/workspace/c.ddd"]);
  });

  it("restoring to the current state changes nothing", async () => {
    const store = await freshStore();
    await store.writeFile("/workspace/a.ddd", "v1");
    const head = (await store.commitWorkingTree("c1"))!;
    expect(await store.restoreCommit(head)).toEqual([]);
    expect(await store.readFile("/workspace/a.ddd")).toBe("v1");
  });

  it("leaves history recoverable: the pre-restore state is still a commit", async () => {
    const store = await freshStore();
    await store.writeFile("/workspace/a.ddd", "v1");
    const c1 = (await store.commitWorkingTree("c1"))!;
    await store.writeFile("/workspace/a.ddd", "v2");
    const c2 = (await store.commitWorkingTree("c2"))!;

    await store.restoreCommit(c1);
    await store.commitWorkingTree("restore");

    // c2's content is still reachable by restoring forward to it.
    await store.restoreCommit(c2);
    expect(await store.readFile("/workspace/a.ddd")).toBe("v2");
  });
});
