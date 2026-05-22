import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrichments.js";
import type { LoomModel } from "../../src/ir/loom-ir.js";
import { lowerModel } from "../../src/ir/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

async function parse(source: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(source, { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length) {
    throw new Error("unexpected diagnostics:\n" + errors.map((d) => d.message).join("\n"));
  }
  return doc.parseResult.value as Model;
}

async function build(source: string): Promise<LoomModel> {
  return enrichLoomModel(lowerModel(await parse(source)));
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
    title: "Login via aggregate"
    entitles [ Identity.Auth.LoginSession.start, AuthApi ]
  }

  testCase TC-001 verifies AC-001 {
    title: "Successful login"
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

  it("emits .loom documentation artifacts", async () => {
    const { files } = generateSystems(await parse(SOURCE));
    for (const p of [
      ".loom/traceability.md",
      ".loom/coverage.md",
      ".loom/gaps.md",
      ".loom/traceability-matrix.md",
      ".loom/traceability.mmd",
      ".loom/traceability.json",
    ]) {
      expect(files.has(p), `missing ${p}`).toBe(true);
    }

    expect(files.get(".loom/coverage.md")).toContain(
      "Overall: **50%** (1/2 referenced code elements covered",
    );
    expect(files.get(".loom/gaps.md")).toContain("`AuthApi` (deployable)");
    expect(files.get(".loom/gaps.md")).toContain("`US-002` — Uncovered story");

    const json = JSON.parse(files.get(".loom/traceability.json")!);
    expect(json.summary.codeCoverage).toEqual({ covered: 1, total: 2 });
    expect(json.summary.requirementCoverage).toEqual({ covered: 2, total: 3 });

    // Mermaid: each code node defined exactly once even when both
    // entitled and covered.
    const mmd = files.get(".loom/traceability.mmd")!;
    const defs = mmd.match(/Identity\.Auth\.LoginSession\.start/g) ?? [];
    // node defined exactly once; edges reference it by node id
    expect(defs.length).toBe(1);
    expect(mmd).toContain("-->|entitles|");
    expect(mmd).toContain("-.->|covers|");
  });

  it("emits no traceability artifacts when none are declared", async () => {
    const { files } = generateSystems(
      await parse(
        `system S { module M { context C { aggregate A { name: string } repository As for A {} } } deployable D { platform: hono  modules: M } }`,
      ),
    );
    expect([...files.keys()].some((k) => k.startsWith(".loom/traceability"))).toBe(false);
    expect(files.has(".loom/coverage.md")).toBe(false);
  });
});
