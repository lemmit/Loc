import { describe, expect, it, vi } from "vitest";
import {
  type BroadcastChannelLike,
  type ChannelFactory,
  openWorkspaceChannel,
  parseWorkspaceTabMessage,
  postWorkspaceMessage,
  type WorkspaceTabMessage,
  workspaceChannelName,
} from "../../web/src/workspace/tab-channel.js";

// ---------------------------------------------------------------------------
// Per-workspace BROADCAST CHANNEL (mission M-T8.12, phase 2).
//
// The fake bus reproduces the two properties the design leans on: messages
// reach every OTHER channel of the same name, and NEVER the sender itself
// (the browser's own no-self-delivery rule, which is half of why there are no
// echo loops).  Channels of different names — i.e. different workspaces — are
// fully isolated.
// ---------------------------------------------------------------------------

class FakeBus {
  private readonly open = new Map<string, Set<FakeChannel>>();

  factory: ChannelFactory = (name: string) => new FakeChannel(this, name);

  register(channel: FakeChannel): void {
    const set = this.open.get(channel.name) ?? new Set();
    set.add(channel);
    this.open.set(channel.name, set);
  }

  unregister(channel: FakeChannel): void {
    this.open.get(channel.name)?.delete(channel);
  }

  deliver(from: FakeChannel, message: unknown): void {
    for (const c of this.open.get(from.name) ?? []) {
      if (c === from) continue; // never self-deliver
      c.onmessage?.({ data: message });
    }
  }
}

class FakeChannel implements BroadcastChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(
    private readonly bus: FakeBus,
    readonly name: string,
  ) {
    bus.register(this);
  }
  postMessage(message: unknown): void {
    this.bus.deliver(this, message);
  }
  close(): void {
    this.bus.unregister(this);
  }
}

describe("workspaceChannelName", () => {
  it("is per-workspace", () => {
    expect(workspaceChannelName("db")).toBe("loom.workspace.db");
    expect(workspaceChannelName("a")).not.toBe(workspaceChannelName("b"));
  });
});

describe("parseWorkspaceTabMessage", () => {
  it("accepts the four message kinds", () => {
    expect(parseWorkspaceTabMessage({ kind: "files", paths: ["/workspace/a.ddd"] })).toEqual({
      kind: "files",
      paths: ["/workspace/a.ddd"],
    });
    expect(parseWorkspaceTabMessage({ kind: "commit", oid: "abc" })).toEqual({
      kind: "commit",
      oid: "abc",
    });
    expect(parseWorkspaceTabMessage({ kind: "role", owner: true })).toEqual({
      kind: "role",
      owner: true,
    });
    expect(parseWorkspaceTabMessage({ kind: "deleted" })).toEqual({ kind: "deleted" });
  });

  it("rejects anything else — another build can put junk on this channel", () => {
    expect(parseWorkspaceTabMessage(null)).toBeNull();
    expect(parseWorkspaceTabMessage("files")).toBeNull();
    expect(parseWorkspaceTabMessage({ kind: "files" })).toBeNull();
    expect(parseWorkspaceTabMessage({ kind: "files", paths: [1] })).toBeNull();
    expect(parseWorkspaceTabMessage({ kind: "commit", oid: 7 })).toBeNull();
    expect(parseWorkspaceTabMessage({ kind: "nope" })).toBeNull();
  });
});

describe("openWorkspaceChannel", () => {
  it("delivers to the other tab and never to the sender", () => {
    const bus = new FakeBus();
    const onA = vi.fn();
    const onB = vi.fn();
    const a = openWorkspaceChannel("ws", { onMessage: onA, factory: bus.factory });
    const b = openWorkspaceChannel("ws", { onMessage: onB, factory: bus.factory });

    a.post({ kind: "files", paths: ["/workspace/main.ddd"] });
    expect(onB).toHaveBeenCalledWith({ kind: "files", paths: ["/workspace/main.ddd"] });
    expect(onA).not.toHaveBeenCalled();

    a.close();
    b.close();
  });

  it("isolates workspaces from each other", () => {
    const bus = new FakeBus();
    const onOther = vi.fn();
    const a = openWorkspaceChannel("ws-one", { onMessage: () => {}, factory: bus.factory });
    const b = openWorkspaceChannel("ws-two", { onMessage: onOther, factory: bus.factory });
    a.post({ kind: "commit", oid: "deadbeef" });
    expect(onOther).not.toHaveBeenCalled();
    a.close();
    b.close();
  });

  it("stops delivering after close, and post() after close is inert", () => {
    const bus = new FakeBus();
    const onB = vi.fn();
    const a = openWorkspaceChannel("ws", { onMessage: () => {}, factory: bus.factory });
    const b = openWorkspaceChannel("ws", { onMessage: onB, factory: bus.factory });
    b.close();
    a.post({ kind: "deleted" });
    expect(onB).not.toHaveBeenCalled();
    a.close();
    a.post({ kind: "deleted" }); // must not throw
  });

  it("degrades to a silent no-op when BroadcastChannel is absent", () => {
    // Same fallback stance as `tab-lock.ts`: the support floor for both APIs
    // is identical, so a browser without one has neither and must degrade
    // coherently rather than fail.
    const channel = openWorkspaceChannel("ws", { onMessage: () => {}, factory: () => null });
    expect(channel.supported).toBe(false);
    channel.post({ kind: "deleted" }); // no throw
    channel.close();
  });

  it("survives a factory that throws (hostile storage partitioning)", () => {
    const channel = openWorkspaceChannel("ws", {
      onMessage: () => {},
      factory: () => {
        throw new Error("blocked by policy");
      },
    });
    expect(channel.supported).toBe(false);
  });

  it("ignores malformed traffic instead of handing it to the store", () => {
    const bus = new FakeBus();
    const onB = vi.fn();
    const raw = new FakeChannel(bus, workspaceChannelName("ws"));
    const b = openWorkspaceChannel("ws", { onMessage: onB, factory: bus.factory });
    raw.postMessage({ kind: "files" });
    raw.postMessage("hello");
    expect(onB).not.toHaveBeenCalled();
    raw.close();
    b.close();
  });
});

describe("postWorkspaceMessage", () => {
  it("one-shots a message for a workspace this tab has no channel on", async () => {
    const bus = new FakeBus();
    const seen: WorkspaceTabMessage[] = [];
    const listener = openWorkspaceChannel("ws", {
      onMessage: (m) => seen.push(m),
      factory: bus.factory,
    });
    // `deleteWorkspace` fires this for a NON-active workspace, where no
    // long-lived channel exists.
    postWorkspaceMessage("ws", { kind: "deleted" }, bus.factory);
    expect(seen).toEqual([{ kind: "deleted" }]);
    await new Promise((r) => setTimeout(r, 5)); // the deferred close
    listener.close();
  });
});
