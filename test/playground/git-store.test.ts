import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";

import type { VfsPath } from "../../web/src/vfs/types.js";
import { commitOnSave, GitStore, openGitFs } from "../../web/src/workspace/git/index.js";

// ---------------------------------------------------------------------------
// GitStore — async, git-backed durable store (LightningFS +
// isomorphic-git).  First step of the playground git-VFS migration
// (docs/old/plans/playground-git-vfs-implementation.md); the module ships
// dark (no consumer wired) so these unit tests are the only gate that
// the durable store, its notifier seam, and the commit/merge helpers
// behave.  Reuses the same `fake-indexeddb/auto` harness as
// idb-vfs.test.ts — LightningFS is IndexedDB-backed.
// ---------------------------------------------------------------------------

beforeAll(() => {
  expect(typeof indexedDB).toBe("object");
});

let dbCounter = 0;
function uniqueDbName(): string {
  // One IDB per test so LightningFS state doesn't leak across tests.
  return `loom-git-test-${++dbCounter}`;
}

async function freshStore(): Promise<GitStore> {
  const gfs = await openGitFs(uniqueDbName());
  return new GitStore(gfs);
}

describe("GitStore: file API round-trip", () => {
  let store: GitStore;
  beforeEach(async () => {
    store = await freshStore();
  });

  it("writes then reads a file (with mkdirp of parents)", async () => {
    await store.writeFile("/workspace/nested/dir/main.ddd", "system X {}");
    expect(await store.readFile("/workspace/nested/dir/main.ddd")).toBe("system X {}");
    expect(await store.exists("/workspace/nested/dir/main.ddd")).toBe(true);
    expect(await store.isFile("/workspace/nested/dir/main.ddd")).toBe(true);
    expect(await store.isDirectory("/workspace/nested")).toBe(true);
  });

  it("read returns undefined for missing path or a directory", async () => {
    expect(await store.readFile("/workspace/nope.ddd")).toBeUndefined();
    await store.mkdir("/workspace/folder");
    expect(await store.readFile("/workspace/folder")).toBeUndefined();
    expect(await store.kindOf("/workspace/folder")).toBe("dir");
  });

  it("delete removes a file and is a no-op on missing/dir", async () => {
    await store.writeFile("/workspace/a.ddd", "1");
    await store.deleteFile("/workspace/a.ddd");
    expect(await store.exists("/workspace/a.ddd")).toBe(false);
    // no-op paths must not throw
    await store.deleteFile("/workspace/a.ddd");
    await store.mkdir("/workspace/keep");
    await store.deleteFile("/workspace/keep");
    expect(await store.isDirectory("/workspace/keep")).toBe(true);
  });

  it("lists files / dirs / all under a prefix, sorted, boundary-aware", async () => {
    await store.writeFile("/workspace/main.ddd", "a");
    await store.writeFile("/workspace/sub/b.ddd", "b");
    await store.mkdir("/workspace/empty");
    expect(await store.list("/workspace")).toEqual(["/workspace/main.ddd", "/workspace/sub/b.ddd"]);
    // Directory listings include the bootstrapped `/workspace` root and
    // any parent dirs LightningFS materialises for nested files — the
    // workspace controller's `snapshotEmptyFolders` already accounts for
    // both (workspace-sources.ts:84-88).
    expect(await store.listDirs("/workspace")).toEqual([
      "/workspace",
      "/workspace/empty",
      "/workspace/sub",
    ]);
    expect(await store.listAll("/workspace")).toEqual([
      "/workspace",
      "/workspace/empty",
      "/workspace/main.ddd",
      "/workspace/sub",
      "/workspace/sub/b.ddd",
    ]);
    // Directory-boundary match: `/workspace/main` must not catch
    // `/workspace/main.ddd`.
    expect(await store.list("/workspace/main")).toEqual([]);
  });
});

describe("GitStore: directories", () => {
  let store: GitStore;
  beforeEach(async () => {
    store = await freshStore();
  });

  it("mkdir is idempotent (mkdirp)", async () => {
    await store.mkdir("/workspace/a/b/c");
    await store.mkdir("/workspace/a/b/c");
    expect(await store.isDirectory("/workspace/a")).toBe(true);
    expect(await store.isDirectory("/workspace/a/b/c")).toBe(true);
  });

  it("rmdir removes empty dirs and refuses non-empty ones", async () => {
    await store.mkdir("/workspace/empty");
    await store.rmdir("/workspace/empty");
    expect(await store.exists("/workspace/empty")).toBe(false);
    // non-empty
    await store.writeFile("/workspace/full/x.ddd", "x");
    await expect(store.rmdir("/workspace/full")).rejects.toThrow(/not empty/);
    // no-op on missing / on a file
    await store.rmdir("/workspace/ghost");
    await store.rmdir("/workspace/full/x.ddd");
    expect(await store.isFile("/workspace/full/x.ddd")).toBe(true);
  });
});

describe("GitStore: path normalization", () => {
  let store: GitStore;
  beforeEach(async () => {
    store = await freshStore();
  });

  it("collapses . and .. and round-trips the normalised path", async () => {
    await store.writeFile("/workspace/./sub/../main.ddd", "x");
    expect(await store.readFile("/workspace/main.ddd")).toBe("x");
  });

  it("rejects relative paths and root escapes", async () => {
    await expect(store.readFile("workspace/x.ddd")).rejects.toThrow(/must be absolute/);
    await expect(store.readFile("/../escape")).rejects.toThrow(/escapes root/);
  });
});

describe("GitStore: git ops", () => {
  let store: GitStore;
  beforeEach(async () => {
    store = await freshStore();
  });

  it("commit-on-save then log shows the commit", async () => {
    await store.writeFile("/workspace/main.ddd", "system X {}");
    const oid = await commitOnSave(store, "initial");
    expect(oid).toBeTypeOf("string");
    const log = await store.log();
    expect(log).toHaveLength(1);
    expect(log[0].message).toContain("initial");
    expect(log[0].author.name).toBe("Loom Playground");
  });

  it("commit-on-save is a no-op when nothing changed", async () => {
    await store.writeFile("/workspace/main.ddd", "a");
    await commitOnSave(store, "first");
    const again = await commitOnSave(store, "noop");
    expect(again).toBeUndefined();
    expect(await store.log()).toHaveLength(1);
  });

  it("readTreeAtRef returns every committed .ddd source, sorted", async () => {
    await store.writeFile("/workspace/main.ddd", 'import "./shared/kernel.ddd"\nsystem X {}');
    await store.writeFile("/workspace/shared/kernel.ddd", "valueobject Money {}");
    // A committed generated artifact must be excluded (only .ddd is a diff input).
    await store.writeFile("/workspace/generated/http/index.ts", "export {}");
    await commitOnSave(store, "initial");

    const tree = await store.readTreeAtRef("/workspace", "HEAD");
    expect(tree.map((e) => e.path)).toEqual([
      "/workspace/main.ddd",
      "/workspace/shared/kernel.ddd",
    ]);
    expect(tree.every((e) => e.kind === "file")).toBe(true);
    expect(tree[1].content).toBe("valueobject Money {}");
  });

  it("readTreeAtRef reads the tree at an EARLIER commit, not the working tree", async () => {
    await store.writeFile("/workspace/main.ddd", "system X {}");
    const first = await commitOnSave(store, "v1");
    await store.writeFile("/workspace/main.ddd", "system X { module M {} }");
    await commitOnSave(store, "v2");

    // Pin the first commit — its blob, not HEAD's, not the working tree.
    const atFirst = await store.readTreeAtRef("/workspace", first as string);
    expect(atFirst).toHaveLength(1);
    expect(atFirst[0].content).toBe("system X {}");
  });

  it("readTreeAtRef returns [] when the ref has no commits yet", async () => {
    await store.writeFile("/workspace/main.ddd", "system X {}");
    // Nothing committed — resolveRef throws, caller reads "no baseline".
    expect(await store.readTreeAtRef("/workspace", "HEAD")).toEqual([]);
  });
});

describe("GitStore: notifier", () => {
  let store: GitStore;
  beforeEach(async () => {
    store = await freshStore();
  });

  it("fires on write/delete with boundary-aware prefix matching", async () => {
    const seen: VfsPath[][] = [];
    const unsub = store.subscribe("/workspace", (changed) => seen.push([...changed]));
    await store.writeFile("/workspace/a.ddd", "1");
    await store.deleteFile("/workspace/a.ddd");
    expect(seen).toEqual([["/workspace/a.ddd"], ["/workspace/a.ddd"]]);
    unsub();
    await store.writeFile("/workspace/b.ddd", "2");
    expect(seen).toHaveLength(2); // no delivery after unsubscribe
  });

  it("does not deliver paths outside the subscribed prefix", async () => {
    const seen: VfsPath[][] = [];
    store.subscribe("/workspace/sub", (changed) => seen.push([...changed]));
    await store.writeFile("/workspace/other.ddd", "x");
    await store.writeFile("/workspace/sub/in.ddd", "y");
    expect(seen).toEqual([["/workspace/sub/in.ddd"]]);
  });

  it("mkdir fans out every created dir, sorted, in one notification", async () => {
    const seen: VfsPath[][] = [];
    store.subscribe("/workspace", (changed) => seen.push([...changed]));
    await store.mkdir("/workspace/a/b/c");
    expect(seen).toEqual([["/workspace/a", "/workspace/a/b", "/workspace/a/b/c"]]);
  });
});

describe("GitStore: snapshot projection", () => {
  it("projects the workspace tree to the VfsEntry union", async () => {
    const store = await freshStore();
    await store.writeFile("/workspace/main.ddd", "system X {}");
    await store.mkdir("/workspace/empty");
    const entries = await store.snapshotEntries();
    expect(entries).toContainEqual({
      kind: "file",
      path: "/workspace/main.ddd",
      content: "system X {}",
    });
    expect(entries).toContainEqual({ kind: "dir", path: "/workspace/empty" });
  });
});
