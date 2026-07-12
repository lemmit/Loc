// ---------------------------------------------------------------------------
// NpmInstallBundleEngine — the npm-in-browser RuntimeEngine.
//
//   install (real tarballs) → makeVfsNpmPlugin esbuild-wasm bundle
//   (real node_modules, no CDN) → boot/dispatch on the PGlite+Hono
//   runtime client.
//
// The esbuild invocation is injected (`EsbuildRun`): in the browser
// it's the esbuild-wasm worker (which also owns install + the IDB
// cache); tests/spikes inject a node-esbuild runner.
// ---------------------------------------------------------------------------

import { LoomRuntimeClient } from "../runtime/client.js";
import type {
  BootResult,
  DispatchResult,
  QueryResult,
  SerializedRequest,
  WipeResult,
} from "../runtime/protocol.js";
import type { LogLine } from "../util/log-line.js";
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
   *  importmap supplies a single instance — avoids the dual-React /
   *  "Invalid hook call" failure that bundling React per-frontend
   *  would cause. */
  externalReactRuntime?: boolean;
  /** Opt-in: emit an inline Source Map v3 for this bundle (see
   *  `PrepareInput.sourcemap`).  Off by default; only meaningful on
   *  the Hono run (the React bundle never sets this — frontend `.ddd`
   *  debugging is a separate, out-of-scope slice). */
  sourcemap?: boolean;
}

export type EsbuildRun = (
  input: EsbuildRunInput,
) => Promise<
  | {
      ok: true;
      code: string;
      css?: string;
      versions: Record<string, string>;
      /** C2: present when the runner externalised a prebuilt
       *  design-pack vendor — the iframe importmap + optional
       *  vendor.css url to forward to the preview. */
      vendorImportmap?: Record<string, string>;
      vendorCssUrl?: string;
    }
  | { ok: false; message: string }
>;


/** Nearest package.json to the entry → its `dependencies`, plus the
 *  runtime-layer PGlite pin (the bundle entry imports it even though
 *  the generated package.json doesn't). */
/** Dependencies declared in the nearest package.json to `entry`.
 *  Each deployable has its own (backend: hono/drizzle/zod; frontend:
 *  react/mantine/…), so the caller harvests per-bundle to install
 *  only what that bundle imports — not the union. */
function harvestDeps(
  files: Map<string, string | Uint8Array>,
  entry: string,
): Record<string, string> {
  const td = new TextDecoder();
  const parts = entry.split("/");
  for (let i = parts.length; i > 0; i--) {
    const p = "/" + [...parts.slice(0, i - 1), "package.json"].join("/");
    const raw = files.get(p);
    if (raw == null) continue;
    try {
      const pkg = JSON.parse(typeof raw === "string" ? raw : td.decode(raw));
      return { ...(pkg.dependencies ?? {}) };
    } catch {
      /* keep walking up */
    }
  }
  return {};
}

export class NpmInstallBundleEngine implements RuntimeEngine {
  readonly capabilities: EngineCapabilities = {
    id: "npm-install-bundle",
    realNode: false,
    npmInstall: true,
    database: "pglite",
    // Real node_modules → the whole public-package long tail works,
    // not just the common-package subset a CDN resolver would cover.
    customPackages: "full",
  };

  private runtime: LoomRuntimeClient | null = null;
  private readonly onLost?: () => void;
  private readonly onLog?: (lines: LogLine[]) => void;
  private readonly injectedRun?: EsbuildRun;
  private vfsBundler: VfsBundlerClient | null = null;
  private lastBoot:
    | { bundleCode: string; dataDir?: string; persistent: boolean }
    | null = null;

  constructor(
    opts: RuntimeEngineOptions & { esbuildRun?: EsbuildRun } = {},
  ) {
    this.onLost = opts.onLost;
    this.onLog = opts.onLog;
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
    return (this.runtime ??= new LoomRuntimeClient({
      onRespawn: this.onLost,
      onLog: this.onLog,
    }));
  }

  async prepare(input: PrepareInput): Promise<PreparedBuild> {
    const generatedFiles = new Map<string, string | Uint8Array>();
    for (const f of input.files) generatedFiles.set("/" + f.path, f.content);

    // Scope the install per bundle: the Hono backend gets its own
    // deps + the runtime PGlite pin (the entry imports it though the
    // package.json doesn't); the React frontend gets its own deps.
    // Installing only what each bundle imports avoids pulling the
    // whole Mantine tree into the backend install (and vice-versa).
    const honoDeps = {
      ...harvestDeps(generatedFiles, input.honoEntry),
      "@electric-sql/pglite": RUNTIME_VERSIONS["@electric-sql/pglite"],
    };
    const run = this.esbuildRun();

    const honoRun = await run({
      generatedFiles,
      rootDeps: honoDeps,
      stdinContents: makeEntryStdin(
        input.honoEntry,
        schemaPathFor(input.honoEntry),
      ),
      // Backend-only: the React run below never sets this.
      sourcemap: input.sourcemap,
    });
    // Apply the npm-pglite postprocess HERE — the runtime worker
    // boots `hono.code` verbatim, so nothing else would.  Failure →
    // a bundle diagnostic, not a thrown rejection that skips
    // BUNDLE_DONE.
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
      // C2: the worker externalises the prebuilt design-pack vendor
      // when one is shipped (app-only bundle + iframe importmap), and
      // otherwise bundles the frontend self-contained (react from the
      // single deduped node_modules — one instance, no importmap).
      // Either way the engine forwards the worker's vendorImportmap /
      // vendorCssUrl (set only on the externalised path) onto the
      // react BundleResult for the preview.
      const r = await run({
        generatedFiles,
        rootDeps: harvestDeps(generatedFiles, input.reactEntry),
        entry: "/" + input.reactEntry,
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
            vendorImportmap: r.vendorImportmap,
            vendorCssUrl: r.vendorCssUrl,
            diagnostics: [],
          }
        : { ok: false, diagnostics: [{ severity: "error", message: r.message }] };
    }
    return { hono, react };
  }

  // boot/dispatch/wipe/reset/respawn delegate to the shared
  // PGlite+Hono runtime client.
  async boot(
    bundleCode: string,
    dataDir?: string,
    opts?: { fresh?: boolean },
  ): Promise<BootResult> {
    const res = await this.rt().boot({ bundleCode, dataDir, fresh: opts?.fresh });
    if (res.ok) this.lastBoot = { bundleCode, dataDir, persistent: res.persistent };
    return res;
  }
  dispatch(req: SerializedRequest): Promise<DispatchResult> {
    return this.rt().dispatch(req);
  }
  query(sql: string): Promise<QueryResult> {
    return this.rt().query(sql);
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
  // Tab-suspension recovery: re-boot the retained bundle into a fresh
  // worker; OPFS data reattaches.
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
