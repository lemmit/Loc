// Main-thread client for the VFS-npm esbuild-wasm worker (Phase B4).
// Exposes the `EsbuildRun` shape NpmInstallBundleEngine consumes.

import type { EsbuildRun } from "../npm-install-bundle-engine.js";
import type {
  VfsBundleRequest,
  VfsBundleResponse,
} from "./vfs-bundler.worker.js";

export class VfsBundlerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: { ok: true; code: string; css?: string } | { ok: false; message: string }) => void;
    }
  >();

  constructor() {
    this.worker = new Worker(
      new URL("./vfs-bundler.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = (ev: MessageEvent<VfsBundleResponse>): void => {
      const m = ev.data;
      const slot = this.pending.get(m.id);
      if (!slot) return;
      this.pending.delete(m.id);
      slot.resolve(
        m.ok
          ? { ok: true, code: m.code ?? "", css: m.css }
          : { ok: false, message: m.message ?? "vfs-bundler: unknown error" },
      );
    };
  }

  /** Bound as the engine's EsbuildRun. */
  run: EsbuildRun = (input) => {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.worker.postMessage({
        id,
        stdinContents: input.stdinContents,
        entry: input.entry,
        files: input.files,
      } satisfies VfsBundleRequest);
    });
  };

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
