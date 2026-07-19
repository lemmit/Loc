// Build-worker protocol — request/response shapes for kicking off a
// generate run from the main thread.  Kept separate from the LSP
// worker so editor latency doesn't compete with potentially heavier
// generator + (later) bundler work.
//
// Phase 2 of the IDE refactor: the protocol grows VFS mutate methods
// (`vfs.write` / `vfs.delete`) so the
// main thread can stream files into the worker-local VFS introduced
// in Phase 1.  `generate` gains an `entryPath` variant that reads
// source from the VFS instead of taking it as an inline argument;
// the legacy `text` form stays callable for back-compat.

export interface BuildDiagnostic {
  severity: "error" | "warning";
  message: string;
  line?: number;
  column?: number;
  source?: string;
}

export interface VirtualFile {
  path: string;
  content: string;
  size: number;
}

export type GenerateMode = "system" | "ts" | "none";

export interface GenerateOk {
  ok: true;
  mode: GenerateMode;
  files: VirtualFile[];
  diagnostics: BuildDiagnostic[];
}

export interface GenerateFail {
  ok: false;
  diagnostics: BuildDiagnostic[];
}

export type GenerateResult = GenerateOk | GenerateFail;

/** Result of a provenance-snapshot capture (the playground's equivalent
 *  of the CLI `ddd snapshot` prebuild step).  `files` are immutable
 *  timestamped+GUID `.loom/snapshots/*.loomsnap.json` entries; empty when
 *  the source declares no written `provenanced` field. */
export interface SnapshotOk {
  ok: true;
  files: VirtualFile[];
  diagnostics: BuildDiagnostic[];
}

export interface SnapshotFail {
  ok: false;
  diagnostics: BuildDiagnostic[];
}

export type SnapshotResult = SnapshotOk | SnapshotFail;

// -- evolution diff --------------------------------------------------------
// The playground regenerates statelessly, so schema migrations, wire-
// contract drift, and provenance all lose their "previous version" and
// become invisible side effects.  `evolution` restores the baseline: it
// lowers TWO sources (a pinned git baseline + the live edit), derives the
// migration the change implies (`buildMigrations` over a `memorySnapshot-
// Store` seeded from the baseline), and classifies the wire-contract delta
// (`diffWireSpec`) — the same pure cores the CLI runs, wrapped as plain
// serialisable DTOs so nothing compiler-internal crosses the worker edge.

/** One derived schema-migration a source change implies, per owning
 *  module.  `steps` are rendered to Postgres DDL for display (the exact
 *  SQL the TS/EF migration emitters share).  `destructive` is true when
 *  the non-destructive gate tripped — a drop/narrowing the operator must
 *  acknowledge; the steps are still shown (re-derived with the gate off)
 *  alongside `destructiveMessage`. */
export interface MigrationView {
  module: string;
  /** `"Initial"` when the baseline is empty, else the derived PascalCase
   *  name (`"AddOrderStatus"`). */
  name: string;
  version: string;
  steps: { op: string; sql: string }[];
  destructive: boolean;
  destructiveMessage?: string;
}

/** One wire-contract change, classified breaking vs additive by
 *  `diffWireSpec`. */
export interface WireChangeView {
  /** Bucket + entity, e.g. `aggregate Order` / `valueObject Money`. */
  entity: string;
  field?: string;
  kind: string;
  breaking: boolean;
  detail: string;
}

export interface EvolutionOk {
  ok: true;
  /** False when the baseline parses to no system (first commit / brand-new
   *  source) — the current source is then the initial version, and every
   *  migration reads `"Initial"`. */
  hasBaseline: boolean;
  migrations: MigrationView[];
  wireChanges: WireChangeView[];
  /** Any breaking wire change OR any destructive migration. */
  breaking: boolean;
  diagnostics: BuildDiagnostic[];
}

export interface EvolutionFail {
  ok: false;
  diagnostics: BuildDiagnostic[];
}

export type EvolutionResult = EvolutionOk | EvolutionFail;

/** One side of an evolution diff — a whole `.ddd` source tree plus the
 *  entry file to load it from.  The worker seeds `files` into its VFS
 *  under an isolated prefix and walks transitive `import`s from
 *  `entryPath` through `loadProjectFromVfs`, so multi-file / import
 *  projects resolve exactly as `ddd generate system` would.  A
 *  single-file source is just the one-entry case. */
export interface EvolutionTree {
  /** Absolute VFS path of the entry file within `files`, e.g.
   *  `/workspace/main.ddd`. */
  entryPath: string;
  /** The project's `.ddd` sources (and any empty dirs).  Relative
   *  `import "./x.ddd"` statements resolve against these. */
  files: VfsEntry[];
}

/** `evolution` lowers two whole source TREES and diffs the derived
 *  artifacts.  Both the pinned baseline (read from a git ref) and the
 *  live edit are seeded into the worker VFS and lowered through the
 *  project loader, so multi-file / import baselines resolve (M-T8.11).
 *  `baseline` is `null` when there's no prior version (empty repo /
 *  first commit) — every shape then reads as "Initial". */
export interface EvolutionParams {
  baseline: EvolutionTree | null;
  current: EvolutionTree;
}

/** A single VFS entry shipped over the wire — file entries carry
 *  `content`, directory entries carry only their `path`.  Re-exports
 *  the in-process VFS tagged union so the protocol and the
 *  underlying store can't drift.  Directory entries cross the
 *  worker boundary in this shape so an empty folder created on the
 *  main thread survives a worker respawn. */
import type { VfsEntry } from "../vfs/types.js";
export type { VfsEntry };

export interface VfsWriteOk {
  ok: true;
  /** Sorted list of paths that were actually written, mirroring what
   *  the VFS surfaces to its subscribers.  Useful for tests and
   *  for the eventual `vfs.invalidated` push. */
  paths: string[];
}

export interface VfsDeleteOk {
  ok: true;
  /** Paths that existed and were removed.  Paths that weren't
   *  present are silently dropped (mirrors `MemoryVfs.delete`). */
  paths: string[];
}

export type VfsWriteResult = VfsWriteOk;
export type VfsDeleteResult = VfsDeleteOk;

/** `generate` takes either an inline `text` (legacy) or an
 *  `entryPath` that resolves inside the VFS (Phase 2+).  Exactly
 *  one of the two must be set; the worker errors when both are. */
export interface GenerateParams {
  text?: string;
  entryPath?: string;
  /** Opt-in Source Map v3 sidecars — threads into `generateSystems` /
   *  `generateSystemsFromLoom`'s `GenerateSystemOptions.sourcemap`.
   *  Off (undefined/false) by default so the "generated code" view and
   *  the download-zip stay byte-identical; only a caller that wants a
   *  `.ddd`-debuggable run bundle sets this.  See `client.ts`. */
  sourcemap?: boolean;
}

export type BuildRpcRequest =
  | { id: number; method: "generate"; params: GenerateParams }
  | { id: number; method: "snapshot"; params: GenerateParams }
  | { id: number; method: "evolution"; params: EvolutionParams }
  | { id: number; method: "vfs.write"; params: { entries: VfsEntry[] } }
  | { id: number; method: "vfs.delete"; params: { paths: string[] } };

export interface BuildRpcResponse {
  id: number;
  result?:
    | GenerateResult
    | SnapshotResult
    | EvolutionResult
    | VfsWriteResult
    | VfsDeleteResult;
  error?: { message: string };
}
