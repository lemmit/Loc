#!/usr/bin/env node
// The flake budget — M-T9.30.
//
// WHY THIS EXISTS
// ---------------
// Races hide as flakes. The java `/ready` that answered ready ~667ms before it
// was (#2350) and the python commit-after-response race were both found *as
// flakes* — someone noticed a leg failing intermittently and went digging.
// Nothing in this repo makes that noticing systematic: a red runtime leg gets
// re-run, goes green, and the evidence evaporates. `ci-red-alarm.yml` catches
// the RED TRANSITION, which is the wrong shape for a flake (a flake's steady
// state is green) and blind to the never-green class — `api-call-e2e` was red
// on 100% of its main pushes for two days with nobody listening (#2434).
//
// So: a flake is a bug report with a probability attached. Budget it like one.
// This script reads each monitored workflow's recent run history on `main`
// through the Actions API and classifies the leg. `.github/workflows/
// flake-budget.yml` runs it daily and turns each flagged leg into ONE deduped
// claiming issue (label `flaky-gate`), reusing the dedupe-by-label machinery
// from `ci-red-alarm.yml`.
//
// THE ONE NON-OBVIOUS RULE: a re-run to green is a FLAKE, not a pass.
// -------------------------------------------------------------------
// The Actions API reports one run per (workflow, SHA) carrying the conclusion
// of its LAST attempt. So the habit this mission exists to break — "it went
// red, I hit re-run, it went green" — is precisely the habit that erases
// itself from the run history. `passRate` here is therefore the FIRST-ATTEMPT
// pass rate (`conclusion == success && run_attempt == 1`); the final-attempt
// rate is reported alongside as `finalPassRate` so the gap between the two is
// visible, and a leg that only stays green by being re-run trips its own class
// (`retry-masked`) even when its final rate looks fine.
//
// WHICH LEGS ARE MONITORED is derived from `.github/workflows/`, never
// hand-curated — hand-curation is exactly what let #2434 rot unwatched. Any
// workflow that can run on `main` (an unscoped or path-scoped `push: [main]`,
// or a `schedule:`) is in scope, minus the small `NOT_A_GATE` set below.
//
// Pure core (`parseTriggers` / `classify` / `renderReport` / `buildReport`) is
// exported and pinned by `test/system/flake-budget.test.ts`; only `main()`
// touches the network.
//
// Usage:
//   node scripts/flake-budget.mjs [--repo owner/name] [--out report.json]
//                                 [--markdown report.md] [--window 20]

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Named constants — the budget's dials. Every threshold the report cites is
// one of these; none is inlined at a call site.
// ---------------------------------------------------------------------------

/** A leg below this first-attempt pass rate over the window is flagged. */
export const PASS_RATE_THRESHOLD = 0.8;

/** Sliding window: how many completed `main` runs each rate is computed over. */
export const WINDOW = 20;

/** Below this many completed runs the window is too thin to call a rate. */
export const MIN_RUNS_FOR_RATE = 5;

/** Re-run-to-green passes in the window before the leg trips `retry-masked`. */
export const RETRY_FLAKE_MIN = 2;

/** A leg expected to run at least daily is stale after this long. */
export const STALE_DAYS = 7;

/** …and one on a weekly cron gets double, so a weekly gate isn't "stale" by 1h. */
export const WEEKLY_STALE_DAYS = 14;

/** The dedupe label. One open issue per flagged leg carries it. */
export const ISSUE_LABEL = "flaky-gate";

/** Conclusions that mean "this run did not report a problem". */
const PASSING_CONCLUSIONS = new Set(["success", "neutral"]);

/**
 * Conclusions that are not EVIDENCE either way, and so leave the denominator.
 * `cancelled` is usually concurrency superseding a run; `skipped` never ran a
 * step; `action_required` is waiting on a human. Counting any of them as a
 * failure would flag every busy day as a flake.
 */
const IGNORED_CONCLUSIONS = new Set(["cancelled", "skipped", "action_required"]);

/**
 * Workflows that run on `main` but are not GATES — nothing about their pass
 * rate is a statement about the product, so budgeting them is pure noise.
 * Deliberately tiny, and each entry says why.
 */
export const NOT_A_GATE = new Map([
  ["ci-red-alarm.yml", "an alarm, not a gate — it 'fails' only if the alarm itself breaks"],
  ["pr-gate.yml", "the aggregate check; its verdict mirrors other legs by construction"],
  ["cleanup-artifacts.yml", "housekeeping cron, no product signal"],
  ["flake-budget.yml", "this budget itself"],
]);

/** Status precedence, worst first — `classify` returns the first that matches. */
export const STATUSES = /** @type {const} */ ([
  "never-run",
  "startup-failure",
  "below-threshold",
  "retry-masked",
  "stale",
  "insufficient-data",
  "healthy",
]);

/** The statuses that earn a claiming issue. `insufficient-data` does not. */
export const FLAGGED = new Set([
  "never-run",
  "startup-failure",
  "below-threshold",
  "retry-masked",
  "stale",
]);

// ---------------------------------------------------------------------------
// Workflow-file reading
//
// Same discipline as `merge-queue-readiness.test.ts` / `main-red-alarm-
// coverage.test.ts`: a deliberately small indentation reader over the
// block-style `on:` every workflow here uses, because no YAML parser is
// resolvable in this repo's dependency tree. `parseTriggers` returning
// `pushMain: false` for a workflow that does push on main would silently drop
// a leg from the budget, so the unit test reads every real workflow file and
// asserts the reader sees the ones we know about.
// ---------------------------------------------------------------------------

const stripQuotes = (s) => s.replace(/^['"]|['"]$/g, "");

/** Top-level `name:` — the identity the Actions API reports runs under. */
export function workflowName(source) {
  const m = source.match(/^name:[ \t]*(.+)$/m);
  return m ? stripQuotes(m[1].trim()) : undefined;
}

/**
 * The `on:` triggers that decide whether a workflow can run on `main`.
 *
 * @param {string} source
 * @returns {{pushMain: boolean, pushMainPaths: boolean, crons: string[]}}
 */
export function parseTriggers(source) {
  const lines = source.split("\n").map((l) => l.replace(/\r$/, ""));
  let inOn = false;
  /** @type {"push" | "schedule" | undefined} */
  let block;
  let pushMain = false;
  let pushMainPaths = false;
  /** @type {string[]} */
  const crons = [];

  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    if (/^\S/.test(line)) {
      inOn = /^on:\s*$/.test(line);
      block = undefined;
      continue;
    }
    if (!inOn) continue;
    if (/^ {2}\S/.test(line)) {
      block = /^ {2}push:/.test(line)
        ? "push"
        : /^ {2}schedule:/.test(line)
          ? "schedule"
          : undefined;
      continue;
    }
    if (block === "push") {
      // `branches: [main]` — the only form used here. The flow-seq match keeps
      // a `branches: [main-something]` from passing by substring.
      const m = line.match(/^ {4}branches:\s*\[(.+)\]\s*$/);
      if (m?.[1].split(",").some((b) => stripQuotes(b.trim()) === "main")) pushMain = true;
      if (/^ {4}paths(-ignore)?:/.test(line) && pushMain) pushMainPaths = true;
    } else if (block === "schedule") {
      const m = line.match(/^ {4}- cron:\s*(.+)$/);
      if (m) crons.push(stripQuotes(m[1].trim()));
    }
  }
  return { pushMain, pushMainPaths, crons };
}

/**
 * How long silence is tolerable before the leg is "never-scheduled" (class c).
 *
 * `null` means the question is unanswerable and the leg is EXEMPT from the
 * stale class: a path-scoped `push: [main]` gate legitimately sits idle for
 * weeks when nothing under its paths changes, and flagging that is the kind of
 * false positive that gets a bot muted — which would cost more than the class
 * is worth.
 *
 * @param {{pushMain: boolean, pushMainPaths: boolean, crons: string[]}} triggers
 * @returns {number | null}
 */
export function staleAfterDays(triggers) {
  if (triggers.crons.length > 0) {
    // A weekly cron pins day-of-week or day-of-month; anything else fires at
    // least daily, so daily silence is already suspicious.
    const weekly = triggers.crons.every((c) => {
      const f = c.trim().split(/\s+/);
      return f.length >= 5 && (f[4] !== "*" || f[2] !== "*");
    });
    return weekly ? WEEKLY_STALE_DAYS : STALE_DAYS;
  }
  if (triggers.pushMain && !triggers.pushMainPaths) return STALE_DAYS;
  return null;
}

/**
 * Every workflow in scope for the budget, derived from the directory.
 *
 * @param {string} dir
 * @returns {{file: string, name: string, triggers: ReturnType<typeof parseTriggers>, staleAfterDays: number | null}[]}
 */
export function monitoredWorkflows(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .filter((f) => !NOT_A_GATE.has(f))
    .sort()
    .map((file) => {
      const source = readFileSync(path.join(dir, file), "utf8");
      const triggers = parseTriggers(source);
      return {
        file,
        name: workflowName(source) ?? file,
        triggers,
        staleAfterDays: staleAfterDays(triggers),
      };
    })
    .filter((w) => w.triggers.pushMain || w.triggers.crons.length > 0);
}

// ---------------------------------------------------------------------------
// Classification — the pure core
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Did this run pass, fail, or carry no evidence? */
export function verdictOf(run) {
  const c = run.conclusion;
  if (c == null || IGNORED_CONCLUSIONS.has(c)) return "ignored";
  // Fail closed on a conclusion this script has never heard of — the same
  // discipline `pr-gate.mjs` applies. A new GitHub conclusion should show up
  // as a flagged leg somebody looks at, not as a silent pass.
  return PASSING_CONCLUSIONS.has(c) ? "pass" : "fail";
}

/**
 * Classify one leg from its recent `main` runs.
 *
 * @param {object} leg
 * @param {string} leg.file
 * @param {string} leg.name
 * @param {number | null} leg.staleAfterDays
 * @param {ReadonlyArray<{conclusion: string|null, status?: string, run_attempt?: number, created_at: string, html_url?: string, head_sha?: string}>} leg.runs
 *        newest first, as the API returns them
 * @param {Date} now
 */
export function classify(leg, now = new Date()) {
  // Window over runs that CARRY EVIDENCE, not over raw runs. This repo pushes
  // to main in bursts and `cancel-in-progress` supersedes the earlier run of
  // each burst, so raw-run windowing spends most of its slots on `cancelled`
  // corpses: the first cut of this script saw 20 runs of
  // `generated-react-build` and could only judge 5 of them. Filter first, then
  // take WINDOW — which is why `fetchRuns` over-fetches.
  const considered = leg.runs
    .filter((r) => r.conclusion != null && verdictOf(r) !== "ignored")
    .slice(0, WINDOW);

  // First-attempt pass — see the header: a re-run to green is a flake, not a
  // pass, so the headline rate refuses to launder it.
  const firstTryPasses = considered.filter(
    (r) => verdictOf(r) === "pass" && (r.run_attempt ?? 1) === 1,
  );
  const retryPasses = considered.filter((r) => verdictOf(r) === "pass" && (r.run_attempt ?? 1) > 1);
  const failures = considered.filter((r) => verdictOf(r) === "fail");
  const startupFailures = considered.filter((r) => r.conclusion === "startup_failure");

  const n = considered.length;
  const passRate = n === 0 ? null : firstTryPasses.length / n;
  const finalPassRate = n === 0 ? null : (firstTryPasses.length + retryPasses.length) / n;

  const lastRunAt = leg.runs.length > 0 ? leg.runs[0].created_at : null;
  const ageDays =
    lastRunAt == null ? null : (now.getTime() - new Date(lastRunAt).getTime()) / DAY_MS;

  const status = pickStatus({
    n,
    passRate,
    startupFailures: startupFailures.length,
    retryPasses: retryPasses.length,
    ageDays,
    staleAfterDays: leg.staleAfterDays,
    everRan: leg.runs.length > 0,
  });

  return {
    file: leg.file,
    name: leg.name,
    status,
    flagged: FLAGGED.has(status),
    considered: n,
    passes: firstTryPasses.length,
    failures: failures.length,
    retryPasses: retryPasses.length,
    startupFailures: startupFailures.length,
    passRate,
    finalPassRate,
    lastRunAt,
    ageDays: ageDays == null ? null : Math.round(ageDays * 10) / 10,
    staleAfterDays: leg.staleAfterDays,
    headline: headlineFor({
      status,
      passRate,
      finalPassRate,
      n,
      retryPasses: retryPasses.length,
      ageDays,
    }),
    failingRuns: failures.slice(0, 5).map((r) => ({
      conclusion: r.conclusion,
      created_at: r.created_at,
      html_url: r.html_url ?? null,
      head_sha: r.head_sha ? r.head_sha.slice(0, 8) : null,
    })),
  };
}

/** The precedence ladder, isolated so the test can drive it directly. */
export function pickStatus({
  n,
  passRate,
  startupFailures,
  retryPasses,
  ageDays,
  staleAfterDays,
  everRan,
}) {
  // (c), extreme case: matches a main trigger and has never run at all.
  if (!everRan) return "never-run";
  // (b) the never-green class: every considered run died before a step ran.
  // Not a statistic — one `startup_failure` is already a broken workflow file,
  // so this fires without waiting for MIN_RUNS_FOR_RATE.
  if (n > 0 && startupFailures === n) return "startup-failure";
  // (a) the budget proper.
  if (n >= MIN_RUNS_FOR_RATE && passRate != null && passRate < PASS_RATE_THRESHOLD)
    return "below-threshold";
  // Green only because somebody kept pressing re-run.
  if (retryPasses >= RETRY_FLAKE_MIN) return "retry-masked";
  // (c) the never-scheduled class.
  if (staleAfterDays != null && ageDays != null && ageDays > staleAfterDays) return "stale";
  if (n < MIN_RUNS_FOR_RATE) return "insufficient-data";
  return "healthy";
}

const pct = (r) => (r == null ? "n/a" : `${Math.round(r * 100)}%`);

function headlineFor({ status, passRate, finalPassRate, n, retryPasses, ageDays }) {
  switch (status) {
    case "never-run":
      return "has never run on `main`, despite a trigger that says it should";
    case "startup-failure":
      return `all ${n} recent runs ended in \`startup_failure\` — the workflow never started, so it has no green to regress from`;
    case "below-threshold":
      return `first-attempt pass rate ${pct(passRate)} over the last ${n} runs on \`main\` (budget: ${pct(PASS_RATE_THRESHOLD)})`;
    case "retry-masked":
      return `${retryPasses} of the last ${n} runs went green only on a re-run — final rate ${pct(finalPassRate)} hides a first-attempt rate of ${pct(passRate)}`;
    case "stale":
      return `last ran ${ageDays == null ? "?" : ageDays.toFixed(1)} days ago despite matching triggers`;
    case "insufficient-data":
      return `only ${n} completed runs in the window — too thin to call`;
    default:
      return `first-attempt pass rate ${pct(passRate)} over ${n} runs`;
  }
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

/** The hidden key an existing issue is matched on. Titles change; this doesn't. */
export const markerFor = (file) => `<!-- flake-budget:${file} -->`;

export function issueTitleFor(s) {
  return `Flaky gate: ${s.name} — ${s.status}`;
}

export function issueBodyFor(s, meta = {}) {
  const when = meta.generatedAt ?? new Date().toISOString();
  const rows = [
    `- **Status:** \`${s.status}\` — ${s.headline}`,
    `- **Window:** last ${s.considered} completed \`main\` runs (cap ${WINDOW}; cancelled/skipped excluded)`,
    `- **First-attempt pass rate:** ${pct(s.passRate)} (budget ${pct(PASS_RATE_THRESHOLD)})`,
    `- **Final-attempt pass rate:** ${pct(s.finalPassRate)}${s.retryPasses > 0 ? ` — ${s.retryPasses} run(s) went green only on a re-run` : ""}`,
    `- **Failures in window:** ${s.failures}${s.startupFailures > 0 ? ` (of which \`startup_failure\`: ${s.startupFailures})` : ""}`,
    `- **Last run:** ${s.lastRunAt ?? "never"}${s.ageDays == null ? "" : ` (${s.ageDays}d ago)`}`,
    `- **Workflow:** \`.github/workflows/${s.file}\``,
  ];
  const evidence = s.failingRuns.length
    ? [
        "",
        "Recent failing runs:",
        ...s.failingRuns.map(
          (r) =>
            `- \`${r.conclusion}\` ${r.created_at} ${r.head_sha ? `(\`${r.head_sha}\`)` : ""} ${r.html_url ? `— [run](${r.html_url})` : ""}`,
        ),
      ]
    : [];
  return [
    markerFor(s.file),
    "",
    "A flake is a bug report with a probability attached (M-T9.30). This leg is outside its budget:",
    "",
    ...rows,
    ...evidence,
    "",
    "Investigate the leg or adjust its budget — a re-run is not a fix. This issue is updated in place by",
    "`.github/workflows/flake-budget.yml`; it closes itself when the leg comes back inside budget.",
    "",
    `_Report generated ${when}._`,
  ].join("\n");
}

/** Full markdown report — the daily job summary, and the PR-body deliverable. */
export function renderReport(summaries, meta = {}) {
  const flagged = summaries.filter((s) => s.flagged);
  const rest = summaries.filter((s) => !s.flagged);
  const row = (s) =>
    `| ${s.name} | \`${s.status}\` | ${pct(s.passRate)} | ${pct(s.finalPassRate)} | ${s.considered} | ${s.failures} | ${s.retryPasses} | ${s.ageDays == null ? "never" : `${s.ageDays}d`} |`;
  const header = [
    "| Leg | Status | 1st-try | Final | Runs | Fails | Re-run greens | Last run |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const out = [
    `# Flake budget — ${meta.repo ?? "repo"} \`main\``,
    "",
    `Window: last ${WINDOW} completed runs per leg · budget: ${pct(PASS_RATE_THRESHOLD)} first-attempt pass rate · generated ${meta.generatedAt ?? new Date().toISOString()}`,
    "",
    `**${flagged.length} of ${summaries.length} monitored legs are outside budget.**`,
    "",
    "A re-run to green counts as a FAILURE here: the Actions API keeps only the last attempt's conclusion, so the 1st-try column is the honest rate and the Final column is what the UI shows you.",
    "",
  ];
  if (flagged.length) {
    out.push("## Flagged", "", ...header, ...flagged.map(row), "");
    for (const s of flagged) out.push(`- **${s.name}** (\`${s.status}\`) — ${s.headline}`);
    out.push("");
  }
  out.push("## All monitored legs", "", ...header, ...flagged.map(row), ...rest.map(row), "");
  return out.join("\n");
}

/** Assemble the machine-readable report the workflow's issue step consumes. */
export function buildReport(summaries, meta = {}) {
  const generatedAt = meta.generatedAt ?? new Date().toISOString();
  return {
    generatedAt,
    repo: meta.repo ?? null,
    window: WINDOW,
    threshold: PASS_RATE_THRESHOLD,
    label: ISSUE_LABEL,
    counts: {
      monitored: summaries.length,
      flagged: summaries.filter((s) => s.flagged).length,
    },
    legs: summaries,
    claims: summaries
      .filter((s) => s.flagged)
      .map((s) => ({
        file: s.file,
        marker: markerFor(s.file),
        title: issueTitleFor(s),
        body: issueBodyFor(s, { generatedAt }),
      })),
    markdown: renderReport(summaries, { ...meta, generatedAt }),
  };
}

// ---------------------------------------------------------------------------
// main() — the only part that touches the network
// ---------------------------------------------------------------------------

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function fetchRuns(repo, file, token) {
  // No `status=completed` filter: whether a `startup_failure` counts as
  // "completed" to the API is exactly the semantics this script must not
  // guess at, so it over-fetches and filters on `conclusion != null` locally.
  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/${file}/runs` +
    `?branch=main&per_page=${WINDOW * 2}&exclude_pull_requests=true`;
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  // A workflow file that exists but has never run answers 200 with an empty
  // list; a 404 means the API does not know the file at all (renamed on disk,
  // never pushed) — both are "no runs", which is the `never-run` class.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${file}: ${await res.text()}`);
  const body = await res.json();
  return body.workflow_runs ?? [];
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workflowsDir = path.resolve(here, "../.github/workflows");
  const repo = arg("--repo", process.env.GITHUB_REPOSITORY || "lemmit/Loc");
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const now = new Date();

  const legs = monitoredWorkflows(workflowsDir);
  const summaries = [];
  for (const leg of legs) {
    const runs = await fetchRuns(repo, leg.file, token);
    summaries.push(classify({ ...leg, runs }, now));
  }
  // Worst first: the flagged legs are the point of the report.
  const order = new Map(STATUSES.map((s, i) => [s, i]));
  summaries.sort(
    (a, b) =>
      (order.get(a.status) ?? 99) - (order.get(b.status) ?? 99) || a.name.localeCompare(b.name),
  );

  const report = buildReport(summaries, { repo, generatedAt: now.toISOString() });
  const jsonOut = arg("--out", "");
  const mdOut = arg("--markdown", "");
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  if (mdOut) writeFileSync(mdOut, `${report.markdown}\n`);
  if (!jsonOut && !mdOut) process.stdout.write(`${report.markdown}\n`);
  else
    process.stdout.write(
      `${report.counts.flagged} of ${report.counts.monitored} legs outside budget\n`,
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
