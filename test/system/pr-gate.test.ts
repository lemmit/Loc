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
import { evaluate, SELF_NAMES, verdict } from "../../scripts/pr-gate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const workflowsDir = path.join(repoRoot, ".github/workflows");

interface CheckRun {
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

/** The quoted entries of pr-gate.yml's `workflow_run.workflows:` list. */
function triggerList(): string[] {
  const src = readFileSync(path.join(workflowsDir, "pr-gate.yml"), "utf8");
  const block = src.slice(src.indexOf("workflows:"), src.indexOf("permissions:"));
  return [...block.matchAll(/-\s*'([^']+)'/g)].map((m) => m[1]);
}

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
