// Spec-driven API contract fuzzing (M-T9.21) — the Hono leg.
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
// Env:
//   LOOM_SCHEMATHESIS=1            required — the opt-in gate (else: skip, exit 0)
//   LOOM_SCHEMATHESIS_MAX_EXAMPLES per-operation case budget (default 20)
//   LOOM_SCHEMATHESIS_SEED         generation seed (default 20260811; pinned so
//                                  the waiver ratchet is reproducible)
//   LOOM_SCHEMATHESIS_BIN          schemathesis executable (default `schemathesis`)
//   LOOM_SCHEMATHESIS_UPDATE=1     rewrite the waiver file from this run — a
//                                  DELIBERATE rebaseline, review the diff
//
// Exit code is non-zero on any unwaived failure, any stale waiver, or a boot
// error.  Findings register: docs/audits/schemathesis-findings-2026-08.md.

import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORK = join(HERE, ".work-schemathesis");
const WAIVERS = join(HERE, "schemathesis-waivers.json");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The checks we assert.  `not_a_server_error` and `response_schema_conformance`
 *  are the mission floor; the rest each mechanize one of the escaped-bug shapes
 *  above — `status_code_conformance` is the #2472 class (a status the contract
 *  never declared), `unsupported_method` the #2485 class (wrong verb), and
 *  `negative_data_rejection` the #2440 class (a schema-violating body accepted). */
const CHECKS = [
  "not_a_server_error",
  "response_schema_conformance",
  "status_code_conformance",
  "content_type_conformance",
  "unsupported_method",
  "negative_data_rejection",
];

/** Phases.  `stateful` is deliberately OFF: its findings are labelled
 *  "Stateful tests" rather than by operation, so they cannot be keyed into a
 *  stable waiver — enabling it is a follow-up slice that needs a per-link key. */
const PHASES = "examples,coverage,fuzzing";

/** Feature-rich fixtures: broad multi-aggregate systems with exactly ONE
 *  `platform: node` deployable (so the boot is unambiguous), covering creates,
 *  named operations, destroys, paged finds, find-by, value objects, money,
 *  enums, date-times and a workflow. */
const CASES = [
  { name: "storefront-system", ddd: "web/src/examples/storefront-system.ddd" },
  { name: "sales-system", ddd: "web/src/examples/sales-system.ddd" },
];

const MAX_EXAMPLES = process.env.LOOM_SCHEMATHESIS_MAX_EXAMPLES ?? "20";
const SEED = process.env.LOOM_SCHEMATHESIS_SEED ?? "20260811";
const BIN = process.env.LOOM_SCHEMATHESIS_BIN ?? "schemathesis";
const UPDATE = process.env.LOOM_SCHEMATHESIS_UPDATE === "1";

// ---------------------------------------------------------------------------
// Boot (mirrors run.mjs — PGlite in-process, plus a real listening port)
// ---------------------------------------------------------------------------

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
    authImport = `import { registerUserVerifier } from ${J(join(deplDir, "auth", "verifier.ts"))};`;
    authRegister = `registerUserVerifier(() => ({ id: "00000000-0000-0000-0000-000000000000", tenantId: "admin" }));`;
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
 *  write it beside the report. */
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
    restore: () => {
      console.error = original;
      return [...seen.entries()].map(([head, v]) => ({ head, ...v }));
    },
  };
}

/** Generate + boot one case; returns { port, stop, genDir }. */
async function bootCase(c) {
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
  const { boot } = await import(pathToFileURL(bundle).href);
  const { port, stop } = await boot();
  return { port, workDir, stop: async () => { await stop(); rmSync(genDir, { recursive: true, force: true }); } };
}

// ---------------------------------------------------------------------------
// Schemathesis
// ---------------------------------------------------------------------------

/** Run schemathesis against the booted server + its own emitted spec, and
 *  return the failing (operation, check) keys with one example request each.
 *
 *  ASYNC on purpose: the server under test lives in THIS process (PGlite +
 *  `@hono/node-server`), so a `spawnSync` here would block the event loop and
 *  the app could never answer a single fuzzed request — the run just hangs. */
async function runSchemathesis({ workDir, port }) {
  const specPath = join(workDir, "openapi.json");
  const reportDir = join(workDir, "report");
  rmSync(reportDir, { recursive: true, force: true });
  const args = [
    "run",
    specPath,
    "--url",
    `http://127.0.0.1:${port}`,
    "-c",
    CHECKS.join(","),
    "-n",
    String(MAX_EXAMPLES),
    "--phases",
    PHASES,
    "--seed",
    String(SEED),
    // Hypothesis persists interesting examples and REPLAYS them on the next
    // run.  That is a feature for a developer and poison for a ratchet: the
    // finding set then depends on what a previous run happened to store, so the
    // same commit produces different waiver diffs on two machines.  Off, so the
    // seed is the only input.
    "--generation-database",
    "none",
    "--continue-on-failure",
    "--no-color",
    "--report",
    "ndjson",
    "--report-dir",
    reportDir,
    // One worker: the request ORDER is what makes a data-dependent finding
    // reproduce, and the waiver ratchet needs reproducibility.
    "-w",
    "1",
  ];
  const proc = await new Promise((res, rej) => {
    const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) =>
      rej(
        new Error(
          `could not run \`${BIN}\`: ${err.message}\n` +
            "Install it with `uv tool install schemathesis` (or `pipx install schemathesis`).",
        ),
      ),
    );
    child.on("close", (status) => res({ status, stdout, stderr }));
  });
  writeFileSync(join(workDir, "schemathesis.log"), `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`);
  const ndjson = readdirSync(reportDir)
    .filter((f) => f.endsWith(".ndjson"))
    .map((f) => join(reportDir, f))[0];
  if (!ndjson) {
    throw new Error(
      `schemathesis produced no ndjson report (exit ${proc.status}).\n${proc.stdout}\n${proc.stderr}`,
    );
  }
  return parseFindings(ndjson);
}

/** ndjson → Map<key, {label, check, request, response}>.
 *
 *  The key is `<METHOD> <PATH-TEMPLATE>::<check>` — the operation label
 *  schemathesis reports plus the check that failed.  Deliberately coarse: a
 *  finding is a PROPERTY of an operation, not of one generated body, so the key
 *  stays stable across seeds and shrinking while a root-cause fix still clears
 *  every operation it touches at once. */
function parseFindings(ndjsonPath) {
  const findings = new Map();
  for (const line of readFileSync(ndjsonPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const sf = event.ScenarioFinished;
    if (!sf || !sf.recorder) continue;
    const { label, checks = {}, cases = {}, interactions = {} } = sf.recorder;
    for (const [caseId, results] of Object.entries(checks)) {
      for (const r of results) {
        if (r.status === "success" || r.status === "skip") continue;
        const key = `${label}::${r.name}`;
        if (findings.has(key)) continue;
        const req = interactions[caseId]?.request ?? null;
        findings.set(key, {
          label,
          check: r.name,
          message: (r.failure_info?.failure?.message ?? r.message ?? "").split("\n")[0],
          request: req
            ? { method: req.method, uri: req.uri, body: decodeBody(req) }
            : { method: cases[caseId]?.value?.method, uri: cases[caseId]?.value?.path, body: null },
          status: interactions[caseId]?.response?.status_code ?? null,
        });
      }
    }
  }
  return findings;
}

/** Schemathesis records request bodies as `{"$base64": "..."}` (it preserves the
 *  exact bytes, which is the whole point for a fuzzer). */
function decodeBody(req) {
  const b64 = req.body?.$base64;
  if (!b64) return null;
  try {
    return Buffer.from(b64, "base64").toString("utf8").slice(0, 400);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Waiver ratchet
// ---------------------------------------------------------------------------

/** Waivers are ROOT-CAUSE rules, not per-operation keys.
 *
 *  The first cut keyed a waiver to one exact `<operation>::<check>` and it was
 *  too brittle to gate on: a fuzzer's reach is data-dependent, so the operation
 *  a given bug surfaces on drifts between runs (the UTF-16 length bug showed up
 *  under `sales-system` one run and `storefront-system` the next) — which the
 *  key-level ratchet reports as one stale waiver plus one new finding, twice
 *  wrong.  A rule instead names a check plus an operation PATTERN and points at
 *  the entry in docs/audits/schemathesis-findings-2026-08.md that explains it.
 *
 *  The ratchet still bites, in both directions:
 *    • an observed finding NO rule matches fails the run — a new bug, or a
 *      known one spreading to a surface no rule claimed;
 *    • a rule that matches NOTHING across the whole run fails it too — so
 *      fixing a root cause forces deleting its rule in the same PR.
 *  Rule-level staleness is what makes the second half trustworthy: a rule only
 *  goes quiet when EVERY operation it covers stops failing, which is what a
 *  real fix looks like and what a flake never is. */
function loadRules() {
  if (!existsSync(WAIVERS)) return [];
  const parsed = JSON.parse(readFileSync(WAIVERS, "utf8"));
  return (parsed.waivers ?? []).map((w) => ({ ...w, re: new RegExp(w.operations) }));
}

/** Attribute this run's findings to the rules.  Mutates `rule.hits`. */
function ratchet(findings, rules) {
  const unwaived = [];
  for (const [key, f] of findings) {
    const rule = rules.find((r) => r.check === f.check && r.re.test(f.label));
    if (rule) rule.hits = (rule.hits ?? 0) + 1;
    else unwaived.push([key, f]);
  }
  return unwaived;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (process.env.LOOM_SCHEMATHESIS !== "1") {
  process.stdout.write(
    "schemathesis contract fuzzing skipped — set LOOM_SCHEMATHESIS=1 to run it\n",
  );
  process.exit(0);
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const selected = CASES.filter((c) => only.length === 0 || only.includes(c.name));
if (selected.length === 0) {
  process.stderr.write(`no such case: ${only.join(", ")}\n`);
  process.exit(1);
}

mkdirSync(WORK, { recursive: true });
// The generated app logs the full observability catalog to stdout — one pino
// line per fuzzed request, thousands of them, drowning the findings.  `silent`
// is pino's own off switch, read by the emitted logger at module init, so it
// has to be set before the bundle is imported.
process.env.LOG_LEVEL ??= "silent";
const rules = loadRules();
/** Every finding observed this run, for `--report` and the UPDATE rebaseline. */
const observed = [];
let bad = 0;

for (const c of selected) {
  process.stdout.write(`\n▶ ${c.name}\n`);
  let booted = null;
  let findings;
  const errs = captureAppErrors();
  try {
    booted = await bootCase(c);
    // The spec under test is the one the SERVER publishes — fetched over the
    // wire, not read off disk, so a spec/route disagreement is in scope.
    const spec = await (await fetch(`http://127.0.0.1:${booted.port}/openapi.json`)).json();
    writeFileSync(join(booted.workDir, "openapi.json"), JSON.stringify(spec, null, 2));
    const opCount = Object.values(spec.paths ?? {}).reduce((n, v) => n + Object.keys(v).length, 0);
    process.stdout.write(`  booted on :${booted.port} — ${opCount} operations in the emitted spec\n`);
    findings = await runSchemathesis(booted);
  } catch (err) {
    errs.restore();
    process.stdout.write(`  ERROR: ${err?.message ?? err}\n`);
    bad++;
    await booted?.stop().catch(() => {});
    continue;
  }
  await booted.stop().catch(() => {});
  const appErrors = errs.restore();
  if (appErrors.length > 0) {
    writeFileSync(
      join(booted.workDir, "app-errors.log"),
      appErrors.map((e) => `### ×${e.count}\n${e.sample}\n`).join("\n"),
    );
    process.stdout.write(
      `  ${appErrors.length} distinct unhandled exception(s) in the app (→ app-errors.log):\n`,
    );
    for (const e of appErrors) process.stdout.write(`      ×${e.count} ${e.head}\n`);
  }

  for (const [key, f] of findings) observed.push({ case: c.name, key, ...f });

  const unwaived = ratchet(findings, rules);
  process.stdout.write(`  ${findings.size} finding(s), ${findings.size - unwaived.length} waived\n`);
  for (const [key, f] of unwaived) {
    bad++;
    process.stdout.write(`  ✗ UNWAIVED ${key}\n`);
    process.stdout.write(`      ${f.status ?? "?"} ${f.message}\n`);
    process.stdout.write(
      `      repro: ${f.request.method} ${f.request.uri}${f.request.body ? ` -d '${f.request.body}'` : ""}\n`,
    );
  }
}

// Staleness is judged over the WHOLE run, not per case: a rule covers a root
// cause, and a root cause can surface under either fixture.
for (const r of rules) {
  if (r.hits) continue;
  // `intermittent` rules opt out of the staleness half — and ONLY that half;
  // they still absorb their findings, so a new bug on the same surface is still
  // unwaived.  It is for a finding whose reproduction depends on the fuzzer
  // both writing a value and then reading it back within one run, where absence
  // is genuinely not evidence of a fix.  Every use must say why.
  if (r.intermittent) {
    process.stdout.write(
      `\n· ${r.id} did not reproduce this run (declared intermittent — not treated as stale)\n`,
    );
    continue;
  }
  bad++;
  process.stdout.write(
    `\n✗ STALE WAIVER ${r.id} (${r.check} on /${r.operations}/) — it matched nothing this run.\n` +
      `    If the root cause is fixed, delete the rule from schemathesis-waivers.json in the same PR\n` +
      `    and strike the finding in docs/audits/schemathesis-findings-2026-08.md.\n`,
  );
}

if (UPDATE) {
  writeFileSync(
    join(WORK, "observed.json"),
    `${JSON.stringify(
      observed.map((o) => ({
        case: o.case,
        key: o.key,
        status: o.status,
        message: o.message,
        request: o.request,
      })),
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `\nwrote ${join(WORK, "observed.json")} (LOOM_SCHEMATHESIS_UPDATE=1) — ${observed.length} finding(s).\n` +
      "Waiver rules are hand-written, not machine-generated: each one has to name a root cause and\n" +
      "point at its entry in docs/audits/schemathesis-findings-2026-08.md.\n",
  );
  process.exit(0);
}

process.stdout.write(bad === 0 ? "\nschemathesis: clean\n" : `\nschemathesis: ${bad} problem(s)\n`);
process.exit(bad === 0 ? 0 : 1);
