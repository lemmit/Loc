import { describe, expect, it, vi } from "vitest";
import { MemoryVfs } from "../../web/src/vfs/memory-vfs.js";
import type { VfsPath } from "../../web/src/vfs/types.js";
import type { GitFs } from "../../web/src/workspace/git/git-fs.js";
import {
  GitStore,
  normalizePath,
  WorkspaceReadOnlyError,
} from "../../web/src/workspace/git/git-store.js";

// `git-store.ts` is 814 lines and the playground's durable source of truth,
// with no test importing it.  Three surfaces are testable without IndexedDB —
// path normalisation, the reactive notifier, and the write-role coordination —
// and each has a failure mode that is silent rather than loud:
//
//   * `normalizePath` is a SECURITY boundary.  Its `memory-vfs` twin's comment
//     says why: VFS paths arrive from user-supplied `.ddd` source
//     (`design: "../../etc/passwd"`) and from main-thread-relayed writes, both
//     untrusted.  A missing escape check writes outside the workspace.
//   * the notifier decides which editor panes refresh.  A prefix mismatch does
//     not throw — the pane just goes stale.
//   * the write role is what stops a second browser tab writing over the tab
//     that owns the lock.
//
// WHY THIS FILE LIVES UNDER `test/`, NOT `web/`.  `web/` has no vitest — no
// dependency, no config, no script — so its only automated coverage is
// Playwright plus two `tsx` scripts.  The root `vitest.config.ts` includes
// exactly `test/**` and `packages/**`.  A `*.test.ts` written next to the
// module would therefore never execute, and would read as coverage forever.
// Root `node_modules` resolves `isomorphic-git`, so importing across is fine.

// ---------------------------------------------------------------------------
// A minimal in-memory stand-in for LightningFS — only the calls the surfaces
// under test make (`mkdir`/`writeFile`/`stat`/`unlink`/`readFile`).  Hand-built
// rather than mocked so the ENOENT/EEXIST codes the store branches on are real
// control flow, not stubbed returns.
// ---------------------------------------------------------------------------
function fakeGitFs(): GitFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>(["/"]);
  const err = (code: string): Error => Object.assign(new Error(code), { code });

  const promises = {
    async mkdir(p: string): Promise<void> {
      if (dirs.has(p) || files.has(p)) throw err("EEXIST");
      dirs.add(p);
    },
    async writeFile(p: string, content: string): Promise<void> {
      files.set(p, content);
    },
    async readFile(p: string): Promise<string> {
      const c = files.get(p);
      if (c === undefined) throw err("ENOENT");
      return c;
    },
    async stat(p: string): Promise<{ isDirectory(): boolean }> {
      if (dirs.has(p)) return { isDirectory: () => true };
      if (files.has(p)) return { isDirectory: () => false };
      throw err("ENOENT");
    },
    async unlink(p: string): Promise<void> {
      if (!files.delete(p)) throw err("ENOENT");
    },
  };
  return { fs: { promises } as unknown as GitFs["fs"], dir: "/", name: "test" };
}

const store = (): GitStore => new GitStore(fakeGitFs());

describe("normalizePath", () => {
  it("keeps an already-normal path", () => {
    expect(normalizePath("/workspace/a/b.ddd" as VfsPath)).toBe("/workspace/a/b.ddd");
  });

  it("collapses `.` and repeated slashes", () => {
    expect(normalizePath("/workspace/./a//b.ddd" as VfsPath)).toBe("/workspace/a/b.ddd");
  });

  it("collapses `..` against the preceding segment", () => {
    expect(normalizePath("/workspace/a/../b.ddd" as VfsPath)).toBe("/workspace/b.ddd");
  });

  it("drops a trailing slash", () => {
    expect(normalizePath("/workspace/a/" as VfsPath)).toBe("/workspace/a");
  });

  it("normalises the root to `/`", () => {
    expect(normalizePath("/" as VfsPath)).toBe("/");
    expect(normalizePath("/." as VfsPath)).toBe("/");
  });

  it("REJECTS a path that escapes the root", () => {
    // The security case.  A `..` that pops past the root must throw, not
    // silently clamp — clamping would turn `../../etc/passwd` into a valid
    // in-workspace write.
    expect(() => normalizePath("/../etc/passwd" as VfsPath)).toThrow(/escapes root/);
    expect(() => normalizePath("/workspace/../../etc/passwd" as VfsPath)).toThrow(/escapes root/);
  });

  it("rejects a relative path", () => {
    expect(() => normalizePath("workspace/a" as VfsPath)).toThrow(/must be absolute/);
  });

  it("rejects empty and non-string input", () => {
    expect(() => normalizePath("" as VfsPath)).toThrow(/empty path/);
    expect(() => normalizePath(undefined as unknown as VfsPath)).toThrow(/empty path/);
  });

  it("allows `..` that stays inside the root", () => {
    // Guards over-eager rejection: only an escape PAST root is an error.
    expect(normalizePath("/a/b/../c" as VfsPath)).toBe("/a/c");
  });
});

describe("normalizePath agrees with MemoryVfs on path identity", () => {
  // Both modules' comments claim this: git-store's says it "Mirrors
  // `web/src/vfs/memory-vfs.ts`'s `normalize` so the two stores agree on path
  // identity".  MemoryVfs's `normalize` is module-private, so the claim is
  // checked through its PUBLIC surface — write via a messy path, read via the
  // normalised one.  If the two ever diverge, a file written through one store
  // becomes unreachable through the other.
  const SAME: [string, string][] = [
    ["/workspace/a.ddd", "/workspace/a.ddd"],
    ["/workspace/./a.ddd", "/workspace/a.ddd"],
    ["/workspace//a.ddd", "/workspace/a.ddd"],
    ["/workspace/x/../a.ddd", "/workspace/a.ddd"],
    ["/workspace/x/y/../../a.ddd", "/workspace/a.ddd"],
  ];

  it.each(SAME)("%s ≡ %s", (messy, clean) => {
    expect(normalizePath(messy as VfsPath)).toBe(clean);

    const vfs = new MemoryVfs();
    vfs.write(messy as VfsPath, "hello");
    expect(
      vfs.read(clean as VfsPath),
      "MemoryVfs resolved this pair differently from normalizePath — a file " +
        "written through one store would be unreachable through the other",
    ).toBe("hello");
  });

  it("both reject a root escape", () => {
    const vfs = new MemoryVfs();
    expect(() => normalizePath("/../x" as VfsPath)).toThrow();
    expect(() => vfs.write("/../x" as VfsPath, "x")).toThrow();
  });
});

describe("the notifier", () => {
  it("delivers a write to a subscriber on an ancestor prefix", async () => {
    const s = store();
    const seen: VfsPath[][] = [];
    s.subscribe("/workspace" as VfsPath, (paths) => seen.push([...paths]));
    await s.writeFile("/workspace/a.ddd" as VfsPath, "x");
    expect(seen).toEqual([["/workspace/a.ddd"]]);
  });

  it("delivers to an EXACT-path subscriber", async () => {
    const s = store();
    const seen: VfsPath[][] = [];
    s.subscribe("/workspace/a.ddd" as VfsPath, (paths) => seen.push([...paths]));
    await s.writeFile("/workspace/a.ddd" as VfsPath, "x");
    expect(seen).toEqual([["/workspace/a.ddd"]]);
  });

  it("delivers everything to a `/` subscriber", async () => {
    const s = store();
    const seen: VfsPath[][] = [];
    s.subscribe("/" as VfsPath, (paths) => seen.push([...paths]));
    await s.writeFile("/workspace/a.ddd" as VfsPath, "x");
    expect(seen).toHaveLength(1);
  });

  it("does NOT deliver to a sibling prefix", async () => {
    const s = store();
    const seen: VfsPath[][] = [];
    s.subscribe("/other" as VfsPath, (paths) => seen.push([...paths]));
    await s.writeFile("/workspace/a.ddd" as VfsPath, "x");
    expect(seen).toEqual([]);
  });

  it("does not treat a prefix STRING match as a path match", async () => {
    // `/workspace2/a.ddd`.startsWith(`/workspace`) is true, but the two are
    // different directories.  A naive `startsWith` without the `/` guard would
    // leak one workspace's writes into the other's subscribers.
    const s = store();
    const seen: VfsPath[][] = [];
    s.subscribe("/workspace" as VfsPath, (paths) => seen.push([...paths]));
    await s.writeFile("/workspace2/a.ddd" as VfsPath, "x");
    expect(seen).toEqual([]);
  });

  it("normalises the subscription prefix", async () => {
    const s = store();
    const seen: VfsPath[][] = [];
    s.subscribe("/workspace/./sub/.." as VfsPath, (paths) => seen.push([...paths]));
    await s.writeFile("/workspace/a.ddd" as VfsPath, "x");
    expect(seen).toEqual([["/workspace/a.ddd"]]);
  });

  it("stops delivering after unsubscribe", async () => {
    const s = store();
    const seen: VfsPath[][] = [];
    const off = s.subscribe("/workspace" as VfsPath, (paths) => seen.push([...paths]));
    await s.writeFile("/workspace/a.ddd" as VfsPath, "x");
    off();
    await s.writeFile("/workspace/b.ddd" as VfsPath, "y");
    expect(seen).toHaveLength(1);
  });

  it("delivers a delete, and stays silent for a missing file", async () => {
    const s = store();
    await s.writeFile("/workspace/a.ddd" as VfsPath, "x");
    const seen: VfsPath[][] = [];
    s.subscribe("/workspace" as VfsPath, (paths) => seen.push([...paths]));
    await s.deleteFile("/workspace/a.ddd" as VfsPath);
    expect(seen).toEqual([["/workspace/a.ddd"]]);
    // Deleting again is a no-op — and must not fire a phantom change.
    await s.deleteFile("/workspace/a.ddd" as VfsPath);
    expect(seen).toHaveLength(1);
  });

  it("fans out to every matching subscriber", async () => {
    const s = store();
    const a: VfsPath[][] = [];
    const b: VfsPath[][] = [];
    s.subscribe("/workspace" as VfsPath, (p) => a.push([...p]));
    s.subscribe("/" as VfsPath, (p) => b.push([...p]));
    await s.writeFile("/workspace/a.ddd" as VfsPath, "x");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

describe("the notifier's prefix rule matches MemoryVfs's", () => {
  // git-store's `subscribe` says "Mirrors `MemoryVfs.subscribe`", and its
  // `underPrefix` helper is byte-identical to MemoryVfs's inline condition.
  // Two copies, one claim — so the claim is checked rather than trusted.
  const CASES: [prefix: string, written: string, delivered: boolean][] = [
    ["/workspace", "/workspace/a.ddd", true],
    ["/workspace", "/workspace/deep/a.ddd", true],
    ["/workspace/a.ddd", "/workspace/a.ddd", true],
    ["/", "/workspace/a.ddd", true],
    ["/workspace", "/other/a.ddd", false],
    ["/workspace", "/workspace2/a.ddd", false],
    ["/workspace/a.ddd", "/workspace/a.ddd.bak", false],
  ];

  it.each(CASES)("prefix %s + write %s", async (prefix, written, delivered) => {
    const gs = store();
    let gitHit = false;
    gs.subscribe(prefix as VfsPath, () => {
      gitHit = true;
    });
    await gs.writeFile(written as VfsPath, "x");

    const mem = new MemoryVfs();
    let memHit = false;
    mem.subscribe(prefix as VfsPath, () => {
      memHit = true;
    });
    mem.write(written as VfsPath, "x");

    expect(gitHit).toBe(delivered);
    expect(
      memHit,
      "MemoryVfs and GitStore disagree on prefix matching — the two stores' " +
        "subscribers would refresh on different events despite both claiming " +
        "to mirror the other",
    ).toBe(gitHit);
  });
});

describe("write-role coordination", () => {
  it("starts writable, so an uncoordinated consumer behaves as before", () => {
    // The constructor's own comment: `writableFlag` starts true so every
    // non-coordinated consumer (tests, CLI-side helpers) is unaffected.
    expect(store().writable).toBe(true);
  });

  it("refuses writes once the role is dropped", async () => {
    const s = store();
    s.setWritable(false);
    await expect(s.writeFile("/workspace/a.ddd" as VfsPath, "x")).rejects.toBeInstanceOf(
      WorkspaceReadOnlyError,
    );
    await expect(s.deleteFile("/workspace/a.ddd" as VfsPath)).rejects.toBeInstanceOf(
      WorkspaceReadOnlyError,
    );
  });

  it("names the attempted operation in the error", async () => {
    const s = store();
    s.setWritable(false);
    await expect(s.writeFile("/workspace/a.ddd" as VfsPath, "x")).rejects.toThrow(
      /\/workspace\/a\.ddd/,
    );
  });

  it("notifies role subscribers on a FLIP only", () => {
    const s = store();
    const seen: boolean[] = [];
    s.subscribeWritable((w) => seen.push(w));
    s.setWritable(false);
    s.setWritable(false); // same value — no event
    s.setWritable(true);
    expect(seen).toEqual([false, true]);
  });

  it("stops notifying after unsubscribe", () => {
    const s = store();
    const seen: boolean[] = [];
    const off = s.subscribeWritable((w) => seen.push(w));
    s.setWritable(false);
    off();
    s.setWritable(true);
    expect(seen).toEqual([false]);
  });

  it("resumes writing when the role comes back", async () => {
    const s = store();
    s.setWritable(false);
    s.setWritable(true);
    await expect(s.writeFile("/workspace/a.ddd" as VfsPath, "x")).resolves.toBeUndefined();
  });
});

describe("the cross-tab publisher", () => {
  it("receives file changes alongside local subscribers", async () => {
    const s = store();
    const publisher = { files: vi.fn(), commit: vi.fn() };
    s.setTabPublisher(publisher);
    await s.writeFile("/workspace/a.ddd" as VfsPath, "x");
    expect(publisher.files).toHaveBeenCalledWith(["/workspace/a.ddd"]);
  });

  it("stops receiving once cleared", async () => {
    const s = store();
    const publisher = { files: vi.fn(), commit: vi.fn() };
    s.setTabPublisher(publisher);
    s.setTabPublisher(null);
    await s.writeFile("/workspace/a.ddd" as VfsPath, "x");
    expect(publisher.files).not.toHaveBeenCalled();
  });
});
