import { describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { GitStore, openGitFs } from "../../web/src/workspace/git/index.js";

// ---------------------------------------------------------------------------
// GitStore.commitChanges — the read-only per-commit file list backing the
// History view.  A root commit reports all-added; a follow-up reports
// added/modified/removed vs its first parent; only /workspace content.
// ---------------------------------------------------------------------------

let dbCounter = 0;
async function freshStore(): Promise<GitStore> {
  return new GitStore(await openGitFs(`loom-commitchanges-${++dbCounter}`));
}

describe("GitStore.commitChanges", () => {
  it("reports every file as added for the root commit", async () => {
    const store = await freshStore();
    await store.writeFile("/workspace/a.ddd", "1");
    await store.writeFile("/workspace/sub/b.ddd", "1");
    const oid = (await store.commitWorkingTree("c1"))!;
    const changes = await store.commitChanges(oid);
    expect(changes).toEqual([
      { path: "/workspace/a.ddd", status: "added" },
      { path: "/workspace/sub/b.ddd", status: "added" },
    ]);
  });

  it("classifies added / modified / removed vs the parent commit", async () => {
    const store = await freshStore();
    await store.writeFile("/workspace/a.ddd", "1");
    await store.writeFile("/workspace/b.ddd", "1");
    await store.commitWorkingTree("c1");

    await store.writeFile("/workspace/a.ddd", "2"); // modified
    await store.deleteFile("/workspace/b.ddd"); // removed
    await store.writeFile("/workspace/c.ddd", "1"); // added
    const oid2 = (await store.commitWorkingTree("c2"))!;

    const byPath = Object.fromEntries(
      (await store.commitChanges(oid2)).map((c) => [c.path, c.status]),
    );
    expect(byPath).toEqual({
      "/workspace/a.ddd": "modified",
      "/workspace/b.ddd": "removed",
      "/workspace/c.ddd": "added",
    });
  });

  it("includes generated files (they live under /workspace) but nothing outside it", async () => {
    const store = await freshStore();
    await store.writeFile("/workspace/generated/app/x.ts", "gen");
    const oid = (await store.commitWorkingTree("gen")) ?? "";
    const paths = (await store.commitChanges(oid)).map((c) => c.path);
    expect(paths).toContain("/workspace/generated/app/x.ts");
    expect(paths.every((p) => p.startsWith("/workspace/"))).toBe(true);
  });
});
