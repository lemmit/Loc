import type {
  BootRequest,
  BootResult,
  DispatchResult,
  RuntimeRpcRequest,
  RuntimeRpcResponse,
  SerializedRequest,
  WipeResult,
} from "./protocol.js";

export interface LoomRuntimeClientOptions {
  /** Optional callback fired every time `respawn` terminates the
   *  worker and creates a fresh one — including when an external
   *  trigger (App.tsx's visibilitychange handler) decides the
   *  backgrounded worker was likely killed.  Used by the
   *  playground to surface "runtime was reset, click Boot again"
   *  in the UI: the booted PGlite database belongs to the old
   *  worker and can't be recovered. */
  onRespawn?: () => void;
}

export class LoomRuntimeClient {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly onRespawn?: () => void;
  private disposed = false;

  constructor(opts: LoomRuntimeClientOptions = {}) {
    this.onRespawn = opts.onRespawn;
    this.spawn();
  }

  /** Create a fresh worker and wire its `onmessage`.  Extracted so
   *  `respawn` can recreate the worker without duplicating
   *  constructor logic. */
  private spawn(): void {
    this.worker = new Worker(new URL("./runtime.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<RuntimeRpcResponse>) => {
      const msg = ev.data;
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message));
      else slot.resolve(msg.result ?? null);
    };
  }

  private send<T>(req: Omit<RuntimeRpcRequest, "id">): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("LoomRuntimeClient: disposed"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.worker.postMessage({ id, ...req } as RuntimeRpcRequest);
    });
  }

  boot(req: BootRequest): Promise<BootResult> {
    return this.send<BootResult>({ method: "boot", params: req });
  }

  dispatch(req: SerializedRequest): Promise<DispatchResult> {
    return this.send<DispatchResult>({
      method: "dispatch",
      params: req,
    });
  }

  reset(): Promise<{ ok: true }> {
    return this.send<{ ok: true }>({
      method: "reset",
      params: {},
    });
  }

  /** Drop every user object inside the booted PGlite and re-apply
   *  DDL.  For OPFS-backed runs the underlying data island
   *  survives — schema reattaches clean, but the rows are gone. */
  wipe(): Promise<WipeResult> {
    return this.send<WipeResult>({
      method: "wipe",
      params: {},
    });
  }

  /** Terminate the current worker and start a fresh one.  Used by
   *  App.tsx's visibilitychange handler after a backgrounded tab
   *  returns to the foreground — mobile Safari (and any desktop
   *  browser under memory pressure) silently kills idle workers,
   *  and a follow-up `dispatch()` against a dead worker would hang
   *  indefinitely instead of failing fast.
   *
   *  Unlike the build worker, the runtime worker owns
   *  unrecoverable state (the booted PGlite database and the
   *  dynamically-imported bundle module).  The `onRespawn` callback
   *  lets the parent flip its pipeline back into a "needs Boot"
   *  state so the user sees a clear affordance instead of a
   *  silent next-request failure.
   *
   *  Pending RPCs are rejected with a labelled error; callers that
   *  care can retry.
   *
   *  `silent` skips the `onRespawn` callback — used by the engine's
   *  `restore()` recovery path, which respawns the worker and
   *  immediately re-boots, so the parent must NOT be told the
   *  runtime was "lost". */
  respawn(silent = false): void {
    if (this.disposed) return;
    try {
      this.worker.terminate();
    } catch {
      /* terminate on a dead worker can throw; ignore */
    }
    for (const slot of this.pending.values()) {
      slot.reject(new Error("Runtime worker respawned; retry the operation."));
    }
    this.pending.clear();
    this.spawn();
    if (!silent) this.onRespawn?.();
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.worker.terminate();
    } catch {
      /* ignore */
    }
    for (const slot of this.pending.values()) {
      slot.reject(new Error("Runtime client disposed"));
    }
    this.pending.clear();
  }
}
