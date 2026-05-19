// ---------------------------------------------------------------------------
// RuntimeEngine — the swappable seam between "the generator produced
// files" and "a running preview answering requests".
//
// Today the playground hard-wires: LoomBundleClient (esbuild-wasm) →
// LoomRuntimeClient (PGlite + Hono blob-import) → SW preview bridge.
// That whole chain is ONE engine.  This interface names it so that:
//
//   - P1 wraps the existing chain as `EsbuildPgliteEngine`, behaviour
//     identical, with the pipeline reducer calling the engine instead
//     of the workers directly.
//   - A future FOSS-runtime engine (nodepod / WebContainer / …) is a
//     second implementation behind the SAME interface — adopted only
//     if it wins at e2e parity, never a rewrite.
//   - The tab-suspension fix (P4) is `snapshot()` / `restore()` on the
//     engine + Vfs, orchestrated at the app level.
//
// `generate` (Langium → IR → files) stays OUTSIDE the engine: it is
// the Loom compiler and is engine-independent.  An engine consumes
// the generated `VirtualFile[]` plus a `DependencySet`.
//
// Return types reuse the existing worker protocols so P1's wrapper is
// thin and lossless.
// ---------------------------------------------------------------------------

import type { VirtualFile } from "../build/protocol.js";
import type {
  BootResult,
  DispatchResult,
  SerializedRequest,
  WipeResult,
} from "../runtime/protocol.js";
import type { BundleDiagnostic } from "../bundle/protocol.js";
import type { DependencySet, RegistryResolver } from "./dependencies.js";

/** Static description of what an engine can do.  Lets the UI and the
 *  dependency layer adapt (e.g. disable `custom-private` when there's
 *  no resolver, or relax the package allow-policy when `npmInstall`
 *  is true) without branching on engine id. */
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
  /** React deployable entry, when the system emits a frontend. */
  reactEntry?: string;
  /** Backend (Hono) entry, when the system emits a server. */
  honoEntry?: string;
}

/** Material the `PreviewHost` needs to render the frontend.  Mirrors
 *  the existing SW `PreviewBundle` shape so P1/P2 map 1:1. */
export interface PreviewMaterial {
  js: string;
  css?: string;
  /** Pkg → resolved version, forwarded to the iframe importmap so
   *  the preview and the bundle agree on singleton instances. */
  versions?: Record<string, string>;
}

export type PrepareResult =
  | {
      ok: true;
      /** Opaque, engine-owned handle passed back into `boot`.  For
       *  the esbuild engine this carries the bundled Hono module;
       *  for a real-Node engine it's the populated workspace ref. */
      prepared: unknown;
      /** null when the system has no frontend deployable. */
      preview: PreviewMaterial | null;
      diagnostics: BundleDiagnostic[];
    }
  | { ok: false; diagnostics: BundleDiagnostic[] };

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

export interface RuntimeEngine {
  readonly capabilities: EngineCapabilities;

  /** Bundle/install the generated project + its dependencies.
   *  Pure w.r.t. the engine's running state — produces the handle
   *  `boot` consumes. */
  prepare(input: PrepareInput): Promise<PrepareResult>;

  /** Bring the backend up from a `prepare` handle.  `dataDir`
   *  follows the existing PGlite convention (`:memory:` /
   *  `opfs-ahp://…`); engines without a DB ignore it. */
  boot(prepared: unknown, dataDir?: string): Promise<BootResult>;

  /** Serve one backend HTTP request against the booted instance. */
  dispatch(req: SerializedRequest): Promise<DispatchResult>;

  /** Drop user data, re-apply idempotent schema. */
  wipe(): Promise<WipeResult>;

  /** Capture restorable state for tab-suspension persistence.
   *  Returns null when the engine has nothing bootworthy yet. */
  snapshot(): Promise<EngineSnapshot | null>;

  /** Rehydrate from a prior `snapshot`.  Resolves false when the
   *  snapshot is incompatible (version/engine mismatch) so the
   *  caller falls back to a cold boot. */
  restore(snap: EngineSnapshot): Promise<boolean>;

  /** Tear down workers/handles.  The engine is unusable afterwards. */
  dispose(): void;
}

export type RuntimeEngineFactory = (
  opts?: RuntimeEngineOptions,
) => RuntimeEngine;
