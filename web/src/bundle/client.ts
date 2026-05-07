import type {
  BundleRequest,
  BundleResult,
  BundleRpcRequest,
  BundleRpcResponse,
} from "./protocol.js";

export class LoomBundleClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: BundleResult) => void; reject: (e: Error) => void }
  >();

  constructor() {
    this.worker = new Worker(new URL("./bundler.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<BundleRpcResponse>) => {
      const msg = ev.data;
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message));
      else if (msg.result) slot.resolve(msg.result);
      else slot.reject(new Error("Bundler returned an empty response"));
    };
  }

  bundle(req: BundleRequest): Promise<BundleResult> {
    const id = this.nextId++;
    return new Promise<BundleResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        id,
        method: "bundle",
        params: req,
      } satisfies BundleRpcRequest);
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const slot of this.pending.values()) {
      slot.reject(new Error("Bundle client disposed"));
    }
    this.pending.clear();
  }
}
