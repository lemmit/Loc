// WIRE-GOLDEN COVERAGE — the boot-free half of the missing-golden gate (B1).
//
// #2577 made "this case records but has no golden" a failure.  That check lives
// in `wire-differential.mjs`, which only ever executes inside a BOOTED runner —
// so it speaks on `behavioral-e2e*.yml` (docker, postgres, minutes) and says
// nothing in `test.yml`.  The consequence is a shape `main` has now hit twice:
// a PR mints a recorded case — a corpus fixture that grows a `test e2e`, a new
// `systems/*.ddd`, a new api entry in `corpus.json` — without capturing its
// golden; the fast suite is green, the PR merges, and seven heavy legs go red
// afterwards.
//
// This file closes that window with no boot: it derives the SAME required case
// set the runners assemble (`test/_helpers/golden-coverage.ts`, which reuses
// `cases.mjs`'s `hasBehaviouralBlock` + `BEHAVIOURAL_SKIP`, the typed corpus
// manifest, `systems/`, `corpus.json` and `GOLDEN_OPT_OUT`) and asserts the
// golden FILE exists for each — plus the reverse, that no golden has outlived
// its case.  Existence only; the content comparison stays the booted tier's job.
//
// MUTATION-PROVEN (CLAUDE.md → "Mutation-prove a new gate"): deleting
// `wire-golden/projection-join.json` — the exact omission behind main-red #5 —
// fails "every recorded behavioural case carries a wire golden", naming
// `projection-join` and the runners that record it; restoring the file
// (md5-identical) turns it green again.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  committedGoldenNames,
  DAPPER_CLAUSE,
  dapperClauseInRunner,
  GOLDEN_DIR,
  knownSkipClauses,
  optedOutCaseNames,
  requiredGoldenCases,
} from "../_helpers/golden-coverage.js";
import { BEHAVIOURAL_SKIP } from "./registers.mjs";

const REQUIRED = requiredGoldenCases();

describe("wire-golden coverage", () => {
  it("derives a non-empty required set", () => {
    // A derivation that silently collapsed to nothing would make every
    // assertion below vacuous — the failure shape this repo keeps re-finding.
    expect(
      REQUIRED.length,
      "no behavioural cases were derived at all — the case assembly in " +
        "test/_helpers/golden-coverage.ts has drifted from cases.mjs",
    ).toBeGreaterThan(30);
  });

  it("every recorded behavioural case carries a wire golden", () => {
    const missing = REQUIRED.filter((c) => !fs.existsSync(path.join(GOLDEN_DIR, `${c.name}.json`)));
    expect(
      missing.map((c) => `${c.name}  (recorded by ${c.runners.join(", ")})`),
      "\nThese behavioural cases are RECORDED by a runner leg but have no committed wire\n" +
        "golden, so every leg that boots them will fail (the golden is the answer key the\n" +
        "cross-backend differential compares against — M-T9.11).  Capture each with:\n\n" +
        "    cd test/behavioral && npm ci\n" +
        "    LOOM_WIRE_UPDATE=1 node run.mjs <case>\n\n" +
        "and commit the resulting test/behavioral/wire-golden/<case>.json — node is the\n" +
        "oracle.  A case deliberately left uncompared needs a signed entry in\n" +
        "GOLDEN_OPT_OUT (test/behavioral/wire-differential.mjs) instead.\n",
    ).toEqual([]);
  });

  it("no golden outlives its case", () => {
    const claimed = new Set([...REQUIRED.map((c) => c.name), ...optedOutCaseNames()]);
    const orphans = committedGoldenNames().filter((n) => !claimed.has(n));
    expect(
      orphans,
      "\nThese wire goldens are claimed by NO behavioural case — the fixture/system was\n" +
        "renamed or deleted, or it lost its `test e2e`/`test` block, or it is now skipped\n" +
        "on every backend (BEHAVIOURAL_SKIP).  A golden nothing compares is dead weight\n" +
        "that hides the drift: delete it, or restore the case that earned it.\n",
    ).toEqual([]);
  });

  it("every BEHAVIOURAL_SKIP key names a platform clause a runner actually uses", () => {
    // The skips are keyed by platform CLAUSE (`dotnet { persistence: dapper }`,
    // not `dapper`), so a clause typo — or a runner changing its clause — turns
    // an entry into a silent no-op AND drops that leg from the derivation above.
    const known = knownSkipClauses();
    const unknown = Object.keys(BEHAVIOURAL_SKIP).filter((k) => !known.includes(k));
    expect(
      unknown,
      `BEHAVIOURAL_SKIP (test/behavioral/cases.mjs) is keyed by platform clause; these keys ` +
        `match no wire-gated runner leg (${known.join(" | ")}), so they skip nothing. Fix the ` +
        `spelling, or add the leg to WIRE_GATED_LEGS in test/_helpers/golden-coverage.ts.`,
    ).toEqual([]);
  });

  it("the dapper leg's platform clause still matches its runner", () => {
    // `run-dapper.mjs` keeps `DAPPER_CLAUSE` module-private, so the derivation
    // has to restate it.  A restated constant that nobody compares is how a leg
    // silently leaves the union (and how a skip register starts excusing
    // nothing), so compare it to the runner's source.
    expect(
      dapperClauseInRunner(),
      `run-dapper.mjs no longer declares DAPPER_CLAUSE = ${JSON.stringify(DAPPER_CLAUSE)}. ` +
        "Update WIRE_GATED_LEGS (test/_helpers/golden-coverage.ts) and the matching " +
        "BEHAVIOURAL_SKIP key to the runner's spelling.",
    ).toBe(true);
  });
});
