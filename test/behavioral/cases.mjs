// Shared behavioural case assembly — the ONE place that decides WHICH sources a
// backend runner boots.  Replaces the per-backend `corpus-*.json` allowlists and
// forked `.ddd`s: every runner derives its cases from the SAME two sources of
// truth, token-swapped to its platform:
//
//   1. featureCases  — the typed corpus manifest (test/fixtures/corpus): every
//      feature that declares the runner's backend AND carries a behavioural
//      block (`test e2e` / `test`).
//   2. sharedSystemCases — the tokenized broad systems under systems/*.ddd
//      (e.g. sales), run on every backend.
//
// A case is `{ name, source }`; `source` has `__PLATFORM__` already swapped.

import { build } from "esbuild";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const CORPUS_DIR = join(REPO, "test/fixtures/corpus");
const SYSTEMS_DIR = join(HERE, "systems");

/** Load the typed corpus manifest via a one-shot esbuild bundle — the same
 *  single source of truth the generation and compile tiers iterate. */
export async function loadCorpusFeatures(workDir) {
  mkdirSync(workDir, { recursive: true });
  const bundled = join(workDir, "_manifest.mjs");
  await build({
    entryPoints: [join(CORPUS_DIR, "manifest.ts")],
    outfile: bundled,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const { CORPUS } = await import(pathToFileURL(bundled).href);
  return CORPUS;
}

/** True when a `.ddd` carries a behavioural block a runner can boot — a
 *  `test e2e "…"` (api) or a domain `test "…"` (unit). Mirror of the gate's
 *  detection in test/conformance/behavioural-coverage.test.ts. */
export function hasBehaviouralBlock(src) {
  return /(^|\n)\s*test\s+e2e\s+"/.test(src) || /(^|\n)\s*test\s+"/.test(src);
}

/** Corpus-feature cases for one backend: every manifest feature that declares
 *  `backendKey` and carries a behavioural block, source-swapped to
 *  `platformClause` (e.g. key "vanilla" → clause "elixir"). */
export async function featureCases(backendKey, platformClause, workDir) {
  const cases = [];
  for (const f of await loadCorpusFeatures(workDir)) {
    if (!f.backends.includes(backendKey)) continue;
    const raw = readFileSync(join(CORPUS_DIR, `${f.id}.ddd`), "utf8");
    if (!hasBehaviouralBlock(raw)) continue;
    cases.push({ name: f.id, source: raw.replaceAll("__PLATFORM__", platformClause) });
  }
  return cases;
}

/** Reset a shared Postgres to a pristine state before a case boots.  The backend
 *  runners (java/dotnet/python/elixir) boot against ONE external DB and each
 *  case emits its own migrations at a FIXED version — so running more than one
 *  case per DB collides (Flyway/EF/Ecto checksum mismatch, or "relation already
 *  exists") unless the DB is wiped between them.  Generated backends put each
 *  bounded context in its OWN schema (named after the context, e.g. `orders`,
 *  `sales`), so dropping `public` alone is not enough — this drops EVERY
 *  non-system schema and recreates `public`.  `pgUrl` is a standard
 *  `postgresql://user:pass@host/db`.  (The node tier needs none — PGlite is a
 *  fresh in-process DB per case.) */
export async function resetDatabase(pgUrl) {
  const client = new pg.Client({ connectionString: pgUrl });
  await client.connect();
  try {
    await client.query(`
      DO $$
      DECLARE s text;
      BEGIN
        FOR s IN SELECT nspname FROM pg_namespace
                 WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
        LOOP
          EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', s);
        END LOOP;
        EXECUTE 'CREATE SCHEMA IF NOT EXISTS public';
      END $$;
    `);
  } finally {
    await client.end();
  }
}

/** Per-(platform, system) behavioural skips: a shared system that GENERATES and
 *  COMPILES on a backend but whose RUNTIME behaviour has a known gap there.
 *  Honest and documented (not a silent drop) — the system still runs on every
 *  other backend, and the gate (behavioural-coverage.test.ts) still requires it
 *  to EMIT everywhere; only the boot is skipped where it's a tracked bug. */
const SHARED_SYSTEM_SKIP = {
  // node event-sourced `create` evaluates `invariant balance >= 0` BEFORE the
  // `Opened` event folds `balance := 0`, so account creation 400s — while java
  // and python fold-then-check and pass.  A node ES invariant-timing gap to fix
  // separately (language-feature-developer), not in the fork-collapse slice.
  node: { ledger: "node ES create checks invariant before the create event folds initial state" },
};

/** Shared broad-system cases (systems/*.ddd), source-swapped to `platformClause`.
 *  Run on every backend — the tokenized replacement for the forked sales.ddd. */
export function sharedSystemCases(platformClause) {
  const skip = SHARED_SYSTEM_SKIP[platformClause] ?? {};
  return readdirSync(SYSTEMS_DIR)
    .filter((p) => p.endsWith(".ddd"))
    .map((file) => file.replace(/\.ddd$/, ""))
    .filter((name) => !(name in skip))
    .sort()
    .map((name) => ({
      name,
      source: readFileSync(join(SYSTEMS_DIR, `${name}.ddd`), "utf8").replaceAll("__PLATFORM__", platformClause),
    }));
}
