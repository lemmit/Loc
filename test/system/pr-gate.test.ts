// Pins the decision core of scripts/pr-gate.mjs (v2, event-driven) — the
// aggregate required check that substitutes for a merge queue on this
// personal-account repo (docs/ci-gating.md).  The gate's claim is "any
// triggered red blocks, path-skipped is fine, pending is never green, and
// every workflow completion re-evaluates"; each arm below is the
// seeded-defect proof for one clause.
//
// The second half pins pr-gate.yml's `workflow_run.workflows` list against
// the real workflow inventory: a workflow missing from that list completes
// WITHOUT re-evaluating the gate, so a PR can stick at in_progress until an
// unrelated event — the v2 equivalent of v1's silent-timeout class.

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS module without a declaration file; the runtime
// shape is pinned by the assertions below.
import {
  API_MAX_ATTEMPTS,
  apiFetch,
  currentGateState,
  evaluate,
  existingGateRunId,
  isRetryableStatus,
  latestPerName,
  publishCheck,
  retryDelayMs,
  SELF_NAMES,
  sweepShouldPost,
  verdict,
} from "../../scripts/pr-gate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const workflowsDir = path.join(repoRoot, ".github/workflows");

interface CheckRun {
  id?: number;
  name: string;
  status: string;
  conclusion: string | null;
}

const run = (name: string, status: string, conclusion: string | null = null): CheckRun => ({
  name,
  status,
  conclusion,
});

const green = (name: string): CheckRun => run(name, "completed", "success");

const evalRuns = (runs: CheckRun[]) => evaluate(runs, SELF_NAMES);

describe("evaluate — one snapshot's classification", () => {
  it("passes success, neutral and skipped; fails failure and cancelled", () => {
    const { failed, pending } = evalRuns([
      green("a"),
      run("b", "completed", "neutral"),
      run("c", "completed", "skipped"),
      run("d", "completed", "failure"),
      run("e", "completed", "cancelled"),
    ]);
    expect(pending).toEqual([]);
    expect(failed).toEqual(["d", "e"]);
  });

  it("fails closed on a conclusion it has never heard of", () => {
    expect(evalRuns([run("x", "completed", "some_future_conclusion")]).failed).toEqual(["x"]);
    expect(evalRuns([run("y", "completed", null)]).failed).toEqual(["y"]);
  });

  it("excludes only its own check names — a FAILING pr-gate run is not self-fulfilling", () => {
    // Both the API-posted check (`pr-gate`) and the eval job's own check
    // (`pr-gate-eval`, cancelled by per-SHA concurrency collapses) must be
    // invisible to the verdict.
    const { total, failed } = evalRuns([
      run("pr-gate", "completed", "failure"),
      run("pr-gate-eval", "completed", "cancelled"),
      green("a"),
    ]);
    expect(total).toBe(1);
    expect(failed).toEqual([]);
  });

  it("reports queued and in_progress runs as pending", () => {
    const { pending } = evalRuns([run("a", "queued"), run("b", "in_progress"), green("c")]);
    expect(pending).toEqual(["a", "b"]);
  });
});

// The stale-suite bug (observed on #2467 and #2477, 2026-08-10).  Both PRs sat
// permanently red with EVERY component check green, because a SHA can carry
// more than one check suite and the API's `filter=latest` only dedupes WITHIN
// one.  The trigger is the flow CLAUDE.md prescribes: open a draft, then mark
// it ready.  The ready-flip fires a second event on the SAME head SHA, the new
// suite's `cancel-in-progress` kills the draft suite mid-flight, and the gate's
// fail-closed "cancelled counts as FAILED" rule then reads the corpse.
//
// It is unrecoverable by design-of-the-bug: the cancelled run never changes, so
// every re-evaluation and every sweep re-derives the same red.  Only a
// force-push to a fresh SHA cleared it, which is why it has to be fixed here
// rather than worked around per PR.
describe("latestPerName — a SHA can carry more than one check suite", () => {
  it("keeps the newest run per name, dropping a superseded suite's corpse", () => {
    const collapsed = latestPerName([
      { id: 1, name: "build", status: "completed", conclusion: "cancelled" },
      { id: 2, name: "build", status: "completed", conclusion: "success" },
    ]);
    expect(collapsed).toEqual([
      { id: 2, name: "build", status: "completed", conclusion: "success" },
    ]);
  });

  it("is order-independent — the corpse loses whichever way the API lists it", () => {
    // The API does not promise an order, so the fix cannot rely on one.
    const newest = { id: 2, name: "build", status: "completed", conclusion: "success" };
    const corpse = { id: 1, name: "build", status: "completed", conclusion: "cancelled" };
    expect(latestPerName([newest, corpse])).toEqual([newest]);
    expect(latestPerName([corpse, newest])).toEqual([newest]);
  });

  it("still lets a genuinely failed NEWEST run condemn the SHA", () => {
    // The point is not "ignore cancellations" — it is "read the live suite".
    // A re-run that fails after an earlier success must still fail closed.
    const { failed } = evalRuns([
      { id: 1, name: "build", status: "completed", conclusion: "success" },
      { id: 2, name: "build", status: "completed", conclusion: "failure" },
    ]);
    expect(failed).toEqual(["build"]);
  });

  it("does not double-count a name across suites in the total", () => {
    const { total } = evalRuns([
      { id: 1, name: "build", status: "completed", conclusion: "cancelled" },
      { id: 2, name: "build", status: "completed", conclusion: "success" },
    ]);
    expect(total).toBe(1);
  });

  it("REGRESSION: the draft-then-ready SHA is green, not permanently red", () => {
    // The exact shape of #2477: a draft suite cancelled wholesale by the
    // ready-flip, and a live suite in which everything passed.  Before the fix
    // this returned `failure` naming all three, and no later event could undo
    // it.  This is the assertion that fails if the dedupe is reverted.
    const draftSuite: CheckRun[] = [
      { id: 10, name: "tests passed", status: "completed", conclusion: "cancelled" },
      { id: 11, name: "pages-passed", status: "completed", conclusion: "cancelled" },
      { id: 12, name: "flutter-build", status: "completed", conclusion: "cancelled" },
    ];
    const liveSuite: CheckRun[] = [
      { id: 20, name: "tests passed", status: "completed", conclusion: "success" },
      { id: 21, name: "pages-passed", status: "completed", conclusion: "success" },
      { id: 22, name: "flutter-build", status: "completed", conclusion: "success" },
    ];
    expect(verdict(evalRuns([...draftSuite, ...liveSuite]))).toEqual({
      state: "success",
      summary: "all 3 triggered check(s) passed",
    });
  });

  it("reads the gate's OWN state from the newest posting too", () => {
    // `pr-gate` posts a fresh check run per evaluation, so a busy SHA carries
    // many.  A bare `find` answered from whichever the API listed first, which
    // made the sweep's has-this-changed comparison a coin flip.
    expect(
      currentGateState([
        { id: 1, name: "pr-gate", status: "completed", conclusion: "failure" },
        { id: 2, name: "pr-gate", status: "completed", conclusion: "success" },
      ]),
    ).toBe("success");
  });
});

describe("verdict — snapshot to published state", () => {
  it("any failure wins, even while others are still pending (fail-fast)", () => {
    const v = verdict(evalRuns([run("fast-suite", "completed", "failure"), run("slow", "queued")]));
    expect(v.state).toBe("failure");
    expect(v.summary).toContain("fast-suite");
  });

  it("pending is BLOCKING but not failed — never green while checks run", () => {
    const v = verdict(evalRuns([green("done"), run("still-going", "in_progress")]));
    expect(v.state).toBe("pending");
    expect(v.summary).toContain("still-going");
  });

  it("zero other checks reporting blocks (fail-closed), it does not pass", () => {
    expect(verdict(evalRuns([])).state).toBe("pending");
  });

  it("all triggered checks green → success", () => {
    const v = verdict(evalRuns([green("a"), green("b")]));
    expect(v.state).toBe("success");
    expect(v.summary).toContain("2");
  });
});

// ---------------------------------------------------------------------------
// The workflow_run trigger list — pinned against the real inventory.
// ---------------------------------------------------------------------------

/** The `name:` of a workflow file (first line by repo convention). */
function workflowName(file: string): string {
  const m = readFileSync(path.join(workflowsDir, file), "utf8").match(/^name:\s*(.+)$/m);
  expect(m, `${file} has no name:`).toBeTruthy();
  return (m as RegExpMatchArray)[1].trim().replace(/^['"]|['"]$/g, "");
}

/** The quoted entries of pr-gate.yml's `workflow_run.workflows:` list.
 *  Anchored on the indented KEY line, not the word — the file's comments and
 *  the `branches-ignore` block also contain "workflows"/list entries. */
function triggerList(): string[] {
  const src = readFileSync(path.join(workflowsDir, "pr-gate.yml"), "utf8");
  const start = src.search(/^ {4}workflows:\s*$/m);
  expect(start, "pr-gate.yml lost its workflow_run.workflows key").toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf("permissions:"));
  return [...block.matchAll(/-\s*'([^']+)'/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// The sweep's concurrency, pinned.
//
// The gate is event-driven, and `workflow_run` delivery is best-effort — the
// 15-minute cron sweep is the safety net that un-parks a PR whose final event
// GitHub dropped.  That net was itself broken by the concurrency block, in a
// way nothing tested: a `schedule` payload carries neither `pull_request` nor
// `workflow_run`, so the group key resolved to the literal `pr-gate-` and, with
// `cancel-in-progress: true`, each cron tick cancelled the previous one.  Under
// the runner starvation the sweep exists to survive, the sweep never ran.
//
// Both halves are pinned because both are load-bearing and the "obvious" fix to
// the first (a unique key per run) silently breaks correctness: unique keys let
// sweeps OVERLAP, and a slower sweep posting its older verdict last can re-park
// a PR it already greened.
// ---------------------------------------------------------------------------

/** The `concurrency:` block of pr-gate.yml, comments stripped. */
function concurrencyBlock(): { group: string; cancelInProgress: string } {
  const src = readFileSync(path.join(workflowsDir, "pr-gate.yml"), "utf8");
  const start = src.search(/^concurrency:\s*$/m);
  expect(start, "pr-gate.yml lost its top-level concurrency: key").toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf("\njobs:"));
  const group = block.match(/^\s*group:\s*(.+)$/m);
  const cancel = block.match(/^\s*cancel-in-progress:\s*(.+)$/m);
  expect(group, "concurrency block lost its group:").toBeTruthy();
  expect(cancel, "concurrency block lost its cancel-in-progress:").toBeTruthy();
  return {
    group: (group as RegExpMatchArray)[1].trim(),
    cancelInProgress: (cancel as RegExpMatchArray)[1].trim(),
  };
}

describe("pr-gate.yml concurrency does not cancel its own safety net", () => {
  it("the group key has a non-empty fallback for SHA-less events", () => {
    const { group } = concurrencyBlock();
    // Both SHA expressions are empty on `schedule` / `workflow_dispatch`.  With
    // no third alternative the key collapses to a single shared literal and
    // every sweep contends with every other sweep.
    expect(group).toContain("github.event.pull_request.head.sha");
    expect(group).toContain("github.event.workflow_run.head_sha");
    expect(
      /\|\|\s*'[^']+'\s*\}\}/.test(group),
      `group key needs a literal fallback for SHA-less (schedule / dispatch) events, got: ${group}`,
    ).toBe(true);
  });

  it("cancel-in-progress is conditional, never an unguarded true", () => {
    const { cancelInProgress } = concurrencyBlock();
    // An unconditional `true` cancels the sweep; a unique-per-run group would
    // instead let sweeps overlap and race.  The only safe shape is: cancel for
    // the SHA-keyed events, do not cancel for the sweep.
    expect(
      cancelInProgress,
      "cancel-in-progress: true cancels the cron sweep — gate it on the SHA-keyed events",
    ).not.toBe("true");
    expect(cancelInProgress).toContain("github.event_name");
    expect(cancelInProgress).toContain("pull_request");
    expect(cancelInProgress).toContain("workflow_run");
    // …and it must NOT name the sweep's own events, or it cancels them again.
    expect(cancelInProgress).not.toContain("schedule");
  });
});

describe("pr-gate.yml re-evaluates on every other workflow's completion", () => {
  const others = readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml") && f !== "pr-gate.yml")
    .sort();
  const listed = new Set(triggerList());

  it("found the real inventory (the reader still works)", () => {
    expect(others.length).toBeGreaterThan(40);
    expect(listed.size).toBeGreaterThan(40);
  });

  for (const file of others) {
    it(`${file} is in the workflow_run list`, () => {
      const name = workflowName(file);
      expect(
        listed.has(name),
        `pr-gate.yml's workflow_run.workflows is missing '${name}' (${file}).\n` +
          "Without it, that workflow's completion never re-evaluates the gate " +
          "and a PR waiting only on it sticks at in_progress.",
      ).toBe(true);
    });
  }

  it("lists nothing that does not exist (stale names re-evaluate nothing)", () => {
    const real = new Set(others.map(workflowName));
    const stale = [...listed].filter((n) => !real.has(n));
    expect(stale, `stale workflow_run entries: ${stale.join("; ")}`).toEqual([]);
  });

  it("does not listen to itself", () => {
    expect(listed.has(workflowName("pr-gate.yml"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dropped-event resilience — pinned.  `workflow_run` delivery is BEST-EFFORT:
// under this repo's completion storms GitHub drops dispatches, and a dropped
// final event parked a fully-green PR at in_progress (#2464, 08:42Z).  Two
// defenses, each of which rots silently if removed:
//   1. `branches-ignore: [main]` on the workflow_run trigger — without it,
//      every push:main heavy-set completion (~60 per merge) creates an eval
//      run, and that dispatch storm is what got real events dropped;
//   2. the scheduled sweep — without it, one dropped event = one PR parked
//      until a human pokes it.
// ---------------------------------------------------------------------------

describe("pr-gate survives dropped workflow_run events", () => {
  const src = readFileSync(path.join(workflowsDir, "pr-gate.yml"), "utf8");

  it("ignores main / merge-queue completions at the trigger (the storm source)", () => {
    const wrBlock = src.slice(src.indexOf("workflow_run:"), src.indexOf("permissions:"));
    expect(
      /branches-ignore:/.test(wrBlock) && /-\s*main\b/.test(wrBlock),
      "workflow_run must carry branches-ignore including main — every push:main " +
        "completion otherwise creates an eval run, and that storm drops real events",
    ).toBe(true);
  });

  it("carries the scheduled sweep (the dropped-event safety net)", () => {
    expect(/^\s*schedule:/m.test(src), "pr-gate.yml lost its schedule trigger").toBe(true);
    expect(/cron:/.test(src)).toBe(true);
  });

  it("the job runs on schedule/dispatch events, not only pull_request paths", () => {
    // The old guard `event_name == 'pull_request' || …` silently skips the
    // sweep.  The inverted form runs everything except non-PR workflow_run.
    expect(src).toContain(
      "if: github.event_name != 'workflow_run' || github.event.workflow_run.event == 'pull_request'",
    );
  });

  it("sweep may list open PRs", () => {
    expect(/pull-requests:\s*read/.test(src)).toBe(true);
  });
});

describe("sweep reconciliation — currentGateState / sweepShouldPost", () => {
  it("reads the published gate state out of a snapshot", () => {
    expect(currentGateState([green("a")])).toBe("absent");
    expect(currentGateState([run("pr-gate", "in_progress"), green("a")])).toBe("pending");
    expect(currentGateState([run("pr-gate", "completed", "success")])).toBe("success");
    expect(currentGateState([run("pr-gate", "completed", "failure")])).toBe("failure");
  });

  it("posts exactly when the fresh verdict disagrees — the parked-PR fix", () => {
    // The observed outage: gate published `pending`, every check green.
    expect(sweepShouldPost("pending", { state: "success" })).toBe(true);
    // And the churn guard: identical verdicts are not re-posted every cycle.
    expect(sweepShouldPost("success", { state: "success" })).toBe(false);
    expect(sweepShouldPost("pending", { state: "pending" })).toBe(false);
    expect(sweepShouldPost("success", { state: "failure" })).toBe(true);
    expect(sweepShouldPost("absent", { state: "pending" })).toBe(true);
  });
});

describe("apiFetch — github.com's transient 5xx is not a verdict", () => {
  // Observed 2026-08-17: the scheduled sweep died on `503 No server is
  // currently available to service your request` while posting PR 6 of 12 —
  // a red `pr-gate` run that said nothing about any PR, and left the six
  // unswept.  The gate is the recovery path for every other check, so an API
  // blip must cost a retry, not the job.
  const res = (status: number) =>
    ({ ok: status >= 200 && status < 300, status, text: async () => "" }) as Response;
  const noSleep = async () => {};

  it("classifies what is worth retrying — transient yes, defect no", () => {
    for (const s of [429, 500, 502, 503, 504]) expect(isRetryableStatus(s), `${s}`).toBe(true);
    // A 401/403 is a bad token or a missing permission and a 422 is a malformed
    // body; retrying those only delays the honest failure.
    for (const s of [400, 401, 403, 404, 409, 422])
      expect(isRetryableStatus(s), `${s}`).toBe(false);
  });

  it("backs off 1s, 2s, 4s — bounded, so an evaluation stays seconds long", () => {
    expect([1, 2, 3].map(retryDelayMs)).toEqual([1000, 2000, 4000]);
    // v2's whole claim is that a gate run never parks a runner slot.
    let total = 0;
    for (let a = 1; a < API_MAX_ATTEMPTS; a += 1) total += retryDelayMs(a);
    expect(total).toBeLessThanOrEqual(10_000);
  });

  it("retries the 503 and returns the response that follows it", async () => {
    const seen: number[] = [];
    const statuses = [503, 503, 201];
    const fetchImpl = async () => {
      const s = statuses[seen.length];
      seen.push(s);
      return res(s);
    };
    const out = await apiFetch("u", {}, { fetchImpl, sleep: noSleep, onRetry: () => {} });
    expect(out.status).toBe(201);
    expect(seen).toEqual([503, 503, 201]);
  });

  it("does not retry a 422 — one call, and the caller still throws", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return res(422);
    };
    const out = await apiFetch("u", {}, { fetchImpl, sleep: noSleep, onRetry: () => {} });
    expect(calls).toBe(1);
    expect(out.ok).toBe(false);
  });

  it("gives up after the ladder and hands the failing response back to the caller", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return res(503);
    };
    const out = await apiFetch("u", {}, { fetchImpl, sleep: noSleep, onRetry: () => {} });
    // Still a Response, not a swallowed error: the call site's own
    // `if (!res.ok) throw` keeps producing its message unchanged.
    expect(calls).toBe(API_MAX_ATTEMPTS);
    expect(out.status).toBe(503);
  });

  it("retries a rejected fetch (reset socket / DNS) and rethrows on the last", async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNRESET");
      return res(200);
    };
    expect(
      (await apiFetch("u", {}, { fetchImpl: flaky, sleep: noSleep, onRetry: () => {} })).ok,
    ).toBe(true);

    let always = 0;
    const dead = async () => {
      always += 1;
      throw new Error("ENOTFOUND");
    };
    await expect(
      apiFetch("u", {}, { fetchImpl: dead, sleep: noSleep, onRetry: () => {} }),
    ).rejects.toThrow("ENOTFOUND");
    expect(always).toBe(API_MAX_ATTEMPTS);
  });

  it("every GitHub call goes through it — a bare fetch would keep the old red", () => {
    // The helper is worthless if a call site skips it, and the miss is
    // invisible (the code reads fine and only fails during an outage).
    const src = readFileSync(path.join(repoRoot, "scripts/pr-gate.mjs"), "utf8");
    const bare = src.match(/await fetch\(/g) ?? [];
    expect(bare, "a call site still calls fetch directly instead of apiFetch").toEqual([]);
    // Three GitHub endpoints: list check runs, list open PRs, publish the
    // check.  (Counted excluding `apiFetch`'s own definition.)
    expect((src.match(/(?<!function )\bapiFetch\(/g) ?? []).length).toBe(3);
  });
});

describe("publishCheck — one `pr-gate` run per SHA, updated in place", () => {
  // The merge refusal on #2593: every component check green, and
  //   405 Repository rule violations found
  //   Required status check "pr-gate" is expected.
  // The SHA carried THREE `pr-gate` runs — two stuck at "waiting on N/M"
  // because v2 created a new run per evaluation and never completed the old
  // ones, and one "all 8 triggered check(s) passed".  The draft→ready flip had
  // split them across two check suites, and the required-check evaluation read
  // a stale pending one.  Only a force-push to a fresh SHA cleared it.
  const ok = { ok: true, status: 200, text: async () => "" } as Response;
  const noSleep = async () => {};
  const V = { state: "success" as const, summary: "all 8 triggered check(s) passed" };

  const spy = (responses: Response[] = [ok]) => {
    const calls: { method: string; url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({
        method: init.method as string,
        url,
        body: JSON.parse(init.body as string),
      });
      return responses[calls.length - 1] ?? ok;
    };
    return { calls, opts: { fetchImpl, sleep: noSleep, onRetry: () => {} } };
  };

  it("finds the run to reuse — newest per name, null when the gate never published", () => {
    expect(
      existingGateRunId([
        { id: 1, name: "pr-gate", status: "in_progress", conclusion: null },
        { id: 2, name: "pr-gate", status: "completed", conclusion: "success" },
        { id: 3, name: "tests passed", status: "completed", conclusion: "success" },
      ]),
    ).toBe(2);
    expect(existingGateRunId([green("tests passed")])).toBe(null);
  });

  it("UPDATES the existing run instead of leaving a stale pending sibling", async () => {
    const { calls, opts } = spy();
    await publishCheck("o/r", "deadbeef", "t", V, 4242, opts);
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/check-runs/4242");
    // head_sha is create-only — PATCH 422s on it.
    expect(calls[0].body.head_sha).toBeUndefined();
    expect(calls[0].body.status).toBe("completed");
    expect(calls[0].body.conclusion).toBe("success");
  });

  it("creates one the first time the gate publishes on a SHA", async () => {
    const { calls, opts } = spy();
    await publishCheck("o/r", "deadbeef", "t", V, null, opts);
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toMatch(/\/check-runs$/);
    expect(calls[0].body.head_sha).toBe("deadbeef");
    expect(calls[0].body.name).toBe("pr-gate");
  });

  it("a pending verdict updates the SAME run — that is the whole fix", async () => {
    // Under v2 this call is what minted the run that later blocked the merge.
    const { calls, opts } = spy();
    await publishCheck(
      "o/r",
      "deadbeef",
      "t",
      { state: "pending", summary: "waiting on 2/8: tests passed, schema-load" },
      4242,
      opts,
    );
    expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
    expect(calls[0].body.status).toBe("in_progress");
    expect(calls[0].body.conclusion).toBeUndefined();
  });

  it("falls back to creating when the run belongs to another app (403)", async () => {
    // Only the app that created a check run may update it.  Better a duplicate
    // than no verdict at all — and the log line says which happened.
    const forbidden = { ok: false, status: 403, text: async () => "" } as Response;
    const { calls, opts } = spy([forbidden, ok]);
    await publishCheck("o/r", "deadbeef", "t", V, 4242, { ...opts, onRetry: () => {} });
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
    expect(calls[1].body.head_sha).toBe("deadbeef");
  });

  it("BOTH call sites pass the id — a `null` there silently restores the bug", () => {
    // publishCheck is correct in isolation and useless if a caller hands it
    // `null`: the SHA grows a second run and the merge refusal comes back.
    // The sweep is the call site that matters most — it is what finally
    // published the green verdict on #2593 after the event was dropped.
    const src = readFileSync(path.join(repoRoot, "scripts/pr-gate.mjs"), "utf8");
    const wired = src.match(/publishCheck\([^)]*existingGateRunId\(runs\)\)/g) ?? [];
    expect(wired.length, "a publishCheck call site is not passing existingGateRunId(runs)").toBe(2);
  });

  it("still throws the caller's message when publishing genuinely fails", async () => {
    const bad = { ok: false, status: 422, text: async () => "Invalid request" } as Response;
    const { opts } = spy([bad, bad]);
    await expect(publishCheck("o/r", "deadbeef", "t", V, 4242, opts)).rejects.toThrow(
      "GitHub API 422 posting check run",
    );
  });
});
