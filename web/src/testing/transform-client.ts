// Main-thread client for the TS-transform worker.  Exposes a single
// `compile(ts) → js` the API test runner consumes as its `compile`
// seam.

import type {
  TransformRequest,
  TransformResponse,
} from "./transform.worker.js";

export class TsTransformClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (code: string) => void; reject: (err: Error) => void }
  >();

  constructor() {
    this.worker = new Worker(
      new URL("./transform.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = (ev: MessageEvent<TransformResponse>): void => {
      const m = ev.data;
      const slot = this.pending.get(m.id);
      if (!slot) return;
      this.pending.delete(m.id);
      if (m.ok && m.code != null) slot.resolve(m.code);
      else slot.reject(new Error(m.message ?? "transform failed"));
    };
  }

  compile(ts: string): Promise<string> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ts } satisfies TransformRequest);
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const slot of this.pending.values()) {
      slot.reject(new Error("TsTransformClient disposed"));
    }
    this.pending.clear();
  }
}
