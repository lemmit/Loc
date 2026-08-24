// Shared core for the schemathesis contract-fuzzing legs (M-T9.21).
//
// WHAT IS SHARED AND WHAT IS NOT.  A fuzzing leg is two things: a way to get a
// generated backend LISTENING on a port, and everything that happens after —
// fetch the spec the server itself publishes, drive schemathesis at it, key the
// findings, attribute them to ratcheting root-cause rules, report.  Only the
// FIRST half differs per backend (PGlite in-process for Hono, a real process +
// a postgres sidecar for the other four, exactly as the behavioral runners
// split), so only the first half stays in the per-leg runner.  Everything else
// lives here, once, and every leg gets the identical ratchet semantics.
//
// The alternative — a fork of run-schemathesis.mjs per backend — is how the
// waiver register would rot: five copies of the finding key, five copies of the
// staleness rule, and a fix that clears a root cause on four of them.
//
// Per-leg boot contract:
//
//   boot(c) -> { base, workDir, stop(), drainErrors() }
//     base         the origin the backend is listening on (http://127.0.0.1:N)
//     workDir      per-case scratch dir; the spec, the ndjson report and the
//                  logs are written here and uploaded as CI artefacts
//     stop()       await-able teardown (the port MUST be released — proc.mjs)
//     drainErrors  () => [{ head, count, sample }] — distinct unhandled
//                  exceptions the app logged while it was being fuzzed.  The
//                  single most valuable artefact of a 500 finding is the trace
//                  that produced it, so each leg collects its own (console
//                  capture in-process for node, stderr scraping for the
//                  spawned backends) and hands it over in one shape.
//
// Env (all legs):
//   LOOM_SCHEMATHESIS=1              required — the opt-in gate (else skip, exit 0)
//   LOOM_SCHEMATHESIS_MAX_EXAMPLES   per-operation case budget (default 20)
//   LOOM_SCHEMATHESIS_SEED           generation seed (default 20260811; pinned so
//                                    the waiver ratchet is reproducible)
//   LOOM_SCHEMATHESIS_BIN            schemathesis executable (default `schemathesis`)
//   LOOM_SCHEMATHESIS_UPDATE=1       write observed.json for a DELIBERATE rebaseline
//
// Findings register: docs/audits/schemathesis-findings-2026-08.md.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
const WAIVERS = join(HERE, "schemathesis-waivers.json");

/** The checks we assert.  `not_a_server_error` and `response_schema_conformance`
 *  are the mission floor; the rest each mechanize one of the escaped-bug shapes
 *  the mission was opened for — `status_code_conformance` is the #2472 class (a
 *  status the contract never declared), `unsupported_method` the #2485 class
 *  (wrong verb), and `negative_data_rejection` the #2440 class (a
 *  schema-violating body accepted). */
export const CHECKS = [
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
export const PHASES = "examples,coverage,fuzzing";

export const MAX_EXAMPLES = process.env.LOOM_SCHEMATHESIS_MAX_EXAMPLES ?? "20";
export const SEED = process.env.LOOM_SCHEMATHESIS_SEED ?? "20260811";
export const BIN = process.env.LOOM_SCHEMATHESIS_BIN ?? "schemathesis";
export const UPDATE = process.env.LOOM_SCHEMATHESIS_UPDATE === "1";

/** Recursively collect files under `dir` matching `pred` (shared by every leg's
 *  deployable finder; skips the build/venv dirs a generated tree can carry). */
export function walk(dir, pred, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (
        e.name === "node_modules" ||
        e.name === ".venv" ||
        e.name === "build" ||
        e.name === ".gradle" ||
        e.name === "_build" ||
        e.name === "deps" ||
        e.name === "obj" ||
        e.name === "bin"
      ) {
        continue;
      }
      walk(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

/** Collect distinct lines a spawned backend wrote to stdout/stderr that look
 *  like an unhandled exception, in the same `{ head, count, sample }` shape the
 *  node leg's console capture produces.  Deduped by first line: at 20 examples ×
 *  ~30 operations the same stack repeats hundreds of times. */
export function makeLogScraper() {
  const seen = new Map();
  let tail = "";
  /** Distinct-head budget.  Without one, a backend that logs a correlation id
   *  per line (the .NET structured logger stamps a fresh SpanId on every 404)
   *  turns "distinct exceptions" into "requests made", and the summary buries
   *  the findings it is meant to explain.  `normalizeHead` collapses most of
   *  that; the cap is the backstop. */
  const MAX_DISTINCT = 25;
  return {
    /** Feed a chunk of the server's output. */
    push(chunk) {
      const text = tail + String(chunk);
      const lines = text.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        // The shapes the five runtimes print an unhandled failure in.  Kept
        // deliberately broad — a missed line only costs diagnostics, never a
        // verdict (the verdict is schemathesis's).
        if (
          !/(Traceback \(most recent call last\)|Unhandled exception|ERROR|Exception|error:|\*\* \(|\bat .*\.(?:ex|exs):\d+)/.test(
            line,
          )
        ) {
          continue;
        }
        const raw = line.trim();
        if (!raw) continue;
        const head = normalizeHead(raw);
        const entry = seen.get(head);
        if (entry) entry.count++;
        else if (seen.size < MAX_DISTINCT) seen.set(head, { count: 1, sample: raw });
      }
    },
    drain() {
      const out = [...seen.entries()].map(([head, v]) => ({ head, ...v }));
      seen.clear();
      return out;
    },
  };
}

/** Collapse the per-request noise out of a log line so two occurrences of the
 *  SAME exception dedupe: trace/span ids, uuids, long digit runs and the fuzzer's
 *  own random payload bytes all differ every time and none of them identify the
 *  fault.  Truncated too, because a structured logger writes the whole event as
 *  one line. */
function normalizeHead(line) {
  return line
    .replace(/[0-9a-f]{8,}/gi, "…")
    .replace(/\d{3,}/g, "…")
    .slice(0, 200);
}

/** Run schemathesis against the booted server + the spec it published, and
 *  return the failing (operation, check) keys with one example request each.
 *
 *  ASYNC on purpose: the node leg's server under test lives in THIS process
 *  (PGlite + `@hono/node-server`), so a `spawnSync` here would block the event
 *  loop and the app could never answer a single fuzzed request — the run just
 *  hangs.  The spawned-backend legs do not need it, but they get the same code
 *  path rather than a second one. */
export async function runSchemathesis({ workDir, base }) {
  const specPath = join(workDir, "openapi.json");
  const reportDir = join(workDir, "report");
  rmSync(reportDir, { recursive: true, force: true });
  const args = [
    "run",
    specPath,
    "--url",
    base,
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
export function parseFindings(ndjsonPath) {
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
 *
 *  BACKEND SCOPE (`backends: [...]`).  Since the leg went from one backend to
 *  five, "the whole run" means one BACKEND's run: each leg is its own process
 *  and cannot see the others' findings, so a rule that only reproduces on
 *  Postgres-backed backends would read as stale on the PGlite one.  A rule
 *  therefore names the legs it claims, and that one list drives BOTH halves:
 *    • it only ABSORBS a finding on a leg it claims — so a known root cause
 *      spreading to a sixth surface is still an unwaived finding, which is the
 *      whole point of the ratchet;
 *    • it is only judged STALE on a leg it claims — so fixing it on python
 *      forces removing "python" from the list in the same PR, and the rule
 *      survives for the legs that still reproduce it.
 *  A missing `backends` means ALL legs (the pre-matrix default, kept so a rule
 *  that genuinely holds everywhere does not have to enumerate five names). */
export const ALL_BACKENDS = ["node", "python", "java", "dotnet", "elixir"];

export function loadRules(backend) {
  if (!existsSync(WAIVERS)) return [];
  const parsed = JSON.parse(readFileSync(WAIVERS, "utf8"));
  return (parsed.waivers ?? [])
    .filter((w) => !w.backends || w.backends.includes(backend))
    .map((w) => ({ ...w, re: new RegExp(w.operations) }));
}

/** Attribute this run's findings to the rules.  Mutates `rule.hits`. */
export function ratchet(findings, rules) {
  const unwaived = [];
  for (const [key, f] of findings) {
    const rule = rules.find((r) => r.check === f.check && r.re.test(f.label));
    if (rule) rule.hits = (rule.hits ?? 0) + 1;
    else unwaived.push([key, f]);
  }
  return unwaived;
}

// ---------------------------------------------------------------------------
// The leg
// ---------------------------------------------------------------------------

/** The whole run for ONE backend: boot each case, fuzz it against the spec the
 *  server publishes, attribute the findings, report, and exit.  Never returns —
 *  it owns the exit code, so a leg runner is `await fuzzLeg({...})` and nothing
 *  after it. */
export async function fuzzLeg({ backend, cases, work, boot, argv = process.argv.slice(2) }) {
  if (process.env.LOOM_SCHEMATHESIS !== "1") {
    process.stdout.write(
      "schemathesis contract fuzzing skipped — set LOOM_SCHEMATHESIS=1 to run it\n",
    );
    process.exit(0);
  }

  const only = argv.filter((a) => !a.startsWith("-"));
  const selected = cases.filter((c) => only.length === 0 || only.includes(c.name));
  if (selected.length === 0) {
    process.stderr.write(
      `no such case for the ${backend} leg: ${only.join(", ")}\n` +
        `known: ${cases.map((c) => c.name).join(", ")}\n`,
    );
    process.exit(1);
  }

  mkdirSync(work, { recursive: true });
  const rules = loadRules(backend);
  /** Every finding observed this run, for the UPDATE rebaseline. */
  const observed = [];
  let bad = 0;

  for (const c of selected) {
    process.stdout.write(`\n▶ ${c.name}  [${backend}]\n`);
    let booted = null;
    let findings;
    try {
      booted = await boot(c);
      // The spec under test is the one the SERVER publishes — fetched over the
      // wire, not read off disk, so a spec/route disagreement is in scope.
      const res = await fetch(`${booted.base}/openapi.json`);
      if (!res.ok) {
        throw new Error(
          `the ${backend} deployable does not publish /openapi.json (HTTP ${res.status}) — ` +
            "there is no contract to fuzz it against",
        );
      }
      const spec = await res.json();
      writeFileSync(join(booted.workDir, "openapi.json"), JSON.stringify(spec, null, 2));
      const opCount = Object.values(spec.paths ?? {}).reduce(
        (n, v) => n + Object.keys(v).length,
        0,
      );
      process.stdout.write(
        `  booted at ${booted.base} — ${opCount} operations in the emitted spec\n`,
      );
      findings = await runSchemathesis({ workDir: booted.workDir, base: booted.base });
    } catch (err) {
      process.stdout.write(`  ERROR: ${err?.message ?? err}\n`);
      bad++;
      await booted?.stop().catch(() => {});
      continue;
    }
    const appErrors = booted.drainErrors?.() ?? [];
    await booted.stop().catch(() => {});
    if (appErrors.length > 0) {
      writeFileSync(
        join(booted.workDir, "app-errors.log"),
        appErrors.map((e) => `### ×${e.count}\n${e.sample}\n`).join("\n"),
      );
      process.stdout.write(
        `  ${appErrors.length} distinct unhandled exception(s) in the app (→ app-errors.log):\n`,
      );
      // The file keeps them all; stdout keeps the findings readable.
      for (const e of appErrors.slice(0, 10)) {
        process.stdout.write(`      ×${e.count} ${e.head.slice(0, 160)}\n`);
      }
      if (appErrors.length > 10) {
        process.stdout.write(`      … ${appErrors.length - 10} more in app-errors.log\n`);
      }
    }

    for (const [key, f] of findings) observed.push({ case: c.name, key, ...f });

    const unwaived = ratchet(findings, rules);
    process.stdout.write(
      `  ${findings.size} finding(s), ${findings.size - unwaived.length} waived\n`,
    );
    for (const [key, f] of unwaived) {
      bad++;
      process.stdout.write(`  ✗ UNWAIVED ${key}\n`);
      process.stdout.write(`      ${f.status ?? "?"} ${f.message}\n`);
      process.stdout.write(
        `      repro: ${f.request.method} ${f.request.uri}${f.request.body ? ` -d '${f.request.body}'` : ""}\n`,
      );
    }
  }

  // Which rule absorbed what.  Without it "11 findings, 11 waived" is a number
  // with no audit trail — and the first question asked of a waived run is
  // always "which known bug is still firing, and how widely".
  if (rules.length > 0) {
    process.stdout.write("\nattribution:\n");
    for (const r of rules) {
      process.stdout.write(`  ${r.hits ? `×${r.hits}` : "  —"}  ${r.id}  ${r.check}  /${r.operations}/\n`);
    }
  }

  // Staleness is judged over the WHOLE leg, not per case: a rule covers a root
  // cause, and a root cause can surface under either fixture.
  for (const r of rules) {
    if (r.hits) continue;
    // `intermittent` rules opt out of the staleness half — and ONLY that half;
    // they still absorb their findings, so a new bug on the same surface is
    // still unwaived.  It is for a finding whose reproduction depends on the
    // fuzzer both writing a value and then reading it back within one run,
    // where absence is genuinely not evidence of a fix.  Every use must say why.
    if (r.intermittent) {
      process.stdout.write(
        `\n· ${r.id} did not reproduce this run (declared intermittent — not treated as stale)\n`,
      );
      continue;
    }
    bad++;
    process.stdout.write(
      `\n✗ STALE WAIVER ${r.id} (${r.check} on /${r.operations}/) — it matched nothing on the ${backend} leg.\n` +
        "    If the root cause is fixed here, drop this leg from the rule's `backends` (or delete the\n" +
        "    rule when no leg reproduces it) in schemathesis-waivers.json in the same PR, and strike the\n" +
        "    finding in docs/audits/schemathesis-findings-2026-08.md.\n",
    );
  }

  if (UPDATE) {
    writeFileSync(
      join(work, "observed.json"),
      `${JSON.stringify(
        observed.map((o) => ({
          backend,
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
      `\nwrote ${join(work, "observed.json")} (LOOM_SCHEMATHESIS_UPDATE=1) — ${observed.length} finding(s).\n` +
        "Waiver rules are hand-written, not machine-generated: each one has to name a root cause and\n" +
        "point at its entry in docs/audits/schemathesis-findings-2026-08.md.\n",
    );
    process.exit(0);
  }

  process.stdout.write(
    bad === 0
      ? `\nschemathesis (${backend}): clean\n`
      : `\nschemathesis (${backend}): ${bad} problem(s)\n`,
  );
  process.exit(bad === 0 ? 0 : 1);
}
