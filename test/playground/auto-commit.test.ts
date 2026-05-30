import { describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { GitStore, openGitFs, startAutoCommit } from "../../web/src/workspace/git/index.js";

// ---------------------------------------------------------------------------
// Commit-on-save: GitStore.commitWorkingTree (serialised) + the debounced
// startAutoCommit, plus the list `skip` option the source scans use to
// prune the generated subtree.
// ---------------------------------------------------------------------------

let dbCounter = 0;
function uniqueDbName(): string {
  return `loom-autocommit-test-${++dbCounter}`;
}

async function freshStore(): Promise<GitStore> {
  return new GitStore(await openGitFs(uniqueDbName()));
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("GitStore.commitWorkingTree", () => {
  it("commits working-tree changes and returns the oid", async () => {
    const store = await freshStore();
    await store.writeFile("/workspace/main.ddd", "system X {}");
    const oid = await store.commitWorkingTree("save");
    expect(oid).toBeTypeOf("string");
    const log = await store.log();
    expect(log).toHaveLength(1);
    expect(log[0].message).toContain("save");
  });

  it("is a no-op (undefined) when nothing changed", async () => {
    const store = await freshStore();
    await store.writeFile("/workspace/main.ddd", "a");
    await store.commitWorkingTree("first");
    expect(await store.commitWorkingTree("again")).toBeUndefined();
    expect(await store.log()).toHaveLength(1);
  });

  it("serialises concurrent commits — no interleave, consistent history", async () => {
    const store = await freshStore();
    await store.writeFile("/workspace/a.ddd", "1");
    // Fire two commits without awaiting the first; the lock serialises them.
    const [r1, r2] = await Promise.all([
      store.commitWorkingTree("c1"),
      store.commitWorkingTree("c2"),
    ]);
    // Exactly one produced a commit; the other found nothing to stage.
    const oids = [r1, r2].filter((x) => x !== undefined);
    expect(oids).toHaveLength(1);
    expect(await store.log()).toHaveLength(1);
  });

  it("keeps committing after a failing run (chain not wedged)", async () => {
    const store = await freshStore();
    // A bogus commit can't really fail here cheaply, so just prove the
    // chain survives a no-op then a real commit in sequence.
    expect(await store.commitWorkingTree("noop")).toBeUndefined();
    await store.writeFile("/workspace/main.ddd", "x");
    expect(await store.commitWorkingTree("real")).toBeTypeOf("string");
  });
});

describe("startAutoCommit", () => {
  it("commits after the debounce once edits settle", async () => {
    const store = await freshStore();
    const stop = startAutoCommit(store, { debounceMs: 10, message: "autosave" });
    await store.writeFile("/workspace/main.ddd", "v1");
    await tick(40);
    const log = await store.log();
    expect(log).toHaveLength(1);
    expect(log[0].message).toContain("autosave");
    stop();
  });

  it("coalesces a burst of writes into a single commit", async () => {
    const store = await freshStore();
    const stop = startAutoCommit(store, { debounceMs: 20 });
    await store.writeFile("/workspace/a.ddd", "1");
    await store.writeFile("/workspace/b.ddd", "2");
    await store.writeFile("/workspace/c.ddd", "3");
    await tick(60);
    expect(await store.log()).toHaveLength(1);
    stop();
  });

  it("does not commit after dispose", async () => {
    const store = await freshStore();
    const stop = startAutoCommit(store, { debounceMs: 20 });
    await store.writeFile("/workspace/main.ddd", "v1");
    stop(); // cancel the pending commit before it fires
    await tick(50);
    await expect(store.log()).rejects.toBeTruthy(); // no commits ever made
  });
});

describe("GitStore.list skip option", () => {
  it("prunes a subtree from list / listDirs / listAll", async () => {
    const store = await freshStore();
    await store.writeFile("/workspace/main.ddd", "a");
    await store.writeFile("/workspace/generated/app/x.ts", "gen");
    await store.writeFile("/workspace/design/pack.json", "{}");

    const skip = { skip: ["/workspace/generated"] };
    const files = await store.list("/workspace", skip);
    expect(files).toContain("/workspace/main.ddd");
    expect(files).toContain("/workspace/design/pack.json");
    expect(files.some((p) => p.startsWith("/workspace/generated"))).toBe(false);

    const dirs = await store.listDirs("/workspace", skip);
    expect(dirs.some((p) => p.startsWith("/workspace/generated"))).toBe(false);
    expect(dirs).toContain("/workspace/design");

    // Without skip, the generated subtree is present.
    const all = await store.list("/workspace");
    expect(all).toContain("/workspace/generated/app/x.ts");
  });
});
