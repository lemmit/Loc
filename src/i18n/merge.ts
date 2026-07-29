// ---------------------------------------------------------------------------
// Pure three-way merge core for locale catalogs (M-T1.11, i18n.md Phase 3).
//
// `git merge` for strings.  Three inputs, all flat `{ key: message }` objects:
//
//   BASE   locales/.loom/source.lock.json  — source snapshot at the last sync
//   OURS   locales/<locale>.json           — the translator's current file
//   THEIRS out/.loom/messages.en.json       — what codegen just extracted
//
// The current extraction (THEIRS) is the authority for WHICH keys exist; the
// translator's file (OURS) is the authority for their VALUES.  BASE lags THEIRS
// so the merge has information to act on (i18n.md "Why the BASE must lag").
//
// This module is pure — no fs, no parse, no git.  It is the single place the
// four merge cases (i18n.md §"The four cases") are decided, so they can be
// golden-tested in isolation from the CLI plumbing that reads/writes the files.
// ---------------------------------------------------------------------------

/** A flat source-key → message catalog (English source or one translation). */
export type Catalog = Record<string, string>;

/** Prefix a still-untranslated entry carries so it stands out in a diff and is
 *  greppable by `ddd i18n check`. */
export const TODO_PREFIX = "TODO: ";

/** True when `value` is an untranslated placeholder (`TODO: …`). */
export function isTodo(value: string): boolean {
  return value.startsWith(TODO_PREFIX);
}

/** True when `value` carries unresolved git-style conflict markers. */
export function hasConflictMarkers(value: string): boolean {
  return value.includes("<<<<<<< OURS") || value.includes(">>>>>>> THEIRS");
}

/** Build the git-style diff3 conflict-marker block for a source-changed key
 *  whose translation the human already wrote.  Embedded in the merged value so
 *  the file still round-trips as JSON, while `ddd i18n check` flags it. */
export function conflictMarker(ours: string, base: string, theirs: string): string {
  return `<<<<<<< OURS\n${ours}\n||||||| BASE\n${base}\n=======\n${theirs}\n>>>>>>> THEIRS`;
}

/** Per-key classification of what the merge did, for `sync`/`status` reporting. */
export interface MergeReport {
  /** New source keys with no translation yet — written as `TODO: …`. */
  added: string[];
  /** Keys whose existing translation was carried through unchanged. */
  kept: string[];
  /** Keys present in OURS but gone from the source — dropped from the result. */
  dropped: string[];
  /** Same-key source changes over a human translation — conflict markers written. */
  conflicted: string[];
}

export interface MergeResult {
  merged: Catalog;
  report: MergeReport;
}

export interface MergeOptions {
  /** Keep dropped-source keys under a `_stale.<key>` shadow instead of deleting
   *  them (i18n.md §"The four cases", deleted-key row — configurable). */
  keepStale?: boolean;
}

/**
 * Three-way merge one locale.  Keys come from THEIRS (the live source);
 * values are preferred from OURS (the human translation).  See the four cases:
 *
 *  1. New key       — in THEIRS, not in OURS            → `TODO: <source>`.
 *  2. Deleted key   — in OURS, not in THEIRS            → dropped (or `_stale`).
 *  3. Unchanged     — in THEIRS & OURS, source == BASE  → keep OURS.
 *  4. Source-changed— same key, THEIRS != BASE, has OURS→ conflict markers.
 *
 * Content-hashed keys (page/component/menu) turn case 4 into a clean
 * delete-old + add-new (the rephrased string gets a new hash key), so the
 * conflict path only fires for stable named keys.
 */
export function mergeCatalog(
  base: Catalog,
  ours: Catalog,
  theirs: Catalog,
  options: MergeOptions = {},
): MergeResult {
  const merged: Catalog = {};
  const report: MergeReport = { added: [], kept: [], dropped: [], conflicted: [] };

  for (const key of Object.keys(theirs).sort()) {
    const source = theirs[key];
    const translated = ours[key];
    const based = base[key];

    if (translated === undefined) {
      // Case 1 — never translated for this locale.
      merged[key] = `${TODO_PREFIX}${source}`;
      report.added.push(key);
    } else if (based !== undefined && based !== source) {
      // Case 4 — the source moved under a translation that's still here (only
      // reachable for stable named keys; hashed keys re-key instead).
      merged[key] = conflictMarker(translated, based, source);
      report.conflicted.push(key);
    } else {
      // Case 3 — unchanged, or new-since-base but already translated.
      merged[key] = translated;
      report.kept.push(key);
    }
  }

  // Case 2 — keys the translator has that the source no longer emits.
  for (const key of Object.keys(ours).sort()) {
    if (key in theirs) continue;
    report.dropped.push(key);
    if (options.keepStale) merged[`_stale.${key}`] = ours[key];
  }

  return result(merged, report);
}

function result(merged: Catalog, report: MergeReport): MergeResult {
  // Stable, key-sorted output so the written file diffs cleanly.
  const sorted: Catalog = {};
  for (const key of Object.keys(merged).sort()) sorted[key] = merged[key];
  return { merged: sorted, report };
}

/** True when a merge would change anything a human must look at — a new
 *  `TODO`, a conflict, or a dropped key.  Drives `status`/`sync` exit codes. */
export function reportHasPending(report: MergeReport): boolean {
  return report.added.length > 0 || report.conflicted.length > 0 || report.dropped.length > 0;
}
