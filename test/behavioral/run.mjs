// Headless behavioral test tier.
//
// For each curated corpus case: generate the system with the repo
// toolchain, then boot its single `platform: node` (Hono) deployable on
// PGlite (Postgres-in-WASM, in-process — no docker) and run its EMITTED
// suites:
//   - api : the generated `e2e/<Sys>.e2e.test.ts` (`test e2e … against
//           <node backend>`), dispatched straight into `app.fetch`.
//   - unit: the generated pure-domain `*.test.ts` (`test "…"` blocks).
//
// It then joins the outcomes onto the generated requirements graph
// (.loom/traceability.json) via `computeVerification` for a per-system
// Definition-of-Done verdict.
//
// This promotes the behavioral domain assertions — which otherwise only
// run nightly in the docker `conformance-full` leg — to a fast, per-PR,
// docker-free gate for the Hono/TS backend.  It reuses the playground's
// own runners (web/src/testing/*, web/src/runtime/ddl, src/verify) so the
// node tier and the in-browser Tests tab share one execution path.
//
// Usage:  npm ci  (in this dir, once) ; node run.mjs [caseName...]
// Exit code is non-zero if any case errors, any test fails, or any
// requirement is FAILING in the rollup.

import { build, transform } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AUTHZ_LADDERS, DEV_CLAIMS, featureCases, sharedSystemCases, unauthorizedCredentials } from "./cases.mjs";
import { makeWireGate, recorderPreamble } from "./wire-differential.mjs";
import { startMockIssuer } from "./oidc-mock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORK = join(HERE, ".work");
const SHIM = join(HERE, "vitest-shim.mjs");

/** The in-process mock OIDC issuer, started on demand when the corpus contains
 *  an `auth {}` (OIDC) system.  `null` until then; runCase reads its token. */
let oidc = null;

/** Recursively collect files under `dir` matching `pred`. */
function walk(dir, pred, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

/** The one `platform: node` deployable dir: has both http/index.ts and db/schema.ts. */
function findNodeDeployable(genDir) {
  const hits = walk(genDir, (p) => p.endsWith("/http/index.ts")).map((p) =>
    resolve(p, "..", ".."),
  );
  const dirs = [...new Set(hits)].filter((d) => existsSync(join(d, "db", "schema.ts")));
  if (dirs.length !== 1) {
    throw new Error(
      `expected exactly one node (Hono) deployable, found ${dirs.length}: ${dirs.join(", ")}`,
    );
  }
  return dirs[0];
}

/** Synthesise the per-case boot+run entry (bundled by esbuild). */
function entrySource({ deplDir, e2eFile, unitFiles, traceFile, authMode, bearerToken, unauthorizedToken, authzLadder, seedFile }) {
  const J = JSON.stringify;
  // When the deployable is `auth: required` the generated boot module
  // (index.ts) registers a verifier before serving — but we boot via
  // `createApp` (http/index.ts), which does NOT, so `verifyUserOrThrow` would
  // throw "No user verifier is registered".  Re-register the SAME verifier the
  // generated boot module would, matched to the auth flavour:
  //   • devstub — no `auth {}` block: re-register the dev-stub (accept every
  //     request as a built-in admin; merge base64-`x-loom-dev-claims` over it),
  //     so the E2E_DEV_CLAIMS principal resolves exactly as it does at runtime.
  //   • oidc — an `auth {}` block: register the generated OIDC verifier
  //     unchanged (validates the bearer JWT against the issuer's JWKS).  The
  //     mock issuer (oidc-mock.mjs) + OIDC_ISSUER env stand in for Keycloak;
  //     the bearer token is forwarded via E2E_BEARER_TOKEN.  No short-circuit —
  //     the real JWT path runs.
  let authImport = "";
  let authRegister = "";
  if (authMode === "oidc") {
    authImport = `import { registerOidcVerifier } from ${J(join(deplDir, "auth", "oidc.ts"))};`;
    authRegister = "registerOidcVerifier();";
  } else if (authMode === "devstub") {
    // The GENERATED registrar, not a copy of it (#2548).  This used to inline
    // its own verifier whose identity was a fixed
    // `{ id, tenantId: "admin" }` — a principal no backend produces: the
    // generated stub fills the DECLARED `user { … }` shape, so on `auth-simple`
    // (`user { id  role }`) the harness answered `tenantId` and dropped `role`.
    // Every `/api/auth/me` this leg records is the oracle for the other four,
    // so a hand-copied identity means the answer key is fiction.  Importing
    // `auth/dev-stub.ts` — the module `index.ts` itself calls — makes the boot
    // path the harness takes and the boot path a real deployment takes register
    // the same thing, the way the OIDC arm above already does.
    authImport = `import { registerDevStubVerifier } from ${J(join(deplDir, "auth", "dev-stub.ts"))};`;
    authRegister = "registerDevStubVerifier();";
  }
  const bearerEnv = bearerToken ? `, E2E_BEARER_TOKEN: ${J(bearerToken)}` : "";
  // The authenticated-but-unauthorized credential, in this system's auth
  // flavour (M-T9.28) — derived by the shared helper all five legs use.
  const unauthorizedCreds = unauthorizedCredentials(authMode, unauthorizedToken);
  // FIRST-BOOT SEEDS.  The generated entrypoint (index.ts) runs
  // `migrate` → `runSeeds` → `createApp`; booting via `createApp` skipped the
  // middle step, so a system carrying `seed` datasets started with EMPTY tables
  // here and with the `default` dataset's rows on the four cross-backend legs
  // (which boot the real entrypoint).  That divergence made every collection
  // read on a seeded aggregate unassertable — the wire golden compares whole
  // bodies, so one `all()` would have recorded the harness gap as a four-way
  // wire divergence (`R.unseededListRead` in test/ir/api-caller-census-pins.ts).
  // Running the EMITTED seeder — not a re-implementation — is what makes the
  // oracle leg start from the same table as the others; it also gives `seed`
  // datasets their first runtime coverage on this leg at all.
  const seedImport = seedFile ? `import { runSeeds } from ${J(seedFile)};` : "";
  const seedRun = seedFile ? "await runSeeds(db);" : "";
  return `
${recorderPreamble()}
import { synthDDL } from ${J(join(REPO, "web/src/runtime/ddl.ts"))};
import { loadApiTests } from ${J(join(REPO, "web/src/testing/run-api-tests.ts"))};
import { createHarness, runTests } from ${J(join(REPO, "web/src/testing/harness.ts"))};
import { computeVerification } from ${J(join(REPO, "src/verify/verification.ts"))};
import { createApp } from ${J(join(deplDir, "http/index.ts"))};
import * as schema from ${J(join(deplDir, "db/schema.ts"))};
${authImport}
${seedImport}
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { is, Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { build as esbuildBuild, transform as esbuildTransform } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const E2E_FILE = ${J(e2eFile)};
const DEV_CLAIMS = ${J(DEV_CLAIMS)};
const AUTHZ_LADDER = ${J(authzLadder ?? null)};
const UNAUTHORIZED_CREDS = ${J(unauthorizedCreds)};
const UNIT_FILES = ${J(unitFiles)};
const TRACE_FILE = ${J(traceFile)};
const SHIM = ${J(SHIM)};

export async function run() {
  const pglite = new PGlite();
  await pglite.exec(synthDDL(schema, { is, Table, getTableConfig }));
  const db = drizzle(pglite, { schema });
  ${seedRun}
  ${authRegister}
  const app = createApp(db);

  // Recorded at the ONE dispatch chokepoint — see wire-differential.mjs.
  const dispatch = __record(async (req) => {
    const r = await app.fetch(new Request(req.url, { method: req.method, headers: req.headers, body: req.body ?? undefined }));
    const headers = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    return { ok: true, response: { status: r.status, statusText: r.statusText, headers, body: await r.text() }, durationMs: 0 };
  });

  const out = [];
  if (E2E_FILE) {
    const compile = async (ts) => (await esbuildTransform(ts, { loader: "ts", format: "cjs" })).code;
    const cases = await loadApiTests({ source: readFileSync(E2E_FILE, "utf8"), compile, dispatch, env: { E2E_DEV_CLAIMS: DEV_CLAIMS${bearerEnv} } });
    for (const r of await runTests(cases)) out.push({ tier: "api", ...r });
    // RS-9 — appended AFTER the tier so the probes never shift the ordinals the
    // golden aligns on, and so a failing tier is diagnosed on its own requests.
    await __frameworkProbes(dispatch, { auth: ${J(authMode !== "none")} });
    // M-T9.28 — the authorization ladder, on the cases that declare one.  Runs
    // last and off the RECORDER (see __authzLadder) so it neither shifts wire
    // ordinals nor perturbs the tier it follows.
    if (AUTHZ_LADDER && UNAUTHORIZED_CREDS) {
      for (const r of await __authzLadder(AUTHZ_LADDER, {
        authorized: __authHeaders,
        unauthorized: UNAUTHORIZED_CREDS,
      })) out.push(r);
    }
  }

  const req = createRequire(import.meta.url);
  for (const uf of UNIT_FILES) {
    const built = await esbuildBuild({ entryPoints: [uf], bundle: true, format: "cjs", platform: "node", packages: "external", alias: { vitest: SHIM }, write: false, logLevel: "silent" });
    const harness = createHarness();
    globalThis.__loomUnit = harness;
    const mod = { exports: {} };
    new Function("module", "exports", "require", built.outputFiles[0].text)(mod, mod.exports, req);
    // Keep __loomUnit set THROUGH runTests — the shim reads expect at
    // body-run time, not registration time.
    for (const r of await runTests(harness.tests)) out.push({ tier: "unit", ...r });
    delete globalThis.__loomUnit;
  }

  await pglite.close?.();

  // Definition-of-Done rollup: join these outcomes onto the generated
  // requirements graph (.loom/traceability.json) via the same
  // computeVerification the playground Tests tab uses.  Null when the
  // source declares no requirements/testCases.
  let verification = null;
  try {
    const trace = JSON.parse(readFileSync(TRACE_FILE, "utf8"));
    // Harness probes are not DSL test cases — they have no requirement to join
    // onto, so they stay out of the Definition-of-Done rollup entirely rather
    // than arriving as unmatched (or, worse, skip-status) outcomes.
    const outcomes = out
      .filter((r) => r.tier !== "authz")
      .map((r) => ({ name: r.name, suite: r.suite, status: r.status }));
    verification = computeVerification(trace.index, trace.requirements.map((r) => r.id), outcomes);
  } catch {
    /* no traceability emitted — verification stays null */
  }

  return { results: out, verification, wire: __wire };
}
`;
}

/** Load the typed feature corpus (`test/fixtures/corpus/manifest.ts`) via a
 *  one-shot esbuild bundle — the SAME single source of truth the generation and
 *  compile tiers iterate, so the behavioural tier needs no hand-maintained
 *  per-backend allowlist. */
async function runCase(c) {
  const genDir = mkdtempSync(join(tmpdir(), `loom-bh-${c.name}-`));
  const workDir = join(WORK, c.name);
  mkdirSync(workDir, { recursive: true });
  try {
    const srcPath = join(workDir, "system.ddd");
    writeFileSync(srcPath, c.source);
    execFileSync("node", [join(REPO, "bin/cli.js"), "generate", "system", srcPath, "-o", genDir], { stdio: "pipe" });
    const deplDir = findNodeDeployable(genDir);
    const e2eDir = join(genDir, "e2e");
    // Tiers are DERIVED from the emitted file map, not declared: a system that
    // emits an e2e suite runs the api tier; one that emits unit tests runs the
    // unit tier. No api/unit flags to drift out of sync.
    const e2eFile = existsSync(e2eDir)
      ? walk(e2eDir, (p) => p.endsWith(".e2e.test.ts"))[0] ?? null
      : null;
    const unitFiles = walk(deplDir, (p) => p.endsWith(".test.ts") && !p.includes("/e2e/"));

    const traceFile = join(genDir, ".loom", "traceability.json");
    // Auth flavour drives verifier re-registration (see entrySource):
    //   • auth/oidc.ts present → OIDC (`auth {}` block): register the real OIDC
    //     verifier + forward a mock-issuer bearer token.
    //   • auth/verifier.ts only → dev-stub (`auth: required`, no block).
    //   • neither → auth-less.
    const authMode = existsSync(join(deplDir, "auth", "oidc.ts"))
      ? "oidc"
      : existsSync(join(deplDir, "auth", "verifier.ts"))
        ? "devstub"
        : "none";
    const bearerToken = authMode === "oidc" ? oidc?.token ?? null : null;
    const unauthorizedToken = authMode === "oidc" ? oidc?.unauthorizedToken ?? null : null;
    // `db/seed.ts` exists iff the system declares `seed` datasets — same
    // derived-from-the-file-map rule as the tiers above, so a system without
    // seeds boots byte-identically to before.
    const seedPath = join(deplDir, "db", "seed.ts");
    const seedFile = existsSync(seedPath) ? seedPath : null;
    const entry = join(workDir, "entry.mts");
    const bundle = join(workDir, "bundle.mjs");
    writeFileSync(entry, entrySource({
      deplDir, e2eFile, unitFiles, traceFile, authMode, bearerToken, unauthorizedToken,
      authzLadder: AUTHZ_LADDERS[c.name] ?? null,
      seedFile,
    }));
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node20", packages: "external", logLevel: "warning" });
    const { run } = await import(pathToFileURL(bundle).href);
    return await run();
  } finally {
    rmSync(genDir, { recursive: true, force: true });
  }
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));

// Feature cases — DERIVED from the typed corpus manifest: every feature that
// declares the `node` backend AND carries a behavioural block. One source of
// truth (manifest.ts + the `.ddd`), swapped to `node` in-process. No allowlist.
const features = await featureCases("node", "node", WORK);

// Shared tokenized systems (systems/*.ddd) — run on every backend.  ALL of them
// run here, `sales` included: node is the ORACLE the wire goldens are captured
// from (M-T9.11), so it must exercise every shared case the other four backends
// are gated against — an oracle with a blind spot is the coverage hole this
// gate exists to close.  (The richer UI-carrying `sales-system` example below
// still runs too; it drives the requirements-verification rollup.  The overlap
// costs one extra in-process PGlite case.)
const shared = sharedSystemCases("node");

// Example cases — the small curated set of broad, multi-aggregate systems that
// aren't single-feature corpus fixtures; the one thing left in corpus.json. Its
// UI-only entries are run-ui.mjs's job and are filtered out here.
const exampleCases = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8")).cases
  .filter((c) => !String(c.ddd).startsWith("corpus:") && (c.api || c.unit))
  .map((c) => ({ name: c.name, source: readFileSync(join(REPO, c.ddd), "utf8") }));

const corpus = [...features, ...shared, ...exampleCases].filter(
  (c) => only.length === 0 || only.includes(c.name),
);

// Stand up the in-process mock OIDC issuer once if any case carries an
// `auth {}` (OIDC) block — the `auth:` in `auth: required` is a plain marker
// (dev-stub), the `auth {` block is the OIDC provider config.  Setting
// OIDC_ISSUER before any generated `auth/oidc.ts` module is imported is what
// lets its boot-time `const ISSUER = process.env.OIDC_ISSUER` capture the mock.
if (corpus.some((c) => /\n\s*auth\s*\{/.test(c.source))) {
  oidc = await startMockIssuer();
  process.env.OIDC_ISSUER = oidc.issuer;
}

// Both tiers gate: `api` (emitted `test e2e`) and `unit` (emitted
// aggregate `test`). A boot/infra error, or a FAILING requirement in the
// Definition-of-Done rollup, fails the case.
let pass = 0, fail = 0, errored = 0, reqFailing = 0, skipped = 0;
// Cross-backend runtime wire differential (M-T9.11): every request this tier
// makes is recorded at the dispatch chokepoint and compared to the committed
// canonical golden.  node is the ORACLE the goldens are captured from, so here
// the gate doubles as "the golden still describes the reference backend".
const wire = makeWireGate("node", WORK);
for (const c of corpus) {
  process.stdout.write(`\n▶ ${c.name}\n`);
  let out;
  try {
    out = await runCase(c);
  } catch (err) {
    errored++;
    process.stdout.write(`  ERROR booting/running: ${err?.message ?? err}\n`);
    continue;
  }
  for (const r of out.results) {
    // `skip` is a THIRD outcome, not a quiet pass: the authz ladder reports an
    // arm its auth flavour cannot express (a dev-stub system has no anonymous
    // caller) as skipped, so the gap stays visible in the log instead of being
    // counted as a rung that held.
    if (r.status === "skip") {
      skipped++;
      process.stdout.write(`  ○ [${r.tier}] ${r.name}\n`);
      continue;
    }
    const ok = r.status === "pass";
    ok ? pass++ : fail++;
    process.stdout.write(`  ${ok ? "✓" : "✗"} [${r.tier}] ${r.name}\n`);
    if (!ok && r.error) process.stdout.write(`      ${String(r.error).split("\n")[0]}\n`);
  }
  const v = out.verification;
  if (v && v.summary.total > 0) {
    const s = v.summary;
    reqFailing += s.failing;
    process.stdout.write(
      `  ⟐ requirements: ${s.verified}/${s.total} verified` +
        `${s.failing ? `, ${s.failing} FAILING` : ""}` +
        `${s.unverified ? `, ${s.unverified} unverified` : ""}` +
        `${s.untested ? `, ${s.untested} untested` : ""}\n`,
    );
    for (const [id, r] of Object.entries(v.requirements)) {
      if (r.verdict === "FAILING") process.stdout.write(`      ✗ ${id} FAILING (${r.failingTestCaseIds.join(", ")})\n`);
    }
  }
  await wire.check(c.name, out.wire, out.results);
}

await oidc?.stop();

const wireBad = await wire.finish();

const reqTail = reqFailing ? `, ${reqFailing} requirement(s) FAILING` : "";
process.stdout.write(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}${reqTail}${errored ? `, ${errored} cases errored` : ""}\n`);
process.exit(fail > 0 || errored > 0 || reqFailing > 0 || wireBad > 0 ? 1 : 0);
