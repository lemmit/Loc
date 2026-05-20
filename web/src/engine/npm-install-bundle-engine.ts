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
import { postProcessNpmBundle } from "./npm/postprocess.js";
import { VfsBundlerClient } from "./npm/vfs-bundler-client.js";

export interface EsbuildRunInput {
  /** The generated project files only (small).  The runner installs
   *  `rootDeps` into its own copy — node_modules never crosses the
   *  worker boundary. */
  generatedFiles: Map<string, string | Uint8Array>;
  rootDeps: Record<string, string>;
  /** Bundle a synthesised entry (Hono path: makeEntryStdin output). */
  stdinContents?: string;
  /** Bundle a real file entry by absolute VFS path (React path). */
  entry?: string;
  /** React build: keep react/react-dom external so the iframe
   *  importmap supplies a single instance — mirrors the esm.sh
   *  path's externalisation and avoids the dual-React/"Invalid hook
   *  call" failure that bundling React per-frontend would cause. */
  externalReactRuntime?: boolean;
}

export type EsbuildRun = (
  input: EsbuildRunInput,
) => Promise<
  | { ok: true; code: string; css?: string; versions: Record<string, string> }
  | { ok: false; message: string }
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
  private lastBoot:
    | { bundleCode: string; dataDir?: string; persistent: boolean }
    | null = null;

  constructor(
    opts: RuntimeEngineOptions & { esbuildRun?: EsbuildRun } = {},
  ) {
    this.onLost = opts.onLost;
    this.injectedRun = opts.esbuildRun;
  }

  /** Injected runner (spikes / tests) wins; otherwise the in-browser
   *  esbuild-wasm worker, created lazily so non-browser callers that
   *  inject never construct a Worker.  The worker now owns install
   *  + the IDB cache, so node_modules never crosses the boundary. */
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
    const generatedFiles = new Map<string, string | Uint8Array>();
    for (const f of input.files) generatedFiles.set("/" + f.path, f.content);

    // System-mode emits a package.json per deployable: the Hono
    // backend's has hono/drizzle/zod, the React frontend's has
    // react/react-dom/mantine/etc.  Install the UNION so BOTH builds
    // resolve (harvesting only the Hono one left the React bundle
    // unable to find react — caught by the #2 parity spike).
    const rootDeps = {
      ...harvestRootDeps(generatedFiles, input.honoEntry),
      ...(input.reactEntry
        ? harvestRootDeps(generatedFiles, input.reactEntry)
        : {}),
    };
    const run = this.esbuildRun();

    const honoRun = await run({
      generatedFiles,
      rootDeps,
      stdinContents: makeEntryStdin(
        input.honoEntry,
        schemaPathFor(input.honoEntry),
      ),
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
          versions: honoRun.versions,
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
        generatedFiles,
        rootDeps,
        entry: "/" + input.reactEntry,
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
            versions: r.versions,
            diagnostics: [],
          }
        : { ok: false, diagnostics: [{ severity: "error", message: r.message }] };
    }
    return { hono, react };
  }

  // boot/dispatch/wipe/reset/respawn delegate to the shared
  // PGlite+Hono runtime client, identical to EsbuildPgliteEngine.
  async boot(bundleCode: string, dataDir?: string): Promise<BootResult> {
    const res = await this.rt().boot({ bundleCode, dataDir });
    if (res.ok) this.lastBoot = { bundleCode, dataDir, persistent: res.persistent };
    return res;
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
  // Same tab-suspension recovery as EsbuildPgliteEngine: re-boot the
  // retained bundle into a fresh worker; OPFS data reattaches.
  async snapshot(): Promise<EngineSnapshot | null> {
    return this.lastBoot?.persistent
      ? { engineId: this.capabilities.id, version: 1, blob: this.lastBoot }
      : null;
  }
  async restore(snap: EngineSnapshot): Promise<boolean> {
    if (snap.engineId !== this.capabilities.id || snap.version !== 1) {
      return false;
    }
    const blob = snap.blob as { bundleCode: string; dataDir?: string } | null;
    if (!blob?.bundleCode) return false;
    this.rt().respawn(true);
    const res = await this.boot(blob.bundleCode, blob.dataDir);
    return res.ok;
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
