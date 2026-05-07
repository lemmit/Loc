import type {
  BootResult,
  DispatchResult,
  RuntimeRpcRequest,
  RuntimeRpcResponse,
  SerializedRequest,
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

  boot(bundleCode: string): Promise<BootResult> {
    return this.send<BootResult>({
      method: "boot",
      params: { bundleCode },
    });
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

  dispose(): void {
    this.worker.terminate();
    for (const slot of this.pending.values()) {
      slot.reject(new Error("Runtime client disposed"));
    }
    this.pending.clear();
  }
}
