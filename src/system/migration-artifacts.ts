import * as fs from "node:fs";
import * as path from "node:path";

import type { EnrichedLoomModel } from "../ir/types/loom-ir.js";
import type { MigrationsIR } from "../ir/types/migrations-ir.js";

// ---------------------------------------------------------------------------
// Migration-baseline safety guards (M-T2.2).
//
// The snapshot store (`snapshot.ts`) reads the last-checked-in schema
// baseline.  When that file is ABSENT, `buildMigrations` treats it as a
// first run and re-emits a full "Initial" migration that re-CREATEs every
// table and resets the version / history chain — silently re-baselining
// against a database that already has migrations applied.  A *corrupt*
// snapshot already fails loudly (`SnapshotReadError`); a *missing* one does
// not, and neither does a snapshot whose recorded history has drifted from
// the migration files actually on disk.
//
// This module closes that window at generate time, before any file is
// written.  It answers one question — "what migration files already exist
// on disk, and at what versions?" — behind an injectable interface (the
// same pattern as `SnapshotStore`), then runs three pure checks against the
// freshly-built `MigrationsIR[]`:
//
//   (a) refuse "Initial" when migration files already exist but the
//       snapshot is missing (override with `allowRebaseline`);
//   (b) verify the on-disk files match `baseline.migrationHistory`
//       (a missing or unexpected file is drift the operator must resolve);
//   (c) reject a version number that already exists on disk (the tell of a
//       stale baseline reissuing a used version).
//
// The interface is fs-free so tests inject an in-memory index and the web
// playground (which never scans a real output tree) simply omits it.  Only
// `fsMigrationArtifactIndex` touches `node:fs`, and only the CLI constructs
// it — mirroring how `fsSnapshotStore` is built in `src/cli/main.ts`.
// ---------------------------------------------------------------------------

export interface MigrationArtifactIndex {
  /** Versions of the migration files currently on disk for `module`, in no
   *  particular order.  Empty when the module has no migration files yet
   *  (a genuine first run). */
  versions(module: string): readonly string[];
}

/**
 * Raised when the migration files already on disk are inconsistent with the
 * snapshot baseline the current generate run read (or didn't).  Deliberately
 * recoverable — like {@link SnapshotReadError}, this is an operator problem
 * (a lost/stale snapshot, a partially-applied history) that must be resolved
 * deliberately, not a compiler crash.  The CLI catches it and exits non-zero
 * with the message's recovery hint.
 */
export class MigrationBaselineError extends Error {
  constructor(
    readonly module: string,
    message: string,
  ) {
    super(message);
    this.name = "MigrationBaselineError";
  }
}

/** Extract the migration *version* token from a migration filename.  All
 *  five backends prefix the version onto the filename, in one of two shapes:
 *    - `<version>_<…>.{sql,exs,cs}`  (Drizzle / Ecto / EF / Alembic)
 *    - `V<version>.<n>__<…>.sql`     (Java / Flyway)
 *  Returns `null` for a file that matches neither (a `.gitkeep`, a
 *  `meta/_journal.json`, an editor temp file) so it's simply ignored. */
export function migrationFileVersion(fileName: string): string | null {
  const flyway = /^V(\d+)\.\d+__/.exec(fileName);
  if (flyway) return flyway[1];
  const prefixed = /^(\d+)_/.exec(fileName);
  if (prefixed) return prefixed[1];
  return null;
}

/** True when `dirName` is a directory a backend lands migration files in.
 *  Matched case-insensitively on the segment itself so `migrations`,
 *  `Migrations`, and Flyway's singular `migration` (under
 *  `src/main/resources/db/migration/`) all count, wherever the layout
 *  adapter nests them. */
function isMigrationDirSegment(dirName: string): boolean {
  const lower = dirName.toLowerCase();
  return lower === "migrations" || lower === "migration";
}

/** Recursively collect migration-file versions found anywhere under `root`
 *  that live inside a migration directory segment.  Missing `root` ⇒ []. */
function scanMigrationVersions(root: string): string[] {
  const versions: string[] = [];
  const walk = (dir: string, insideMigrationDir: boolean): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable / absent — treat as no artifacts
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, insideMigrationDir || isMigrationDirSegment(entry.name));
      } else if (insideMigrationDir && entry.isFile()) {
        const v = migrationFileVersion(entry.name);
        if (v !== null) versions.push(v);
      }
    }
  };
  walk(root, false);
  return versions;
}

/** Docker-compose-safe slug — the per-deployable output subdirectory name.
 *  Kept in sync with `serviceSlug` in `system/index.ts` (the repo already
 *  carries this one-liner in two other places; a local copy avoids an
 *  import cycle with the orchestrator). */
function serviceSlug(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Filesystem-backed index over a real generated output tree.  For every
 * module with a migration owner, scans that owner deployable's output
 * subdirectory (`<outDir>/<serviceSlug(owner)>/`) for migration files and
 * records their versions.  Built once (eager) so repeated `versions(...)`
 * lookups don't re-walk the tree.
 *
 * Only this function reaches for `node:fs`; the CLI is the sole caller.
 */
export function fsMigrationArtifactIndex(
  outDir: string,
  loom: EnrichedLoomModel,
): MigrationArtifactIndex {
  const byModule = new Map<string, string[]>();
  for (const sys of loom.systems) {
    for (const sub of sys.subdomains) {
      if (!sub.migrationsOwner) continue;
      const ownerDir = path.join(outDir, serviceSlug(sub.migrationsOwner));
      byModule.set(sub.name, scanMigrationVersions(ownerDir));
    }
  }
  return {
    versions: (module) => byModule.get(module) ?? [],
  };
}

/** In-memory index for tests and callers with no real output tree.  Keyed
 *  module → version list. */
export function memoryMigrationArtifactIndex(
  byModule: Record<string, readonly string[]> = {},
): MigrationArtifactIndex {
  return {
    versions: (module) => byModule[module] ?? [],
  };
}

export interface CheckMigrationBaselineOptions {
  /** Override guard (a): permit re-emitting "Initial" even though migration
   *  files already exist and the snapshot is missing.  The escape hatch for
   *  a deliberate re-baseline (the CLI `--allow-rebaseline` flag). */
  allowRebaseline?: boolean;
}

/**
 * Run the three baseline-safety checks over freshly-built migrations.  Pure
 * (no fs) — the on-disk state arrives through `index`.  Throws
 * {@link MigrationBaselineError} on the first violation.
 */
export function checkMigrationBaseline(
  migrations: readonly MigrationsIR[],
  index: MigrationArtifactIndex,
  options: CheckMigrationBaselineOptions = {},
): void {
  const allowRebaseline = options.allowRebaseline ?? false;
  for (const m of migrations) {
    const onDisk = index.versions(m.module);
    const onDiskSet = new Set(onDisk);

    // (a) Missing snapshot + existing migration files ⇒ this run would emit
    //     a fresh "Initial" and reset the version/history chain against a
    //     database that already has migrations.  Refuse unless overridden.
    if (m.baseline === null) {
      if (onDisk.length > 0 && !allowRebaseline) {
        throw new MigrationBaselineError(
          m.module,
          `refusing to re-baseline module '${m.module}': its migration snapshot ` +
            `(.loom/snapshots/${m.module}.snapshot.json) is missing, but ${onDisk.length} ` +
            `migration file(s) already exist in the output tree. Emitting a fresh "Initial" ` +
            `migration here would reset the version history and re-CREATE tables against a ` +
            `database that already has these migrations applied. Restore the snapshot from ` +
            `version control, or pass --allow-rebaseline to overwrite the migration history ` +
            `deliberately.`,
        );
      }
      // Fresh module (no snapshot, no files) or an explicit re-baseline —
      // nothing more to verify.
      continue;
    }

    // (b) Snapshot present: every migration the recorded history claims must
    //     have a file on disk.  A history entry with no file means the
    //     snapshot and the output tree have drifted — the next delta would be
    //     computed against a baseline the disk doesn't agree with.
    //
    //     This is a one-directional check (history ⊆ files), NOT files ⊆
    //     history.  Backends legitimately emit migration files the version
    //     chain never records: the feature-local audit/provenance late
    //     migrations (fixed far-future `2999…` versions, deliberately sorted
    //     after every real migration — see dotnet/elixir/java emitters) are
    //     never in `migrationHistory`.  Flagging "extra" files would false-
    //     positive on every audited/provenanced system; the stale-baseline
    //     case it would otherwise catch is caught instead by guard (c) on the
    //     next real delta (the reissued version collides with the file).
    const history = m.baseline.migrationHistory ?? [];
    const missing = history.map((h) => h.version).filter((v) => !onDiskSet.has(v));
    if (missing.length > 0) {
      throw new MigrationBaselineError(
        m.module,
        `migration files for module '${m.module}' are inconsistent with the snapshot ` +
          `(.loom/snapshots/${m.module}.snapshot.json): migration file(s) for version(s) ` +
          `${missing.join(", ")} are recorded in the snapshot history but absent from the output ` +
          `tree. The snapshot and the generated migrations have drifted — restore both from ` +
          `version control together, or re-baseline deliberately.`,
      );
    }

    // (c) The version this run is about to emit must not already exist on
    //     disk.  It only assigns a new version when there are steps to emit;
    //     a no-op regen reuses the last version and writes no new file.  A
    //     collision here is the tell of a stale baseline whose `lastVersion`
    //     lags the files, reissuing a number already taken.
    if (m.steps.length > 0 && onDiskSet.has(m.version)) {
      throw new MigrationBaselineError(
        m.module,
        `migration version '${m.version}' for module '${m.module}' is already present in the ` +
          `output tree, but this run would emit a new migration under the same version. The ` +
          `snapshot's baseline is stale (its lastVersion lags the migration files on disk). ` +
          `Restore the snapshot from version control so the next version is assigned after the ` +
          `latest file.`,
      );
    }
  }
}
