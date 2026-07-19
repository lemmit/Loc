import { describe, expect, it } from "vitest";
import type { TestOutcome } from "../../src/ir/types/loom-ir.js";
import { computeVerification } from "../../src/verify/verification.js";
import { buildLoomModel as build } from "../_helpers/index.js";

// US-001 ─ parent of ─ AC-001 (verified by TC-001, backed by a unit test
// on the LoginSession aggregate) and AC-002 (verified by TC-002, backed by
// an API e2e test). US-002 has no tests at all.
const SOURCE = `
  requirement US-001 { type: UserStory  title: "Login" }
  requirement AC-001 parent US-001 { type: AcceptanceCriteria  title: "valid creds" }
  requirement AC-002 parent US-001 { type: AcceptanceCriteria  title: "session starts" }
  requirement US-002 { type: UserStory  title: "Uncovered" }

  system Shop {
    subdomain Identity {
      context Auth {
        aggregate LoginSession {
          operation start() {}
          test "valid credentials are accepted" verifies TC-001 {}
        }
      }
    }
    deployable api { platform: node  contexts: [Auth] }
    test e2e "session can be started" against api verifies TC-002 {}
  }

  testCase TC-001 verifies AC-001 { covers [ Identity.Auth.LoginSession.start ] }
  testCase TC-002 verifies AC-002 { covers [ Identity.Auth.LoginSession.start ] }
`;

function verify(loom: LoomModel, results: TestOutcome[]) {
  return computeVerification(
    loom.traceability!,
    loom.requirements.map((r) => r.id),
    results,
  );
}

describe("computeVerification", () => {
  it("indexes executable tests with the runner's exact suite names", async () => {
    const loom = await build(SOURCE);
    const refs = loom.traceability!.execTests;
    expect(refs).toEqual(
      expect.arrayContaining([
        {
          name: "valid credentials are accepted",
          suite: "LoginSession",
          kind: "unit",
          testCaseId: "TC-001",
        },
        { name: "session can be started", suite: "Shop e2e", kind: "api", testCaseId: "TC-002" },
      ]),
    );
  });

  it("all backing tests pass → testCase VERIFIED → requirement VERIFIED (with child rollup)", async () => {
    const loom = await build(SOURCE);
    const v = verify(loom, [
      { name: "valid credentials are accepted", suite: "LoginSession", status: "pass" },
      { name: "session can be started", suite: "Shop e2e", status: "pass" },
    ]);
    expect(v.testCases["TC-001"].status).toBe("VERIFIED");
    expect(v.testCases["TC-002"].status).toBe("VERIFIED");
    expect(v.requirements["AC-001"].verdict).toBe("VERIFIED");
    expect(v.requirements["US-001"].verdict).toBe("VERIFIED"); // rolled up from both ACs
    expect(v.requirements["US-002"].verdict).toBe("UNTESTED");
    expect(v.summary).toEqual({ verified: 3, failing: 0, untested: 1, unverified: 0, total: 4 });
  });

  it("a failing backing test turns the testCase and its (parent) requirement FAILING", async () => {
    const loom = await build(SOURCE);
    const v = verify(loom, [
      { name: "valid credentials are accepted", suite: "LoginSession", status: "fail" },
      { name: "session can be started", suite: "Shop e2e", status: "pass" },
    ]);
    expect(v.testCases["TC-001"].status).toBe("FAILING");
    expect(v.requirements["AC-001"].verdict).toBe("FAILING");
    expect(v.requirements["US-001"].verdict).toBe("FAILING"); // child failure propagates
    expect(v.requirements["US-001"].failingTestCaseIds).toContain("TC-001");
  });

  it("a testCase whose tests didn't run is UNVERIFIED (distinct from UNTESTED)", async () => {
    const loom = await build(SOURCE);
    const v = verify(loom, [
      { name: "valid credentials are accepted", suite: "LoginSession", status: "pass" },
      // TC-002's e2e test is absent from the results
    ]);
    expect(v.testCases["TC-002"].status).toBe("UNVERIFIED");
    expect(v.requirements["AC-002"].verdict).toBe("UNVERIFIED");
    expect(v.requirements["US-002"].verdict).toBe("UNTESTED");
    expect(v.requirements["US-001"].verdict).toBe("UNVERIFIED"); // one child verified, one not
  });

  it("disambiguates duplicate test names across aggregates by suite", async () => {
    const loom = await build(`
      requirement R1 { type: UserStory  title: "a" }
      requirement R2 { type: UserStory  title: "b" }
      system S {
        subdomain M { context C {
          aggregate Alpha { operation go() {}  test "create works" verifies T1 {} }
          aggregate Beta  { operation go() {}  test "create works" verifies T2 {} }
        } }
        deployable api { platform: node  contexts: [C] }
      }
      testCase T1 verifies R1 { covers [ M.C.Alpha.go ] }
      testCase T2 verifies R2 { covers [ M.C.Beta.go ] }
    `);
    // Same name, different suites: Alpha passes, Beta fails.
    const v = verify(loom, [
      { name: "create works", suite: "Alpha", status: "pass" },
      { name: "create works", suite: "Beta", status: "fail" },
    ]);
    expect(v.requirements.R1.verdict).toBe("VERIFIED");
    expect(v.requirements.R2.verdict).toBe("FAILING");
  });

  it("refuses to attribute a suiteless result to a name shared by two tests", async () => {
    const loom = await build(`
      requirement R1 { type: UserStory  title: "a" }
      requirement R2 { type: UserStory  title: "b" }
      system S {
        subdomain M { context C {
          aggregate Alpha { operation go() {}  test "create works" verifies T1 {} }
          aggregate Beta  { operation go() {}  test "create works" verifies T2 {} }
        } }
        deployable api { platform: node  contexts: [C] }
      }
      testCase T1 verifies R1 { covers [ M.C.Alpha.go ] }
      testCase T2 verifies R2 { covers [ M.C.Beta.go ] }
    `);
    // One suiteless "create works" result. It cannot be attributed to either
    // Alpha's or Beta's test (the name is shared), so NEITHER requirement may
    // be marked VERIFIED off it — both stay UNVERIFIED (their tests didn't
    // unambiguously run). Pre-fix this single pass marked BOTH VERIFIED.
    const v = verify(loom, [{ name: "create works", status: "pass" }]);
    expect(v.testCases.T1.status).toBe("UNVERIFIED");
    expect(v.testCases.T2.status).toBe("UNVERIFIED");
    expect(v.requirements.R1.verdict).toBe("UNVERIFIED");
    expect(v.requirements.R2.verdict).toBe("UNVERIFIED");
  });

  it("still attributes a suiteless result when the name is unique", async () => {
    const loom = await build(SOURCE);
    // No suite on the unit result, but "valid credentials are accepted" is a
    // unique test name → safe to attribute.
    const v = verify(loom, [
      { name: "valid credentials are accepted", status: "pass" },
      { name: "session can be started", suite: "Shop e2e", status: "pass" },
    ]);
    expect(v.testCases["TC-001"].status).toBe("VERIFIED");
    expect(v.requirements["AC-001"].verdict).toBe("VERIFIED");
  });

  it("reports results that match no declared test, and is deterministic", async () => {
    const loom = await build(SOURCE);
    const results: TestOutcome[] = [
      { name: "valid credentials are accepted", suite: "LoginSession", status: "pass" },
      { name: "session can be started", suite: "Shop e2e", status: "pass" },
      { name: "a hand-written test", suite: "LoginSession", status: "pass" },
    ];
    const a = verify(loom, results);
    const b = verify(loom, results);
    expect(a).toEqual(b);
    expect(a.diagnostics.unknownTests.map((r) => r.name)).toEqual(["a hand-written test"]);
  });
});
