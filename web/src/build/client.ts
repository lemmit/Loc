import type {
  BuildRpcRequest,
  BuildRpcResponse,
  GenerateResult,
} from "./protocol.js";

export class LoomBuildClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: GenerateResult) => void; reject: (e: Error) => void }
  >();

  constructor() {
    this.worker = new Worker(new URL("./build.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<BuildRpcResponse>) => {
      const msg = ev.data;
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message));
      else if (msg.result) slot.resolve(msg.result);
      else slot.reject(new Error("Build worker returned an empty response"));
    };
  }

  generate(text: string): Promise<GenerateResult> {
    const id = this.nextId++;
    return new Promise<GenerateResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        id,
        method: "generate",
        params: { text },
      } satisfies BuildRpcRequest);
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const slot of this.pending.values()) {
      slot.reject(new Error("Build client disposed"));
    }
    this.pending.clear();
  }
}
