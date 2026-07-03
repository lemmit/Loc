import * as fs from "node:fs";
import * as path from "node:path";

import type { SchemaSnapshot } from "../ir/types/migrations-ir.js";

// ---------------------------------------------------------------------------
// Snapshot store — reads `.loom/snapshots/<Subdomain>.snapshot.json` from
// disk.  The `module` parameter name in the API below is a pre-D-STORAGE-
// SPLIT holdover; callers pass a subdomain name.
//
// The reader is fronted by an interface so tests inject an in-memory map
// and the web playground can swap in a VFS-backed implementation that
// matches its `_packs/loader-fs.js` pattern (see CLAUDE.md).  The writer
// side is just `out.set(...)` in the system orchestrator — the existing
// output-writer handles disk landing.
// ---------------------------------------------------------------------------

export interface SnapshotStore {
  /** Returns the last-checked-in snapshot for `module`, or `null` when no
   *  snapshot file exists (first run).  Throws {@link SnapshotReadError} when
   *  a snapshot file *is* present but cannot be read or parsed. */
  read(module: string): SchemaSnapshot | null;
}

/**
 * Raised when a migration snapshot file exists on disk but cannot be read or
 * parsed (corrupted / truncated JSON — e.g. an interrupted write, or a merge
 * conflict left in the file).  This is deliberately NOT collapsed to `null`:
 * a `null` snapshot means "first run" to `buildMigrations`, which then re-emits
 * an "Initial" migration that re-CREATEs every table and resets the version /
 * history chain — silently re-baselining against an existing database.  A
 * corrupt snapshot must fail loudly instead so the operator can recover it.
 */
export class SnapshotReadError extends Error {
  constructor(
    readonly filePath: string,
    readonly reason: unknown,
  ) {
    const detail = reason instanceof Error ? reason.message : String(reason);
    super(
      `migration snapshot at ${filePath} exists but could not be read (${detail}). ` +
        "It is likely corrupted or truncated (e.g. an interrupted write or an " +
        "unresolved merge conflict). Restore it from version control, or delete " +
        "it deliberately to re-baseline the migration history from scratch.",
    );
    this.name = "SnapshotReadError";
  }
}

export function fsSnapshotStore(root: string): SnapshotStore {
  return {
    read(module: string): SchemaSnapshot | null {
      const filePath = snapshotPath(root, module);
      // Absent file ⇒ legitimately null (first run).  A file that is present
      // but unreadable/unparseable is a corruption error, NOT a fresh dir.
      if (!fs.existsSync(filePath)) return null;
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(raw) as SchemaSnapshot;
      } catch (err) {
        throw new SnapshotReadError(filePath, err);
      }
    },
  };
}

export function memorySnapshotStore(initial: Record<string, SchemaSnapshot> = {}): SnapshotStore {
  return {
    read(module: string): SchemaSnapshot | null {
      return initial[module] ?? null;
    },
  };
}

/** Relative path inside the system output where the snapshot for `module`
 *  lives.  Stable so backends and the CLI can both reference it. */
export function snapshotRelPath(module: string): string {
  return `.loom/snapshots/${module}.snapshot.json`;
}

function snapshotPath(root: string, module: string): string {
  return path.join(root, snapshotRelPath(module));
}

/** Serialise a snapshot to JSON with stable key order — tables sorted by
 *  name (the builder already does this; we re-sort defensively), columns
 *  and indexes in declared order.  Two-space indent for diff-friendliness. */
export function serializeSnapshot(snapshot: SchemaSnapshot): string {
  const tables = [...snapshot.tables].sort((a, b) => a.name.localeCompare(b.name));
  const payload: SchemaSnapshot = { ...snapshot, tables };
  return JSON.stringify(payload, null, 2) + "\n";
}
