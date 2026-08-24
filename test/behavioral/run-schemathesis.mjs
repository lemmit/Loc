// Spec-driven API contract fuzzing (M-T9.21) — the node/Hono leg.
//
// Every other runtime gate drives the backends with EXAMPLE-shaped input: the
// emitted `test e2e` suite, the corpus fixtures, the hand-written negatives in
// the auth/tenancy legs.  The adversarial request space — wrong verb, absent
// body, missing/extra/malformed fields, boundary numbers, non-UUID references —
// is exercised only where a human happened to write the case.  That is the
// class that produced #2485 (wrong verb → framework 404), #2440 (missing
// required accepted on PUT), #2442 (malformed claim → 500), #2472 (framework
// errors off RFC 7807), #2500 (401 violating an RFC 9110 MUST) and #2261
// (malformed token → 500) inside nine days.
//
// So: boot the generated Hono deployable and feed it its OWN emitted
// `/openapi.json` to Schemathesis, which derives thousands of cases from the
// schema and asserts the server never 500s, never violates its own declared
// response schema, and honours the `required`/`format`/`enum`/bounds it
// published.  Complements M-T9.11: the wire differential checks the backends
// against EACH OTHER, this checks each backend against ITS OWN contract.
//
// Boot recipe: the cheapest one in the repo that serves a real port — the
// behavioural tier's PGlite-in-process boot (run.mjs), wrapped in
// `@hono/node-server` because Schemathesis is an out-of-process HTTP client and
// cannot reach `app.fetch`.  No docker, no npm install in the generated tree.
// The other four backends have no in-process Postgres and boot a real process
// against a sidecar instead — run-schemathesis-backend.mjs.  Everything after
// "the server is listening" is shared: schemathesis-core.mjs.
//
// Known failures are an explicit RATCHETING waiver file
// (schemathesis-waivers.json) — never a silent skip, and a waiver that stops
// reproducing fails the run so a fix deletes its waiver in the same PR.
//
// Usage:
//   cd test/behavioral && npm ci        # once
//   LOOM_SCHEMATHESIS=1 node run-schemathesis.mjs [caseName...]
// or, from the repo root:  npm run test:schemathesis
//
// Env: see schemathesis-core.mjs (LOOM_SCHEMATHESIS, …_MAX_EXAMPLES, …_SEED,
// …_BIN, …_UPDATE).
//
// Exit code is non-zero on any unwaived failure, any stale waiver, or a boot
// error.  Findings register: docs/audits/schemathesis-findings-2026-08.md.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fuzzLeg, REPO, walk } from "./schemathesis-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, ".work-schemathesis");

/** Feature-rich fixtures: broad multi-aggregate systems with exactly ONE
 *  `platform: node` deployable (so the boot is unambiguous), covering creates,
 *  named operations, destroys, paged finds, find-by, value objects, money,
 *  enums, date-times and a workflow.  The cross-backend legs re-platform these
 *  same two, so the fixture is the constant. */
const CASES = [
  { name: "storefront-system", ddd: "web/src/examples/storefront-system.ddd" },
  { name: "sales-system", ddd: "web/src/examples/sales-system.ddd" },
];

// ---------------------------------------------------------------------------
// Boot (mirrors run.mjs — PGlite in-process, plus a real listening port)
// ---------------------------------------------------------------------------

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

/** Synthesise the boot entry: PGlite + the generated app, served on a real
 *  ephemeral port.  Schemathesis is an out-of-process client, so unlike run.mjs
 *  the app cannot stay behind `app.fetch`. */
function entrySource({ deplDir, authMode }) {
  const J = JSON.stringify;
  // Same verifier re-registration run.mjs does: `createApp` (http/index.ts) does
  // NOT register one — only the generated boot module (index.ts) does — so an
  // `auth: required` deployable would throw "No user verifier is registered" on
  // the first request and every finding would collapse into that one 500.
  let authImport = "";
  let authRegister = "";
  if (authMode === "devstub") {
    // The GENERATED registrar (#2548) — same reason as run.mjs: a hand-written
    // identity is one this backend never actually serves, and here it would
    // also mean fuzzing `/api/auth/me` against a shape the emitter never emits.
    authImport = `import { registerDevStubVerifier } from ${J(join(deplDir, "auth", "dev-stub.ts"))};`;
    authRegister = "registerDevStubVerifier();";
  }
  return `
import { synthDDL } from ${J(join(REPO, "web/src/runtime/ddl.ts"))};
import { createApp } from ${J(join(deplDir, "http/index.ts"))};
import * as schema from ${J(join(deplDir, "db/schema.ts"))};
${authImport}
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { is, Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { serve } from "@hono/node-server";

export async function boot() {
  const pglite = new PGlite();
  await pglite.exec(synthDDL(schema, { is, Table, getTableConfig }));
  const db = drizzle(pglite, { schema });
  ${authRegister}
  const app = createApp(db);
  const server = await new Promise((res, rej) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => res(s));
    s.on?.("error", rej);
  });
  const port = server.address().port;
  return {
    port,
    stop: async () => {
      await new Promise((res) => server.close(res));
      await pglite.close?.();
    },
  };
}
`;
}

/** The generated app's own `onError` writes the unhandled exception to
 *  `console.error`.  That trace is the most valuable artefact in the run — it
 *  names the line that produced the 500 — but at 20 examples × 29 operations it
 *  is thousands of lines of stdout.  So: capture it, dedupe by first line, and
 *  hand it to the core in the same shape the spawned legs scrape off stderr.
 *
 *  IN-PROCESS, unlike every other leg: the app under test runs in THIS node
 *  process, so its `console.error` is ours to intercept — there is no stderr to
 *  scrape. */
function captureAppErrors() {
  const original = console.error;
  const seen = new Map();
  console.error = (...args) => {
    const text = args
      .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : String(a)))
      .join(" ");
    const head = text.split("\n")[0].trim();
    const entry = seen.get(head);
    if (entry) entry.count++;
    else seen.set(head, { count: 1, sample: text });
  };
  return {
    drain: () => {
      const out = [...seen.entries()].map(([head, v]) => ({ head, ...v }));
      seen.clear();
      return out;
    },
    restore: () => {
      console.error = original;
    },
  };
}

/** Generate + boot one case; returns the core's boot shape. */
async function boot(c) {
  const genDir = mkdtempSync(join(tmpdir(), `loom-st-${c.name}-`));
  const workDir = join(WORK, c.name);
  mkdirSync(workDir, { recursive: true });
  execFileSync(
    "node",
    [join(REPO, "bin/cli.js"), "generate", "system", join(REPO, c.ddd), "-o", genDir],
    { stdio: "pipe" },
  );
  const deplDir = findNodeDeployable(genDir);
  const authMode = existsSync(join(deplDir, "auth", "oidc.ts"))
    ? "oidc"
    : existsSync(join(deplDir, "auth", "verifier.ts"))
      ? "devstub"
      : "none";
  if (authMode === "oidc") {
    rmSync(genDir, { recursive: true, force: true });
    throw new Error(
      `${c.name}: OIDC deployables are not fuzzed yet (the bearer material would have to be fed to schemathesis) — pick an auth-less or dev-stub fixture`,
    );
  }
  const entry = join(workDir, "entry.mts");
  const bundle = join(workDir, "bundle.mjs");
  writeFileSync(entry, entrySource({ deplDir, authMode }));
  await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
    logLevel: "warning",
  });
  const { boot: bootApp } = await import(pathToFileURL(bundle).href);
  const errs = captureAppErrors();
  let started;
  try {
    started = await bootApp();
  } catch (err) {
    errs.restore();
    rmSync(genDir, { recursive: true, force: true });
    throw err;
  }
  return {
    base: `http://127.0.0.1:${started.port}`,
    workDir,
    drainErrors: () => errs.drain(),
    stop: async () => {
      await started.stop();
      errs.restore();
      rmSync(genDir, { recursive: true, force: true });
    },
  };
}

// The generated app logs the full observability catalog to stdout — one pino
// line per fuzzed request, thousands of them, drowning the findings.  `silent`
// is pino's own off switch, read by the emitted logger at module init, so it
// has to be set before the bundle is imported.
process.env.LOG_LEVEL ??= "silent";

await fuzzLeg({ backend: "node", cases: CASES, work: WORK, boot });
