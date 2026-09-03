// Merge-queue readiness ratchet.
//
// WHY THIS EXISTS
// ---------------
// `docs/ci-gating.md` documents the structural fix for "green PR, red `main`
// one merge later": turn on GitHub's merge queue and make the heavy runtime
// gates required checks that run once, on the rebased merge candidate, instead
// of never running on the PR at all.
//
// That flip has one sharp edge. A required status check whose workflow has NO
// `merge_group:` trigger never reports inside the queue — and GitHub waits for
// it. The queue does not fail, it *stalls*, indefinitely, for every PR, until
// someone edits branch protection. The same hazard hides in the smaller cases:
// a required check whose job was renamed, a matrix whose cell names are
// dynamic (`${{ matrix.backend }}`) and therefore un-nameable in branch
// protection, or a rollup job that goes green because it was skipped.
//
// So the required-checks set is written down once, in
// `merge-queue-required-checks.ts`, and this test proves the workflows still
// honour it. Drift becomes a red fast-suite run today, instead of a surprise
// on flip day — the same audit→gate ratchet the repo applies everywhere else
// (docs/audits/quality-audit-2026-08.md §6 R1/R2).
//
// It intentionally does NOT check the live repo settings (a test cannot see
// them). The settings flip stays a documented runbook in docs/ci-gating.md;
// this test guarantees the workflow side of that runbook is true.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REQUIRED_CHECKS } from "./merge-queue-required-checks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.resolve(here, "../../.github/workflows");

interface JobInfo {
  readonly id: string;
  /** Job-level `name:`, if declared. */
  readonly name?: string;
  readonly needs: readonly string[];
  /** Job-level `if:` with folded continuations flattened onto one line. */
  readonly ifExpr?: string;
}

interface Workflow {
  readonly onKeys: readonly string[];
  readonly jobs: readonly JobInfo[];
}

/**
 * Deliberately small, indentation-disciplined reader for the subset of
 * workflow syntax this ratchet cares about — no YAML parser is resolvable in
 * this repo's dependency tree, and pulling one in for a structural assertion
 * would be a heavier change than the assertion. Every workflow in
 * `.github/workflows/` is 2-space indented with a block-style `on:` and
 * `jobs:`; the "the reader understands every workflow" case below fails loudly
 * if that ever stops holding.
 */
function parseWorkflow(source: string): Workflow {
  const lines = source.split("\n");
  const onKeys: string[] = [];
  const jobs: JobInfo[] = [];

  let section: "on" | "jobs" | null = null;
  let job: { id: string; name?: string; needs: string[]; ifExpr?: string } | null = null;
  // Set while consuming a folded/literal scalar (`if: >-`) so the
  // continuation lines land on the job's `if` expression.
  let foldingIf = false;

  const flush = () => {
    if (job) jobs.push({ ...job, needs: [...job.needs] });
    job = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*#/.test(line)) continue;

    // A new top-level key closes whatever section we were in.
    if (/^\S/.test(line)) {
      flush();
      foldingIf = false;
      section = /^on:\s*$/.test(line) ? "on" : /^jobs:\s*$/.test(line) ? "jobs" : null;
      continue;
    }

    if (section === "on") {
      const m = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/);
      if (m) onKeys.push(m[1]);
      continue;
    }

    if (section !== "jobs") continue;

    const jobStart = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobStart) {
      flush();
      foldingIf = false;
      job = { id: jobStart[1], needs: [] };
      continue;
    }
    if (!job) continue;

    if (foldingIf) {
      if (/^ {6}\S/.test(line)) {
        job.ifExpr = `${job.ifExpr ?? ""} ${line.trim()}`.trim();
        continue;
      }
      foldingIf = false;
    }

    const key = line.match(/^ {4}([A-Za-z0-9_-]+):(.*)$/);
    if (!key) continue;
    const [, name, rest] = key;
    const value = rest.trim();

    if (name === "name" && job.name === undefined) job.name = stripQuotes(value);
    else if (name === "if") {
      if (value === ">-" || value === ">" || value === "|" || value === "|-") {
        job.ifExpr = "";
        foldingIf = true;
      } else job.ifExpr = value;
    } else if (name === "needs") {
      if (value.startsWith("[")) {
        job.needs.push(
          ...value
            .replace(/^\[|\]$/g, "")
            .split(",")
            .map((s) => stripQuotes(s.trim()))
            .filter(Boolean),
        );
      } else if (value) job.needs.push(stripQuotes(value));
    }
  }
  flush();
  return { onKeys, jobs };
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, "");
}

/** The check-run name GitHub reports for a job: its `name:`, else its id. */
function checkName(job: JobInfo): string {
  return job.name ?? job.id;
}

function load(workflow: string): Workflow {
  return parseWorkflow(readFileSync(path.join(workflowsDir, workflow), "utf8"));
}

describe("merge-queue readiness", () => {
  it("the reader understands every workflow in the repo (block-style on:/jobs:)", () => {
    const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml"));
    expect(files.length).toBeGreaterThan(0);
    const unreadable = files.filter((f) => {
      const wf = load(f);
      return wf.onKeys.length === 0 || wf.jobs.length === 0;
    });
    expect(unreadable, "workflows this ratchet cannot read (inline on:/jobs:?)").toEqual([]);
  });

  it("declares no duplicate check names (check-run names are repo-global)", () => {
    const seen = new Map<string, string[]>();
    for (const entry of REQUIRED_CHECKS) {
      const at = seen.get(entry.check) ?? [];
      at.push(entry.workflow);
      seen.set(entry.check, at);
    }
    const dupes = [...seen].filter(([, files]) => files.length > 1);
    expect(dupes, "two required checks share a name").toEqual([]);
  });

  it("lists each workflow at most once", () => {
    const files = REQUIRED_CHECKS.map((c) => c.workflow);
    expect(files.length).toBe(new Set(files).size);
  });

  describe.each(REQUIRED_CHECKS.map((c) => [c.workflow, c] as const))("%s", (workflow, entry) => {
    it("exists", () => {
      expect(existsSync(path.join(workflowsDir, workflow))).toBe(true);
    });

    it("has a `merge_group:` trigger — without it the queue stalls on this check", () => {
      expect(load(workflow).onKeys).toContain("merge_group");
    });

    it(`exposes the required check name "${entry.check}"`, () => {
      const names = load(workflow).jobs.map(checkName);
      expect(names, `jobs in ${workflow}: ${names.join(", ")}`).toContain(entry.check);
    });

    it("does not gate the required job on a `pull_request`-only context", () => {
      const job = load(workflow).jobs.find((j) => checkName(j) === entry.check);
      expect(job).toBeDefined();
      const expr = job?.ifExpr ?? "";
      // The repo's label-guard idiom short-circuits to `true` on
      // merge_group. Anything else that reads `github.event.pull_request`
      // or compares `event_name` to a pull_request/push literal would make
      // the job skip (or misbehave) inside the queue.
      if (expr.includes("github.event.pull_request") || /event_name\s*==/.test(expr)) {
        expect(
          expr.includes("github.event_name != 'pull_request' ||"),
          `job \`${entry.check}\` has a pull_request-shaped if: ${expr}`,
        ).toBe(true);
      }
    });
  });

  describe("rollup jobs", () => {
    const rollups = REQUIRED_CHECKS.filter((c) => c.check.endsWith("-passed"));

    it("cover every workflow whose required check is a rollup", () => {
      // Sanity: the rollups are the matrix/multi-job workflows, so there is
      // at least one per frontend build family plus the runtime matrices.
      expect(rollups.length).toBeGreaterThanOrEqual(10);
    });

    it.each(
      rollups.map((c) => [c.workflow, c.check] as const),
    )("%s → %s is always() over a non-empty needs", (workflow, check) => {
      const job = load(workflow).jobs.find((j) => checkName(j) === check);
      expect(job, `no job named ${check} in ${workflow}`).toBeDefined();
      if (!job) return;
      expect(job.needs.length, `${check} must aggregate other jobs`).toBeGreaterThan(0);
      // `always()` (or the `!cancelled()` variant test.yml uses) is what
      // makes the rollup report red when a needed job failed, instead of
      // being skipped into a silent pass.
      const expr = job.ifExpr ?? "";
      expect(
        /always\(\)/.test(expr) || /!\s*cancelled\(\)/.test(expr),
        `${check} if: "${expr}" — must be always() so a failed need cannot skip it`,
      ).toBe(true);
      // Every `needs` entry must be a real job in the same workflow.
      const ids = new Set(load(workflow).jobs.map((j) => j.id));
      for (const need of job.needs)
        expect(ids, `${check} needs unknown job ${need}`).toContain(need);
    });
  });

  it("keeps test.yml's pre-existing `tests passed` rollup intact", () => {
    // Branch protection already requires this one; renaming the job would
    // silently drop the only required check the repo has today.
    const job = load("test.yml").jobs.find((j) => j.id === "tests-passed");
    expect(job).toBeDefined();
    expect(job?.name).toBe("tests passed");
    expect(job?.needs).toEqual(["test", "corpus", "lint"]);
  });
});
