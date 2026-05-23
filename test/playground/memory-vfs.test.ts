import { describe, expect, it, vi } from "vitest";

import { MemoryVfs } from "../../web/src/vfs/memory-vfs.js";

// ---------------------------------------------------------------------------
// MemoryVfs — the playground's in-memory VFS implementation.  Sync
// only; everything else (`IdbVfs`, the worker-mutate RPC) sits on
// this primitive in later phases.  These tests pin the path-
// normalisation rules and pub/sub semantics that the rest of the
// system depends on.
// ---------------------------------------------------------------------------

describe("MemoryVfs: read/write basics", () => {
  it("round-trips a single path", () => {
    const vfs = new MemoryVfs();
    vfs.write("/a/b.txt", "hello");
    expect(vfs.read("/a/b.txt")).toBe("hello");
    expect(vfs.exists("/a/b.txt")).toBe(true);
  });

  it("returns undefined for unknown paths and throws via readRequired", () => {
    const vfs = new MemoryVfs();
    expect(vfs.read("/missing")).toBeUndefined();
    expect(() => vfs.readRequired("/missing")).toThrow(/no entry at "\/missing"/);
  });

  it("delete removes the entry; subsequent read returns undefined", () => {
    const vfs = new MemoryVfs();
    vfs.write("/x", "1");
    vfs.delete("/x");
    expect(vfs.exists("/x")).toBe(false);
  });
});

describe("MemoryVfs: path normalisation", () => {
  it("rejects relative paths (no leading slash)", () => {
    const vfs = new MemoryVfs();
    expect(() => vfs.write("a/b", "x")).toThrow(/path must be absolute/);
  });

  it("rejects empty paths", () => {
    const vfs = new MemoryVfs();
    expect(() => vfs.write("", "x")).toThrow(/empty path/);
  });

  it("collapses `.` and `..` segments", () => {
    const vfs = new MemoryVfs();
    vfs.write("/a/./b/../c.txt", "ok");
    expect(vfs.read("/a/c.txt")).toBe("ok");
  });

  it("rejects paths that escape root via `..`", () => {
    const vfs = new MemoryVfs();
    expect(() => vfs.write("/../etc/passwd", "x")).toThrow(/escapes root/);
    expect(() => vfs.write("/a/../../etc/passwd", "x")).toThrow(/escapes root/);
  });
});

describe("MemoryVfs: list", () => {
  const vfs = new MemoryVfs();
  vfs.write("/designs/mantine/pack.json", "{}");
  vfs.write("/designs/mantine/page-list.hbs", "...");
  vfs.write("/designs/shadcn/pack.json", "{}");
  vfs.write("/workspace/main.ddd", "system X {}");

  it("lists entries under a directory prefix (trailing slash optional)", () => {
    expect(vfs.list("/designs/mantine/")).toEqual([
      "/designs/mantine/pack.json",
      "/designs/mantine/page-list.hbs",
    ]);
    expect(vfs.list("/designs/mantine")).toEqual([
      "/designs/mantine/pack.json",
      "/designs/mantine/page-list.hbs",
    ]);
  });

  it("does NOT do literal-startsWith — `/designs/man` is a prefix, not a directory", () => {
    // Anti-regression: an earlier draft accepted `list("/designs/man")`
    // as a glob-prefix match for `/designs/mantine/...`.  That made
    // `list("/workspace/main")` return both `main.ddd` and
    // `maintenance.ddd`, which is surprising.  The contract is now
    // strictly directory-boundary; callers that want a glob filter
    // do it themselves.
    expect(vfs.list("/designs/man")).toEqual([]);
  });

  it("returns the whole VFS when prefix is `/`", () => {
    expect(vfs.list("/")).toEqual([
      "/designs/mantine/pack.json",
      "/designs/mantine/page-list.hbs",
      "/designs/shadcn/pack.json",
      "/workspace/main.ddd",
    ]);
  });
});

describe("MemoryVfs: subscribe", () => {
  it("notifies subscribers whose prefix is a parent of the changed path", () => {
    const vfs = new MemoryVfs();
    const designsListener = vi.fn();
    const workspaceListener = vi.fn();
    vfs.subscribe("/designs", designsListener);
    vfs.subscribe("/workspace", workspaceListener);

    vfs.write("/designs/mantine/page-list.hbs", "...");
    expect(designsListener).toHaveBeenCalledWith(["/designs/mantine/page-list.hbs"]);
    expect(workspaceListener).not.toHaveBeenCalled();
  });

  it("does NOT notify when the changed path lies outside the prefix", () => {
    const vfs = new MemoryVfs();
    const listener = vi.fn();
    vfs.subscribe("/designs/mantine", listener);
    vfs.write("/designs/shadcn/x.hbs", "...");
    expect(listener).not.toHaveBeenCalled();
  });

  it("returns an unsubscribe fn that detaches the listener", () => {
    const vfs = new MemoryVfs();
    const listener = vi.fn();
    const unsub = vfs.subscribe("/", listener);
    vfs.write("/x", "1");
    unsub();
    vfs.write("/y", "2");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hydrate fires a single notification batched across paths", () => {
    const vfs = new MemoryVfs();
    const listener = vi.fn();
    vfs.subscribe("/designs", listener);
    vfs.hydrate([
      ["/designs/a.hbs", "1"],
      ["/designs/b.hbs", "2"],
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(["/designs/a.hbs", "/designs/b.hbs"]);
  });
});

describe("MemoryVfs: snapshot", () => {
  it("returns a deep-enough copy that mutating after-the-fact doesn't leak", () => {
    const vfs = new MemoryVfs();
    vfs.write("/x", "1");
    const snap = vfs.snapshot();
    vfs.write("/x", "2");
    // Snapshot values are tagged `VfsEntry`s now (commit 1 of the
    // first-class-directories refactor) — reach into `.content`
    // for a file entry.
    const e = snap.get("/x");
    expect(e?.kind).toBe("file");
    if (e?.kind === "file") expect(e.content).toBe("1");
  });

  it("preserves both file and directory entries", () => {
    const vfs = new MemoryVfs();
    vfs.write("/a/b.ddd", "body");
    vfs.mkdir("/audit");
    const snap = vfs.snapshot();
    expect(snap.get("/audit")?.kind).toBe("dir");
    expect(snap.get("/a/b.ddd")?.kind).toBe("file");
  });
});

// ---------------------------------------------------------------------------
// First-class directories — `mkdir` / `rmdir` / `isDirectory` /
// `kindOf` / `listDirs` / `listFiles` / `listAll`.  Replaces the
// `.gitkeep` sentinel workaround that previously simulated empty
// folders.  Files-only `list()` stays as-is for back-compat with
// every existing `for (const p of list(prefix)) { content = read(p) … }`
// loop.
// ---------------------------------------------------------------------------
describe("MemoryVfs: first-class directories", () => {
  it("mkdir creates a dir entry surfaced by isDirectory + kindOf", () => {
    const vfs = new MemoryVfs();
    vfs.mkdir("/shared");
    expect(vfs.isDirectory("/shared")).toBe(true);
    expect(vfs.isFile("/shared")).toBe(false);
    expect(vfs.exists("/shared")).toBe(true);
    expect(vfs.kindOf("/shared")).toBe("dir");
  });

  it("mkdir is idempotent on an existing directory", () => {
    const vfs = new MemoryVfs();
    vfs.mkdir("/shared");
    expect(() => vfs.mkdir("/shared")).not.toThrow();
    expect(vfs.kindOf("/shared")).toBe("dir");
  });

  it("mkdir throws when the path is already a file", () => {
    const vfs = new MemoryVfs();
    vfs.write("/shared", "i am a file");
    expect(() => vfs.mkdir("/shared")).toThrow(/is a file/);
  });

  it("mkdir auto-creates missing ancestor directories (mkdirp)", () => {
    const vfs = new MemoryVfs();
    vfs.mkdir("/a/b/c");
    expect(vfs.isDirectory("/a")).toBe(true);
    expect(vfs.isDirectory("/a/b")).toBe(true);
    expect(vfs.isDirectory("/a/b/c")).toBe(true);
  });

  it("mkdir refuses when an ancestor is a file", () => {
    const vfs = new MemoryVfs();
    vfs.write("/a", "file");
    expect(() => vfs.mkdir("/a/b")).toThrow(/ancestor/);
  });

  it("write throws when the path is already a directory", () => {
    const vfs = new MemoryVfs();
    vfs.mkdir("/shared");
    expect(() => vfs.write("/shared", "x")).toThrow(/directory/);
  });

  it("delete on a directory is a no-op (use rmdir instead)", () => {
    const vfs = new MemoryVfs();
    vfs.mkdir("/shared");
    vfs.delete("/shared");
    expect(vfs.isDirectory("/shared")).toBe(true);
  });

  it("rmdir removes an empty directory", () => {
    const vfs = new MemoryVfs();
    vfs.mkdir("/shared");
    vfs.rmdir("/shared");
    expect(vfs.exists("/shared")).toBe(false);
  });

  it("rmdir throws on a non-empty directory", () => {
    const vfs = new MemoryVfs();
    vfs.mkdir("/shared");
    vfs.write("/shared/money.ddd", "vo");
    expect(() => vfs.rmdir("/shared")).toThrow(/not empty/);
  });

  it("rmdir is a no-op on a missing path or on a file path", () => {
    const vfs = new MemoryVfs();
    vfs.write("/file", "x");
    expect(() => vfs.rmdir("/file")).not.toThrow();
    expect(() => vfs.rmdir("/missing")).not.toThrow();
    expect(vfs.isFile("/file")).toBe(true);
  });

  it("list is files-only (back-compat for every legacy consumer)", () => {
    const vfs = new MemoryVfs();
    vfs.write("/main.ddd", "m");
    vfs.mkdir("/shared");
    vfs.write("/shared/money.ddd", "vo");
    expect(vfs.list("/")).toEqual(["/main.ddd", "/shared/money.ddd"]);
  });

  it("listDirs returns directory paths only", () => {
    const vfs = new MemoryVfs();
    vfs.write("/main.ddd", "m");
    vfs.mkdir("/shared");
    vfs.mkdir("/audit/log");
    expect(vfs.listDirs("/")).toEqual(["/audit", "/audit/log", "/shared"]);
  });

  it("listAll returns both kinds", () => {
    const vfs = new MemoryVfs();
    vfs.write("/main.ddd", "m");
    vfs.mkdir("/shared");
    expect(vfs.listAll("/")).toEqual(["/main.ddd", "/shared"]);
  });

  it("subscribers see dir-creation + dir-removal events", () => {
    const vfs = new MemoryVfs();
    const fn = vi.fn();
    vfs.subscribe("/", fn);
    vfs.mkdir("/shared");
    expect(fn).toHaveBeenLastCalledWith(["/shared"]);
    vfs.rmdir("/shared");
    expect(fn).toHaveBeenLastCalledWith(["/shared"]);
  });

  it("hydrate accepts mixed file and directory entries", () => {
    const vfs = new MemoryVfs();
    vfs.hydrate([
      { kind: "file", path: "/main.ddd", content: "m" },
      { kind: "dir", path: "/shared" },
      ["/legacy.ddd", "compat"], // tuple form still works
    ]);
    expect(vfs.isFile("/main.ddd")).toBe(true);
    expect(vfs.isDirectory("/shared")).toBe(true);
    expect(vfs.read("/legacy.ddd")).toBe("compat");
  });

  it("restore replaces every entry — dirs included", () => {
    const vfs = new MemoryVfs();
    vfs.write("/old.ddd", "x");
    vfs.mkdir("/old-dir");
    vfs.restore([
      { kind: "file", path: "/new.ddd", content: "y" },
      { kind: "dir", path: "/new-dir" },
    ]);
    expect(vfs.exists("/old.ddd")).toBe(false);
    expect(vfs.exists("/old-dir")).toBe(false);
    expect(vfs.isFile("/new.ddd")).toBe(true);
    expect(vfs.isDirectory("/new-dir")).toBe(true);
  });
});
