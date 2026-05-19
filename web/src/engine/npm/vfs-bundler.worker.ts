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

declare const self: DedicatedWorkerGlobalScope;

export interface VfsBundleRequest {
  id: number;
  stdinContents?: string;
  entry?: string;
  files: Map<string, string | Uint8Array>;
}
export interface VfsBundleResponse {
  id: number;
  ok: boolean;
  code?: string;
  css?: string;
  message?: string;
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
  const { id, stdinContents, entry, files } = ev.data;
  try {
    await ensureInit();
    const common = {
      bundle: true,
      format: "esm" as const,
      platform: "browser" as const,
      target: "es2022",
      logLevel: "silent" as const,
      write: false as const,
      sourcemap: false as const,
      loader: { ".wasm": "binary" as const },
      plugins: [makeVfsNpmPlugin(files)],
    };
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
    const js = out.outputFiles.find((f) => f.path.endsWith(".js"));
    const css = out.outputFiles.find((f) => f.path.endsWith(".css"));
    const resp: VfsBundleResponse = {
      id,
      ok: true,
      code: js?.text ?? out.outputFiles[0]?.text ?? "",
      css: css?.text,
    };
    self.postMessage(resp);
  } catch (err) {
    const message =
      (err as { errors?: Array<{ text: string }> }).errors?.[0]?.text ??
      (err instanceof Error ? err.message : String(err));
    self.postMessage({ id, ok: false, message } satisfies VfsBundleResponse);
  }
};
