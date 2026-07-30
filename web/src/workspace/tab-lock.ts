// ---------------------------------------------------------------------------
// Per-workspace WRITER LOCK — the one-writer guarantee behind multi-tab
// coordination (mission M-T8.12, phase 1).
//
// Each workspace is one LightningFS over one IndexedDB.  LightningFS *does*
// already take a cross-tab mutex, but only over an **activation window**
// (`PromisifiedFS` deactivates 500 ms after the last fs call), so every idle
// gap hands it over mid-*git*-operation.  A `stageAll` → `commit` → `writeRef`
// sequence spans hundreds of fs ops with release windows between them, and
// `GitStore.commitChain` serialises commits within ONE tab only.  The fix is a
// lock at the right altitude: one exclusive Web Lock per workspace, held for
// the tab's whole session, that decides which tab is allowed to write at all.
//
// Held for the session on purpose: `navigator.locks` releases automatically
// when the holding context dies, so a crashed / closed tab hands the workspace
// to the next one with no heartbeat, no TTL, and no stale-lease recovery code.
// That auto-release IS the recovery story (it is also why a localStorage
// heartbeat was rejected — see the design brief's "Rejected alternatives").
//
// The name must NOT collide with LightningFS's own `` `${gitDb}_lock` `` —
// reusing it would deadlock the filesystem itself.
//
// Framework-free and node-testable: the `LockManager` is injected, because
// `navigator.locks` does not exist under vitest.  An ABSENT locks API is a
// first-class case, not an error: the tab stays writable (today's single-tab
// assumption), never read-only — a false read-only on a lone tab is worse than
// the status quo.
// ---------------------------------------------------------------------------

/** Lock name for a workspace's git DB.  Deliberately distinct from
 *  LightningFS's internal `` `${gitDb}_lock` ``. */
export const writerLockName = (gitDb: string): string => `loom.workspace.${gitDb}.writer`;

/** The subset of `LockOptions` this module uses. */
export interface LockRequestOptionsLike {
  mode?: "exclusive" | "shared";
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: AbortSignal;
}

/** The granted-callback: receives the granted `Lock`, or `null` when an
 *  `ifAvailable` request missed.  Returning a pending promise HOLDS the lock
 *  until that promise settles — how a session-long hold is expressed. */
export type LockGrantedCallback = (lock: unknown) => unknown;

/** Structural stand-in for `navigator.locks` (`LockManager`).  Injected so
 *  the unit suite can drive acquire / miss / steal deterministically in node,
 *  where the real API is absent. */
export interface LockManagerLike {
  request(
    name: string,
    options: LockRequestOptionsLike,
    callback: LockGrantedCallback,
  ): Promise<unknown>;
}

export interface WriterLockOptions {
  /** Fired whenever this tab's ownership FLIPS (never for the initial
   *  value — `acquireWriterLock` resolves with that on `.owner`).
   *
   *  Deviation from the design brief, which named a one-way `onLost()`:
   *  ownership also flips the other way (the holder closes its tab and our
   *  queued request is granted), and both directions drive the same UI
   *  swap, so one symmetric callback beats two asymmetric ones. */
  onOwnerChange?: (owner: boolean) => void;
  /** Injected manager.  Omit for `navigator.locks`; pass `null` to force
   *  the no-Web-Locks fallback (used by the unit suite). */
  manager?: LockManagerLike | null;
}

export interface WorkspaceWriterLock {
  readonly gitDb: string;
  /** True while this tab is the workspace's writer. */
  readonly owner: boolean;
  /** False when the platform has no Web Locks API — the tab then runs
   *  writable under the documented single-tab assumption. */
  readonly supported: boolean;
  /** Take the lock from whoever holds it ("Take over" in the UI).  The old
   *  holder's held request rejects with `AbortError`, which fires ITS
   *  `onOwnerChange(false)` — it flips to read-only rather than silently
   *  continuing to write.  Resolves to whether we now own the lock. */
  steal(): Promise<boolean>;
  /** Release and stop tracking.  Idempotent; safe to call while queued. */
  release(): void;
}

/** `navigator.locks`, when the platform has it. */
export function defaultLockManager(): LockManagerLike | null {
  const nav: unknown = typeof navigator === "undefined" ? undefined : navigator;
  const locks = (nav as { locks?: LockManagerLike } | undefined)?.locks;
  return locks != null && typeof locks.request === "function" ? locks : null;
}

class WriterLock implements WorkspaceWriterLock {
  private ownerFlag = false;
  private disposed = false;
  /** Resolver of the promise our granted-callback returned.  Calling it
   *  releases the held lock; non-null exactly while we hold one. */
  private releaseHeld: (() => void) | null = null;
  /** Abort handle for the QUEUED (blocking) request that waits for the
   *  current holder to die.  Null when nothing is queued. */
  private waitAbort: AbortController | null = null;

  constructor(
    readonly gitDb: string,
    private readonly manager: LockManagerLike | null,
    private readonly onOwnerChange: (owner: boolean) => void,
  ) {}

  get owner(): boolean {
    return this.ownerFlag;
  }

  get supported(): boolean {
    return this.manager !== null;
  }

  private setOwner(next: boolean): void {
    if (this.ownerFlag === next || this.disposed) return;
    this.ownerFlag = next;
    this.onOwnerChange(next);
  }

  /** One `LockManager.request`.  Resolves `true` once the granted-callback
   *  has been invoked with a real lock (we now HOLD it), `false` when an
   *  `ifAvailable` request missed, our own queued wait was aborted, or the
   *  request rejected. */
  private attempt(options: LockRequestOptionsLike): Promise<boolean> {
    const manager = this.manager;
    if (manager === null) return Promise.resolve(false);
    let settle: (owned: boolean) => void = () => {};
    const acquired = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    // Identity of THIS attempt's hold, so the rejection handler below can
    // tell "the lock we were holding got stolen" from "a queued request we
    // cancelled ourselves" — only the former is an ownership loss.
    let token: (() => void) | null = null;
    const held = manager.request(writerLockName(this.gitDb), options, (lock) => {
      if (lock === null || lock === undefined) {
        settle(false); // `ifAvailable` miss — someone else holds it
        return undefined;
      }
      return new Promise<void>((resolve) => {
        token = resolve;
        this.releaseHeld = resolve;
        settle(true);
      });
    });
    Promise.resolve(held).then(
      () => {
        // Released normally (by us).
        if (token !== null && this.releaseHeld === token) this.releaseHeld = null;
        settle(false);
      },
      () => {
        settle(false);
        if (token !== null && this.releaseHeld === token) {
          // We were HOLDING it and the request rejected — another tab used
          // `{ steal: true }`.  This is the defining "you are no longer the
          // writer" signal; flip read-only and queue for it to come back.
          this.releaseHeld = null;
          this.setOwner(false);
          this.queueWait();
        }
      },
    );
    return acquired;
  }

  /** Queue a BLOCKING request so that when the current holder's tab dies
   *  (or releases) we are granted the lock and become writable — no polling,
   *  no heartbeat.  At most one queued request at a time. */
  private queueWait(): void {
    if (this.disposed || this.manager === null || this.ownerFlag) return;
    if (this.waitAbort !== null) return;
    const ctrl = new AbortController();
    this.waitAbort = ctrl;
    void this.attempt({ signal: ctrl.signal }).then((got) => {
      if (this.waitAbort === ctrl) this.waitAbort = null;
      if (!got) return;
      if (this.disposed) {
        // Granted after teardown — hand it straight back.
        const r = this.releaseHeld;
        this.releaseHeld = null;
        r?.();
        return;
      }
      this.setOwner(true);
    });
  }

  private cancelWait(): void {
    const ctrl = this.waitAbort;
    this.waitAbort = null;
    ctrl?.abort();
  }

  /** Initial acquisition.  `ifAvailable` so a second tab NEVER blocks on
   *  open — it opens read-only and queues instead. */
  async open(): Promise<void> {
    if (this.manager === null) {
      // No Web Locks: keep today's behaviour (single-tab assumption) rather
      // than degrading to a hard failure or a false read-only.
      this.ownerFlag = true;
      return;
    }
    if (await this.attempt({ ifAvailable: true })) {
      this.ownerFlag = true;
      return;
    }
    this.queueWait();
  }

  async steal(): Promise<boolean> {
    if (this.disposed || this.manager === null) return this.ownerFlag;
    if (this.ownerFlag) return true;
    // Drop our queued waiter first: `{ steal: true }` preempts queued
    // requests, and leaving ours queued would grant us a SECOND hold later.
    this.cancelWait();
    const got = await this.attempt({ steal: true });
    if (got) this.setOwner(true);
    else this.queueWait();
    return got;
  }

  release(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelWait();
    const r = this.releaseHeld;
    this.releaseHeld = null;
    this.ownerFlag = false;
    r?.();
  }
}

/** Acquire (or fail to acquire) the writer lock for `gitDb`.  Never rejects
 *  and never blocks: resolves as soon as the open decision is made, with
 *  `.owner` telling the caller whether this tab may write. */
export async function acquireWriterLock(
  gitDb: string,
  opts: WriterLockOptions = {},
): Promise<WorkspaceWriterLock> {
  const manager = "manager" in opts ? (opts.manager ?? null) : defaultLockManager();
  const lock = new WriterLock(gitDb, manager, opts.onOwnerChange ?? (() => {}));
  await lock.open();
  return lock;
}
