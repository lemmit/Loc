import { describe, expect, it, vi } from "vitest";
import { MemoryVfs } from "../../web/src/vfs/memory-vfs.js";
import {
  DEFAULT_PATH,
  isDddSource,
  pickFallbackActivePath,
  snapshotSources,
  WorkspaceSourcesController,
  type WorkspaceSourcesSnapshot,
} from "../../web/src/workspace/workspace-sources.js";

function makeVfs(seed: Record<string, string> = {}): MemoryVfs {
  const vfs = new MemoryVfs();
  vfs.hydrate(Object.entries(seed));
  return vfs;
}

describe("workspace sources — pure helpers", () => {
  it("isDddSource accepts /workspace/*.ddd and rejects anything else", () => {
    expect(isDddSource("/workspace/main.ddd")).toBe(true);
    expect(isDddSource("/workspace/nested/orders.ddd")).toBe(true);
    expect(isDddSource("/workspace/design/mantine/foo.hbs")).toBe(false);
    expect(isDddSource("/elsewhere/main.ddd")).toBe(false);
    expect(isDddSource("/workspace/main.txt")).toBe(false);
  });

  it("snapshotSources filters to .ddd files under /workspace/", () => {
    const vfs = makeVfs({
      "/workspace/main.ddd": "context A {}",
      "/workspace/sub/orders.ddd": "context B {}",
      "/workspace/design/mantine/pack.json": "{}",
      "/workspace/notes.txt": "ignored",
      "/elsewhere/other.ddd": "ignored",
    });
    const snap = snapshotSources(vfs);
    expect([...snap.keys()].sort()).toEqual([
      "/workspace/main.ddd",
      "/workspace/sub/orders.ddd",
    ]);
  });

  it("pickFallbackActivePath prefers main.ddd, else lexicographically-first", () => {
    expect(pickFallbackActivePath(["/workspace/a.ddd", DEFAULT_PATH, "/workspace/b.ddd"])).toBe(
      DEFAULT_PATH,
    );
    expect(pickFallbackActivePath(["/workspace/b.ddd", "/workspace/a.ddd"])).toBe(
      "/workspace/a.ddd",
    );
    expect(pickFallbackActivePath([])).toBe(DEFAULT_PATH);
  });
});

describe("WorkspaceSourcesController", () => {
  it("initial snapshot reflects existing VFS contents", () => {
    const vfs = makeVfs({
      "/workspace/main.ddd": "main",
      "/workspace/sub/orders.ddd": "orders",
      "/workspace/ignored.txt": "should not appear",
    });
    const controller = new WorkspaceSourcesController(vfs);
    const snap = controller.snapshot();
    expect([...snap.files.entries()].sort()).toEqual([
      ["/workspace/main.ddd", "main"],
      ["/workspace/sub/orders.ddd", "orders"],
    ]);
    expect(snap.activePath).toBe(DEFAULT_PATH);
    controller.dispose();
  });

  it("null VFS yields an empty snapshot and a working (no-op) write", () => {
    const c = new WorkspaceSourcesController(null);
    expect(c.snapshot().files.size).toBe(0);
    expect(c.snapshot().activePath).toBe(DEFAULT_PATH);
    // write/delete are silent no-ops when persistence is unavailable
    // — mirrors useWorkspace's "hostile storage" fallback.
    expect(() => c.write("/workspace/main.ddd", "x")).not.toThrow();
    expect(() => c.delete("/workspace/main.ddd")).not.toThrow();
    c.dispose();
  });

  it("setActivePath emits a snapshot with the new active file", () => {
    const vfs = makeVfs({
      "/workspace/main.ddd": "m",
      "/workspace/orders.ddd": "o",
    });
    const c = new WorkspaceSourcesController(vfs);
    const listener = vi.fn<(s: WorkspaceSourcesSnapshot) => void>();
    c.subscribe(listener);
    c.setActivePath("/workspace/orders.ddd");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0].activePath).toBe("/workspace/orders.ddd");
    // No-op for setting the same path.
    listener.mockClear();
    c.setActivePath("/workspace/orders.ddd");
    expect(listener).not.toHaveBeenCalled();
    c.dispose();
  });

  it("write persists to VFS and re-emits via the subscription", () => {
    const vfs = makeVfs();
    const c = new WorkspaceSourcesController(vfs);
    const listener = vi.fn<(s: WorkspaceSourcesSnapshot) => void>();
    c.subscribe(listener);
    c.write("/workspace/main.ddd", "context A {}");
    expect(vfs.read("/workspace/main.ddd")).toBe("context A {}");
    expect(listener).toHaveBeenCalled();
    const latest = listener.mock.calls.at(-1)![0];
    expect(latest.files.get("/workspace/main.ddd")).toBe("context A {}");
    c.dispose();
  });

  it("rejects writes to non-.ddd paths", () => {
    const vfs = makeVfs();
    const c = new WorkspaceSourcesController(vfs);
    expect(() => c.write("/workspace/notes.txt", "x")).toThrow(/must be a \/workspace\/\*\.ddd/);
    expect(() => c.write("/elsewhere/main.ddd", "x")).toThrow(/must be a \/workspace\/\*\.ddd/);
    c.dispose();
  });

  it("delete removes from VFS and re-emits", () => {
    const vfs = makeVfs({
      "/workspace/main.ddd": "m",
      "/workspace/orders.ddd": "o",
    });
    const c = new WorkspaceSourcesController(vfs);
    const listener = vi.fn<(s: WorkspaceSourcesSnapshot) => void>();
    c.subscribe(listener);
    c.delete("/workspace/orders.ddd");
    expect(vfs.exists("/workspace/orders.ddd")).toBe(false);
    expect(listener).toHaveBeenCalled();
    const latest = listener.mock.calls.at(-1)![0];
    expect([...latest.files.keys()]).toEqual(["/workspace/main.ddd"]);
    c.dispose();
  });

  it("deleting the active file re-points activePath to main.ddd when present", () => {
    const vfs = makeVfs({
      "/workspace/main.ddd": "m",
      "/workspace/orders.ddd": "o",
    });
    const c = new WorkspaceSourcesController(vfs);
    c.setActivePath("/workspace/orders.ddd");
    c.delete("/workspace/orders.ddd");
    expect(c.snapshot().activePath).toBe(DEFAULT_PATH);
    c.dispose();
  });

  it("deleting the active file with no main.ddd falls back to the first remaining", () => {
    const vfs = makeVfs({
      "/workspace/orders.ddd": "o",
      "/workspace/shipping.ddd": "s",
      "/workspace/billing.ddd": "b",
    });
    const c = new WorkspaceSourcesController(vfs);
    c.setActivePath("/workspace/orders.ddd");
    c.delete("/workspace/orders.ddd");
    // Lexicographic — billing.ddd wins.
    expect(c.snapshot().activePath).toBe("/workspace/billing.ddd");
    c.dispose();
  });

  it("deleting a non-active file leaves activePath untouched", () => {
    const vfs = makeVfs({
      "/workspace/main.ddd": "m",
      "/workspace/orders.ddd": "o",
    });
    const c = new WorkspaceSourcesController(vfs);
    c.setActivePath("/workspace/main.ddd");
    c.delete("/workspace/orders.ddd");
    expect(c.snapshot().activePath).toBe("/workspace/main.ddd");
    c.dispose();
  });

  it("external VFS writes propagate through the subscription", () => {
    const vfs = makeVfs({ "/workspace/main.ddd": "old" });
    const c = new WorkspaceSourcesController(vfs);
    const listener = vi.fn<(s: WorkspaceSourcesSnapshot) => void>();
    c.subscribe(listener);
    // Simulate another tab / worker writing the same VFS directly.
    vfs.write("/workspace/main.ddd", "new");
    expect(listener).toHaveBeenCalled();
    expect(listener.mock.calls.at(-1)![0].files.get("/workspace/main.ddd")).toBe("new");
    c.dispose();
  });

  it("design-pack writes under /workspace/design/ don't appear in `files`", () => {
    const vfs = makeVfs();
    const c = new WorkspaceSourcesController(vfs);
    const listener = vi.fn<(s: WorkspaceSourcesSnapshot) => void>();
    c.subscribe(listener);
    // A design-pack file change still fires the prefix subscription,
    // but the snapshot filter keeps `files` to .ddd sources only.
    vfs.write("/workspace/design/mantine/pack.json", "{}");
    expect(listener).toHaveBeenCalled();
    const latest = listener.mock.calls.at(-1)![0];
    expect([...latest.files.keys()]).toEqual([]);
    c.dispose();
  });

  it("dispose unsubscribes from the VFS and stops emitting", () => {
    const vfs = makeVfs({ "/workspace/main.ddd": "m" });
    const c = new WorkspaceSourcesController(vfs);
    const listener = vi.fn<(s: WorkspaceSourcesSnapshot) => void>();
    c.subscribe(listener);
    c.dispose();
    listener.mockClear();
    vfs.write("/workspace/main.ddd", "post-dispose");
    expect(listener).not.toHaveBeenCalled();
  });
});
