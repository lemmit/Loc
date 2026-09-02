import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BACKENDS, PLATFORM_CLAUSE } from "../fixtures/corpus/backends.js";
import { allSourceCases, caseId, type PairwiseCase } from "../pairwise/axes.js";
import { persistenceFor } from "../pairwise/cases.js";
import { composeSourceFor } from "../pairwise/compose.js";
import { runPipeline } from "../pairwise/harness.js";
import { GENERATION_WAIVERS, type Waiver, waiverFor } from "../pairwise/waivers.js";

// ---------------------------------------------------------------------------
// M-T9.29 slice 1 — the GENERATION oracle of the pairwise-combination corpus.
//
// The curated corpus is one fixture per FEATURE.  The "generated code fails to
// compile" bug class does not live inside a feature — it lives at the
// intersections (#2412 mask×audited, #2387/#2391 audited×dapper×document/ES,
// #2492 policy-deny×dapper).  This suite runs the full compiler pipeline over
// the cross product of capability × shape × authz × persistence on every
// backend and asserts the cheapest possible property:
//
//     a system a user could write must get an ANSWER, not an exception.
//
// A `loom.*` validator rejection IS an answer — combinations that genuinely
// cannot coexist are supposed to be refused by name, and those are recorded
// (with their code) rather than failed.  A THROW is the finding.
//
// Opt-in via LOOM_PAIRWISE=1: it is ~1000 pipeline runs, seconds not minutes,
// but it is a discovery sweep, not a per-PR floor.
// ---------------------------------------------------------------------------

const ENABLED = process.env.LOOM_PAIRWISE === "1";

/** `LOOM_PAIRWISE_DUMP=<dir>` writes every composed `.ddd` there — the matrix
 *  is generated, so this is how a human reads what was actually tested. */
const DUMP_DIR = process.env.LOOM_PAIRWISE_DUMP;

/** `LOOM_PAIRWISE_REPORT=<file>` writes the full per-crossing verdict census.
 *  The findings register quotes these numbers, and a register whose counts are
 *  hand-tallied goes stale the first time the matrix changes. */
const REPORT = process.env.LOOM_PAIRWISE_REPORT;

interface Row {
  readonly platform: string;
  readonly kase: PairwiseCase;
  readonly verdict: string;
  readonly codes: readonly string[];
  readonly detail: string;
  readonly waiver?: Waiver;
}

describe.skipIf(!ENABLED)(
  "pairwise corpus — every crossing gets an answer, not an exception",
  () => {
    it("cross product of capability × shape × authz × persistence, all backends", async () => {
      const rows: Row[] = [];
      const usedWaivers = new Set<Waiver>();

      for (const backend of BACKENDS) {
        const platform = PLATFORM_CLAUSE[backend];
        for (const persistence of persistenceFor(platform)) {
          for (const sc of allSourceCases()) {
            const kase: PairwiseCase = { ...sc, persistence };
            if (DUMP_DIR) {
              fs.mkdirSync(DUMP_DIR, { recursive: true });
              fs.writeFileSync(
                path.join(DUMP_DIR, `${platform}-${caseId(kase)}.ddd`),
                composeSourceFor(kase, platform),
              );
            }
            const out = await runPipeline(kase, platform);
            const waiver = waiverFor(GENERATION_WAIVERS, kase, platform);
            if (out.verdict === "crashed" && waiver) usedWaivers.add(waiver);
            rows.push({
              platform,
              kase,
              verdict: out.verdict,
              codes: out.codes,
              detail: out.detail,
              waiver,
            });
          }
        }
      }

      if (REPORT) {
        const tally = new Map<string, number>();
        for (const r of rows) tally.set(r.verdict, (tally.get(r.verdict) ?? 0) + 1);
        const codeTally = new Map<string, number>();
        for (const r of rows) {
          for (const c of r.codes) codeTally.set(c, (codeTally.get(c) ?? 0) + 1);
        }
        fs.writeFileSync(
          REPORT,
          [
            `crossings: ${rows.length}`,
            ...[...tally].sort().map(([v, n]) => `  ${v}: ${n}`),
            "rejection codes:",
            ...[...codeTally].sort().map(([c, n]) => `  ${c}: ${n}`),
            "",
            ...rows
              .filter((r) => r.verdict !== "ok")
              .map(
                (r) =>
                  `${r.verdict.padEnd(9)} ${r.platform}/${r.kase.persistence} ${caseId(r.kase)} ${r.codes.join(",")} :: ${r.detail.split("\n")[0]}`,
              ),
          ].join("\n"),
        );
      }

      // ---- (1) NEW crashes fail. -------------------------------------------
      const unwaived = rows.filter((r) => r.verdict === "crashed" && !r.waiver);
      expect(
        unwaived.map(
          (r) =>
            `${r.platform}/${r.kase.persistence} ${caseId(r.kase)}\n    ${r.detail.split("\n")[0]}`,
        ),
        "crossings whose pipeline THREW with no matching waiver — a system a user " +
          "could write must get an answer (an emitted project, or a named loom.* " +
          "rejection), never an exception.  Diagnose it, then add it to " +
          "docs/audits/pairwise-corpus-findings-2026-08.md + test/pairwise/waivers.ts.",
      ).toEqual([]);

      // ---- (2) STALE waivers fail (the ratchet). ---------------------------
      // A waiver that matched nothing means the crossing was FIXED — the entry
      // has to go in the same PR, or the register rots into a suppression list.
      const stale = GENERATION_WAIVERS.filter((w) => !usedWaivers.has(w)).map((w) => w.reason);
      expect(
        stale,
        "waivers that matched no crashing crossing — the underlying bug is fixed, " +
          "so delete the entry from test/pairwise/waivers.ts and close its row in " +
          "docs/audits/pairwise-corpus-findings-2026-08.md.",
      ).toEqual([]);

      // ---- (3) The gate must have REACHED something. -----------------------
      // A composer bug (or a rename) that made every case fail to parse would
      // otherwise leave (1) and (2) trivially satisfiable.  Assert a floor of
      // successfully generated crossings so the sweep cannot pass vacuously.
      const ok = rows.filter((r) => r.verdict === "ok").length;
      const rejected = rows.filter((r) => r.verdict === "rejected").length;
      // W3 raised all three floors with the matrix.  A floor left at its
      // pre-widening value is not conservative, it is DEAD: 4200 crossings
      // clear a floor of 500 even if five of the six axes collapsed to one
      // value each, so the collapse detector would have stopped detecting
      // collapse while still reading as a passing assertion.
      expect(rows.length, "crossings attempted").toBeGreaterThan(3500);
      // A COLLAPSE floor, not a target: a composer bug (or a rename) that made
      // every case fail to parse would otherwise leave assertions (1) and (2)
      // trivially satisfiable.  The floor sits well under the current 3528 so
      // that legitimately growing the rejection count — a backend adding an
      // honest `loom.*` refusal — does not fail the gate.
      expect(
        ok,
        "crossings that generated cleanly — a collapse here means the " +
          "composer broke, not that the language did",
      ).toBeGreaterThan(2800);
      // …and the mirror: rejections must still be REACHED.  If phase ⑦ stopped
      // running (the hole this harness shipped with once — see harness.ts), the
      // honest refusals would silently become `ok` and the sweep would go quiet
      // exactly where it is most load-bearing.
      expect(
        rejected,
        "crossings refused by a named loom.* diagnostic — zero here means the " +
          "validator phases are not being run at all",
      ).toBeGreaterThan(400);
    }, 900_000);
  },
);
