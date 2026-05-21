// Main-thread client for the esbuild-wasm test worker.
//   - `compile(ts)`  → type-strip a single file (API runner).
//   - `build(entry, files, aliases)` → bundle a generated suite + its
//     imports, aliasing the framework module (UI / unit runners).

import type {
  TransformRequest,
  TransformResponse,
} from "./transform.worker.js";

/** esbuild build seam: bundle a suite entry from a file map, aliasing
 *  the framework module to a shim.  Injected so runners are decoupled
 *  from the worker. */
export type EsbuildBuild = (
  entry: string,
  files: Record<string, string>,
  aliases: Record<string, string>,
) => Promise<string>;

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

  private request(payload: Omit<TransformRequest, "id">): Promise<string> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...payload } as TransformRequest);
    });
  }

  compile(ts: string): Promise<string> {
    return this.request({ ts });
  }

  /** Bundle a generated test suite, aliasing the framework module
   *  (`vitest` / `@playwright/test`) to a globalThis-reading shim. */
  build(
    entry: string,
    files: Record<string, string>,
    aliases: Record<string, string>,
  ): Promise<string> {
    return this.request({ build: { entry, files, aliases } });
  }

  dispose(): void {
    this.worker.terminate();
    for (const slot of this.pending.values()) {
      slot.reject(new Error("TsTransformClient disposed"));
    }
    this.pending.clear();
  }
}
