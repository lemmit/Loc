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

/** Parse a JUnit-XML report string into `{ tier: "unit", name, status, error }`
 *  rows — the shared shape every runner's unit tier returns.  Passing cases
 *  self-close (`<testcase … />`); a failure/error nests a `<failure>`/`<error>`
 *  child.  Emitted by pytest (`--junitxml`) and gradle (`build/test-results`). */
export function parseJUnitXml(xml) {
  const results = [];
  const re = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const name = /\bname="([^"]*)"/.exec(m[1])?.[1] ?? "(unknown)";
    const inner = m[2] ?? "";
    const failed = /<(?:failure|error)\b/.test(inner);
    const failMsg = /<(?:failure|error)\b[^>]*\bmessage="([^"]*)"/.exec(inner)?.[1];
    results.push({ tier: "unit", name, status: failed ? "fail" : "pass", error: failed ? (failMsg ?? "assertion failed") : undefined });
  }
  return results;
}

/** Parse a VS Test `.trx` report (`dotnet test --logger trx`) into the same
 *  `{ tier: "unit", name, status, error }` rows.  TRX carries one
 *  `<UnitTestResult testName="…" outcome="Passed|Failed">` per test; a failure
 *  nests `<Output><ErrorInfo><Message>…`. */
export function parseTrx(xml) {
  const results = [];
  const re = /<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const name = /\btestName="([^"]*)"/.exec(m[1])?.[1] ?? "(unknown)";
    const outcome = /\boutcome="([^"]*)"/.exec(m[1])?.[1] ?? "";
    const failed = outcome !== "Passed";
    const msg = /<Message>([\s\S]*?)<\/Message>/.exec(m[2] ?? "")?.[1]?.trim();
    results.push({ tier: "unit", name, status: failed ? "fail" : "pass", error: failed ? (msg ?? outcome) : undefined });
  }
  return results;
}
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
 *  row any other value; a `requires currentUser.role == "agent"` op is satisfied.
 *  `orgId` carries the same value under a second name, for the fixture whose
 *  tenancy claim is deliberately NOT called `tenantId` (tenancy-claim-name):
 *  each backend maps only the claims its own `user { … }` block declares, so an
 *  extra key is inert everywhere else. */
export const DEV_CLAIMS = JSON.stringify({ tenantId: "acme", orgId: "acme", role: "agent" });

/** The SECOND dev-stub principal: **authenticated but not authorized** (M-T9.28).
 *
 *  Until this existed the behavioural tier had exactly ONE identity, so the only
 *  authz arm it could assert was "the gate lets the satisfying principal
 *  through" — a gate emitted as a no-op passes that just as well.  Three
 *  consumers are on record as blocked on the gap: M-T9.28's authz-surface
 *  census, M-T9.25 round 2's 401/403 problem-arm sweep, and M-T9.11's 4xx wire
 *  goldens.
 *
 *  Same SHAPE as `DEV_CLAIMS` — same tenancy claims, so a probe with it stays
 *  inside the tenant and the only thing that differs is the authorization
 *  predicate — but `role` is deliberately a value no fixture's `requires`
 *  accepts.  Keep it that way: a fixture that starts granting `"visitor"`
 *  silently turns every 403 arm into a 2xx and the ladder stops proving
 *  anything.  Strings only, for the same reason `DEV_CLAIMS` is strings only
 *  (the non-node backends honour only string claims).
 *
 *  The OIDC twin is `oidc.unauthorizedToken` (oidc-mock.mjs) — same issuer, same
 *  signing key, `realm_access.roles` set to the same non-granting value. */
export const DEV_CLAIMS_UNAUTHORIZED = JSON.stringify({
  tenantId: "acme",
  orgId: "acme",
  role: "visitor",
});

/** The authenticated-but-unauthorized credential for one case, in that system's
 *  auth flavour — the ONE place all five runner legs derive it, so "what
 *  unauthorized means" cannot drift between them.
 *
 *  dev-stub: the same `x-loom-dev-claims` channel the authorized principal
 *  rides, carrying the non-granting claims.  OIDC: a second mock-issuer token —
 *  same key and same issuer, so it VERIFIES and the ONLY thing separating it
 *  from the authorized principal by the time a request reaches a route is the
 *  authorization predicate.  That is what makes a 403 here mean "the gate
 *  denied" rather than "the verifier rejected" (which would be a 401).
 *
 *  `null` (no auth, or OIDC without a mock issuer) means the ladder cannot run
 *  at all and the runner skips it. */
export function unauthorizedCredentials(authMode, unauthorizedToken) {
  if (authMode === "oidc") {
    return unauthorizedToken ? { authorization: `Bearer ${unauthorizedToken}` } : null;
  }
  if (authMode === "devstub") {
    return { "x-loom-dev-claims": Buffer.from(DEV_CLAIMS_UNAUTHORIZED).toString("base64") };
  }
  return null;
}

/** Per-case authorization-ladder probes (M-T9.28 slice 1).
 *
 *  Keyed by case name; the runner hands the matching entry to `__authzLadder`
 *  in the shared recorder preamble.  Slice 1 is deliberately a HAND-WRITTEN
 *  spec over one gated surface — slice 2 replaces this map with a census
 *  DERIVED from the enriched IR (every `requires` / `policy` / `mask unless` /
 *  tenancy stance), at which point this map goes away.  It is here to prove the
 *  harness seam carries a real ladder, not to be the census.
 *
 *  Shape:
 *    seed    — what the AUTHORIZED principal performs first, so the gated
 *              surface has a row to address.  `{ path, body }` (method defaults
 *              to POST), or an ARRAY of those to run in order — the first id
 *              any of them returns is what `{id}` substitutes.  A non-2xx seed
 *              step fails the ladder rather than being measured as denial.
 *    gated   — the `requires`-guarded surface, `{ method, path, body }`, or an
 *              ARRAY of them when one system gates several.  `{id}` in `path`
 *              is substituted with the seeded id; `label` names the surface in
 *              the arm output and a per-surface `arms` overrides the spec-level
 *              one.
 *    arms    — expected status per identity.  `null` means "not expressible on
 *              this system's auth flavour" and the arm is SKIPPED (see
 *              `anonymousNote`), never silently passed.
 *
 *  `anonymous: null` on the dev-stub cases is not an oversight: the emitted
 *  dev-stub verifier (`index.ts`, `registerUserVerifier`) accepts EVERY request
 *  and falls back to its built-in identity when no `x-loom-dev-claims` header is
 *  present.  Under the dev stub there is therefore no anonymous caller to
 *  express — omitting credentials yields the built-in admin, not a 401.  Only
 *  the OIDC flavour, whose verifier rejects a missing/invalid bearer, can assert
 *  that rung. */
export const AUTHZ_LADDERS = {
  "auth-simple": {
    seed: { path: "/api/tickets", body: { subject: "authz ladder probe", open: true } },
    gated: { method: "POST", path: "/api/tickets/{id}/close", body: {} },
    arms: { anonymous: null, unauthorized: 403, authorized: 204 },
    anonymousNote: "dev-stub verifier accepts every request — no anonymous caller exists",
  },
  "auth-oidc": {
    seed: { path: "/api/tickets", body: { subject: "authz ladder probe", open: true } },
    gated: { method: "POST", path: "/api/tickets/{id}/close", body: {} },
    arms: { anonymous: 401, unauthorized: 403, authorized: 204 },
  },

  /** The READ side (read-gates.ddd).  Three distinct emission sites, each of
   *  which shipped ungated on some subset of backends while every compile tier
   *  stayed green — the exact #2446 shape, on reads instead of writes:
   *
   *    1. `find all(): T[] requires` — java/python/elixir each special-case
   *       `all` out of the per-find route loop and emitted the bespoke list
   *       route without reading its `requires`.
   *    2. a FOLDED projection's gate — it had no surface to be spelled on at
   *       all until the gate moved to the projection declaration header.
   *    3. a QUERY-TIME projection's gate.
   *
   *  The fixture's `test e2e` drives these same three surfaces with the
   *  AUTHORIZED principal, so the two halves pin the guard to its predicate
   *  from both sides: an always-deny guard fails the e2e, a no-op guard fails
   *  the `unauthorized` arms here.  Reads are non-mutating, so the surface
   *  ordering carries no state between them.
   *
   *  `seed` is two steps because the folded read model is populated by an
   *  EVENT, not by the create: `place()` is what emits `OrderPlaced`.  Probing
   *  an empty read model would make a 403 indistinguishable from a 200 over
   *  nothing. */
  "read-gates": {
    seed: [
      { path: "/api/orders", body: { code: "ladder", total: "10.00", open: true } },
      { path: "/api/orders/{id}/place", body: {} },
    ],
    gated: [
      { label: "gated list read", method: "GET", path: "/api/orders" },
      { label: "folded projection", method: "GET", path: "/api/projections/order_book" },
      { label: "folded projection by key", method: "GET", path: "/api/projections/order_book/{id}" },
      { label: "query-time projection", method: "GET", path: "/api/projections/open_orders" },
    ],
    arms: { anonymous: null, unauthorized: 403, authorized: 200 },
    anonymousNote: "dev-stub verifier accepts every request — no anonymous caller exists",
  },
};

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
  },
  java: {},
  // The DAPPER adapter of the .NET backend (`run-dapper.mjs` forces this exact
  // clause, and looks the skip set up by it).
  "dotnet { persistence: dapper }": {
    // DRAINED — all three entries (`projection-aggregation`, `projection-groupby`,
    // `read-gates`) claimed one boundary: "dapper emits no query-time projection
    // reads, `loom.dapper-unsupported` refuses to generate".  That claim was true
    // when `src/generator/dotnet/query-projection-emit.ts` had no `dapper` branch
    // at all (#2468); M-T6.25 ported the four direct-table arms to raw Npgsql, so
    // the three fixtures generate, compile and answer on this adapter.  The
    // adapter's own oracle agrees and is the ratchet that would have caught a
    // stale entry here: `test/e2e/corpus-dotnet-dapper-build.test.ts` now carries
    // `DAPPER_UNSUPPORTED = { "tenancy-hierarchy": … }` and nothing else, and it
    // FAILS an entry whose `loom.dapper-unsupported` no longer fires.  Deleting
    // these three RE-ARMS boots that had never run once on this leg.
  },
  elixir: {
    // B19 (`seed-values`) is FIXED — M-T6.37 landed the Ecto seeder, so this leg
    // now runs the collection reads over seeded rows like the other four:
    // `<Ctx>.Seeds` (elixir/vanilla/seed-emit.ts) inserts domain rows through the
    // aggregate's repository changeset, `raw` rows as schema-qualified INSERTs,
    // ship-once per dataset behind the `__loom_seed` marker, invoked from
    // `Application.start/2` on a SERVING node.  Its skip entry is deleted rather
    // than re-worded: an allowlist ratchets, so the fix removes the waiver.
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
