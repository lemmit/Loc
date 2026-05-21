// ---------------------------------------------------------------------------
// Verification rollup — joins test-execution results onto the traceability
// graph to produce a per-requirement Definition-of-Done verdict.
//
// This is the missing `TEST_EXECUTION → DoD` step of the traceability model:
// the graph already knows which executable tests back each testCase
// (`TraceabilityIR.execTests` / `execTestsByTestCase`) and which testCases
// verify each requirement (`TraceabilityIR.testsByRequirement`, already
// rolled up through child requirements).  Given the results of running
// those tests, this computes the obvious join.
//
// The join is by (suite, name): a unit-test name is unique only within an
// aggregate, so `name` alone is ambiguous.  `ExecTestRef.suite` is the
// exact string the runner reports (aggregate name for unit tests,
// `"<System> e2e"` for e2e tests — see `collectExecTests`).
//
// Pure and dependency-free (no fs, no Langium, no Date) so both the CLI
// (`ddd verify`) and the in-browser playground runner consume the same
// function.  Deterministic: identical inputs → deep-equal output.
// ---------------------------------------------------------------------------

import type {
  ExecTestRef,
  RequirementVerdict,
  TestCaseStatus,
  TestOutcome,
  TraceabilityIR,
  VerificationIR,
} from "../ir/loom-ir.js";

/** The slice of the traceability index the rollup needs. */
export type VerificationIndex = Pick<
  TraceabilityIR,
  "execTests" | "testsByRequirement"
>;

/** Pick the result for one executable test.  Prefer an exact
 *  (suite, name) match; fall back to a unique name-only match when the
 *  result carries no suite.  Returns the chosen outcome, or undefined
 *  when nothing ran for it. */
function outcomeFor(
  ref: ExecTestRef,
  byName: Map<string, TestOutcome[]>,
): TestOutcome | undefined {
  const named = byName.get(ref.name);
  if (!named || named.length === 0) return undefined;
  const exact = named.filter((r) => r.suite === ref.suite);
  if (exact.length > 0) return worst(exact);
  // No suite-qualified match.  Only attribute a bare-name result when
  // it can't be confused with another test of the same name.
  const suiteless = named.filter((r) => r.suite === undefined);
  if (suiteless.length > 0) return worst(suiteless);
  return undefined;
}

/** Of several runs of one test, the most pessimistic: fail > skip > pass. */
function worst(rs: TestOutcome[]): TestOutcome {
  return (
    rs.find((r) => r.status === "fail") ??
    rs.find((r) => r.status === "skip") ??
    rs[0]!
  );
}

/**
 * @param index           the precomputed traceability slice (read, not recomputed)
 * @param requirementIds  every requirement id, in source order (stable output)
 * @param results         normalized test outcomes from any runner
 */
export function computeVerification(
  index: VerificationIndex,
  requirementIds: readonly string[],
  results: readonly TestOutcome[],
): VerificationIR {
  const byName = new Map<string, TestOutcome[]>();
  for (const r of results) {
    (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)!).push(r);
  }

  // Group executable tests by the testCase they verify.  `testCaseId`
  // is a resolved cross-reference (the linker rejects a `verifies <TC>`
  // that doesn't exist — it lands as null), so every non-null id here
  // names a declared testCase.
  const refsByTestCase = new Map<string, ExecTestRef[]>();
  for (const ref of index.execTests) {
    if (ref.testCaseId == null) continue; // unlinked test — not part of any verdict
    (refsByTestCase.get(ref.testCaseId) ??
      refsByTestCase.set(ref.testCaseId, []).get(ref.testCaseId)!).push(ref);
  }

  const consumed = new Set<TestOutcome>();
  const testCases: VerificationIR["testCases"] = {};
  const testCaseStatus = new Map<string, TestCaseStatus>();

  for (const tcId of [...refsByTestCase.keys()].sort()) {
    const refs = refsByTestCase.get(tcId)!;
    const backing: { name: string; status: string }[] = [];
    let anyFail = false;
    let anyNotPassed = false; // missing or skip

    for (const ref of refs) {
      const outcome = outcomeFor(ref, byName);
      if (outcome) consumed.add(outcome);
      const status = outcome ? outcome.status : "missing";
      if (status === "fail") anyFail = true;
      if (status !== "pass") anyNotPassed = true;
      backing.push({ name: ref.name, status });
    }

    const status: TestCaseStatus = anyFail
      ? "FAILING"
      : anyNotPassed
        ? "UNVERIFIED"
        : "VERIFIED";
    testCaseStatus.set(tcId, status);
    testCases[tcId] = { status, backing };
  }

  const requirements: VerificationIR["requirements"] = {};
  let verified = 0;
  let failing = 0;
  let untested = 0;
  let unverified = 0;

  for (const reqId of requirementIds) {
    const tcIds = (index.testsByRequirement[reqId] ?? []).slice().sort();
    const failingTestCaseIds = tcIds.filter(
      (id) => testCaseStatus.get(id) === "FAILING",
    );

    let verdict: RequirementVerdict;
    if (tcIds.length === 0) {
      verdict = "UNTESTED";
      untested++;
    } else if (failingTestCaseIds.length > 0) {
      verdict = "FAILING";
      failing++;
    } else if (tcIds.every((id) => testCaseStatus.get(id) === "VERIFIED")) {
      verdict = "VERIFIED";
      verified++;
    } else {
      verdict = "UNVERIFIED";
      unverified++;
    }
    requirements[reqId] = { verdict, testCaseIds: tcIds, failingTestCaseIds };
  }

  // Results that ran but matched no declared executable test (e.g. a
  // hand-written test, or a renamed one).  Surfaced, never scored.
  const unknownTests = results.filter((r) => !consumed.has(r));

  return {
    version: 1,
    testCases,
    requirements,
    summary: {
      verified,
      failing,
      untested,
      unverified,
      total: requirementIds.length,
    },
    diagnostics: { unknownTests, unmappedTestCases: [] },
  };
}
