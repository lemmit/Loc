// Build-worker protocol — request/response shapes for kicking off a
// generate run from the main thread.  Kept separate from the LSP
// worker so editor latency doesn't compete with potentially heavier
// generator + (later) bundler work.
//
// Phase 2 of the IDE refactor: the protocol grows VFS mutate methods
// (`vfs.write` / `vfs.delete` / `vfs.list` / `vfs.snapshot`) so the
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

/** A single VFS entry shipped over the wire — the worker writes
 *  `content` at `path` into its local MemoryVfs. */
export interface VfsEntry {
  path: string;
  content: string;
}

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

export interface VfsListOk {
  ok: true;
  paths: string[];
}

export interface VfsSnapshotOk {
  ok: true;
  entries: VfsEntry[];
}

export type VfsWriteResult = VfsWriteOk;
export type VfsDeleteResult = VfsDeleteOk;
export type VfsListResult = VfsListOk;
export type VfsSnapshotResult = VfsSnapshotOk;

/** `generate` takes either an inline `text` (legacy) or an
 *  `entryPath` that resolves inside the VFS (Phase 2+).  Exactly
 *  one of the two must be set; the worker errors when both are. */
export interface GenerateParams {
  text?: string;
  entryPath?: string;
}

export type BuildRpcRequest =
  | { id: number; method: "generate"; params: GenerateParams }
  | { id: number; method: "snapshot"; params: GenerateParams }
  | { id: number; method: "vfs.write"; params: { entries: VfsEntry[] } }
  | { id: number; method: "vfs.delete"; params: { paths: string[] } }
  | { id: number; method: "vfs.list"; params: { prefix: string } }
  | { id: number; method: "vfs.snapshot"; params: Record<string, never> };

export interface BuildRpcResponse {
  id: number;
  result?:
    | GenerateResult
    | SnapshotResult
    | VfsWriteResult
    | VfsDeleteResult
    | VfsListResult
    | VfsSnapshotResult;
  error?: { message: string };
}
