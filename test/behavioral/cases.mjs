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
  const skip = BEHAVIOURAL_SKIP[platformClause] ?? {};
  for (const f of await loadCorpusFeatures(workDir)) {
    if (!f.backends.includes(backendKey)) continue;
    if (f.id in skip) continue; // known runtime gap on this backend — see the bug register
    const raw = readFileSync(join(CORPUS_DIR, `${f.id}.ddd`), "utf8");
    if (!hasBehaviouralBlock(raw)) continue;
    cases.push({ name: f.id, source: raw.replaceAll("__PLATFORM__", platformClause) });
  }
  return cases;
}

/** The canonical dev-stub principal every behavioural runner authenticates as.
 *  Injected via `E2E_DEV_CLAIMS` → the emitted `__authHeaders` base64-encodes it
 *  into the `x-loom-dev-claims` header that each backend's dev-stub auth verifier
 *  merges over its built-in identity (the exact mechanism tenancy-e2e uses).
 *  Only STRING claims are honoured on the non-node backends, so keep it to
 *  strings keyed by the declared `user` field name.  Inert for auth-less systems
 *  (no middleware reads it).  Fixtures in the tenancy/auth cluster assert against
 *  THIS principal — an in-tenant row uses `tenantId: "acme"`, an out-of-tenant
 *  row any other value; a `requires currentUser.role == "agent"` op is satisfied. */
export const DEV_CLAIMS = JSON.stringify({ tenantId: "acme", role: "agent" });

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

/** Per-(platform, case) behavioural skips: a corpus feature or shared system that
 *  GENERATES and COMPILES on a backend but whose RUNTIME behaviour has a known,
 *  tracked gap there.  Honest and documented (not a silent drop) — the case still
 *  runs on every other backend, the gate (behavioural-coverage.test.ts) still
 *  requires it to EMIT everywhere, and each entry cites its bug in
 *  docs/audits/behavioral-parity-bugs-2026-07.md.  Removing an entry is how a fix
 *  re-arms the boot.  Keyed by platform clause; applies to BOTH featureCases and
 *  sharedSystemCases (a case name is either a corpus feature id or a systems/ file). */
// OIDC boot-harness gap: `auth-oidc` has an `auth {}` block → a real JWT
// verifier that validates a bearer token against the issuer's JWKS.  The node
// runner (run.mjs) stands up an in-process mock issuer (oidc-mock.mjs), sets
// OIDC_ISSUER, and forwards a signed E2E_BEARER_TOKEN — so it boots the full
// OIDC path.  The backend runners (java/python/dotnet/elixir) spawn a SEPARATE
// backend process and would each need the mock issuer forwarded into that
// process's env (OIDC_ISSUER) + the token plumbed through; that per-runner
// wiring (and any per-backend claim-mapping differences it surfaces) is the
// tracked follow-up.  Until then the OIDC boot is node-only; the case still
// EMITS on every backend (behavioural-coverage gate) and boots on node.
const OIDC_BOOT_GAP = { "auth-oidc": "OIDC mock-issuer harness wired into run.mjs (node) only — backend-runner forwarding is the follow-up" };

const BEHAVIOURAL_SKIP = {
  node: {
    // B1 fixed (event-sourced create now folds events before asserting
    // invariants — src/generator/typescript/emit/aggregate.ts).  `ledger`
    // re-armed; no node skips remain.
  },
  dotnet: {
    // B2/B3/B4/B8/B12 fixed — no dotnet skips remain. (B12: `crudish` on a
    // `shape: document` aggregate now emits a matching `DeleteAsync` on the
    // document-repo impl, so the interface/impl method sets agree; repository.ts.)
    ...OIDC_BOOT_GAP,
  },
  java: { ...OIDC_BOOT_GAP },
  python: { ...OIDC_BOOT_GAP },
  elixir: {
    ...OIDC_BOOT_GAP,
    // B5/B6/B7/B9/B10/B11 fixed; batch-5 (core-domain/document/inheritance) booted
    // green on elixir — no elixir skips remain. (B11: `T or <primitive>` union return
    // now mints a valid PascalCase module alias; openapi-emit.ts.)
    // (B9: single `contains`
    // arms the `__put_assoc_parts/1` helper on an `assign` mutation + the helper
    // handles a single `has_one` struct; context-emit.ts. B10: parent-table
    // migrations ordered FK-topologically so a cross-aggregate reference target
    // is created first; migrations-emit.ts.)
  },
};

/** Filter a case-name list against the platform's behavioural skip set. */
function notSkipped(names, platformClause) {
  const skip = BEHAVIOURAL_SKIP[platformClause] ?? {};
  return names.filter((name) => !(name in skip));
}

/** Shared broad-system cases (systems/*.ddd), source-swapped to `platformClause`.
 *  Run on every backend — the tokenized replacement for the forked sales.ddd. */
export function sharedSystemCases(platformClause) {
  const names = readdirSync(SYSTEMS_DIR)
    .filter((p) => p.endsWith(".ddd"))
    .map((file) => file.replace(/\.ddd$/, ""))
    .sort();
  return notSkipped(names, platformClause).map((name) => ({
    name,
    source: readFileSync(join(SYSTEMS_DIR, `${name}.ddd`), "utf8").replaceAll("__PLATFORM__", platformClause),
  }));
}
