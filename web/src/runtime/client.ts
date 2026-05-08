import type {
  BootRequest,
  BootResult,
  DispatchResult,
  RuntimeRpcRequest,
  RuntimeRpcResponse,
  SerializedRequest,
  WipeResult,
} from "./protocol.js";

export class LoomRuntimeClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor() {
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

  dispose(): void {
    this.worker.terminate();
    for (const slot of this.pending.values()) {
      slot.reject(new Error("Runtime client disposed"));
    }
    this.pending.clear();
  }
}
