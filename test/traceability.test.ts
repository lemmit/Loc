import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { createDddServices } from "../src/language/ddd-module.js";
import { lowerModel } from "../src/ir/lower.js";
import { enrichLoomModel } from "../src/ir/enrichments.js";
import type { LoomModel } from "../src/ir/loom-ir.js";
import type { Model } from "../src/language/generated/ast.js";

async function build(source: string): Promise<LoomModel> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(source, { validation: true });
  return enrichLoomModel(lowerModel(doc.parseResult.value as Model));
}

const SOURCE = `
  requirement US-001 { type: UserStory  title: "User can log in"  status: InProgress }
  requirement AC-001 parent US-001 { type: AcceptanceCriteria  title: "Valid credentials" }
  requirement US-002 { type: UserStory  title: "Uncovered story" }

  system Shop {
    module Identity {
      context Auth {
        aggregate LoginSession {
          operation start() {}
          operation fail() {}
          test "start works" verifies TC-001 {}
        }
      }
    }
    deployable AuthApi { platform: hono  modules: Identity }
  }

  solution SOL-001 for US-001 {
    title "Login via aggregate"
    entitles [ Identity.Auth.LoginSession.start, AuthApi ]
  }

  testCase TC-001 verifies AC-001 {
    title "Successful login"
    covers [ Identity.Auth.LoginSession.start ]
  }
`;

describe("traceability IR (Slice 12)", () => {
  it("lowers requirements / solutions / testCases", async () => {
    const loom = await build(SOURCE);
    expect(loom.requirements.map((r) => r.id).sort()).toEqual(["AC-001", "US-001", "US-002"]);
    expect(loom.requirements.find((r) => r.id === "AC-001")?.parentId).toBe("US-001");
    expect(loom.requirements.find((r) => r.id === "US-001")?.status).toBe("InProgress");

    const sol = loom.solutions[0]!;
    expect(sol.id).toBe("SOL-001");
    expect(sol.forRequirement).toBe("US-001");
    expect(sol.entitles).toEqual([
      { qualifiedName: "Identity.Auth.LoginSession.start", kind: "operation" },
      { qualifiedName: "AuthApi", kind: "deployable" },
    ]);

    const tc = loom.testCases[0]!;
    expect(tc.verifies).toBe("AC-001");
    expect(tc.covers).toEqual([
      { qualifiedName: "Identity.Auth.LoginSession.start", kind: "operation" },
    ]);
  });

  it("computes the traceability index", async () => {
    const t = (await build(SOURCE)).traceability!;
    expect(t).toBeDefined();

    // Hierarchy.
    expect(t.childrenOf["US-001"]).toEqual(["AC-001"]);

    // A test on a child requirement rolls up to the parent.
    expect(t.testsByRequirement["US-001"]).toEqual(["TC-001"]);
    expect(t.testsByRequirement["AC-001"]).toEqual(["TC-001"]);
    expect(t.testsByRequirement["US-002"]).toEqual([]);

    // Solution completeness.
    expect(t.solutionByRequirement["US-001"]).toBe("SOL-001");
    expect(t.solutionByRequirement["US-002"]).toBeNull();

    // Code coverage — `start` is covered, `AuthApi` is entitled-but-untested.
    expect(t.testsByCodeElement["Identity.Auth.LoginSession.start"]).toEqual(["TC-001"]);
    expect(t.testsByCodeElement["AuthApi"]).toBeUndefined();
    expect(t.codeElements["AuthApi"]).toBe("deployable");

    // Executable-test back-link reaches the covered code element.
    expect(t.execTestsByTestCase["TC-001"]).toEqual(["start works"]);
    expect(t.execTestsByCodeElement["Identity.Auth.LoginSession.start"]).toEqual(["start works"]);
  });
});
