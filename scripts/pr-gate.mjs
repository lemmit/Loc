// The `pr-gate` aggregate check, v2 — EVENT-DRIVEN (docs/ci-gating.md → "No
// merge queue on a personal account").
//
// v1 was a single long-polling job: it waited up to 80 minutes for every other
// check on the head SHA. Under real load that design fed on itself — each open
// PR's pr-gate PARKED a runner slot while polling (6 parked gates ≈ a third of
// the ~20-slot pool), which starved the very jobs it was waiting for, which
// burned its timeout, which required manual label re-arms.
//
// v2 never waits. `pr-gate.yml` triggers on `workflow_run: completed` of every
// other workflow (list pinned by test/system/pr-gate.test.ts) plus the
// pull_request events, and each run is one seconds-long EVALUATION that posts
// a check run named `pr-gate` on the head SHA via the Checks API:
//
//   - any triggered check failed        -> completed/failure (culprits named);
//   - checks still running / none yet   -> in_progress ("re-evaluates on the
//     next completion") — BLOCKS merge without claiming failure;
//   - all triggered checks completed OK -> completed/success.
//
// The last workflow to complete always fires one final evaluation, so the
// verdict flips green with no polling, no timeout to tune, and no parked slot.
// A re-run of a red check fires `workflow_run: completed` again, so recovery
// is automatic too — no manual pr-gate re-run.
//
// The API-posted check (not this job's own check) is what branch protection
// requires: `workflow_run`-triggered jobs don't surface in the PR's checks UI,
// so the job is named `pr-gate-eval` and the posted check carries the
// canonical `pr-gate` name on every event path. Both names are excluded from
// the verdict.
//
// Fail-closed invariants, unchanged from v1: an unknown/future conclusion or
// a cancelled run counts as FAILED; zero other checks reporting blocks (the
// unfiltered test.yml guarantees at least one always comes); pending is never
// green. The decision core (`evaluate`, `verdict`) is pure and pinned by
// test/system/pr-gate.test.ts.

import { pathToFileURL } from "node:url";

/** Check-run names this gate itself produces — never part of the verdict. */
export const SELF_NAMES = new Set(["pr-gate", "pr-gate-eval"]);

/** Conclusions that count as "did not break the PR". Everything else —
 *  including conclusions this script has never heard of — fails closed. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Classify one snapshot of the head SHA's check runs.
 *
 * @param {ReadonlyArray<{name: string, status: string, conclusion: string | null}>} runs
 * @param {ReadonlySet<string>} selfNames - this gate's own check names, excluded
 * @returns {{total: number, pending: string[], failed: string[]}}
 */
export function evaluate(runs, selfNames) {
  const others = runs.filter((r) => !selfNames.has(r.name));
  const pending = others.filter((r) => r.status !== "completed").map((r) => r.name);
  const failed = others
    .filter((r) => r.status === "completed" && !PASSING_CONCLUSIONS.has(r.conclusion ?? ""))
    .map((r) => r.name);
  return { total: others.length, pending, failed };
}

/**
 * One snapshot -> one verdict.  `pending` maps to a BLOCKING-but-not-failed
 * check (`in_progress`), so the PR shows "waiting", not a spurious red,
 * between completion events.
 *
 * @param {{total: number, pending: string[], failed: string[]}} snapshot
 * @returns {{state: "success" | "failure" | "pending", summary: string}}
 */
export function verdict({ total, pending, failed }) {
  if (failed.length > 0) {
    return { state: "failure", summary: `check(s) failed: ${failed.join(", ")}` };
  }
  if (total === 0) {
    return {
      state: "pending",
      summary:
        "no other check has reported on this SHA yet — waiting (test.yml runs unfiltered on every PR, so at least one always comes)",
    };
  }
  if (pending.length > 0) {
    const head = pending.slice(0, 10).join(", ");
    return {
      state: "pending",
      summary: `waiting on ${pending.length}/${total}: ${head}${pending.length > 10 ? ", …" : ""} — re-evaluates when the next workflow completes`,
    };
  }
  return { state: "success", summary: `all ${total} triggered check(s) passed` };
}

const API_HEADERS = (token) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
});

/** Fetch every check run on `sha` (paginated; `filter=latest` keeps only the
 *  newest attempt per check name, which is the run branch protection shows). */
async function fetchCheckRuns(repo, sha, token) {
  const runs = [];
  for (let page = 1; ; page += 1) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`,
      { headers: API_HEADERS(token) },
    );
    if (!res.ok)
      throw new Error(`GitHub API ${res.status} listing check runs: ${await res.text()}`);
    const body = await res.json();
    runs.push(...body.check_runs);
    if (runs.length >= body.total_count || body.check_runs.length === 0) break;
  }
  return runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion }));
}

/** Publish the verdict as a check run named `pr-gate` on the head SHA — the
 *  check branch protection requires.  A new run per evaluation is fine:
 *  GitHub surfaces the latest run per check name. */
async function postCheck(repo, sha, token, v) {
  const body = {
    name: "pr-gate",
    head_sha: sha,
    output: {
      title: v.state === "success" ? "all triggered checks passed" : v.summary.slice(0, 120),
      summary: v.summary,
    },
    ...(v.state === "pending"
      ? { status: "in_progress" }
      : { status: "completed", conclusion: v.state }),
  };
  const res = await fetch(`https://api.github.com/repos/${repo}/check-runs`, {
    method: "POST",
    headers: { ...API_HEADERS(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} posting check run: ${await res.text()}`);
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.HEAD_SHA;
  if (!token || !repo || !sha) {
    console.error("pr-gate: GITHUB_TOKEN, GITHUB_REPOSITORY and HEAD_SHA are required");
    process.exit(2);
  }

  const snapshot = evaluate(await fetchCheckRuns(repo, sha, token), SELF_NAMES);
  const v = verdict(snapshot);
  await postCheck(repo, sha, token, v);
  console.log(`pr-gate: ${v.state.toUpperCase()} — ${v.summary}`);
  // The verdict lives in the posted `pr-gate` check; this job succeeds as long
  // as it evaluated and published (an API failure above exits non-zero).
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
