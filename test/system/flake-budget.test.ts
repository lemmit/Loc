// The flake budget's decision core — M-T9.30.
//
// `scripts/flake-budget.mjs` classifies each CI leg from its recent `main` run
// history; `.github/workflows/flake-budget.yml` turns each flagged leg into one
// deduped claiming issue. The network half is not testable here, but every
// judgement it makes is pure, so all of it is pinned below against fixture
// history in `fixtures/flake-budget-runs.json`.
//
// The case that earns this file: `twoGreenRestCancelled` /
// `reactBuildMain2026-08`. This repo pushes to main in bursts and
// `cancel-in-progress` supersedes all but the last of each burst, so a naive
// "take the last 20 runs, then drop the cancelled ones" window spends most of
// its slots on cancelled corpses. The first cut of the script did exactly that
// and could only judge 5 of `generated-react-build`'s 20 most recent runs —
// halving the evidence behind a claim that files an issue at somebody. The
// fixture is that leg's REAL captured history, so the fix stays fixed.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, deliberately dependency-free and untyped.
import * as budget from "../../scripts/flake-budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.resolve(here, "../../.github/workflows");
const fixtures = JSON.parse(
  readFileSync(path.join(here, "fixtures/flake-budget-runs.json"), "utf8"),
);

/** A fixed clock, so `daysAgo` maps to a stable `created_at`. */
const NOW = new Date("2026-08-11T20:00:00Z");
const DAY_MS = 86_400_000;

type FixtureRun = { conclusion: string | null; status?: string; attempt?: number; daysAgo: number };

/** Expand a fixture scenario into the run shape the Actions API returns. */
function runs(name: string) {
  const scenario: FixtureRun[] = fixtures[name];
  expect(scenario, `no such fixture scenario: ${name}`).toBeDefined();
  return scenario.map((r, i) => ({
    id: 1000 - i,
    conclusion: r.conclusion,
    status: r.status ?? "completed",
    run_attempt: r.attempt ?? 1,
    created_at: new Date(NOW.getTime() - r.daysAgo * DAY_MS).toISOString(),
    html_url: `https://github.com/lemmit/Loc/actions/runs/${1000 - i}`,
    head_sha: `${i}`.padStart(8, "0"),
  }));
}

/** Classify a scenario as a leg with the given stale policy. */
function classify(scenario: string, staleAfterDays: number | null = null) {
  return budget.classify(
    { file: "some-gate.yml", name: "Some gate", staleAfterDays, runs: runs(scenario) },
    NOW,
  );
}

describe("flake budget — pass rate and classification", () => {
  it("an all-green leg is healthy at 100%", () => {
    const s = classify("allGreen");
    expect(s.status).toBe("healthy");
    expect(s.passRate).toBe(1);
    expect(s.flagged).toBe(false);
  });

  it("flags a leg below the threshold", () => {
    const s = classify("fiveInTwentyFail");
    expect(s.considered).toBe(20);
    expect(s.passRate).toBe(0.75);
    expect(s.status).toBe("below-threshold");
    expect(s.flagged).toBe(true);
  });

  // The boundary is the whole point of a named threshold: exactly-at-budget is
  // IN budget, so 80% must not flag while 79% must. Without both sides an
  // off-by-one in the comparison passes.
  it("treats exactly-at-threshold as inside budget", () => {
    const at = classify("fourInTwentyFail");
    expect(at.passRate).toBe(budget.PASS_RATE_THRESHOLD);
    expect(at.status).toBe("healthy");

    const under = classify("fiveInTwentyFail");
    expect(under.passRate).toBeLessThan(budget.PASS_RATE_THRESHOLD);
    expect(under.status).toBe("below-threshold");
  });

  it("leaves a leg just inside budget alone", () => {
    const s = classify("threeInTwentyFail");
    expect(s.passRate).toBe(0.85);
    expect(s.status).toBe("healthy");
  });

  it("counts a re-run to green as a flake, not a pass", () => {
    const s = classify("retriedToGreen");
    // What actually happened: two of them needed a re-run. Assert the honest
    // rate FIRST — if the first-attempt discipline is ever dropped, the failure
    // should name `passRate`, not a knock-on in a derived field.
    expect(s.passRate).toBe(0.8);
    expect(s.retryPasses).toBe(2);
    // What the Actions UI shows: everything green.
    expect(s.finalPassRate).toBe(1);
    expect(s.status).toBe("retry-masked");
    expect(s.flagged).toBe(true);
  });

  it("does not flag a single re-run as retry-masked", () => {
    const one = runs("retriedToGreen").map((r, i) => (i === 2 ? { ...r, run_attempt: 1 } : r));
    const s = budget.classify({ file: "f.yml", name: "n", staleAfterDays: null, runs: one }, NOW);
    expect(s.retryPasses).toBe(1);
    expect(s.retryPasses).toBeLessThan(budget.RETRY_FLAKE_MIN);
    expect(s.status).not.toBe("retry-masked");
  });
});

describe("flake budget — the never-green and never-scheduled classes", () => {
  it("flags an all-startup_failure leg without waiting for a full window", () => {
    const s = classify("allStartupFailure");
    expect(s.considered).toBeLessThan(budget.MIN_RUNS_FOR_RATE);
    expect(s.status).toBe("startup-failure");
    expect(s.flagged).toBe(true);
    expect(s.headline).toContain("startup_failure");
  });

  it("flags a leg that has never run at all", () => {
    const s = budget.classify({ file: "f.yml", name: "n", staleAfterDays: 7, runs: [] }, NOW);
    expect(s.status).toBe("never-run");
    expect(s.flagged).toBe(true);
  });

  it("flags a leg that has gone quiet past its stale window", () => {
    const s = classify("goneQuiet", budget.STALE_DAYS);
    expect(s.ageDays).toBeGreaterThan(budget.STALE_DAYS);
    expect(s.status).toBe("stale");
  });

  // The false positive that would get this bot muted: a path-scoped gate
  // legitimately idles for weeks when nothing under its paths changes, so it is
  // exempt (staleAfterDays === null) rather than flagged every week.
  it("exempts a path-scoped leg from the stale class", () => {
    const s = classify("goneQuiet", null);
    expect(s.ageDays).toBeGreaterThan(budget.STALE_DAYS);
    expect(s.status).not.toBe("stale");
    expect(s.flagged).toBe(false);
  });

  it("gives a weekly cron a longer leash than a daily one", () => {
    expect(
      budget.staleAfterDays({ pushMain: false, pushMainPaths: false, crons: ["0 3 * * *"] }),
    ).toBe(budget.STALE_DAYS);
    expect(
      budget.staleAfterDays({ pushMain: false, pushMainPaths: false, crons: ["0 3 * * 1"] }),
    ).toBe(budget.WEEKLY_STALE_DAYS);
    expect(budget.staleAfterDays({ pushMain: true, pushMainPaths: false, crons: [] })).toBe(
      budget.STALE_DAYS,
    );
    expect(budget.staleAfterDays({ pushMain: true, pushMainPaths: true, crons: [] })).toBeNull();
  });

  it("says too-thin rather than healthy on a short history", () => {
    const s = budget.classify(
      { file: "f.yml", name: "n", staleAfterDays: null, runs: runs("allGreen").slice(0, 3) },
      NOW,
    );
    expect(s.status).toBe("insufficient-data");
    expect(s.flagged).toBe(false);
  });
});

describe("flake budget — what counts as evidence", () => {
  it("drops cancelled and skipped runs from the denominator", () => {
    const s = classify("twoGreenRestCancelled");
    // 7 runs in, only the 2 successes carry evidence.
    expect(s.considered).toBe(2);
    expect(s.passRate).toBe(1);
  });

  // A conclusion this script has never heard of must not read as a pass — the
  // same fail-closed discipline pr-gate.mjs applies.
  it("fails closed on an unknown conclusion", () => {
    const s = classify("unknownConclusion");
    expect(s.considered).toBe(6);
    expect(s.failures).toBe(5);
    expect(s.passRate).toBeCloseTo(1 / 6);
    expect(s.status).toBe("below-threshold");
  });

  it("ignores runs that have not concluded yet", () => {
    const s = classify("reactBuildMain2026-08");
    // The queued run at the head of the capture must not count either way.
    expect(s.considered + s.retryPasses).toBeLessThan(runs("reactBuildMain2026-08").length);
  });

  // THE REGRESSION PIN. The real capture is cancellation-heavy: 30 runs, 20 of
  // them cancelled, 10 genuine failures. Windowing over RAW runs would judge
  // this leg on ~5 of its failures; windowing over runs that carry evidence
  // sees all 10. Both agree it is broken — but only one of them says so with
  // the sample size the claim actually has.
  it("does not let cancelled runs eat the window", () => {
    const s = classify("reactBuildMain2026-08");
    expect(s.considered).toBe(10);
    expect(s.failures).toBe(10);
    expect(s.passRate).toBe(0);
    expect(s.status).toBe("below-threshold");
  });

  it("caps the window at WINDOW runs that carry evidence", () => {
    const many = [...runs("allGreen"), ...runs("allGreen"), ...runs("allGreen")];
    const s = budget.classify({ file: "f.yml", name: "n", staleAfterDays: null, runs: many }, NOW);
    expect(many.length).toBeGreaterThan(budget.WINDOW);
    expect(s.considered).toBe(budget.WINDOW);
  });
});

describe("flake budget — the claiming issue", () => {
  it("keys the issue on a stable marker, not on the title", () => {
    const s = classify("fiveInTwentyFail");
    const body = budget.issueBodyFor(s, { generatedAt: NOW.toISOString() });
    expect(body).toContain(budget.markerFor(s.file));
    // The marker survives a status change; the title deliberately does not.
    const worse = classify("allStartupFailure");
    expect(budget.issueTitleFor(worse)).not.toBe(budget.issueTitleFor(s));
    expect(budget.markerFor(s.file)).toBe(budget.markerFor(worse.file));
  });

  it("reports both rates in the body, so a re-run-green leg is legible", () => {
    const s = classify("retriedToGreen");
    const body = budget.issueBodyFor(s, { generatedAt: NOW.toISOString() });
    expect(body).toContain("First-attempt pass rate");
    expect(body).toContain("Final-attempt pass rate");
    expect(body).toContain("re-run");
  });

  it("claims only the flagged legs", () => {
    const report = budget.buildReport(
      [classify("allGreen"), classify("fiveInTwentyFail"), classify("allStartupFailure")],
      { repo: "lemmit/Loc", generatedAt: NOW.toISOString() },
    );
    expect(report.counts.monitored).toBe(3);
    expect(report.counts.flagged).toBe(2);
    expect(report.claims).toHaveLength(2);
    expect(report.label).toBe(budget.ISSUE_LABEL);
  });

  it("the marker round-trips through the regex the workflow greps with", () => {
    // Keep this in step with `.github/workflows/flake-budget.yml`.
    const wf = readFileSync(path.join(workflowsDir, "flake-budget.yml"), "utf8");
    const declared = wf.match(/match\((\/<!-- flake-budget:.+?\/)\)/)?.[1];
    expect(declared, "flake-budget.yml lost its marker regex").toBeTruthy();
    const re = new RegExp(declared!.slice(1, -1));
    expect(budget.markerFor("behavioral-e2e-java.yml").match(re)?.[1]).toBe(
      "behavioral-e2e-java.yml",
    );
  });
});

describe("flake budget — which legs are monitored", () => {
  const monitored = budget.monitoredWorkflows(workflowsDir);
  const byFile = new Map(monitored.map((w: { file: string }) => [w.file, w]));

  it("derives the watchlist from the directory rather than a hand-curated list", () => {
    expect(monitored.length).toBeGreaterThan(20);
    // A hand-curated list is what let api-call-e2e rot unwatched (#2434); the
    // heavy runtime legs must be in scope by construction.
    for (const f of [
      "api-call-e2e.yml",
      "behavioral-e2e-java.yml",
      "channels-e2e.yml",
      "tenancy-e2e.yml",
      "hono-obs-e2e.yml",
      "python-oidc-e2e.yml",
      "migration-evolution-e2e.yml",
    ]) {
      expect(byFile.has(f), `${f} is not in the flake budget`).toBe(true);
    }
  });

  it("excludes the meta workflows that have no product signal", () => {
    for (const f of budget.NOT_A_GATE.keys()) expect(byFile.has(f)).toBe(false);
    // …and every exclusion carries a reason, so the list can't grow silently.
    for (const why of budget.NOT_A_GATE.values()) expect(String(why).length).toBeGreaterThan(10);
  });

  it("the trigger reader sees a name and an on: block for every workflow it monitors", () => {
    for (const w of monitored as { file: string; name: string }[]) {
      expect(w.name, `${w.file} has no top-level name:`).toBeTruthy();
      expect(w.name).not.toBe(w.file);
    }
  });

  it("reads a real nightly-cron workflow as cron-triggered", () => {
    const nightly = byFile.get("generated-a11y.yml");
    expect(nightly, "generated-a11y.yml is not monitored").toBeTruthy();
    expect(nightly.triggers.crons.length).toBeGreaterThan(0);
  });
});
