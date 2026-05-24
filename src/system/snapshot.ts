import * as fs from "node:fs";
import * as path from "node:path";

import type { SchemaSnapshot } from "../ir/migrations-ir.js";

// ---------------------------------------------------------------------------
// Snapshot store — reads `.loom/snapshots/<module>.snapshot.json` from disk.
//
// The reader is fronted by an interface so tests inject an in-memory map
// and the web playground can swap in a VFS-backed implementation that
// matches its `_packs/loader-fs.js` pattern (see CLAUDE.md).  The writer
// side is just `out.set(...)` in the system orchestrator — the existing
// output-writer handles disk landing.
// ---------------------------------------------------------------------------

export interface SnapshotStore {
  /** Returns the last-checked-in snapshot for `module`, or `null` when no
   *  snapshot file exists (first run). */
  read(module: string): SchemaSnapshot | null;
}

export function fsSnapshotStore(root: string): SnapshotStore {
  return {
    read(module: string): SchemaSnapshot | null {
      const filePath = snapshotPath(root, module);
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, "utf8");
      try {
        return JSON.parse(raw) as SchemaSnapshot;
      } catch {
        return null;
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
