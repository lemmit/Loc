// ---------------------------------------------------------------------------
// EsbuildPgliteEngine — the proven default RuntimeEngine.
//
// A thin, behaviour-preserving wrapper around the two worker clients
// the playground already shipped:
//
//   LoomBundleClient   esbuild-wasm: generated tree → ESM module(s)
//   LoomRuntimeClient  PGlite + Hono blob-import + dispatch/wipe
//
// P1 introduces no behaviour change.  The bundling order and the
// runtime calls mirror App.tsx's old `runBundleStep` / `runBootStep`
// exactly: bundle Hono first, bundle React only when Hono succeeded
// and a React entry exists, boot from the Hono bundle code.  All the
// orchestration that stays in App (deployable analysis, the
// "nothing to bundle" wording, dataDir source-keying, the pipeline
// reducer) is untouched.
//
// Self-registers as the default engine on import.
// ---------------------------------------------------------------------------

import { LoomBundleClient } from "../bundle/client.js";
import { LoomRuntimeClient } from "../runtime/client.js";
import type {
  BootResult,
  DispatchResult,
  SerializedRequest,
  WipeResult,
} from "../runtime/protocol.js";
import { engineRegistry } from "./registry.js";
import type {
  EngineCapabilities,
  EngineSnapshot,
  PrepareInput,
  PreparedBuild,
  RuntimeEngine,
  RuntimeEngineOptions,
} from "./runtime-engine.js";

export class EsbuildPgliteEngine implements RuntimeEngine {
  readonly capabilities: EngineCapabilities = {
    id: "esbuild-pglite",
    realNode: false,
    npmInstall: false,
    database: "pglite",
    // esm.sh handles the pure-JS/ESM 80%; the WASM/native long tail
    // needs per-package handling (see the refactor plan, P6).
    customPackages: "common",
  };

  private readonly bundle: LoomBundleClient;
  private readonly runtime: LoomRuntimeClient;
  /** Last successful boot inputs — the snapshot needed to transparently
   *  re-boot after the browser kills a backgrounded worker.  The
   *  PGlite data itself survives in OPFS (keyed by `dataDir`), so
   *  re-booting the same bundle + dataDir reattaches it. */
  private lastBoot:
    | { bundleCode: string; dataDir?: string; persistent: boolean }
    | null = null;

  constructor(opts: RuntimeEngineOptions = {}) {
    this.bundle = new LoomBundleClient();
    // `onLost` maps 1:1 to the old `onRespawn`: the booted PGlite
    // belongs to the worker that was killed and can't be recovered,
    // so the app flips the pipeline back to "needs Boot".
    this.runtime = new LoomRuntimeClient({ onRespawn: opts.onLost });
  }

  async prepare(input: PrepareInput): Promise<PreparedBuild> {
    const hono = await this.bundle.bundle({
      kind: "hono",
      files: input.files,
      entryPath: input.honoEntry,
    });
    let react: PreparedBuild["react"] = null;
    if (hono.ok && input.reactEntry) {
      react = await this.bundle.bundle({
        kind: "react",
        files: input.files,
        entryPath: input.reactEntry,
      });
    }
    return { hono, react };
  }

  async boot(bundleCode: string, dataDir?: string): Promise<BootResult> {
    const res = await this.runtime.boot({ bundleCode, dataDir });
    if (res.ok) this.lastBoot = { bundleCode, dataDir, persistent: res.persistent };
    return res;
  }

  dispatch(req: SerializedRequest): Promise<DispatchResult> {
    return this.runtime.dispatch(req);
  }

  wipe(): Promise<WipeResult> {
    return this.runtime.wipe();
  }

  reset(): Promise<{ ok: true }> {
    return this.runtime.reset();
  }

  respawn(): void {
    this.runtime.respawn();
  }

  // Tab-suspension recovery: capture the inputs needed to re-boot.
  // Null until a successful boot — nothing to recover, caller
  // cold-boots as before.
  async snapshot(): Promise<EngineSnapshot | null> {
    // Only offer recovery when the data actually survived (OPFS).
    // A non-persistent (in-memory) DB is genuinely gone on
    // worker-kill, so let the caller drop to RUNTIME_LOST and show
    // its "rows are gone" message rather than silently re-booting an
    // empty DB.
    return this.lastBoot?.persistent
      ? { engineId: this.capabilities.id, version: 1, blob: this.lastBoot }
      : null;
  }

  // Silently respawn the (browser-killed) worker and re-boot from the
  // snapshot.  OPFS-backed data reattaches via the same dataDir, so a
  // successful restore is transparent — the caller keeps its "booted"
  // state instead of dropping to "needs Boot".
  async restore(snap: EngineSnapshot): Promise<boolean> {
    if (snap.engineId !== this.capabilities.id || snap.version !== 1) {
      return false;
    }
    const blob = snap.blob as { bundleCode: string; dataDir?: string } | null;
    if (!blob?.bundleCode) return false;
    this.runtime.respawn(true); // silent — recovery, not loss
    const res = await this.boot(blob.bundleCode, blob.dataDir);
    return res.ok;
  }

  dispose(): void {
    this.bundle.dispose();
    this.runtime.dispose();
  }
}

engineRegistry.register(
  "esbuild-pglite",
  (opts) => new EsbuildPgliteEngine(opts),
  true,
);
