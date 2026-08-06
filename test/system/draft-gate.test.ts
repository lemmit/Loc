// Draft PRs run only the fast lane — pinned.
//
// docs/ci-gating.md → "Draft PRs and the runner queue": the account's runner
// pool allows ~20 concurrent jobs, a substantive push fires 30–50, and the
// claim-first culture means most pushes happen on DRAFT PRs.  So the per-PR
// fan-out is draft-gated: every expensive workflow fires only once the PR is
// marked ready for review, while drafts get the fast lane (test.yml,
// langium-generated, workflow-lint, pr-gate).
//
// Two ways this rots, both silent:
//   1. a NEW workflow gets a plain `pull_request:` trigger and quietly
//      rejoins the draft fan-out — the queue regrows one workflow at a time;
//   2. someone draft-gates a FAST-LANE workflow — worst of all test.yml,
//      whose `tests passed` is a required check and the floor pr-gate's
//      fail-closed arm stands on; gating it strands every draft PR.
//
// This suite reads the workflow files the same indentation-disciplined way
// merge-queue-readiness.test.ts does (no YAML parser in the dependency tree)
// and pins both directions.

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.resolve(here, "../../.github/workflows");

/** Workflows that MUST keep running on draft PRs.  test.yml is the required
 *  floor; langium-generated and workflow-lint are seconds-cheap correctness
 *  gates; pr-gate must always run to aggregate whatever did. */
const FAST_LANE = new Set([
  "test.yml",
  "langium-generated.yml",
  "workflow-lint.yml",
  "pr-gate.yml",
]);

const DRAFT_GATE_IF =
  "github.event_name != 'pull_request' || github.event.pull_request.draft == false";

interface Workflow {
  readonly file: string;
  readonly source: string;
  /** The `types:` list of the top-level pull_request trigger, if declared. */
  readonly prTypes: string[] | undefined;
  readonly hasPullRequest: boolean;
}

function readWorkflow(file: string): Workflow {
  const source = readFileSync(path.join(workflowsDir, file), "utf8");
  const lines = source.split("\n").filter((l) => !/^\s*#/.test(l));
  let hasPullRequest = false;
  let prTypes: string[] | undefined;
  let inPr = false;
  for (const line of lines) {
    if (/^ {2}pull_request:/.test(line)) {
      hasPullRequest = true;
      inPr = true;
      continue;
    }
    if (inPr) {
      const types = line.match(/^ {4}types:\s*\[([^\]]*)\]/);
      if (types) prTypes = types[1].split(",").map((t) => t.trim());
      // any non-indented-under-pull_request line ends the block
      if (/^ {2}\S/.test(line)) inPr = false;
    }
  }
  return { file, source, prTypes, hasPullRequest };
}

/** Top-level job blocks: name plus whether the body carries `needs:` / the
 *  draft-gate `if`. */
function jobs(source: string): Array<{ name: string; hasNeeds: boolean; hasDraftGate: boolean }> {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const found: Array<{ name: string; hasNeeds: boolean; hasDraftGate: boolean }> = [];
  let current: { name: string; hasNeeds: boolean; hasDraftGate: boolean } | undefined;
  for (const line of lines.slice(start + 1)) {
    const header = line.match(/^ {2}([A-Za-z_][\w-]*):\s*$/);
    if (header) {
      current = { name: header[1], hasNeeds: false, hasDraftGate: false };
      found.push(current);
      continue;
    }
    if (!current) continue;
    if (/^ {4}needs:/.test(line)) current.hasNeeds = true;
    if (line.includes(DRAFT_GATE_IF)) current.hasDraftGate = true;
  }
  return found;
}

const all = readdirSync(workflowsDir)
  .filter((f) => f.endsWith(".yml"))
  .sort()
  .map(readWorkflow);

/** The draft-gated population: a plain per-PR workflow — has pull_request,
 *  is not label-opt-in (those fire only on an explicit label, drafts
 *  included, on purpose), and is not fast-lane. */
const gated = all.filter(
  (w) => w.hasPullRequest && !w.prTypes?.includes("labeled") && !FAST_LANE.has(w.file),
);

describe("draft PRs run only the fast lane", () => {
  it("finds the draft-gated population (the reader still works)", () => {
    // If the trigger reader breaks, `gated` empties and everything below
    // passes vacuously — pin a floor well below the real count (~29).
    expect(gated.length).toBeGreaterThan(15);
  });

  for (const w of gated) {
    it(`${w.file} is draft-gated and re-fires on ready_for_review`, () => {
      expect(
        w.prTypes,
        `${w.file} has a plain pull_request trigger but no types: list — it will not re-fire when a draft is marked ready`,
      ).toBeDefined();
      expect(
        w.prTypes,
        `${w.file} must include ready_for_review so the fan-out fires when the draft flips`,
      ).toContain("ready_for_review");

      const entryJobs = jobs(w.source).filter((j) => !j.hasNeeds);
      expect(entryJobs.length, `${w.file}: no entry jobs found — reader broken?`).toBeGreaterThan(
        0,
      );
      const unguarded = entryJobs.filter((j) => !j.hasDraftGate).map((j) => j.name);
      expect(
        unguarded,
        `${w.file}: entry job(s) ${unguarded.join(", ")} lack the draft-gate if — they will run on every draft push.\n` +
          `Add: if: ${DRAFT_GATE_IF}\n(needs:-chained jobs cascade-skip and are exempt.)`,
      ).toEqual([]);
    });
  }

  for (const file of FAST_LANE) {
    it(`${file} stays UN-gated — drafts depend on it`, () => {
      const w = all.find((x) => x.file === file);
      expect(w, `${file} disappeared — update FAST_LANE`).toBeDefined();
      expect(
        w?.source.includes(DRAFT_GATE_IF),
        `${file} carries the draft-gate if — the fast lane must run on drafts ` +
          "(test.yml is the required floor; pr-gate aggregates it)",
      ).toBe(false);
    });
  }

  it("pr-gate re-arms on ready_for_review", () => {
    const w = all.find((x) => x.file === "pr-gate.yml");
    expect(w?.prTypes).toContain("ready_for_review");
  });
});
