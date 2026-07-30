import { describe, expect, it, vi } from "vitest";
import {
  acquireWriterLock,
  type LockGrantedCallback,
  type LockManagerLike,
  type LockRequestOptionsLike,
  writerLockName,
} from "../../web/src/workspace/tab-lock.js";

// ---------------------------------------------------------------------------
// Per-workspace WRITER LOCK (mission M-T8.12, phase 1).
//
// `navigator.locks` does not exist in node — which is exactly WHY the manager
// is injected.  This file ships a faithful-enough fake of the Web Locks
// contract (exclusive by name, `ifAvailable` miss → `null` callback arg,
// `steal` → the current holder's request promise rejects with `AbortError`,
// queued requests granted FIFO on release, `signal` abort) and drives the real
// lock against it.  Two "tabs" are two `acquireWriterLock` calls sharing one
// fake manager, the same way two browser tabs share one `LockManager`.
// ---------------------------------------------------------------------------

interface Held {
  release: () => void;
  reject: (err: unknown) => void;
}

interface Waiter {
  options: LockRequestOptionsLike;
  callback: LockGrantedCallback;
  settle: (value: unknown) => void;
  fail: (err: unknown) => void;
}

class AbortError extends Error {
  constructor() {
    super("The operation was aborted.");
    this.name = "AbortError";
  }
}

/** In-process stand-in for `navigator.locks`, shared by the fake tabs. */
class FakeLockManager implements LockManagerLike {
  private readonly held = new Map<string, Held>();
  private readonly queues = new Map<string, Waiter[]>();

  request(
    name: string,
    options: LockRequestOptionsLike,
    callback: LockGrantedCallback,
  ): Promise<unknown> {
    return new Promise<unknown>((settle, fail) => {
      const waiter: Waiter = { options, callback, settle, fail };
      if (options.steal === true) {
        const current = this.held.get(name);
        if (current) {
          this.held.delete(name);
          current.reject(new AbortError());
        }
        // A steal preempts the queue.
        this.grant(name, waiter);
        return;
      }
      if (!this.held.has(name)) {
        this.grant(name, waiter);
        return;
      }
      if (options.ifAvailable === true) {
        // Miss: the callback runs with `null` and the request completes.
        settle(callback(null));
        return;
      }
      const queue = this.queues.get(name) ?? [];
      queue.push(waiter);
      this.queues.set(name, queue);
      options.signal?.addEventListener("abort", () => {
        const q = this.queues.get(name);
        const at = q?.indexOf(waiter) ?? -1;
        if (q && at >= 0) {
          q.splice(at, 1);
          fail(new AbortError());
        }
      });
    });
  }

  private grant(name: string, waiter: Waiter): void {
    const entry: Held = {
      release: () => {
        if (this.held.get(name) !== entry) return;
        this.held.delete(name);
        this.pump(name);
      },
      reject: () => {},
    };
    this.held.set(name, entry);
    const result = waiter.callback({ name, mode: "exclusive" });
    // The granted callback returns a pending promise to HOLD the lock.
    void Promise.resolve(result).then(
      () => {
        entry.release();
        waiter.settle(undefined);
      },
      (err) => {
        entry.release();
        waiter.fail(err);
      },
    );
    entry.reject = (err) => {
      // Stolen: reject the holder's request promise; the callback's own
      // pending promise is simply abandoned (as in the real API).
      if (this.held.get(name) === entry) this.held.delete(name);
      waiter.fail(err);
      this.pump(name);
    };
  }

  private pump(name: string): void {
    if (this.held.has(name)) return;
    const queue = this.queues.get(name);
    const next = queue?.shift();
    if (next) this.grant(name, next);
  }

  isHeld(name: string): boolean {
    return this.held.has(name);
  }
}

/** Let queued microtasks settle (the fake is fully in-process). */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("writerLockName", () => {
  it("never collides with LightningFS's own `<db>_lock`", () => {
    // Reusing LightningFS's mutex name would deadlock the filesystem itself
    // — the one naming rule this module MUST hold.
    expect(writerLockName("loom-workspace-git")).toBe("loom.workspace.loom-workspace-git.writer");
    expect(writerLockName("db")).not.toBe("db_lock");
  });
});

describe("acquireWriterLock", () => {
  it("gives the FIRST tab ownership and opens the second read-only", async () => {
    const manager = new FakeLockManager();
    const a = await acquireWriterLock("ws", { manager });
    const b = await acquireWriterLock("ws", { manager });

    expect(a.owner).toBe(true);
    expect(b.owner).toBe(false);
    expect(a.supported).toBe(true);

    a.release();
    b.release();
  });

  it("hands the lock to a waiting tab when the holder goes away (crash/close)", async () => {
    const manager = new FakeLockManager();
    const a = await acquireWriterLock("ws", { manager });
    const gained = vi.fn();
    const b = await acquireWriterLock("ws", { manager, onOwnerChange: gained });
    expect(b.owner).toBe(false);

    // A tab dying releases its Web Lock — that IS the recovery story; there is
    // no heartbeat and no TTL to expire.
    a.release();
    await tick();

    expect(b.owner).toBe(true);
    expect(gained).toHaveBeenCalledWith(true);
    b.release();
  });

  it("steal() takes the lock and flips the OLD holder to read-only", async () => {
    const manager = new FakeLockManager();
    const lostA = vi.fn();
    const a = await acquireWriterLock("ws", { manager, onOwnerChange: lostA });
    const b = await acquireWriterLock("ws", { manager });
    expect(a.owner).toBe(true);
    expect(b.owner).toBe(false);

    expect(await b.steal()).toBe(true);
    await tick();

    // Both halves of the handshake: the stealer owns it AND the old holder
    // knows it lost — the property that stops it silently writing on.
    expect(b.owner).toBe(true);
    expect(a.owner).toBe(false);
    expect(lostA).toHaveBeenCalledWith(false);

    a.release();
    b.release();
  });

  it("the tab that was stolen from re-queues, and regains on the thief's exit", async () => {
    const manager = new FakeLockManager();
    const a = await acquireWriterLock("ws", { manager });
    const b = await acquireWriterLock("ws", { manager });
    await b.steal();
    await tick();
    expect(a.owner).toBe(false);

    b.release();
    await tick();
    expect(a.owner).toBe(true);
    a.release();
  });

  it("steal() is a no-op for the tab that already owns the lock", async () => {
    const manager = new FakeLockManager();
    const a = await acquireWriterLock("ws", { manager });
    expect(await a.steal()).toBe(true);
    expect(a.owner).toBe(true);
    a.release();
  });

  it("release() frees the lock and is idempotent", async () => {
    const manager = new FakeLockManager();
    const a = await acquireWriterLock("ws", { manager });
    expect(manager.isHeld(writerLockName("ws"))).toBe(true);
    a.release();
    a.release();
    await tick();
    expect(manager.isHeld(writerLockName("ws"))).toBe(false);
    expect(a.owner).toBe(false);
  });

  it("two tabs on DIFFERENT workspaces are both writable", async () => {
    const manager = new FakeLockManager();
    const a = await acquireWriterLock("ws-one", { manager });
    const b = await acquireWriterLock("ws-two", { manager });
    expect(a.owner).toBe(true);
    expect(b.owner).toBe(true);
    a.release();
    b.release();
  });

  it("degrades to today's single-tab behaviour when the locks API is absent", async () => {
    // A false read-only on a LONE tab is worse than the status quo, so an
    // absent `navigator.locks` keeps every tab writable — never a hard
    // failure, never a spurious banner.
    const a = await acquireWriterLock("ws", { manager: null });
    const b = await acquireWriterLock("ws", { manager: null });
    expect(a.supported).toBe(false);
    expect(a.owner).toBe(true);
    expect(b.owner).toBe(true);
    expect(await b.steal()).toBe(true);
    a.release();
    b.release();
  });

  it("a tab released while queued never later claims ownership", async () => {
    const manager = new FakeLockManager();
    const a = await acquireWriterLock("ws", { manager });
    const changed = vi.fn();
    const b = await acquireWriterLock("ws", { manager, onOwnerChange: changed });
    b.release(); // e.g. the workspace was switched away from
    a.release();
    await tick();
    expect(b.owner).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    // …and the lock really is free for the next tab.
    const c = await acquireWriterLock("ws", { manager });
    expect(c.owner).toBe(true);
    c.release();
  });
});
