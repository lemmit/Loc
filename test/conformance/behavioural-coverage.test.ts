import { describe, expect, it } from "vitest";
import { BACKEND_LABEL } from "../fixtures/corpus/backends.js";
import { corpusSource, generateCorpusCase } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";

// ---------------------------------------------------------------------------
// Behavioural coverage gate — the parity floor for the behavioural tier.
//
// The behavioural runners (test/behavioral/run*.mjs) boot each backend and run
// the corpus fixtures' emitted `test e2e` / `test` suites.  This gate enforces,
// WITHOUT docker, the invariant those runners depend on: a corpus fixture that
// carries a behavioural block must EMIT the corresponding suite on EVERY backend
// it declares — so a test authored once is wired on every target, never silently
// dropped on one.  It is the behavioural analogue of `corpus-coverage.test.ts`
// (which proves every feature generates); this proves every AUTHORED behavioural
// test is emitted cross-backend.
//
// Scope today: `test e2e` (api) blocks, whose suite is emitted once at the system
// layer and must appear for all five backends.  Domain `test "…"` (unit) blocks
// emit per-backend files (xUnit / JUnit / ExUnit / pytest / vitest); their
// per-backend artifact predicate is added with the first corpus fixture that
// carries a unit block (see docs/old/plans/global-test-coverage-plan.md, Phase 4).
//
// `hasE2EBlock` mirrors run.mjs's `hasBehaviouralBlock` — keep the two in sync.
// ---------------------------------------------------------------------------

/** A fixture carries an api behavioural block iff its source has a `test e2e`. */
const hasE2EBlock = (src: string): boolean => /(^|\n)\s*test\s+e2e\s+"/.test(src);

const withE2E = CORPUS.filter((f) => hasE2EBlock(corpusSource(f.id)));

describe("behavioural coverage — e2e emission parity", () => {
  if (withE2E.length === 0) {
    it("no corpus fixture carries a `test e2e` block yet (informational)", () => {
      // The drain (authoring `test e2e` blocks into the corpus) has not started.
      // This keeps the suite green; each block added below becomes an enforced
      // cross-backend cell.
      expect(withE2E).toEqual([]);
    });
  }

  for (const feature of withE2E) {
    for (const backend of feature.backends) {
      it(`${feature.id}: e2e suite emits on ${BACKEND_LABEL[backend]}`, async () => {
        const files = await generateCorpusCase(feature.id, backend);
        const emitted = [...files.keys()].filter((p) => p.endsWith(".e2e.test.ts"));
        expect(
          emitted.length,
          `${feature.id} declares the ${BACKEND_LABEL[backend]} backend and carries a ` +
            "`test e2e` block, but generation emitted no e2e/*.e2e.test.ts — the authored " +
            "behavioural test is silently dropped on this target.",
        ).toBeGreaterThan(0);
      });
    }
  }
});
