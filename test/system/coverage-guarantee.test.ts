// Coverage-guarantee gate — every archived design doc is dispositioned.
//
// `docs/new-plan/coverage.md` opens with a promise: *"every doc that lived in
// `docs/proposals/` and `docs/plans/` (now under `../old/`) is listed here"*, and
// the plan README leans on it — *"if you find an open thread in an old doc that no
// mission covers, that's a bug in this plan."*  The promise is what stops a
// proposal from being quietly forgotten when `main` moves on.
//
// It was PROSE-ENFORCED, and it drifted twice:
//   - 2026-07-21 — 13 proposals/plans authored after the 2026-07-13 classification
//     had never been dispositioned (reconciled by hand).
//   - 2026-07-30 — two more proposals were missing, one of them
//     (`integrity-audit-2026-07-residue.md`) carrying a LIVE silent-codegen gap
//     (R1, now M-T6.23); and the Audits section listed 8 of 29 audits, collapsing
//     the rest into an unchecked "others — no open findings" row that hid the
//     25-bug `fleet-bug-hunt-2026-07-19` register entirely.
//
// A promise that only a human re-reads rots on the same schedule as any other
// undocumented invariant.  This test makes it mechanical: add a doc under
// `docs/old/proposals/`, `docs/old/plans/`, or `docs/audits/` and coverage.md must
// gain a row naming it, or CI fails.  That is the whole gate — it checks the doc
// is MENTIONED, not that its disposition is correct (no test can judge that);
// the point is that nothing can be silently absent.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const COVERAGE = join(REPO_ROOT, "docs", "new-plan", "coverage.md");

/** Doc sets the guarantee spans, with the coverage.md section that owns each. */
const TRACKED_DIRS = [
  { dir: join("docs", "old", "proposals"), label: "Proposals" },
  { dir: join("docs", "old", "proposals", "maybe-one-day"), label: "Proposals (maybe-one-day)" },
  { dir: join("docs", "old", "plans"), label: "Plans" },
  { dir: join("docs", "audits"), label: "Audits" },
] as const;

/** `README.md` is the index of its own directory, not a dispositionable doc. */
const EXEMPT = new Set(["README.md"]);

function markdownFilesIn(relDir: string): string[] {
  return readdirSync(join(REPO_ROOT, relDir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !EXEMPT.has(e.name))
    .map((e) => e.name)
    .sort();
}

describe("coverage.md dispositions every archived design doc", () => {
  const coverage = readFileSync(COVERAGE, "utf8");

  for (const { dir, label } of TRACKED_DIRS) {
    describe(`${label} (${dir})`, () => {
      for (const file of markdownFilesIn(dir)) {
        it(`${file} is dispositioned`, () => {
          // Mentioning the basename anywhere in the doc counts — rows use a few
          // shapes (plain, bolded for emphasis, or a relative link), and pinning
          // one shape would make the gate about formatting instead of coverage.
          expect(
            coverage.includes(file),
            `${join(dir, file)} has no row in docs/new-plan/coverage.md.\n\n` +
              `Every archived proposal/plan/audit must be dispositioned there: either\n` +
              `shipped/superseded/historical (no open work — the doc stays as the design\n` +
              `record), or mapped to the mission(s) carrying its remaining items. If the\n` +
              `doc names open work no mission covers, add the mission to a track file\n` +
              `(T1–T10) first — don't fork a new tracker doc.`,
          ).toBe(true);
        });
      }
    });
  }

  it("spans every doc directory the guarantee claims", () => {
    // Guards the guard: if a new doc DIRECTORY appears under docs/old/, this test
    // would silently stop covering it. Fails so TRACKED_DIRS is extended.
    const oldSubdirs = readdirSync(join(REPO_ROOT, "docs", "old"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(oldSubdirs).toEqual(["plans", "proposals"]);
  });
});
