import type { VirtualFile } from "../build/protocol.js";

// Bundler-worker protocol.  The bundler is the third worker in the
// playground: it takes the generator's virtual file map, runs
// esbuild-wasm with our virtual-fs / alias / http resolvers, and
// returns a single self-contained ESM module string ready for the
// runtime worker (hono kind) or the iframe host (react kind) to
// dynamic-import.

export type BundleKind = "hono" | "react";

export interface BundleRequest {
  kind: BundleKind;
  /** Files emitted by the generator (Map<path, content> flattened). */
  files: VirtualFile[];
  /** Path of the deployable's entry file — for hono this is
   *  `http/index.ts` or `<slug>/http/index.ts`; for react it's
   *  `<slug>/src/main.tsx`. */
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
  kind: BundleKind;
  /** Self-contained ESM module source. */
  code: string;
  /** Combined CSS produced by esbuild's CSS bundling — only set
   *  for the react kind, which imports Mantine stylesheets. */
  css?: string;
  /** Bytes written (JS only). */
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
