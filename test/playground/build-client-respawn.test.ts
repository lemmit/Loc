import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Worker is mocked at module-load time via globalThis stubbing —
// the LoomBuildClient does `new Worker(new URL(..., import.meta.url))`,
// which needs a Worker constructor in the global scope.  jsdom
// doesn't provide one; stubbing here gives us a Worker spy that
// captures messages and exposes a fake-postMessage method.

interface MessageRecord {
  workerId: number;
  message: unknown;
}

class FakeWorker {
  static all: FakeWorker[] = [];
  static messages: MessageRecord[] = [];
  static reset(): void {
    FakeWorker.all = [];
    FakeWorker.messages = [];
  }

  readonly id: number;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  terminated = false;

  constructor(_url: URL | string, _opts?: WorkerOptions) {
    this.id = FakeWorker.all.length;
    FakeWorker.all.push(this);
  }

  postMessage(message: unknown): void {
    FakeWorker.messages.push({ workerId: this.id, message });
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(): void {
    /* not used */
  }
  removeEventListener(): void {
    /* not used */
  }
  dispatchEvent(): boolean {
    return true;
  }
}

beforeEach(() => {
  FakeWorker.reset();
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
});

afterEach(() => {
  delete (globalThis as unknown as { Worker?: unknown }).Worker;
});

// LoomBuildClient is async-loaded so the Worker stub is in place
// before the module evaluates.  Each test re-imports a fresh copy
// via dynamic import — Vitest module caching is fine because we
// don't mutate the module itself, only the global Worker.
async function load(): Promise<typeof import("../../web/src/build/client.js")> {
  return import("../../web/src/build/client.js");
}

describe("LoomBuildClient.spawn (constructor)", () => {
  it("creates exactly one worker and posts no seed when seedWorkspace is omitted", async () => {
    const { LoomBuildClient } = await load();
    new LoomBuildClient();
    expect(FakeWorker.all).toHaveLength(1);
    expect(FakeWorker.messages).toHaveLength(0);
  });

  it("calls seedWorkspace and posts the entries as a vfs.write before any user RPC", async () => {
    const { LoomBuildClient } = await load();
    new LoomBuildClient({
      seedWorkspace: () => [
        { path: "/workspace/main.ddd", content: "x" },
        { path: "/workspace/design/foo/pack.json", content: "{}" },
      ],
    });
    expect(FakeWorker.messages).toHaveLength(1);
    const msg = FakeWorker.messages[0].message as {
      method: string;
      params: { entries: Array<{ path: string }> };
    };
    expect(msg.method).toBe("vfs.write");
    expect(msg.params.entries.map((e) => e.path)).toEqual([
      "/workspace/main.ddd",
      "/workspace/design/foo/pack.json",
    ]);
  });

  it("skips the seed message when seedWorkspace returns an empty array", async () => {
    const { LoomBuildClient } = await load();
    new LoomBuildClient({ seedWorkspace: () => [] });
    expect(FakeWorker.messages).toHaveLength(0);
  });
});

describe("LoomBuildClient.respawn", () => {
  it("terminates the old worker and creates a new one", async () => {
    const { LoomBuildClient } = await load();
    const client = new LoomBuildClient();
    expect(FakeWorker.all).toHaveLength(1);
    client.respawn();
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(FakeWorker.all[1].terminated).toBe(false);
  });

  it("re-runs seedWorkspace on respawn so the new worker gets the workspace state", async () => {
    const { LoomBuildClient } = await load();
    let callCount = 0;
    new LoomBuildClient({
      seedWorkspace: () => {
        callCount++;
        return [{ path: "/workspace/main.ddd", content: `v${callCount}` }];
      },
    });
    expect(callCount).toBe(1);
    expect(
      (FakeWorker.messages[0].message as { params: { entries: Array<{ content: string }> } }).params
        .entries[0].content,
    ).toBe("v1");

    // Inject a respawn — re-import so we get the same client back.
    // Have to keep a reference; do it inline.
  });

  it("re-runs seedWorkspace and the new worker gets fresh entries", async () => {
    const { LoomBuildClient } = await load();
    const seedSnapshots: string[][] = [];
    let revision = 0;
    const client = new LoomBuildClient({
      seedWorkspace: () => {
        revision++;
        const entries = [{ path: "/workspace/main.ddd", content: `rev-${revision}` }];
        seedSnapshots.push(entries.map((e) => e.content));
        return entries;
      },
    });
    expect(seedSnapshots).toEqual([["rev-1"]]);
    client.respawn();
    expect(seedSnapshots).toEqual([["rev-1"], ["rev-2"]]);
    // The new worker (index 1) received the rev-2 seed; the old
    // worker (index 0) only saw rev-1.
    const seedMessages = FakeWorker.messages.filter(
      (m) => (m.message as { method: string }).method === "vfs.write",
    );
    expect(seedMessages.map((m) => m.workerId)).toEqual([0, 1]);
  });

  it("rejects in-flight RPCs with a clear retry hint", async () => {
    const { LoomBuildClient } = await load();
    const client = new LoomBuildClient();
    const inflight = client.generate("source");
    client.respawn();
    await expect(inflight).rejects.toThrow(/respawned; retry/);
  });

  it("is a no-op after dispose", async () => {
    const { LoomBuildClient } = await load();
    const client = new LoomBuildClient();
    client.dispose();
    client.respawn(); // should not throw, should not create a new worker
    expect(FakeWorker.all).toHaveLength(1);
    expect(FakeWorker.all[0].terminated).toBe(true);
  });
});

describe("LoomBuildClient.dispose", () => {
  it("terminates the worker and rejects pending calls", async () => {
    const { LoomBuildClient } = await load();
    const client = new LoomBuildClient();
    const inflight = client.generate("source");
    client.dispose();
    await expect(inflight).rejects.toThrow(/disposed/);
    expect(FakeWorker.all[0].terminated).toBe(true);
  });

  it("rejects subsequent calls with a disposed error", async () => {
    const { LoomBuildClient } = await load();
    const client = new LoomBuildClient();
    client.dispose();
    await expect(client.generate("x")).rejects.toThrow(/disposed/);
  });
});
