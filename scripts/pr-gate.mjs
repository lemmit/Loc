// The `pr-gate` aggregate check — the personal-account substitute for a merge
// queue (docs/ci-gating.md → "No merge queue on a personal account").
//
// Branch protection on this repo can safely require almost no individual
// check: every PR workflow is path-filtered, and a required check that gets
// path-skipped never reports, leaving the PR blocked on "Expected" forever.
// So instead of requiring a list of names, `pr-gate.yml` runs this script on
// EVERY pull request and branch protection requires only its verdict:
//
//   - a check that never triggered (path-skipped) simply never appears on the
//     head SHA — that is OK by construction, not by a hand-maintained list;
//   - a check that DID trigger must complete without failure — any red on the
//     SHA fails the gate immediately (fail-fast, no waiting for the rest);
//   - zero other checks reporting is a FAILURE, not a pass: `test.yml` runs
//     unfiltered on every PR, so "nothing reported" means Actions never picked
//     the push up — fail closed rather than merge unverified.
//
// A run that a workflow re-run later turns green needs a manual `pr-gate`
// re-run to pick the new verdict up — GitHub tracks the LATEST run per check
// name, so re-running pr-gate is sufficient (and cheap).
//
// The decision core (`evaluate`, `runGate`) is pure and dependency-injected;
// `test/system/pr-gate.test.ts` pins it, including the fail-closed arms.
// Only `main()` below touches the network.

import { pathToFileURL } from "node:url";

/** Conclusions that count as "did not break the PR". Everything else —
 *  including conclusions this script has never heard of — fails closed. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Classify one snapshot of the head SHA's check runs.
 *
 * @param {ReadonlyArray<{name: string, status: string, conclusion: string | null}>} runs
 * @param {string} selfName - this gate's own check name, excluded from the verdict
 * @returns {{total: number, pending: string[], failed: string[]}}
 */
export function evaluate(runs, selfName) {
  const others = runs.filter((r) => r.name !== selfName);
  const pending = others.filter((r) => r.status !== "completed").map((r) => r.name);
  const failed = others
    .filter((r) => r.status === "completed" && !PASSING_CONCLUSIONS.has(r.conclusion ?? ""))
    .map((r) => r.name);
  return { total: others.length, pending, failed };
}

/**
 * Poll until every other check on the SHA has completed cleanly, a check has
 * failed, or the timeout elapses.  Time is tracked by accumulating `pollMs`
 * (injectable, deterministic in tests) rather than reading a wall clock.
 *
 * Two consecutive all-clear polls after `graceMs` are required before passing:
 * workflow runs are created within seconds of the triggering event, but a
 * single early poll could land in that window and pass before the real gates
 * even appear as queued.
 *
 * @param {{
 *   listCheckRuns: () => Promise<ReadonlyArray<{name: string, status: string, conclusion: string | null}>>,
 *   sleep: (ms: number) => Promise<void>,
 *   log: (msg: string) => void,
 *   selfName: string,
 *   pollMs: number,
 *   graceMs: number,
 *   timeoutMs: number,
 * }} deps
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
export async function runGate({ listCheckRuns, sleep, log, selfName, pollMs, graceMs, timeoutMs }) {
  let elapsed = 0;
  let allClearPolls = 0;

  for (;;) {
    const runs = await listCheckRuns();
    const { total, pending, failed } = evaluate(runs, selfName);

    if (failed.length > 0) {
      return { ok: false, reason: `check(s) failed: ${failed.join(", ")}` };
    }

    if (pending.length === 0 && total > 0 && elapsed >= graceMs) {
      allClearPolls += 1;
      if (allClearPolls >= 2) {
        return { ok: true, reason: `all ${total} triggered check(s) passed` };
      }
    } else {
      allClearPolls = 0;
    }

    if (elapsed >= timeoutMs) {
      return {
        ok: false,
        reason:
          total === 0
            ? "no other check ever reported on this SHA — Actions never picked the push up (fail closed)"
            : `timed out waiting for: ${pending.join(", ")}`,
      };
    }

    log(
      total === 0
        ? `waiting for checks to appear (${Math.round(elapsed / 1000)}s elapsed)`
        : `waiting on ${pending.length}/${total}: ${pending.slice(0, 8).join(", ")}${pending.length > 8 ? ", …" : ""}`,
    );
    await sleep(pollMs);
    elapsed += pollMs;
  }
}

/** Fetch every check run on `sha` (paginated; `filter=latest` keeps only the
 *  newest attempt per check name, which is the run branch protection shows). */
async function fetchCheckRuns(repo, sha, token) {
  const runs = [];
  for (let page = 1; ; page += 1) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!res.ok)
      throw new Error(`GitHub API ${res.status} listing check runs: ${await res.text()}`);
    const body = await res.json();
    runs.push(...body.check_runs);
    if (runs.length >= body.total_count || body.check_runs.length === 0) break;
  }
  return runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion }));
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.HEAD_SHA;
  if (!token || !repo || !sha) {
    console.error("pr-gate: GITHUB_TOKEN, GITHUB_REPOSITORY and HEAD_SHA are required");
    process.exit(2);
  }

  const result = await runGate({
    listCheckRuns: () => fetchCheckRuns(repo, sha, token),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (msg) => console.log(`pr-gate: ${msg}`),
    selfName: process.env.PR_GATE_SELF_NAME ?? "pr-gate",
    pollMs: Number(process.env.PR_GATE_POLL_MS ?? 30_000),
    graceMs: Number(process.env.PR_GATE_GRACE_MS ?? 120_000),
    timeoutMs: Number(process.env.PR_GATE_TIMEOUT_MS ?? 80 * 60_000),
  });

  console.log(`pr-gate: ${result.ok ? "PASS" : "FAIL"} — ${result.reason}`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
