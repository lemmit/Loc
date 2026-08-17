import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BEHAVIOURAL_SKIP,
  GOLDEN_OPT_OUT,
  goldenPath,
  hasBehaviouralBlock,
  sharedSystemGoldenCases,
} from "../behavioral/registers.mjs";
import { BACKENDS, PLATFORM_CLAUSE } from "../fixtures/corpus/backends.js";
import { corpusSource } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";

// ---------------------------------------------------------------------------
// Wire-golden coverage gate — every case the behavioural tier RECORDS must have
// a committed golden to be recorded AGAINST.
//
// WHY THIS IS IN THE FAST SUITE.  `wire-differential.mjs` already fails a case
// that has no golden, and it is right to: "a silently-off gate is worse than an
// absent one".  But it can only say so from inside a booted backend, ~4 minutes
// in — and only on the legs whose workflow the PR's paths happen to trigger.  So
// a fixture landing without a golden turns EVERY behavioural leg red, on the PR
// and then on `main`, for a fact that is completely static: a case in the
// manifest with no file beside it.
//
// It has now happened twice in two days — `read-gates` (1346b87d5) and
// `projection-join` (#2545, which left `main` red across all six legs for two
// hours).  Both times the missing-golden branch did exactly its job; nothing
// checked the cheap version first.  This is the #2572 move: when detection is
// static, detect it statically.
//
// NO SECOND COPY OF ANY REGISTER.  The required set is derived from the same
// sources the runners assemble their cases from — `CORPUS` (the manifest),
// `BEHAVIOURAL_SKIP` + `hasBehaviouralBlock` + `GOLDEN_OPT_OUT` +
// `sharedSystemGoldenCases` (all four now in the dependency-free
// behavioral/registers.mjs), and corpus.json's curated
// broad systems.  (That last one is why the orphan arm below matters: the first
// draft of this file derived from the first three only, and the two example
// systems' goldens looked like dead files.)
//
// It imports `registers.mjs` and NOT `cases.mjs` / `wire-differential.mjs`, and
// that is load-bearing rather than tidiness: those two pull in `pg` and
// `esbuild` from test/behavioral/node_modules, which the ROOT install does not
// create.  Importing them here passes on a machine that has run `npm ci` in
// test/behavioral and fails in CI with `Cannot find package 'esbuild'` — which
// is exactly how the first version of this file landed red.
//
// THE DAPPER LEG IS DELIBERATELY NOT IN THE UNION.  `run-dapper.mjs` re-runs the
// `dotnet` key under the `dotnet { persistence: dapper }` clause, whose skip set
// is a SUPERSET of plain dotnet's — so it can never require a golden the five
// primary legs do not already require.  Including it would change nothing except
// which register a future reader thinks is load-bearing.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, "..", "behavioral", "wire-golden");

const skipSetFor = (clause: string): Record<string, string> =>
  (BEHAVIOURAL_SKIP as Record<string, Record<string, string>>)[clause] ?? {};

/** A case runs somewhere iff at least one backend's leg does not skip it. */
const runsSomewhere = (name: string): boolean =>
  BACKENDS.some((b) => !(name in skipSetFor(PLATFORM_CLAUSE[b])));

const optedOut = new Set<string>(
  (GOLDEN_OPT_OUT as ReadonlyArray<{ case: string }>).map((o) => o.case),
);

/** Corpus features that carry a behavioural block AND survive some leg's skips. */
const featureCasesRun = CORPUS.filter(
  (f) =>
    hasBehaviouralBlock(corpusSource(f.id)) &&
    f.backends.some((b) => !(f.id in skipSetFor(PLATFORM_CLAUSE[b]))),
).map((f) => f.id);

const sharedCasesRun = (sharedSystemGoldenCases() as string[]).filter(runsSomewhere);

/** The curated broad systems in corpus.json — node-only (run.mjs is the sole leg
 *  that reads the file), and its UI-only entries belong to run-ui.mjs, which
 *  records nothing.  Mirrors run.mjs's own filter. */
const exampleCasesRun = (
  JSON.parse(readFileSync(join(HERE, "..", "behavioral", "corpus.json"), "utf8")) as {
    cases: { name: string; ddd: string; api?: boolean; unit?: boolean }[];
  }
).cases
  .filter((c) => !String(c.ddd).startsWith("corpus:") && (c.api || c.unit))
  .map((c) => c.name)
  .filter(runsSomewhere);

const recorded = [...featureCasesRun, ...sharedCasesRun, ...exampleCasesRun].sort();
const required = recorded.filter((name) => !optedOut.has(name));

describe("wire-golden coverage — every recorded case has an answer key", () => {
  it("the tier records a non-trivial number of cases (non-vacuity)", () => {
    // Without this, a manifest-import regression that yields zero cases would
    // make every assertion below pass by iterating nothing.
    expect(recorded.length).toBeGreaterThan(30);
  });

  for (const name of required) {
    it(`${name}: has a committed wire golden`, () => {
      expect(
        existsSync(goldenPath(name)),
        `the behavioural tier boots and RECORDS "${name}" on every backend that runs it, ` +
          "but test/behavioral/wire-golden/" +
          `${name}.json does not exist — so every leg fails with "no golden for case" ` +
          "and reports 0 test failures alongside a non-zero exit.\n" +
          `Capture the answer key from the oracle and REVIEW the diff:\n` +
          `    cd test/behavioral && LOOM_WIRE_UPDATE=1 node run.mjs ${name}\n` +
          "(or sign a GOLDEN_OPT_OUT entry in test/behavioral/registers.mjs).",
      ).toBe(true);
    });
  }

  // The ratchet's other direction: a golden for a case that no longer runs is
  // dead weight that reads as coverage.  Same discipline as a stale waiver.
  it("no golden outlives the case it was captured for", () => {
    const goldens = readdirSync(GOLDEN_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    const orphans = goldens.filter((g) => !recorded.includes(g));
    expect(
      orphans,
      "these goldens name no case the behavioural tier records — the fixture was " +
        "renamed, removed, or skipped on every backend. Delete them, or re-arm the case.",
    ).toEqual([]);
  });
});
