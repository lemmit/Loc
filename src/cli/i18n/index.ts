// ---------------------------------------------------------------------------
// `ddd i18n <subcommand>` — the translator-workflow CLI (M-T1.11, i18n.md
// Phase 3).  `git merge` for strings, backed by the pure three-way merge core
// (`src/i18n/merge.ts`) and the phase ①–⑥ extraction (`./extract.ts`).
//
//   ddd i18n extract <file> [-o out]        write <out>/.loom/messages.en.json
//   ddd i18n init    <file> <locale>        scaffold locales/<locale>.json + lock
//   ddd i18n sync    <file> [--locale l]    three-way merge every locale; bump lock
//   ddd i18n status  <file>                 what sync would do; non-zero if pending
//   ddd i18n check   <file> [--strict]      CI gate: TODO / conflicts / missing keys
//   ddd i18n prune   <file>                 drop keys the source no longer emits
//
// File layout (i18n.md §"File layout"):
//   <dir>/.loom/source.lock.json  BASE — source snapshot at last sync
//   <dir>/<locale>.json           OURS — the translator's file (human-owned)
//   <out>/.loom/messages.en.json  THEIRS — freshly extracted source catalog
//
// Codegen never writes under <dir>/; reconciliation here is a deliberate,
// commit-worthy checkpoint, so every write is explicit and reported.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type Catalog,
  hasConflictMarkers,
  isTodo,
  type MergeReport,
  mergeCatalog,
  reportHasPending,
  TODO_PREFIX,
} from "../../i18n/merge.js";
import { extractCatalog } from "./extract.js";

const LOCK_REL = path.join(".loom", "source.lock.json");
const EXTRACT_REL = path.join(".loom", "messages.en.json");

interface DirOption {
  dir?: string;
}
interface LocaleFilter {
  locale?: string;
}

function localesDir(options: DirOption): string {
  return path.resolve(options.dir ?? "locales");
}

function readCatalog(file: string): Catalog {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as Catalog;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Enumerate the locale files under `<dir>` (top-level `*.json`, skipping the
 *  machine `.loom/` subtree), returning `{ locale, file }` pairs. */
function discoverLocales(dir: string, filter?: string): { locale: string; file: string }[] {
  if (!fs.existsSync(dir)) return [];
  const out: { locale: string; file: string }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const locale = entry.name.slice(0, -".json".length);
    if (filter && locale !== filter) continue;
    out.push({ locale, file: path.join(dir, entry.name) });
  }
  return out.sort((a, b) => a.locale.localeCompare(b.locale));
}

/** `ddd i18n extract <file> [-o out]` — write the fresh source catalog. */
export async function runI18nExtract(file: string, options: { out?: string }): Promise<void> {
  const source = await extractCatalog(file);
  const out = path.resolve(options.out ?? "out");
  const target = path.join(out, EXTRACT_REL);
  writeJson(target, source);
  console.log(
    `Extracted ${Object.keys(source).length} message(s) → ${path.relative(process.cwd(), target)}`,
  );
}

/** `ddd i18n init <file> <locale>` — scaffold a locale file + the lock. */
export async function runI18nInit(file: string, locale: string, options: DirOption): Promise<void> {
  const source = await extractCatalog(file);
  const dir = localesDir(options);
  const lockFile = path.join(dir, LOCK_REL);
  const localeFile = path.join(dir, `${locale}.json`);

  if (fs.existsSync(localeFile)) {
    console.error(
      `Locale already exists: ${path.relative(process.cwd(), localeFile)} (leaving it untouched)`,
    );
  } else {
    const seeded: Catalog = {};
    for (const key of Object.keys(source).sort()) seeded[key] = `${TODO_PREFIX}${source[key]}`;
    writeJson(localeFile, seeded);
    console.log(
      `Created ${path.relative(process.cwd(), localeFile)} — ${Object.keys(seeded).length} key(s) to translate`,
    );
  }

  if (!fs.existsSync(lockFile)) {
    writeJson(lockFile, source);
    console.log(`Wrote lock ${path.relative(process.cwd(), lockFile)}`);
  }
}

function summarize(locale: string, report: MergeReport): string {
  const parts = [`+${report.added.length} new`, `${report.kept.length} kept`];
  if (report.dropped.length) parts.push(`-${report.dropped.length} dropped`);
  if (report.conflicted.length) parts.push(`${report.conflicted.length} CONFLICT`);
  return `  ${locale}: ${parts.join(", ")}`;
}

/** `ddd i18n sync <file>` — three-way merge every locale, then bump the lock. */
export async function runI18nSync(
  file: string,
  options: DirOption & LocaleFilter & { keepStale?: boolean },
): Promise<void> {
  const theirs = await extractCatalog(file);
  const dir = localesDir(options);
  const lockFile = path.join(dir, LOCK_REL);
  const base = readCatalog(lockFile);

  const locales = discoverLocales(dir, options.locale);
  if (locales.length === 0) {
    console.error(
      `No locale files under ${path.relative(process.cwd(), dir)}. Run \`ddd i18n init <file> <locale>\` first.`,
    );
    process.exit(1);
  }

  let conflicts = 0;
  for (const { locale, file: localeFile } of locales) {
    const ours = readCatalog(localeFile);
    const { merged, report } = mergeCatalog(base, ours, theirs, { keepStale: options.keepStale });
    writeJson(localeFile, merged);
    conflicts += report.conflicted.length;
    console.log(summarize(locale, report));
  }

  // The lock only advances once every locale has reconciled against the new
  // source — that's what makes BASE lag THEIRS for the next merge.
  writeJson(lockFile, theirs);
  console.log(`Updated lock → ${path.relative(process.cwd(), lockFile)}`);
  if (conflicts > 0) {
    console.error(`\n${conflicts} conflict(s) written — resolve the <<<<<<< markers, then commit.`);
    process.exit(1);
  }
}

/** `ddd i18n status <file>` — dry-run of sync; non-zero if anything is pending. */
export async function runI18nStatus(
  file: string,
  options: DirOption & LocaleFilter,
): Promise<void> {
  const theirs = await extractCatalog(file);
  const dir = localesDir(options);
  const base = readCatalog(path.join(dir, LOCK_REL));
  const locales = discoverLocales(dir, options.locale);

  if (locales.length === 0) {
    console.log("No locale files — nothing to sync.");
    return;
  }

  let pending = false;
  for (const { locale, file: localeFile } of locales) {
    const ours = readCatalog(localeFile);
    const { report } = mergeCatalog(base, ours, theirs);
    console.log(summarize(locale, report));
    if (reportHasPending(report)) pending = true;
  }
  if (pending) {
    console.error("\nPending changes — run `ddd i18n sync`.");
    process.exit(1);
  }
}

/** `ddd i18n check <file> [--strict]` — CI gate for untranslated / conflicted
 *  / missing keys.  With `--strict`, any finding is a non-zero exit. */
export async function runI18nCheck(
  file: string,
  options: DirOption & LocaleFilter & { strict?: boolean },
): Promise<void> {
  const source = await extractCatalog(file);
  const dir = localesDir(options);
  const locales = discoverLocales(dir, options.locale);

  if (locales.length === 0) {
    console.log("No locale files to check.");
    return;
  }

  let findings = 0;
  for (const { locale, file: localeFile } of locales) {
    const catalog = readCatalog(localeFile);
    const todos = Object.entries(catalog)
      .filter(([, v]) => isTodo(v))
      .map(([k]) => k);
    const conflicts = Object.entries(catalog)
      .filter(([, v]) => hasConflictMarkers(v))
      .map(([k]) => k);
    const missing = Object.keys(source).filter((k) => !(k in catalog));
    const count = todos.length + conflicts.length + missing.length;
    findings += count;
    if (count === 0) {
      console.log(`  ${locale}: ok`);
      continue;
    }
    const parts: string[] = [];
    if (todos.length) parts.push(`${todos.length} TODO`);
    if (conflicts.length) parts.push(`${conflicts.length} conflict`);
    if (missing.length) parts.push(`${missing.length} missing`);
    console.log(`  ${locale}: ${parts.join(", ")}`);
    for (const k of conflicts) console.log(`      conflict: ${k}`);
    for (const k of missing) console.log(`      missing:  ${k}`);
  }
  if (findings > 0 && options.strict) {
    console.error(`\n${findings} finding(s) with --strict → failing.`);
    process.exit(1);
  }
}

/** `ddd i18n prune <file>` — delete keys the source no longer emits (off by
 *  default; run deliberately). */
export async function runI18nPrune(file: string, options: DirOption & LocaleFilter): Promise<void> {
  const source = await extractCatalog(file);
  const dir = localesDir(options);
  const locales = discoverLocales(dir, options.locale);

  for (const { locale, file: localeFile } of locales) {
    const catalog = readCatalog(localeFile);
    const stale = Object.keys(catalog).filter((k) => !(k in source));
    if (stale.length === 0) {
      console.log(`  ${locale}: nothing to prune`);
      continue;
    }
    const pruned: Catalog = {};
    for (const key of Object.keys(catalog).sort()) {
      if (key in source) pruned[key] = catalog[key];
    }
    writeJson(localeFile, pruned);
    console.log(`  ${locale}: pruned ${stale.length} stale key(s)`);
  }
}
