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
// pull_request events, and each run is one seconds-long EVALUATION that
// publishes the check run named `pr-gate` on the head SHA via the Checks API
// — ONE run per SHA, updated in place (see `publishCheck`):
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
// a cancelled run counts as FAILED — but only ever the NEWEST run of a given
// check name (`latestPerName`), so a superseded suite's cancelled corpse never
// condemns a SHA whose live suite is green; zero other checks reporting blocks (the
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
 * Collapse a check-run list to ONE run per NAME, keeping the newest.
 *
 * The API's `filter=latest` is per NAME **per CHECK SUITE**, not per name — a
 * distinction that is invisible until a SHA carries two suites, and then it is
 * a permanent red.  A PR opened as a draft and later marked ready (the flow
 * CLAUDE.md prescribes) fires a second event on the SAME head SHA; the second
 * suite's `concurrency: cancel-in-progress` CANCELS the first, and the gate's
 * fail-closed rule ("a cancelled run counts as FAILED") then condemns the PR
 * on the corpse of a superseded suite.  Nothing clears it: re-evaluation
 * re-reads the same cancelled run and the sweep re-derives the same verdict,
 * so the PR is unmergeable until it is force-pushed to a fresh SHA.
 *
 * Ordering is by check-run `id`, which GitHub assigns monotonically at
 * creation: the newer suite's jobs are created later, so they win — and a
 * re-run also wins over the attempt it replaces, the same answer
 * `filter=latest` already gives within a suite.  Runs with no `id` (only the
 * hand-built snapshots in the tests) fall back to "last one in the list wins",
 * so array order stays meaningful rather than silently preferring the head.
 *
 * @template {{name: string, id?: number}} T
 * @param {ReadonlyArray<T>} runs
 * @returns {T[]}
 */
export function latestPerName(runs) {
  /** @type {Map<string, T>} */
  const byName = new Map();
  for (const r of runs) {
    const prev = byName.get(r.name);
    if (!prev || (r.id ?? 0) >= (prev.id ?? 0)) byName.set(r.name, r);
  }
  return [...byName.values()];
}

/**
 * Classify one snapshot of the head SHA's check runs.
 *
 * @param {ReadonlyArray<{name: string, status: string, conclusion: string | null}>} runs
 * @param {ReadonlySet<string>} selfNames - this gate's own check names, excluded
 * @returns {{total: number, pending: string[], failed: string[]}}
 */
export function evaluate(runs, selfNames) {
  const others = latestPerName(runs).filter((r) => !selfNames.has(r.name));
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

/** Attempts per API call (1 try + 3 retries). */
export const API_MAX_ATTEMPTS = 4;

/**
 * Is this response status worth trying again?
 *
 * github.com is not a reliable dependency at this repo's request volume: an
 * evaluation that hit a transient `503 No server is currently available to
 * service your request` failed the whole job (observed 2026-08-17 on the
 * scheduled sweep, which died on PR 6 of 12 and left the rest unreconciled) —
 * a red that says nothing about the PRs it gates.  Retrying the CALL is the
 * fix; failing the JOB is not, because the job IS the recovery mechanism for
 * every other check.
 *
 * Retryable: 5xx (server-side, always transient here), 429 (secondary
 * rate-limit, which GitHub explicitly asks callers to back off on).  NOT
 * retryable: 4xx — a 401/403/404/422 is a real defect (bad token, missing
 * permission, malformed body) and repeating it three times only delays the
 * honest failure.
 *
 * @param {number} status
 * @returns {boolean}
 */
export function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * Backoff before attempt N+1: 1s, 2s, 4s.  Bounded on purpose — the whole
 * point of v2 is that an evaluation is seconds long and never parks a runner
 * slot, so the retry ladder tops out at ~7s of waiting, not minutes.
 *
 * @param {number} attempt - 1-based number of the attempt that just failed
 * @returns {number} milliseconds to wait
 */
export function retryDelayMs(attempt) {
  return 1000 * 2 ** (attempt - 1);
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `fetch` with the retry ladder above.  Returns the LAST response whatever it
 * says — callers keep their own `res.ok` check and error message, so a
 * non-retryable failure still throws exactly what it threw before.  A rejected
 * fetch (DNS, reset socket) is retried on the same ladder and rethrown after
 * the final attempt.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, attempts?: number, onRetry?: (msg: string) => void}} [opts]
 * @returns {Promise<Response>}
 */
export async function apiFetch(url, init = {}, opts = {}) {
  const {
    fetchImpl = fetch,
    sleep = sleepMs,
    attempts = API_MAX_ATTEMPTS,
    onRetry = (msg) => console.log(msg),
  } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const last = attempt === attempts;
    try {
      const res = await fetchImpl(url, init);
      if (res.ok || !isRetryableStatus(res.status) || last) return res;
      onRetry(`  pr-gate: ${res.status} from ${url} — retry ${attempt}/${attempts - 1}`);
    } catch (err) {
      if (last) throw err;
      lastErr = err;
      onRetry(`  pr-gate: ${lastErr} from ${url} — retry ${attempt}/${attempts - 1}`);
    }
    await sleep(retryDelayMs(attempt));
  }
  /* c8 ignore next -- unreachable: the loop always returns or throws on `last` */
  throw lastErr;
}

/** Fetch every check run on `sha` (paginated).  `filter=latest` narrows to the
 *  newest attempt per name WITHIN EACH CHECK SUITE — a SHA carrying two suites
 *  still yields two runs per name, so `latestPerName` does the cross-suite
 *  collapse the verdict actually needs.  `id` is carried for that ordering. */
async function fetchCheckRuns(repo, sha, token) {
  const runs = [];
  for (let page = 1; ; page += 1) {
    const res = await apiFetch(
      `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`,
      { headers: API_HEADERS(token) },
    );
    if (!res.ok)
      throw new Error(`GitHub API ${res.status} listing check runs: ${await res.text()}`);
    const body = await res.json();
    runs.push(...body.check_runs);
    if (runs.length >= body.total_count || body.check_runs.length === 0) break;
  }
  return runs.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
  }));
}

/**
 * The id of the newest `pr-gate` check run on this SHA, or null when the gate
 * has never published here.  Same cross-suite collapse `evaluate` needs: the
 * API lists every run, and the one worth reusing is the newest.
 *
 * @param {ReadonlyArray<{id?: number, name: string}>} runs
 * @returns {number | null}
 */
export function existingGateRunId(runs) {
  const gate = latestPerName(runs).find((r) => r.name === "pr-gate");
  return gate?.id ?? null;
}

/** The check-run body for a verdict.  `head_sha` is create-only — PATCH
 *  rejects it — so it is added by the caller on the POST path. */
function checkBody(v) {
  return {
    name: "pr-gate",
    output: {
      title: v.state === "success" ? "all triggered checks passed" : v.summary.slice(0, 120),
      summary: v.summary,
    },
    ...(v.state === "pending"
      ? { status: "in_progress" }
      : { status: "completed", conclusion: v.state }),
  };
}

/**
 * Publish the verdict as the check run named `pr-gate` on the head SHA — the
 * check branch protection requires — by UPDATING the run already on this SHA,
 * and creating one only the first time.
 *
 * v2 created a new run per evaluation on the theory that "GitHub surfaces the
 * latest run per check name".  That holds within one check suite and fails
 * across two, and a SHA gets a second suite from the exact flow CLAUDE.md
 * prescribes (open a draft, mark it ready).  Every intermediate "waiting on
 * N/M" verdict is then a run that stays `in_progress` FOREVER, and the
 * required-check evaluation reads one of those instead of the newest success:
 *
 *   405 Repository rule violations found
 *   Required status check "pr-gate" is expected.
 *
 * — an unmergeable PR whose every component check is green (observed on #2593,
 * which had three `pr-gate` runs on one SHA: two stuck at "waiting on …" and
 * one "all 8 triggered check(s) passed").  Reusing the run means a SHA carries
 * exactly ONE `pr-gate`, so there is no stale sibling to read.
 *
 * The PATCH can legitimately fail if the run was created by a different app
 * (only its author may update it), so a failed update falls back to creating
 * one — noisily, because that path resurrects the bug above.
 */
export async function publishCheck(repo, sha, token, v, existingId, opts = {}) {
  const send = (method, url, body) =>
    apiFetch(
      url,
      {
        method,
        headers: { ...API_HEADERS(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      opts,
    );

  const create = () =>
    send("POST", `https://api.github.com/repos/${repo}/check-runs`, {
      ...checkBody(v),
      head_sha: sha,
    });

  let res;
  if (existingId) {
    res = await send(
      "PATCH",
      `https://api.github.com/repos/${repo}/check-runs/${existingId}`,
      checkBody(v),
    );
    if (!res.ok) {
      console.log(
        `  pr-gate: ${res.status} updating check run ${existingId} — creating a new one instead`,
      );
      res = await create();
    }
  } else {
    res = await create();
  }
  if (!res.ok) throw new Error(`GitHub API ${res.status} posting check run: ${await res.text()}`);
}

/**
 * The state of the currently-published `pr-gate` check in a snapshot, so the
 * sweep can tell whether a fresh verdict would CHANGE anything.  Uses the same
 * fetched list the verdict uses, collapsed by `latestPerName` — the gate posts
 * a new check run per evaluation, so this SHA has many `pr-gate` runs.
 *
 * @param {ReadonlyArray<{name: string, status: string, conclusion: string | null}>} runs
 * @returns {"success" | "failure" | "pending" | "absent"}
 */
export function currentGateState(runs) {
  // Deduped for the same reason `evaluate` is.  `publishCheck` now keeps one
  // run per SHA, but a SHA from before that change (or one whose PATCH fell
  // back to a create) still carries several, and a bare `find` would answer
  // from whichever the API happened to list first.
  const gate = latestPerName(runs).find((r) => r.name === "pr-gate");
  if (!gate) return "absent";
  if (gate.status !== "completed") return "pending";
  return gate.conclusion === "success" ? "success" : "failure";
}

/** Sweep-mode posting rule: publish only when the fresh verdict DISAGREES with
 *  what is already on the SHA.  The sweep is a safety net for dropped
 *  `workflow_run` events, not a second event stream — re-publishing an
 *  identical verdict every cycle is churn with no information. */
export function sweepShouldPost(current, fresh) {
  return current !== fresh.state;
}

async function fetchOpenPrHeads(repo, token) {
  const res = await apiFetch(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`, {
    headers: API_HEADERS(token),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} listing open PRs: ${await res.text()}`);
  const prs = await res.json();
  return prs.map((p) => ({ number: p.number, sha: p.head.sha }));
}

/** The safety net: `workflow_run` delivery is best-effort — under this repo's
 *  completion storms (a post-merge heavy set is ~60 completions; a label event
 *  spawns a dozen more) GitHub demonstrably DROPS some dispatches, and an
 *  event-driven gate turns one dropped final event into a permanently parked
 *  PR (observed on #2464: last checks completed 08:40–08:42, no eval fired).
 *  This re-derives the verdict for every open PR and posts only where it
 *  differs.
 *
 *  It does NOT cap the outage at one sweep interval — that claim was here, in
 *  `pr-gate.yml` and in `docs/ci-gating.md`, and none of the three had been
 *  measured.  GitHub runs the every-15-minutes schedule far slower than
 *  requested: the 30 most recent `schedule` runs span 135 HOURS (mean gap
 *  4.7 h, median 4.6 h, shortest gap in that window 110 min).  Treat the sweep as
 *  an eventual backstop on the order of hours, not a 15-minute cap; when a
 *  green PR is parked, force a fresh evaluation instead of waiting for it.
 *
 *  (Spell that cadence out in words, never as the cron literal — the slash-star
 *  sequence closes this block comment and breaks the file.  Which is how this
 *  paragraph was first written, and what `test/system/pr-gate.test.ts` caught.) */
async function sweep(repo, token) {
  const prs = await fetchOpenPrHeads(repo, token);
  console.log(`pr-gate sweep: ${prs.length} open PR(s)`);
  for (const pr of prs) {
    const runs = await fetchCheckRuns(repo, pr.sha, token);
    const v = verdict(evaluate(runs, SELF_NAMES));
    const current = currentGateState(runs);
    if (sweepShouldPost(current, v)) {
      await publishCheck(repo, pr.sha, token, v, existingGateRunId(runs));
      console.log(`  #${pr.number} ${pr.sha.slice(0, 8)}: ${current} -> ${v.state} — ${v.summary}`);
    } else {
      console.log(`  #${pr.number} ${pr.sha.slice(0, 8)}: ${current} (unchanged)`);
    }
  }
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.HEAD_SHA;
  if (!token || !repo) {
    console.error("pr-gate: GITHUB_TOKEN and GITHUB_REPOSITORY are required");
    process.exit(2);
  }

  // No HEAD_SHA = sweep mode (schedule / workflow_dispatch): reconcile every
  // open PR instead of evaluating one SHA.
  if (!sha) {
    await sweep(repo, token);
    return;
  }

  const runs = await fetchCheckRuns(repo, sha, token);
  const v = verdict(evaluate(runs, SELF_NAMES));
  await publishCheck(repo, sha, token, v, existingGateRunId(runs));
  console.log(`pr-gate: ${v.state.toUpperCase()} — ${v.summary}`);
  // The verdict lives in the posted `pr-gate` check; this job succeeds as long
  // as it evaluated and published (an API failure above exits non-zero).
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
