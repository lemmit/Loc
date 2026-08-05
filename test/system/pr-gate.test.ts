// Pins the decision core of scripts/pr-gate.mjs — the aggregate required
// check that substitutes for a merge queue on this personal-account repo
// (docs/ci-gating.md).  The gate's whole claim is "any triggered red blocks,
// path-skipped is fine, nothing-reported fails closed"; each arm below is the
// seeded-defect proof for one clause of that claim.

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS module without a declaration file; the runtime
// shape is pinned by the assertions below.
import { evaluate, runGate } from "../../scripts/pr-gate.mjs";

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

/** Drive runGate over a scripted sequence of poll snapshots; the last snapshot
 *  repeats once the script runs out (a stable end state). */
function gateOver(snapshots: CheckRun[][], overrides: Record<string, unknown> = {}) {
  let poll = 0;
  return runGate({
    listCheckRuns: () => {
      const snap = snapshots[Math.min(poll, snapshots.length - 1)];
      poll += 1;
      return Promise.resolve(snap);
    },
    sleep: () => Promise.resolve(),
    log: () => {},
    selfName: "pr-gate",
    pollMs: 1000,
    graceMs: 2000,
    timeoutMs: 10_000,
    ...overrides,
  }) as Promise<{ ok: boolean; reason: string }>;
}

describe("evaluate — one snapshot's verdict", () => {
  it("passes success, neutral and skipped; fails failure and cancelled", () => {
    const { failed, pending } = evaluate(
      [
        green("a"),
        run("b", "completed", "neutral"),
        run("c", "completed", "skipped"),
        run("d", "completed", "failure"),
        run("e", "completed", "cancelled"),
      ],
      "pr-gate",
    );
    expect(pending).toEqual([]);
    expect(failed).toEqual(["d", "e"]);
  });

  it("fails closed on a conclusion it has never heard of", () => {
    expect(evaluate([run("x", "completed", "some_future_conclusion")], "pr-gate").failed).toEqual([
      "x",
    ]);
    expect(evaluate([run("y", "completed", null)], "pr-gate").failed).toEqual(["y"]);
  });

  it("excludes only itself — a FAILING run named pr-gate is not self-fulfilling", () => {
    const { total, failed } = evaluate(
      [run("pr-gate", "completed", "failure"), green("a")],
      "pr-gate",
    );
    expect(total).toBe(1);
    expect(failed).toEqual([]);
  });

  it("reports queued and in_progress runs as pending", () => {
    const { pending } = evaluate(
      [run("a", "queued"), run("b", "in_progress"), green("c")],
      "pr-gate",
    );
    expect(pending).toEqual(["a", "b"]);
  });
});

describe("runGate — the polling verdict", () => {
  it("passes once every triggered check completes green (after grace, twice)", async () => {
    const result = await gateOver([
      [run("suite", "in_progress")],
      [run("suite", "in_progress")],
      [green("suite")],
      [green("suite")],
    ]);
    expect(result.ok).toBe(true);
  });

  it("fails FAST on a red check — does not wait out the still-pending ones", async () => {
    let polls = 0;
    const result = await runGate({
      listCheckRuns: () => {
        polls += 1;
        return Promise.resolve([run("fast-suite", "completed", "failure"), run("slow", "queued")]);
      },
      sleep: () => Promise.resolve(),
      log: () => {},
      selfName: "pr-gate",
      pollMs: 1000,
      graceMs: 2000,
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("fast-suite");
    expect(polls).toBe(1);
  });

  it("fails closed when NO other check ever reports (Actions never picked the push up)", async () => {
    const result = await gateOver([[]]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no other check ever reported");
  });

  it("a lone early all-clear poll does not pass — late-created runs are waited for", async () => {
    // Poll 1: only the fast check exists and is already green (inside grace).
    // Poll 2: a heavier workflow's run has appeared, still queued.  A gate that
    // trusted the first snapshot would have passed before the real gates ran.
    const result = await gateOver([
      [green("fast")],
      [green("fast"), run("heavy", "queued")],
      [green("fast"), run("heavy", "completed", "failure")],
    ]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("heavy");
  });

  it("requires TWO consecutive all-clear polls, independent of the grace period", async () => {
    // graceMs: 0 isolates the consecutive-poll defense from the grace window —
    // with grace alone, a single-poll pass (`allClearPolls >= 1`) would survive
    // the test above (the grace delay happens to outlast the late run's
    // appearance).  Mutation-proved: weakening the threshold to 1 fails here.
    const result = await gateOver(
      [
        [green("fast")],
        [green("fast"), run("heavy", "queued")],
        [green("fast"), run("heavy", "completed", "failure")],
      ],
      { graceMs: 0 },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("heavy");
  });

  it("times out with the culprits named when a check never completes", async () => {
    const result = await gateOver([[run("wedged", "in_progress")]]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("wedged");
  });
});
