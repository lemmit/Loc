/// <reference lib="webworker" />
// esbuild-wasm worker for the npm-in-browser engine (Phase B4).
//
// Fills NpmInstallBundleEngine's `EsbuildRun` seam in the browser:
// runs esbuild-wasm with makeVfsNpmPlugin over the install-populated
// VFS (no esm.sh).  The build options + plugin are byte-identical to
// what the B3b/B4 node spikes verified — only the host (esbuild-wasm
// in a Worker vs. node esbuild) differs.
//
// Init mirrors bundler.worker.ts exactly (pre-fetch + compile the
// wasm ourselves to dodge CDN content-encoding / streaming-API
// pitfalls), so behaviour matches the proven esm.sh worker.

import * as esbuild from "esbuild-wasm";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";
import { makeVfsNpmPlugin } from "./esbuild-vfs-plugin.js";
import { harvestTsconfigPaths } from "../../bundle/plugin.js";
import { install } from "./install.js";
import { IdbInstallCache } from "./install-cache-idb.js";

declare const self: DedicatedWorkerGlobalScope;

export interface VfsBundleRequest {
  id: number;
  stdinContents?: string;
  entry?: string;
  /** Generated project files only — the worker installs rootDeps
   *  into its own copy, so node_modules never crosses postMessage. */
  generatedFiles: Map<string, string | Uint8Array>;
  rootDeps: Record<string, string>;
  externalReactRuntime?: boolean;
}

export interface VfsBundleResponse {
  id: number;
  ok: boolean;
  code?: string;
  css?: string;
  versions?: Record<string, string>;
  /** C0 perf instrumentation — install vs esbuild-wasm bundle split. */
  installMs?: number;
  bundleMs?: number;
  message?: string;
}

// IDB-backed install cache, worker-scoped (IndexedDB is available in
// DedicatedWorkerGlobalScope).  Opened once; memory-only no-op when
// IDB is unavailable.  This is why a dep set installs once and
// replays across prepares/reloads.
let cachePromise: Promise<IdbInstallCache> | null = null;
function getCache(): Promise<IdbInstallCache> {
  if (!cachePromise) {
    cachePromise = (async () => {
      const c = new IdbInstallCache();
      await c.open();
      return c;
    })();
  }
  return cachePromise;
}

let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const res = await fetch(wasmURL);
      if (!res.ok) {
        throw new Error(
          `vfs-bundler.worker: failed to fetch esbuild wasm (${res.status} ${res.statusText})`,
        );
      }
      const wasmModule = await WebAssembly.compile(await res.arrayBuffer());
      await esbuild.initialize({ wasmModule, worker: false });
    })();
  }
  return initPromise;
}

self.onmessage = async (ev: MessageEvent<VfsBundleRequest>): Promise<void> => {
  const { id, stdinContents, entry, generatedFiles, rootDeps, externalReactRuntime } =
    ev.data;
  try {
    await ensureInit();
    // Install in the worker, into our own copy of the generated
    // tree — off the main thread, and node_modules stays here.
    const files = new Map(generatedFiles);
    const tInstall = performance.now();
    const { versions, fileCount } = await install(
      rootDeps,
      (p, d) => files.set(p, d),
      { cache: await getCache() },
    );
    const installMs = Math.round(performance.now() - tInstall);
    const versionRec = Object.fromEntries(versions);
    const common = {
      bundle: true,
      format: "esm" as const,
      platform: "browser" as const,
      target: "es2022",
      logLevel: "silent" as const,
      write: false as const,
      sourcemap: false as const,
      // outdir gives JS-imported CSS (Mantine `*.css`) an output
      // path so esbuild bundles it into a sibling .css output file
      // instead of erroring "without an output path configured".
      // write:false → it comes back in outputFiles, collected below.
      outdir: "/" as const,
      loader: { ".wasm": "binary" as const },
      plugins: [
        makeVfsNpmPlugin(
          files,
          "/node_modules",
          !!externalReactRuntime,
          // tsconfig `@/*` aliases (shadcn etc.); harvested from the
          // entry's nearest tsconfig.  Backend (stdin) builds have no
          // entry path and don't use these aliases.
          entry
            ? harvestTsconfigPaths(files as unknown as Map<string, string>, entry)
            : [],
        ),
      ],
    };
    const tBundle = performance.now();
    const out = await esbuild.build(
      stdinContents
        ? {
            ...common,
            stdin: {
              contents: stdinContents,
              resolveDir: "/",
              sourcefile: "__entry__.ts",
              loader: "ts",
            },
          }
        : { ...common, entryPoints: [entry as string] },
    );
    const bundleMs = Math.round(performance.now() - tBundle);
    // C0 — perf instrumentation: the install-vs-bundle split decides
    // whether the npm-default perf work targets install latency (C1)
    // or esbuild-wasm bundling (C2).  `kind` distinguishes the small
    // Hono backend bundle from the heavy React/Mantine frontend one.
    const kind = stdinContents ? "hono" : "react";
    // eslint-disable-next-line no-console
    console.info(
      `[npm-engine] ${kind}: install=${installMs}ms bundle=${bundleMs}ms ` +
        `(${versions.size} pkgs, ${fileCount} files installed)`,
    );
    const js = out.outputFiles.find((f) => f.path.endsWith(".js"));
    const css = out.outputFiles.find((f) => f.path.endsWith(".css"));
    const resp: VfsBundleResponse = {
      id,
      ok: true,
      code: js?.text ?? out.outputFiles[0]?.text ?? "",
      css: css?.text,
      versions: versionRec,
      installMs,
      bundleMs,
    };
    self.postMessage(resp);
  } catch (err) {
    const message =
      (err as { errors?: Array<{ text: string }> }).errors?.[0]?.text ??
      (err instanceof Error ? err.message : String(err));
    self.postMessage({ id, ok: false, message } satisfies VfsBundleResponse);
  }
};
