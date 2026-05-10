import type {
  BuildRpcRequest,
  BuildRpcResponse,
  GenerateResult,
  VfsEntry,
  VfsDeleteResult,
  VfsListResult,
  VfsSnapshotResult,
  VfsWriteResult,
} from "./protocol.js";

/** Anything the worker can return — narrowed by the call-site to the
 *  expected method's result type.  Centralising avoids duplicating
 *  the union across every wrapper method below. */
type AnyResult =
  | GenerateResult
  | VfsWriteResult
  | VfsDeleteResult
  | VfsListResult
  | VfsSnapshotResult;

interface PendingSlot {
  resolve: (v: AnyResult) => void;
  reject: (e: Error) => void;
}

export class LoomBuildClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, PendingSlot>();

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

  /** Send an RPC and resolve when the worker ACKs.  All public
   *  methods funnel through here so the request-id bookkeeping and
   *  promise wiring live in one place. */
  private call(
    method: BuildRpcRequest["method"],
    params: BuildRpcRequest["params"],
  ): Promise<AnyResult> {
    const id = this.nextId++;
    return new Promise<AnyResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, params } as BuildRpcRequest);
    });
  }

  /** Generate from inline source text.  Legacy entry point — kept
   *  callable so existing callers don't break during the Phase 2
   *  migration.  New call sites should write to the VFS first and
   *  use `generateFromPath` instead. */
  generate(text: string): Promise<GenerateResult> {
    return this.call("generate", { text }) as Promise<GenerateResult>;
  }

  /** Generate from a path inside the worker's VFS.  Pair with a
   *  prior `vfsWrite` of the entry file (typically
   *  `/workspace/main.ddd`); the returned promise resolves only
   *  after the worker ACKs the write, so chaining write→generate
   *  through `await` preserves ordering without a separate barrier. */
  generateFromPath(entryPath: string): Promise<GenerateResult> {
    return this.call("generate", { entryPath }) as Promise<GenerateResult>;
  }

  /** Push one or more files into the worker's VFS.  Returns the
   *  sorted list of paths actually written (the worker echoes back
   *  what it accepted, mirroring the `vfs.invalidated` push that
   *  Phase 2.5 will add for cross-worker fan-out). */
  vfsWrite(entries: VfsEntry[]): Promise<VfsWriteResult> {
    return this.call("vfs.write", { entries }) as Promise<VfsWriteResult>;
  }

  /** Remove paths from the worker's VFS.  Missing paths are silently
   *  dropped; the response lists the paths that actually existed. */
  vfsDelete(paths: string[]): Promise<VfsDeleteResult> {
    return this.call("vfs.delete", { paths }) as Promise<VfsDeleteResult>;
  }

  /** List paths under a prefix — see `MemoryVfs.list` for prefix
   *  semantics (trailing `/` enforces a directory boundary). */
  vfsList(prefix: string): Promise<VfsListResult> {
    return this.call("vfs.list", { prefix }) as Promise<VfsListResult>;
  }

  /** Full snapshot of the worker's VFS.  Used by tests and by the
   *  worker-rehydrate flow when a backgrounded worker is replaced
   *  (mobile Safari kills workers aggressively; Phase 2.5 wires
   *  rehydrate from the main-thread workspace VFS). */
  vfsSnapshot(): Promise<VfsSnapshotResult> {
    return this.call("vfs.snapshot", {}) as Promise<VfsSnapshotResult>;
  }

  dispose(): void {
    this.worker.terminate();
    for (const slot of this.pending.values()) {
      slot.reject(new Error("Build client disposed"));
    }
    this.pending.clear();
  }
}
