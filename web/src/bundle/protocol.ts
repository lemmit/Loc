import type { VirtualFile } from "../build/protocol.js";

// Bundler-worker protocol.  The bundler is the third worker in the
// playground: it takes the generator's virtual file map, runs
// esbuild-wasm with our virtual-fs / alias / http resolvers, and
// returns a single self-contained ESM module string ready for the
// runtime worker to dynamic-import.

export interface BundleRequest {
  /** Files emitted by the generator (Map<path, content> flattened). */
  files: VirtualFile[];
  /** Path of the file that re-exports `createApp` — relative to the
   *  generator's virtual root, e.g. "http/index.ts" for legacy
   *  output, or "<slug>/http/index.ts" for a system deployable. */
  entryPath: string;
}

export interface BundleDiagnostic {
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface BundleOk {
  ok: true;
  /** Self-contained ESM module source. */
  code: string;
  /** Bytes written. */
  size: number;
  /** Wall-clock time the worker spent in `build()`. */
  durationMs: number;
  /** Distinct external URLs the http resolver fetched (for stats). */
  fetchedUrls: string[];
  diagnostics: BundleDiagnostic[];
}

export interface BundleFail {
  ok: false;
  diagnostics: BundleDiagnostic[];
}

export type BundleResult = BundleOk | BundleFail;

export interface BundleRpcRequest {
  id: number;
  method: "bundle";
  params: BundleRequest;
}

export interface BundleRpcResponse {
  id: number;
  result?: BundleResult;
  error?: { message: string };
}
