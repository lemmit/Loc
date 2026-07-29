import { describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import {
  applyGeneratedTree,
  GENERATED_PREFIX,
  GitStore,
  openGitFs,
} from "../../web/src/workspace/git/index.js";

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

  // The generated-merge base ("the output generated last time") has to
  // roll back with the tree.  Left pointing at the newer output, every
  // rolled-back generated file reads as a hand edit and the next
  // regenerate sprays conflict markers over /workspace/generated/**.
  describe("generated-base re-baseline", () => {
    it("a regenerate after restore takes fresh output without conflicts", async () => {
      const store = await freshStore();
      await store.writeFile("/workspace/main.ddd", "v1");
      // `applyGeneratedTree` commits the merge itself, so HEAD after it
      // IS the "v1 + its generated output" milestone.
      await applyGeneratedTree(store, [{ path: "app/domain.ts", content: "gen-v1" }]);
      const c1 = (await store.log(1))[0]!.oid;

      // Move on: source v2 + its generated output, committed.
      await store.writeFile("/workspace/main.ddd", "v2");
      await applyGeneratedTree(store, [{ path: "app/domain.ts", content: "gen-v2" }]);

      await store.restoreCommit(c1);
      expect(await store.readFile(GENERATED_PREFIX + "app/domain.ts")).toBe("gen-v1");

      // Edit the rolled-back source and regenerate: nobody hand-edited the
      // generated tree, so the fresh output must apply cleanly.  With the
      // base still at gen-v2 the working copy (gen-v1) reads as a hand
      // edit and this conflicts.
      await store.writeFile("/workspace/main.ddd", "v1b");
      const res = await applyGeneratedTree(store, [{ path: "app/domain.ts", content: "gen-v1b" }]);
      expect(res.conflicted).toEqual([]);
      expect(await store.readFile(GENERATED_PREFIX + "app/domain.ts")).toBe("gen-v1b");
    });

    it("a genuine hand edit made after the restore still conflicts", async () => {
      const store = await freshStore();
      await applyGeneratedTree(store, [{ path: "a.ts", content: "gen-v1" }]);
      const c1 = (await store.log(1))[0]!.oid;
      await applyGeneratedTree(store, [{ path: "a.ts", content: "gen-v2" }]);

      await store.restoreCommit(c1);
      await store.writeFile(GENERATED_PREFIX + "a.ts", "hand-edited");

      const res = await applyGeneratedTree(store, [{ path: "a.ts", content: "gen-v3" }]);
      expect(res.conflicted).toEqual([GENERATED_PREFIX + "a.ts"]);
    });
  });
});
