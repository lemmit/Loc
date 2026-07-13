// Main-thread client for the VFS-npm esbuild-wasm worker (Phase B4).
// Exposes the `EsbuildRun` shape NpmInstallBundleEngine consumes.
//
// Self-healing (#13): the browser silently kills idle Web Workers
// while a tab is backgrounded; a subsequent postMessage to the dead
// worker never replies, so a naive client would hang forever.  Each
// run is therefore bounded by a timeout that respawns the worker and
// resolves with a retryable error instead of hanging — and the fresh
// worker is ready for the next attempt.

import type { EsbuildRun } from "../npm-install-bundle-engine.js";
import type {
  VfsBundleRequest,
  VfsBundleResponse,
} from "./vfs-bundler.worker.js";

type RunResult =
  | {
      ok: true;
      code: string;
      css?: string;
      versions: Record<string, string>;
      vendorImportmap?: Record<string, string>;
      vendorCssUrl?: string;
    }
  | { ok: false; message: string };

// Generous cap: a cold run does a full npm install + esbuild-wasm
// bundle (tens of seconds).  The timeout only fires on a genuine
// hang — i.e. a worker the browser killed while idle — not on
// legitimately-slow bundling.
const RUN_TIMEOUT_MS = 180_000;

export class VfsBundlerClient {
  private worker!: Worker;
  private nextId = 1;
  private disposed = false;
  private pending = new Map<
    number,
    { resolve: (v: RunResult) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor() {
    this.spawn();
  }

  private spawn(): void {
    this.worker = new Worker(
      new URL("./vfs-bundler.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = (ev: MessageEvent<VfsBundleResponse>): void => {
      const m = ev.data;
      const slot = this.pending.get(m.id);
      if (!slot) return;
      this.pending.delete(m.id);
      clearTimeout(slot.timer);
      slot.resolve(
        m.ok
          ? {
              ok: true,
              code: m.code ?? "",
              css: m.css,
              versions: m.versions ?? {},
              vendorImportmap: m.vendorImportmap,
              vendorCssUrl: m.vendorCssUrl,
            }
          : { ok: false, message: m.message ?? "vfs-bundler: unknown error" },
      );
    };
  }

  /** Terminate and recreate the worker; fail any in-flight runs so
   *  callers retry against the fresh one.  esbuild-wasm re-inits
   *  lazily on the next run. */
  respawn(): void {
    if (this.disposed) return;
    try {
      this.worker.terminate();
    } catch {
      /* terminate on a dead worker can throw; ignore */
    }
    for (const slot of this.pending.values()) {
      clearTimeout(slot.timer);
      slot.resolve({ ok: false, message: "Bundler worker was reset — try again." });
    }
    this.pending.clear();
    this.spawn();
  }

  /** Bound as the engine's EsbuildRun. */
  run: EsbuildRun = (input) => {
    if (this.disposed) {
      return Promise.resolve({ ok: false, message: "Bundler disposed" });
    }
    const id = this.nextId++;
    return new Promise<RunResult>((resolve) => {
      const timer = setTimeout(() => {
        // No reply within the budget — almost always a worker the
        // browser killed while the tab was backgrounded.  Respawn so
        // the next run succeeds, and surface a retryable error
        // rather than hanging indefinitely.
        if (this.pending.delete(id)) {
          this.respawn();
          resolve({
            ok: false,
            message: `Bundling timed out after ${Math.round(
              RUN_TIMEOUT_MS / 1000,
            )}s; the bundler worker was reset — try again.`,
          });
        }
      }, RUN_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage({
        id,
        stdinContents: input.stdinContents,
        entry: input.entry,
        generatedFiles: input.generatedFiles,
        rootDeps: input.rootDeps,
        externalReactRuntime: input.externalReactRuntime,
        sourcemap: input.sourcemap,
        // Resolve the configured base (relative "./" on GH Pages) to an
        // absolute url against the main document.  The worker can't do
        // this — a relative fetch there resolves against the worker's
        // own assets/ url and misses the deployed vendor/ + npm-mirror/.
        deployBase: new URL(
          import.meta.env?.BASE_URL ?? "/",
          document.baseURI,
        ).href,
      } satisfies VfsBundleRequest);
    });
  };

  dispose(): void {
    this.disposed = true;
    // Resolve — not just clear — any in-flight runs.  A run pending at
    // dispose time would otherwise leave its `prepare()` awaiter hanging
    // forever (the timer is cleared, no reply ever comes): the lost
    // completion behind #1242 (preview-runtime e2e specs stall the full
    // 600s after a SUCCESSFUL bundle when a dispose races the run).
    // Mirror `respawn`, which already resolves its pending set.
    for (const slot of this.pending.values()) {
      clearTimeout(slot.timer);
      slot.resolve({ ok: false, message: "Bundler disposed" });
    }
    this.pending.clear();
    try {
      this.worker.terminate();
    } catch {
      /* ignore */
    }
  }
}
