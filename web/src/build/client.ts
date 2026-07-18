import type {
  BuildRpcRequest,
  BuildRpcResponse,
  EvolutionResult,
  GenerateResult,
  SnapshotResult,
  VfsEntry,
  VfsDeleteResult,
  VfsWriteResult,
} from "./protocol.js";

/** Anything the worker can return — narrowed by the call-site to the
 *  expected method's result type.  Centralising avoids duplicating
 *  the union across every wrapper method below. */
type AnyResult =
  | GenerateResult
  | SnapshotResult
  | EvolutionResult
  | VfsWriteResult
  | VfsDeleteResult;

interface PendingSlot {
  resolve: (v: AnyResult) => void;
  reject: (e: Error) => void;
}

export interface LoomBuildClientOptions {
  /** Optional callback invoked at every worker spawn (initial mount
   *  AND `respawn`).  Returns the workspace VFS entries the worker
   *  should be re-seeded with — typically `/workspace/main.ddd`
   *  plus any imported custom packs under `/workspace/design/...`.
   *
   *  Built-in pack templates live in the worker bundle and re-seed
   *  themselves automatically (see `template-bundled.ts`); only
   *  workspace state needs replaying.
   *
   *  Mobile Safari kills backgrounded workers aggressively; this
   *  callback is what makes respawn correctness-preserving — the
   *  fresh worker comes back operationally indistinguishable from
   *  the one the browser killed. */
  seedWorkspace?: () => VfsEntry[];
}

export class LoomBuildClient {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<number, PendingSlot>();
  private readonly seedWorkspace?: () => VfsEntry[];
  private disposed = false;

  constructor(opts: LoomBuildClientOptions = {}) {
    this.seedWorkspace = opts.seedWorkspace;
    this.spawn();
  }

  /** Create a fresh worker, wire its `onmessage`, and immediately
   *  push the workspace seed (if any) so generation calls land on
   *  a worker whose VFS already mirrors the main-thread workspace. */
  private spawn(): void {
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
    if (this.seedWorkspace) {
      const entries = this.seedWorkspace();
      if (entries.length > 0) {
        // Fire-and-forget: the seed is bookkeeping the user didn't
        // request and doesn't need to await.  The worker queues
        // it before any user RPC by virtue of message ordering.
        const id = this.nextId++;
        this.worker.postMessage({
          id,
          method: "vfs.write",
          params: { entries },
        } satisfies BuildRpcRequest);
      }
    }
  }

  /** Send an RPC and resolve when the worker ACKs.  All public
   *  methods funnel through here so the request-id bookkeeping and
   *  promise wiring live in one place. */
  private call(
    method: BuildRpcRequest["method"],
    params: BuildRpcRequest["params"],
  ): Promise<AnyResult> {
    if (this.disposed) {
      return Promise.reject(new Error("LoomBuildClient: disposed"));
    }
    const id = this.nextId++;
    return new Promise<AnyResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, params } as BuildRpcRequest);
    });
  }

  /** Generate from inline source text.  Legacy entry point — kept
   *  callable so existing callers don't break during the Phase 2
   *  migration.  New call sites should write to the VFS first and
   *  use `generateFromPath` instead.
   *
   *  `opts.sourcemap` is opt-in (undefined by default) — see
   *  `GenerateParams.sourcemap`. */
  generate(text: string, opts?: { sourcemap?: boolean }): Promise<GenerateResult> {
    return this.call("generate", { text, sourcemap: opts?.sourcemap }) as Promise<GenerateResult>;
  }

  /** Generate from a path inside the worker's VFS.  Pair with a
   *  prior `vfsWrite` of the entry file (typically
   *  `/workspace/main.ddd`); the returned promise resolves only
   *  after the worker ACKs the write, so chaining write→generate
   *  through `await` preserves ordering without a separate barrier.
   *
   *  `opts.sourcemap` is opt-in (undefined by default) — see
   *  `GenerateParams.sourcemap`. */
  generateFromPath(
    entryPath: string,
    opts?: { sourcemap?: boolean },
  ): Promise<GenerateResult> {
    return this.call("generate", {
      entryPath,
      sourcemap: opts?.sourcemap,
    }) as Promise<GenerateResult>;
  }

  /** Capture provenance rule snapshots — the playground equivalent of the
   *  CLI `ddd snapshot` prebuild step.  Resolves with the immutable
   *  timestamped+GUID snapshot files (empty when no `provenanced` field is
   *  written). */
  snapshot(text: string): Promise<SnapshotResult> {
    return this.call("snapshot", { text }) as Promise<SnapshotResult>;
  }

  snapshotFromPath(entryPath: string): Promise<SnapshotResult> {
    return this.call("snapshot", { entryPath }) as Promise<SnapshotResult>;
  }

  /** Derive the migration + wire-contract delta between a pinned baseline
   *  source and the live edit — the playground's window onto the evolution
   *  lifecycle the stateless regen otherwise hides.  Both sources are
   *  lowered in the worker; the result is plain DTOs (rendered SQL steps +
   *  classified contract changes).  Single-entry text only (v1). */
  evolution(baselineText: string, currentText: string): Promise<EvolutionResult> {
    return this.call("evolution", { baselineText, currentText }) as Promise<EvolutionResult>;
  }

  /** Push one or more files into the worker's VFS.  Returns the
   *  sorted list of paths actually written. */
  vfsWrite(entries: VfsEntry[]): Promise<VfsWriteResult> {
    return this.call("vfs.write", { entries }) as Promise<VfsWriteResult>;
  }

  /** Remove paths from the worker's VFS.  Missing paths are silently
   *  dropped; the response lists the paths that actually existed. */
  vfsDelete(paths: string[]): Promise<VfsDeleteResult> {
    return this.call("vfs.delete", { paths }) as Promise<VfsDeleteResult>;
  }

  /** Terminate the current worker and start a fresh one, replaying
   *  workspace state via `seedWorkspace`.  Used after the browser
   *  kills a backgrounded worker (mobile Safari) — without this,
   *  the next `generateFromPath` would target an empty VFS and
   *  throw "entryPath not found".
   *
   *  Pending RPCs are rejected: they targeted the dead worker and
   *  there's no safe way to re-issue them blindly.  Callers that
   *  care can retry after the rejection. */
  respawn(): void {
    if (this.disposed) return;
    try {
      this.worker.terminate();
    } catch {
      /* terminate on a dead worker can throw; we don't care */
    }
    for (const slot of this.pending.values()) {
      slot.reject(new Error("Build worker respawned; retry the operation."));
    }
    this.pending.clear();
    this.spawn();
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.worker.terminate();
    } catch {
      /* ignore */
    }
    for (const slot of this.pending.values()) {
      slot.reject(new Error("Build client disposed"));
    }
    this.pending.clear();
  }
}
