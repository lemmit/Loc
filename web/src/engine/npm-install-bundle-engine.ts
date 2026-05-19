// ---------------------------------------------------------------------------
// NpmInstallBundleEngine (Phase B3c) — the npm-in-browser RuntimeEngine.
//
// Assembly of the proven B1–B3b parts:
//   install (real tarballs) → makeVfsNpmPlugin esbuild bundle (real
//   node_modules, no esm.sh) → boot/dispatch on the SAME PGlite+Hono
//   runtime client EsbuildPgliteEngine uses (engine-agnostic path).
//
// Registered NON-default and not selected by anything yet — purely
// additive, app behaviour unchanged.  It becomes selectable once B4
// wires the browser esbuild-wasm worker builder and proves boot
// parity (real-pglite postprocess + React externalisation are B4).
//
// The esbuild invocation is injected (`EsbuildRun`) so the assembled
// class is verifiable with node esbuild today; the default runner
// throws a clear "not wired until B4" until the worker builder lands.
// ---------------------------------------------------------------------------

import { LoomRuntimeClient } from "../runtime/client.js";
import type {
  BootResult,
  DispatchResult,
  SerializedRequest,
  WipeResult,
} from "../runtime/protocol.js";
import type { BundleResult } from "../bundle/protocol.js";
import {
  RUNTIME_VERSIONS,
  makeEntryStdin,
  schemaPathFor,
} from "../bundle/plugin.js";
import { engineRegistry } from "./registry.js";
import type {
  EngineCapabilities,
  EngineSnapshot,
  PrepareInput,
  PreparedBuild,
  RuntimeEngine,
  RuntimeEngineOptions,
} from "./runtime-engine.js";
import { install, type InstallCache } from "./npm/install.js";
import { IdbInstallCache } from "./npm/install-cache-idb.js";
import { postProcessNpmBundle } from "./npm/postprocess.js";
import { VfsBundlerClient } from "./npm/vfs-bundler-client.js";

export interface EsbuildRunInput {
  /** Bundle a synthesised entry (Hono path: makeEntryStdin output). */
  stdinContents?: string;
  /** Bundle a real file entry by absolute VFS path (React path). */
  entry?: string;
  files: Map<string, string | Uint8Array>;
  /** React build: keep react/react-dom external so the iframe
   *  importmap supplies a single instance — mirrors the esm.sh
   *  path's externalisation and avoids the dual-React/"Invalid hook
   *  call" failure that bundling React per-frontend would cause. */
  externalReactRuntime?: boolean;
}

export type EsbuildRun = (
  input: EsbuildRunInput,
) => Promise<
  { ok: true; code: string; css?: string } | { ok: false; message: string }
>;


/** Nearest package.json to the entry → its `dependencies`, plus the
 *  runtime-layer PGlite pin (the bundle entry imports it even though
 *  the generated package.json doesn't). */
function harvestRootDeps(
  files: Map<string, string | Uint8Array>,
  honoEntry: string,
): Record<string, string> {
  const td = new TextDecoder();
  const parts = honoEntry.split("/");
  for (let i = parts.length; i > 0; i--) {
    const p = "/" + [...parts.slice(0, i - 1), "package.json"].join("/");
    const raw = files.get(p);
    if (raw == null) continue;
    try {
      const pkg = JSON.parse(typeof raw === "string" ? raw : td.decode(raw));
      return {
        ...(pkg.dependencies ?? {}),
        "@electric-sql/pglite": RUNTIME_VERSIONS["@electric-sql/pglite"],
      };
    } catch {
      /* keep walking up */
    }
  }
  return { "@electric-sql/pglite": RUNTIME_VERSIONS["@electric-sql/pglite"] };
}

export class NpmInstallBundleEngine implements RuntimeEngine {
  readonly capabilities: EngineCapabilities = {
    id: "npm-install-bundle",
    realNode: false,
    npmInstall: true,
    database: "pglite",
    // Real node_modules → the whole public-package long tail works,
    // not just the esm.sh 80%.
    customPackages: "full",
  };

  private runtime: LoomRuntimeClient | null = null;
  private readonly onLost?: () => void;
  private readonly injectedRun?: EsbuildRun;
  private vfsBundler: VfsBundlerClient | null = null;
  private readonly injectedCache?: InstallCache;
  private cachePromise: Promise<InstallCache> | null = null;

  constructor(
    opts: RuntimeEngineOptions & {
      esbuildRun?: EsbuildRun;
      cache?: InstallCache;
    } = {},
  ) {
    this.onLost = opts.onLost;
    this.injectedRun = opts.esbuildRun;
    this.injectedCache = opts.cache;
  }

  /** Injected cache (tests) wins; otherwise a lazily-opened
   *  IdbInstallCache so a dependency set installs once and replays
   *  across prepares / reloads instead of re-fetching tens of MB
   *  every Bundle.  Memoised; `open()` is a no-op (memory-only) when
   *  IDB is unavailable, so non-browser callers still work. */
  private async resolveCache(): Promise<InstallCache> {
    if (this.injectedCache) return this.injectedCache;
    if (!this.cachePromise) {
      this.cachePromise = (async () => {
        const c = new IdbInstallCache();
        await c.open();
        return c;
      })();
    }
    return this.cachePromise;
  }

  /** Injected runner (spikes / tests) wins; otherwise the in-browser
   *  esbuild-wasm worker, created lazily so non-browser callers that
   *  inject never construct a Worker. */
  private esbuildRun(): EsbuildRun {
    if (this.injectedRun) return this.injectedRun;
    this.vfsBundler ??= new VfsBundlerClient();
    return this.vfsBundler.run;
  }

  /** The runtime worker is created lazily on first boot — `prepare`
   *  (install + bundle) needs no worker, which also keeps the class
   *  unit-testable outside a Worker host. */
  private rt(): LoomRuntimeClient {
    return (this.runtime ??= new LoomRuntimeClient({ onRespawn: this.onLost }));
  }

  async prepare(input: PrepareInput): Promise<PreparedBuild> {
    const files = new Map<string, string | Uint8Array>();
    for (const f of input.files) files.set("/" + f.path, f.content);

    const rootDeps = harvestRootDeps(files, input.honoEntry);
    const cache = await this.resolveCache();
    const { versions } = await install(
      rootDeps,
      (p, d) => files.set(p, d),
      { cache },
    );
    const versionRec = Object.fromEntries(versions);
    const run = this.esbuildRun();

    const honoRun = await run({
      stdinContents: makeEntryStdin(
        input.honoEntry,
        schemaPathFor(input.honoEntry),
      ),
      files,
    });
    // Apply the npm-pglite postprocess HERE — the runtime worker
    // boots `hono.code` verbatim, and unlike the esm.sh path (where
    // bundler.worker post-processes internally) nothing else would.
    // Failure → a bundle diagnostic, not a thrown rejection that
    // skips BUNDLE_DONE.
    let hono: BundleResult;
    if (!honoRun.ok) {
      hono = { ok: false, diagnostics: [{ severity: "error", message: honoRun.message }] };
    } else {
      try {
        const code = postProcessNpmBundle(honoRun.code);
        hono = {
          ok: true,
          kind: "hono",
          code,
          size: code.length,
          durationMs: 0,
          fetchedUrls: [],
          versions: versionRec,
          diagnostics: [],
        };
      } catch (err) {
        hono = {
          ok: false,
          diagnostics: [
            {
              severity: "error",
              message: err instanceof Error ? err.message : String(err),
            },
          ],
        };
      }
    }

    let react: BundleResult | null = null;
    if (hono.ok && input.reactEntry) {
      const r = await run({
        entry: "/" + input.reactEntry,
        files,
        externalReactRuntime: true,
      });
      react = r.ok
        ? {
            ok: true,
            kind: "react",
            code: r.code,
            css: r.css,
            size: r.code.length,
            durationMs: 0,
            fetchedUrls: [],
            versions: versionRec,
            diagnostics: [],
          }
        : { ok: false, diagnostics: [{ severity: "error", message: r.message }] };
    }
    return { hono, react };
  }

  // boot/dispatch/wipe/reset/respawn delegate to the shared
  // PGlite+Hono runtime client, identical to EsbuildPgliteEngine.
  boot(bundleCode: string, dataDir?: string): Promise<BootResult> {
    return this.rt().boot({ bundleCode, dataDir });
  }
  dispatch(req: SerializedRequest): Promise<DispatchResult> {
    return this.rt().dispatch(req);
  }
  wipe(): Promise<WipeResult> {
    return this.rt().wipe();
  }
  reset(): Promise<{ ok: true }> {
    return this.rt().reset();
  }
  respawn(): void {
    this.runtime?.respawn();
  }
  async snapshot(): Promise<EngineSnapshot | null> {
    return null; // P4
  }
  async restore(_snap: EngineSnapshot): Promise<boolean> {
    return false; // P4
  }
  dispose(): void {
    this.runtime?.dispose();
    this.vfsBundler?.dispose();
  }
}

// Selectable by config; NOT the default (esbuild-pglite registered
// first with asDefault=true keeps that crown until B4 parity).
engineRegistry.register(
  "npm-install-bundle",
  (opts) => new NpmInstallBundleEngine(opts),
);
