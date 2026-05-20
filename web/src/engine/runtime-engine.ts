// ---------------------------------------------------------------------------
// RuntimeEngine — the swappable seam between "the generator produced
// files" and "a running preview answering requests".
//
// Today the playground hard-wires: LoomBundleClient (esbuild-wasm) →
// LoomRuntimeClient (PGlite + Hono blob-import) → SW preview bridge.
// That whole chain is ONE engine.  This interface names it so that:
//
//   - P1 wraps the existing chain as `EsbuildPgliteEngine`, behaviour
//     identical, with App holding an engine instead of the two raw
//     worker clients.
//   - A future FOSS-runtime engine (nodepod / WebContainer / …) is a
//     second implementation behind the SAME interface — adopted only
//     if it wins at e2e parity, never a rewrite.
//   - The tab-suspension fix (P4) replaces the lossy `respawn` path
//     with `snapshot()` / `restore()` (P1 ships them as stubs).
//
// `generate` (Langium → IR → files) stays OUTSIDE the engine: it is
// the Loom compiler and is engine-independent.  An engine consumes
// the generated `VirtualFile[]` plus a `DependencySet`.
//
// Return types deliberately reuse the existing worker protocols so
// the P1 wrapper is thin and lossless and the pipeline reducer /
// preview consume exactly what they consume today.
// ---------------------------------------------------------------------------

import type { VirtualFile } from "../build/protocol.js";
import type { BundleResult } from "../bundle/protocol.js";
import type {
  BootResult,
  DispatchResult,
  SerializedRequest,
  WipeResult,
} from "../runtime/protocol.js";
import type { DependencySet, RegistryResolver } from "./dependencies.js";

/** Static description of what an engine can do.  Lets the UI and the
 *  dependency layer adapt (e.g. relax the package allow-policy when
 *  `npmInstall` is true) without branching on engine id. */
export interface EngineCapabilities {
  /** Stable identifier, e.g. `"esbuild-pglite"` / `"nodepod"`. */
  readonly id: string;
  /** True for a real in-VM Node (npm scripts, dev server) rather
   *  than the bundle-and-run simulation. */
  readonly realNode: boolean;
  /** True when the engine performs a real `npm install` (vs. CDN
   *  module resolution). */
  readonly npmInstall: boolean;
  readonly database: "pglite" | "none";
  /** How much of the custom-package long tail the engine handles:
   *  `"common"` = the esm.sh 80%; `"full"` = real install. */
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
}

export interface RuntimeEngine extends RuntimeDispatcher {
  readonly capabilities: EngineCapabilities;

  /** Bundle/install the generated project + its dependencies.
   *  Pure w.r.t. the engine's running state. */
  prepare(input: PrepareInput): Promise<PreparedBuild>;

  /** Bring the backend up from prepared bundle code.  `dataDir`
   *  follows the existing PGlite convention (`:memory:` /
   *  `opfs-ahp://…`); engines without a DB ignore it. */
  boot(bundleCode: string, dataDir?: string): Promise<BootResult>;

  /** Serve one backend HTTP request against the booted instance. */
  dispatch(req: SerializedRequest): Promise<DispatchResult>;

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
}
