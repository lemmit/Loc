// ---------------------------------------------------------------------------
// RuntimeEngine — the swappable seam between "the generator produced
// files" and "a running preview answering requests".
//
// Today `NpmInstallBundleEngine` (real npm tarballs in-browser →
// esbuild-wasm VFS bundle → LoomRuntimeClient PGlite + Hono blob-
// import → sandbox preview bridge) is the one implementation.  This
// interface names the seam so that:
//
//   - A future FOSS-runtime engine (nodepod / WebContainer / …) is a
//     second implementation behind the SAME interface — adopted only
//     if it wins at e2e parity, never a rewrite.
//   - Tab-suspension recovery goes through `snapshot()` / `restore()`
//     rather than the lossy `respawn` path.
//
// `generate` (Langium → IR → files) stays OUTSIDE the engine: it is
// the Loom compiler and is engine-independent.  An engine consumes
// the generated `VirtualFile[]` plus a `DependencySet`.
// ---------------------------------------------------------------------------

import type { VirtualFile } from "../build/protocol.js";
import type { BundleResult } from "../bundle/protocol.js";
import type {
  BootResult,
  DispatchResult,
  QueryResult,
  SerializedRequest,
  WipeResult,
} from "../runtime/protocol.js";
import type { DependencySet, RegistryResolver } from "./dependencies.js";
import type { LogLine } from "../util/log-line.js";

/** Static description of what an engine can do.  Lets the UI and the
 *  dependency layer adapt (e.g. relax the package allow-policy when
 *  `npmInstall` is true) without branching on engine id. */
export interface EngineCapabilities {
  /** Stable identifier, e.g. `"npm-install-bundle"` / `"nodepod"`. */
  readonly id: string;
  /** True for a real in-VM Node (npm scripts, dev server) rather
   *  than the bundle-and-run simulation. */
  readonly realNode: boolean;
  /** True when the engine performs a real `npm install` (vs. CDN
   *  module resolution). */
  readonly npmInstall: boolean;
  readonly database: "pglite" | "none";
  /** How much of the custom-package long tail the engine handles:
   *  `"common"` = a CDN-resolver subset; `"full"` = real install. */
  readonly customPackages: "none" | "common" | "full";
}

export interface PrepareInput {
  /** Files emitted by the Loom generator (engine-independent). */
  files: VirtualFile[];
  /** Packages the prepared build may import (P6 populates this;
   *  P0/P1 pass an empty set). */
  dependencies: DependencySet;
  /** Backend (Hono) entry path.  Required — callers analyse the
   *  generated tree and only invoke `prepare` once a bundlable
   *  backend exists; the "nothing to bundle" wording stays in the
   *  caller because it needs the unsupported-deployable list. */
  honoEntry: string;
  /** React deployable entry, when the system emits a frontend. */
  reactEntry?: string;
  /** Opt-in: bundle the Hono backend with an inline Source Map v3 that
   *  chains back to `.ddd` (via the `.ts.map` sidecars `files` carries
   *  when its generate step ran with `sourcemap: true`), so the
   *  browser's DevTools can breakpoint the running backend in `.ddd`.
   *  Off by default — undefined/false keeps the bundle byte-identical
   *  to today's output.  Backend-only (frontend `.ddd`→ debugging is
   *  out of scope; see `docs/debugging.md`). */
  sourcemap?: boolean;
}

/** What `prepare` yields — the same per-kind bundle pair the pipeline
 *  state stores and the preview consumes today.  Keeping this as the
 *  protocol `BundleResult` (carrying `code`/`css`/`versions`) is what
 *  makes P1 lossless. */
export interface PreparedBuild {
  hono: BundleResult;
  react: BundleResult | null;
}

/** Minimal surface the preview's SW bridge needs.  `Preview.tsx`
 *  depends on this, not the whole engine, so the bridge is engine-
 *  agnostic. */
export interface RuntimeDispatcher {
  dispatch(req: SerializedRequest): Promise<DispatchResult>;
}

/** Opaque, structured-clone-serialisable engine state for the
 *  tab-suspension fix (P4).  Written atomically to IndexedDB on
 *  `freeze`/`pagehide`, replayed on resume instead of cold-booting. */
export interface EngineSnapshot {
  readonly engineId: string;
  readonly version: number;
  readonly blob: unknown;
}

export interface RuntimeEngineOptions {
  /** Fired when the engine had to discard unrecoverable state
   *  (e.g. the browser killed a backgrounded worker holding the
   *  PGlite DB).  The app flips the pipeline back to "needs Boot".
   *  Mirrors today's `LoomRuntimeClient.onRespawn`. */
  onLost?: () => void;
  /** Optional private-package resolver.  Engines without
   *  private-package support ignore it and reject `custom-private`
   *  specs with a clear diagnostic. */
  registryResolver?: RegistryResolver;
  /** Fired with `console.*` / stack lines captured in the backend
   *  runtime while serving a boot / dispatch — drives the "Backend"
   *  log stream in the Output panel.  Engines without a hosted backend
   *  ignore it. */
  onLog?: (lines: LogLine[]) => void;
}

export interface RuntimeEngine extends RuntimeDispatcher {
  readonly capabilities: EngineCapabilities;

  /** Bundle/install the generated project + its dependencies.
   *  Pure w.r.t. the engine's running state. */
  prepare(input: PrepareInput): Promise<PreparedBuild>;

  /** Bring the backend up from prepared bundle code.  `dataDir`
   *  follows the existing PGlite convention (`:memory:` /
   *  `opfs-ahp://…`); engines without a DB ignore it.  `opts.fresh`
   *  drops the persistent DB's stored data before applying schema —
   *  the recovery path for a boot that keeps failing on stale data. */
  boot(
    bundleCode: string,
    dataDir?: string,
    opts?: { fresh?: boolean },
  ): Promise<BootResult>;

  /** Serve one backend HTTP request against the booted instance. */
  dispatch(req: SerializedRequest): Promise<DispatchResult>;

  /** Run one SQL statement against the booted database (Database
   *  console).  Engines without a DB reject with a clear message. */
  query(sql: string): Promise<QueryResult>;

  /** Drop user data, re-apply idempotent schema. */
  wipe(): Promise<WipeResult>;

  /** Clear any booted state without tearing the engine down — used
   *  when the edited source changes (new example).  Mirrors
   *  `LoomRuntimeClient.reset`. */
  reset(): Promise<{ ok: true }>;

  /** Discard and recreate the runtime after the browser killed a
   *  backgrounded worker.  Fires `onLost`.  P4 supersedes the
   *  state loss here with snapshot/restore; the operation itself
   *  (a real-Node engine has an equivalent) stays. */
  respawn(): void;

  /** Capture restorable state for tab-suspension persistence.
   *  P1 stub returns null (nothing to restore yet). */
  snapshot(): Promise<EngineSnapshot | null>;

  /** Rehydrate from a prior `snapshot`.  Resolves false when the
   *  snapshot is incompatible so the caller falls back to a cold
   *  boot.  P1 stub returns false. */
  restore(snap: EngineSnapshot): Promise<boolean>;

  /** Tear down workers/handles.  The engine is unusable afterwards. */
  dispose(): void;
}

export type RuntimeEngineFactory = (
  opts?: RuntimeEngineOptions,
) => RuntimeEngine;

/** Frontend assets the preview renders.  Not part of the engine
 *  interface — `Preview.tsx` pulls these off `PreparedBuild.react`
 *  and feeds them to `makePreviewHtml`. */
export interface PreviewMaterial {
  js: string;
  css?: string;
  versions?: Record<string, string>;
  /** C2: when the bundle externalised a prebuilt design-pack vendor,
   *  the iframe importmap (bare spec → origin-absolute url) and the
   *  optional vendor.css url.  Absent → self-contained bundle. */
  vendorImportmap?: Record<string, string>;
  vendorCssUrl?: string;
}
