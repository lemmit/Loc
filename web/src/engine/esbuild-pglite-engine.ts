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

  boot(bundleCode: string, dataDir?: string): Promise<BootResult> {
    return this.runtime.boot({ bundleCode, dataDir });
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

  // Tab-suspension persistence lands in P4.  Until then the engine
  // has nothing to restore: snapshot yields null and the caller
  // cold-boots as today.
  async snapshot(): Promise<EngineSnapshot | null> {
    return null;
  }

  async restore(_snap: EngineSnapshot): Promise<boolean> {
    return false;
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
