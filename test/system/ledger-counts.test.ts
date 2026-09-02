// The gap ledger's counts must be CODE, not a hand-typed cache — a table in
// `docs/audits/targets-completeness-2026-08-30.md` that nobody recomputes when
// a row moves between buckets is exactly the "count in prose" trap
// experience_gathered.md §91 names: it was accurate when written and then
// silently rotted the first time someone forgot to update it by hand.
//
// `scripts/ledger-counts.mjs` derives the "## Counts" table and the
// "## Open ledger" table from `targets-completeness-2026-08-30.ledger.json`
// on every run. This test runs its `--check` mode: it fails the moment the
// committed `.md` stops being byte-identical to what the JSON would generate
// — a future edit that moves a row (open → done/claimed, or adds a deferral)
// without regenerating the `.md` fails here instead of shipping a stale count.
//
// Mutation-proof (run by hand, not in CI): edit one number in the "## Counts"
// table of the `.md` (e.g. bump "open rows" by one) and re-run this test — it
// fails with the `--check` mismatch message. Restore the file and it passes
// again.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeCounts, loadLedger, regenerateMd } from "../../scripts/ledger-counts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const scriptPath = path.join(repoRoot, "scripts/ledger-counts.mjs");
const mdPath = path.join(repoRoot, "docs/audits/targets-completeness-2026-08-30.md");

describe("gap ledger counts are derived, not hand-typed (§91)", () => {
  it("--check passes on the committed .md (it matches what the JSON generates)", () => {
    // Runs the real CLI entry point end to end, exactly as a human/CI would.
    expect(() =>
      execFileSync(process.execPath, [scriptPath, "--check"], { cwd: repoRoot, stdio: "pipe" }),
    ).not.toThrow();
  });

  it("regenerating from the JSON reproduces the committed .md exactly", () => {
    const ledger = loadLedger();
    const currentMd = fs.readFileSync(mdPath, "utf8");
    const regenerated = regenerateMd(ledger, currentMd);
    expect(regenerated).toBe(currentMd);
  });

  it("the '## Counts' table's open-row total equals the `open` bucket's length", () => {
    const ledger = loadLedger();
    const counts = computeCounts(ledger);
    expect(counts.open).toBe(ledger.open.length);
    const md = fs.readFileSync(mdPath, "utf8");
    expect(md).toContain(`| open rows | **${counts.open}** |`);
  });

  it("every open/done/claimed id is unique and every id started in exactly one bucket", () => {
    const ledger = loadLedger();
    const seen = new Map<string, string>();
    for (const bucket of ["open", "done", "claimed"] as const) {
      for (const row of ledger[bucket] as Array<{ id: string }>) {
        const prior = seen.get(row.id);
        expect(prior, `"${row.id}" appears in both "${prior}" and "${bucket}"`).toBeUndefined();
        seen.set(row.id, bucket);
      }
    }
  });

  it("F2-ADP-3 is closed by #2708 — W1b landed the gate the reconciliation had recorded as deferred", () => {
    // Wave 1 packet 1a ran the ledger's own repro (dapper + efcore over one
    // context) on b826f87 and got exit 1 with `loom.dapper-unsupported`; the
    // "handed off" note was stale.  Running the repro beats reading the PR body.
    const ledger = loadLedger();
    const open = (ledger.open as Array<{ id: string }>).find((r) => r.id === "F2-ADP-3");
    expect(open, "F2-ADP-3 must not be in the `open` bucket").toBeUndefined();
    const done = (ledger.done as Array<{ id: string; pr: string }>).find(
      (r) => r.id === "F2-ADP-3",
    );
    expect(done?.pr).toBe("#2708");
  });
});
