import { describe, it, expect, vi } from "vitest";

import { MemoryVfs } from "../web/src/vfs/memory-vfs.js";

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
    expect(snap.get("/x")).toBe("1");
  });
});
