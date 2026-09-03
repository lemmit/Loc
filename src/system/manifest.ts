// `.loom/manifest.json` — the record of what a `generate` run emitted, and
// the prune plan that turns it into deletions on the next run.
//
// The problem it solves (field-test finding G1): `ddd generate` only ever
// ADDED to the output tree.  Rename `operation comment` to `addComment` and
// regenerate in place, and the old `CommentHandler.cs` stays — a compiled
// file calling a method the aggregate no longer has, so `dotnet build` fails
// with CS1061.  Rename a page and `board.tsx` lingers, routed from nothing.
// The generated tree accumulated dead code that broke builds, and the only
// workaround was `rm -rf` (which then tripped the migration baseline guard).
//
// The fix is the smallest thing that can be correct: remember which paths
// THIS generator wrote, and on the next run delete the ones it no longer
// writes.  Everything else on disk is somebody else's file and is never
// touched.  Concretely, a path is deleted only when ALL of these hold:
//
//   1. it is listed in the PREVIOUS manifest (⇒ a past run of this generator
//      created it — a hand-written file has no manifest entry and so is
//      structurally un-prunable, whatever it is named);
//   2. it is NOT in the file map of the current run;
//   3. it is not matched by `.loomignore` (the user pinned it);
//   4. it is not scaffold-once (an `extern` impl the user now owns — see
//      `src/util/scaffold-once.ts`; deleting one destroys hand-written code);
//   5. it is not PROTECTED — see {@link isProtectedFromPrune}.
//
// This module is pure: no `node:fs`, no `process`.  The CLI write phase does
// the reading, deleting and writing; everything decidable without a disk
// lives here so it is testable without one.

/** Where the manifest lives inside the output tree. */
export const MANIFEST_REL_PATH = ".loom/manifest.json";

/** Schema version of the manifest file.  A manifest written by a NEWER Loom
 *  (unknown version) is ignored rather than misread — an unreadable manifest
 *  degrades to "prune nothing", never to "prune the wrong thing". */
export const MANIFEST_VERSION = 1;

/** One emitted path. */
export interface ManifestEntry {
  /** Forward-slash path relative to the output directory. */
  path: string;
  /** Present and `true` when the generator marked this file scaffold-once, so
   *  a later run that stops emitting it must still leave the user's copy
   *  alone.  Recorded here rather than re-sniffed from disk because a user
   *  editing "their" file may well drop the marker comment. */
  scaffoldOnce?: true;
}

export interface OutputManifest {
  version: number;
  /** Sorted by `path`, deduplicated. */
  entries: ManifestEntry[];
}

/** Normalise a generated file-map key (which may carry OS separators) to the
 *  forward-slash form the manifest and `.loomignore` both speak. */
export function normaliseManifestPath(relPath: string): string {
  return relPath.split("\\").join("/");
}

/**
 * Paths the pruner refuses to consider, even when a previous manifest lists
 * them and the current run does not emit them.  Two families, both cases
 * where "not emitted this run" does NOT mean "stale":
 *
 *  - **Migration files.**  Backends emit only the NEW migration each run;
 *    every earlier migration file stays on disk unmentioned (that is exactly
 *    what `checkMigrationBaseline`'s history ⊆ files guard verifies).  A
 *    naive prune would therefore delete the entire applied schema history on
 *    the second regeneration.  Matched on a `migrations`/`migration` path
 *    segment, the same rule `migration-artifacts.ts` scans with, so every
 *    backend's layout (Drizzle, EF, Ecto, Alembic, Flyway) is covered.
 *  - **`.loom/snapshots/`.**  The migration baselines and `ddd snapshot`
 *    provenance records.  Losing one is unrecoverable and turns the next
 *    generate into a refused re-baseline.
 *
 * The manifest itself is protected too, so a stale entry can never make a run
 * delete its own bookkeeping.
 */
export function isProtectedFromPrune(relPath: string): boolean {
  const p = normaliseManifestPath(relPath);
  if (p === MANIFEST_REL_PATH) return true;
  if (p.startsWith(".loom/snapshots/")) return true;
  const segments = p.split("/");
  // The last segment is the file name — a directory segment is what marks a
  // migration directory.
  return segments.slice(0, -1).some(isMigrationDirSegment);
}

/** True when `dirName` is a directory a backend lands migration files in.
 *  Matched case-insensitively so `migrations`, `Migrations`, and Flyway's
 *  singular `migration` (under `src/main/resources/db/migration/`) all count,
 *  wherever the layout adapter nests them.  (Mirrors the private predicate in
 *  `migration-artifacts.ts`, which scans the same shape on disk.) */
function isMigrationDirSegment(dirName: string): boolean {
  const lower = dirName.toLowerCase();
  return lower === "migrations" || lower === "migration";
}

/** Build a manifest from the paths a run emitted.  Sorted and deduplicated so
 *  the file is diff-stable across runs (it is meant to be committed). */
export function buildManifest(entries: readonly ManifestEntry[]): OutputManifest {
  const byPath = new Map<string, ManifestEntry>();
  for (const e of entries) {
    const p = normaliseManifestPath(e.path);
    // A duplicate key can't really happen (the file map is a Map), but if it
    // did, scaffold-once is the sticky, safer bit.
    const prev = byPath.get(p);
    const scaffoldOnce = e.scaffoldOnce || prev?.scaffoldOnce;
    byPath.set(p, scaffoldOnce ? { path: p, scaffoldOnce: true } : { path: p });
  }
  return {
    version: MANIFEST_VERSION,
    entries: [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

/** Serialise for `.loom/manifest.json` — two-space indent, trailing newline. */
export function serializeManifest(manifest: OutputManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Parse a manifest read off disk.  Returns `null` for anything this version
 * cannot vouch for — absent, truncated, hand-mangled, or written by a newer
 * Loom.  Callers treat `null` as "no previous manifest", i.e. prune nothing:
 * the failure mode of an unreadable manifest must be a stale file left
 * behind, never a deletion decided from garbage.
 */
export function parseManifest(text: string): OutputManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as { version?: unknown; entries?: unknown };
  if (obj.version !== MANIFEST_VERSION) return null;
  if (!Array.isArray(obj.entries)) return null;
  const entries: ManifestEntry[] = [];
  for (const item of obj.entries) {
    if (typeof item !== "object" || item === null) return null;
    const e = item as { path?: unknown; scaffoldOnce?: unknown };
    if (typeof e.path !== "string" || e.path.length === 0) return null;
    entries.push(
      e.scaffoldOnce === true
        ? { path: normaliseManifestPath(e.path), scaffoldOnce: true }
        : { path: normaliseManifestPath(e.path) },
    );
  }
  return { version: MANIFEST_VERSION, entries };
}

/**
 * Entries the previous manifest listed that this run does not re-emit, yet
 * still owns — the protected families (see {@link isProtectedFromPrune}),
 * when the file is still on disk.
 *
 * Without this the manifest would CHURN.  Backends emit only the newest
 * migration each run, so run 2's file map has no migration in it; a manifest
 * built from that map alone drops the migration entry, run 3 has nothing to
 * drop, and the manifest flips between two contents forever — rewritten on
 * every regen, which breaks the "a no-op regen touches no file" invariant
 * that watching dev servers depend on (`test/cli/regeneration.test.ts`).
 *
 * Only the PROTECTED families are carried.  An ordinary path the previous run
 * emitted and this one does not is precisely a prune candidate: it is about
 * to be deleted, so re-claiming it would be a lie.
 */
export function carriedOverEntries(
  previous: OutputManifest | null,
  currentPaths: Iterable<string>,
  exists: (relPath: string) => boolean,
): ManifestEntry[] {
  if (!previous) return [];
  const current = new Set<string>();
  for (const p of currentPaths) current.add(normaliseManifestPath(p));
  return previous.entries.filter(
    (e) => !current.has(e.path) && isProtectedFromPrune(e.path) && exists(e.path),
  );
}

export interface PrunePlanOptions {
  /** `.loomignore` matcher, over forward-slash output-relative paths. */
  isIgnored: (relPath: string) => boolean;
  /** Does the path still exist on disk?  A file the user already deleted is
   *  not reported as removed — the run would otherwise claim a deletion it
   *  did not make. */
  exists: (relPath: string) => boolean;
}

export interface PrunePlan {
  /** Paths to delete, sorted. */
  remove: string[];
  /** Stale manifest entries deliberately left alone, by reason.  Reported so
   *  the CLI can explain a survivor rather than leaving the user to wonder. */
  keptScaffoldOnce: string[];
  keptIgnored: string[];
  keptProtected: string[];
}

/**
 * Decide what the current run should delete.  Pure — `previous` is the
 * manifest the last run wrote, `currentPaths` the keys of this run's file
 * map, and the two callbacks answer the only two questions that need a disk.
 */
export function planPrune(
  previous: OutputManifest | null,
  currentPaths: Iterable<string>,
  options: PrunePlanOptions,
): PrunePlan {
  const plan: PrunePlan = {
    remove: [],
    keptScaffoldOnce: [],
    keptIgnored: [],
    keptProtected: [],
  };
  if (!previous) return plan;
  const current = new Set<string>();
  for (const p of currentPaths) current.add(normaliseManifestPath(p));

  for (const entry of previous.entries) {
    const p = entry.path;
    if (current.has(p)) continue; // still emitted — not stale
    if (entry.scaffoldOnce) {
      plan.keptScaffoldOnce.push(p);
      continue;
    }
    if (isProtectedFromPrune(p)) {
      plan.keptProtected.push(p);
      continue;
    }
    if (options.isIgnored(p)) {
      plan.keptIgnored.push(p);
      continue;
    }
    if (!options.exists(p)) continue; // already gone — nothing to report
    plan.remove.push(p);
  }
  plan.remove.sort();
  plan.keptScaffoldOnce.sort();
  plan.keptIgnored.sort();
  plan.keptProtected.sort();
  return plan;
}
