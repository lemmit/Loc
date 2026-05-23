// Requirements pane edit-engine integration: the printer helpers in
// `web/src/builder/requirements/printers.ts` must emit text that parses
// back into the same requirement/solution/testCase, and splicing that text
// over the original node's CST range must yield a valid `.ddd` source.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import { spliceNode } from "../../web/src/builder/edit-engine.js";
import { parseDdd } from "../../web/src/builder/parse.js";
import {
  printRequirementText,
  printSolutionText,
  printTestCaseText,
} from "../../web/src/builder/requirements/printers.js";

const SRC = `
requirement US-001 {
  type: UserStory
  title: "User can log in"
  status: InProgress
  priority: 1
}

requirement AC-001 parent US-001 {
  type: AcceptanceCriteria
  title: "Valid credentials grant access"
}

system Shop {
  module Identity {
    context Auth {
      aggregate LoginSession {
        operation start() {}
      }
    }
  }
  deployable AuthApi { platform: hono  modules: Identity }
}

solution SOL-001 for US-001 {
  title: "Login handled by the LoginSession aggregate"
  entitles [
    Identity.Auth.LoginSession.start,
    AuthApi
  ]
}

testCase TC-001 verifies AC-001 {
  title: "Successful login"
  covers [ Identity.Auth.LoginSession.start ]
}
`;

describe("Requirements printer helpers", () => {
  it("printRequirementText emits canonical key order", () => {
    expect(
      printRequirementText({
        name: "US-001",
        type: "UserStory",
        title: "User can log in",
        status: "InProgress",
        priority: 1,
      }),
    ).toBe(`requirement US-001 {
  type: UserStory
  title: "User can log in"
  status: InProgress
  priority: 1
}`);
  });

  it("printRequirementText emits the parent in the header", () => {
    const out = printRequirementText({
      name: "AC-001",
      parent: "US-001",
      type: "AcceptanceCriteria",
      title: "Valid credentials",
    });
    expect(out.startsWith("requirement AC-001 parent US-001 {")).toBe(true);
  });

  it("printSolutionText preserves the entitles list verbatim", () => {
    expect(
      printSolutionText({
        name: "SOL-001",
        forRequirement: "US-001",
        title: "Login via aggregate",
        entitles: ["Identity.Auth.LoginSession.start", "AuthApi"],
      }),
    ).toBe(`solution SOL-001 for US-001 {
  title: "Login via aggregate"
  entitles [Identity.Auth.LoginSession.start, AuthApi]
}`);
  });

  it("printTestCaseText emits an empty body when nothing's set", () => {
    expect(printTestCaseText({ name: "TC-001", verifies: "AC-001", covers: [] })).toBe(
      "testCase TC-001 verifies AC-001 {}",
    );
  });
});

describe("Requirements edit round-trip via spliceNode", () => {
  it("changing a requirement status round-trips through the parser", () => {
    const { ast } = parseDdd(SRC);
    const us001 = [...AstUtils.streamAst(ast)].find(
      (n) => n.$type === "Requirement" && (n as { name: string }).name === "US-001",
    )!;
    const next = printRequirementText({
      name: "US-001",
      type: "UserStory",
      title: "User can log in",
      status: "Done", // ← was InProgress
      priority: 1,
    });
    const updated = spliceNode(SRC, us001, next);
    expect(updated).toContain("status: Done");
    expect(updated).not.toContain("status: InProgress");

    const reparsed = parseDdd(updated);
    expect(reparsed.parserErrors).toEqual([]);
    const us = [...AstUtils.streamAst(reparsed.ast)].find(
      (n) => n.$type === "Requirement" && (n as { name: string }).name === "US-001",
    ) as { props: { name: string; value: unknown }[] } | undefined;
    const status = us?.props.find((p) => p.name === "status");
    expect((status?.value as { name: string }).name).toBe("Done");
  });

  it("adding a code element to a solution's entitles round-trips", () => {
    const { ast } = parseDdd(SRC);
    const sol = [...AstUtils.streamAst(ast)].find(
      (n) => n.$type === "Solution" && (n as { name: string }).name === "SOL-001",
    )!;
    const next = printSolutionText({
      name: "SOL-001",
      forRequirement: "US-001",
      title: "Login handled by the LoginSession aggregate",
      entitles: [
        "Identity.Auth.LoginSession.start",
        "AuthApi",
        "Identity.Auth.LoginSession", // ← new
      ],
    });
    const updated = spliceNode(SRC, sol, next);
    // The new entry is last in the list, so it lands before the closing `]`.
    expect(updated).toContain("Identity.Auth.LoginSession]");
    const reparsed = parseDdd(updated);
    expect(reparsed.parserErrors).toEqual([]);
  });

  it("appending a fresh new-requirement block parses and lands as a top-level Requirement", () => {
    // Phase 4 — the wizard's create path is "print + append".  This
    // verifies that appending the printed text to the end of the file
    // produces a valid source containing the new requirement.
    const sep = SRC.endsWith("\n\n") ? "" : SRC.endsWith("\n") ? "\n" : "\n\n";
    const newText = printRequirementText({
      name: "AC-009",
      parent: "US-001",
      type: "AcceptanceCriteria",
      title: "Locked-out accounts cannot log in",
    });
    const updated = SRC + sep + newText + "\n";
    const reparsed = parseDdd(updated);
    expect(reparsed.parserErrors).toEqual([]);
    const found = [...AstUtils.streamAst(reparsed.ast)].find(
      (n) => n.$type === "Requirement" && (n as { name: string }).name === "AC-009",
    ) as { parent?: { $refText: string } } | undefined;
    expect(found?.parent?.$refText).toBe("US-001");
  });

  it("re-parenting AC-001 to a new user story round-trips", () => {
    // Add a second user story we can re-parent under.
    const SRC2 = SRC.replace(
      `requirement AC-001 parent US-001 {`,
      `requirement US-002 {\n  type: UserStory\n  title: "Another story"\n}\n\nrequirement AC-001 parent US-001 {`,
    );
    const { ast } = parseDdd(SRC2);
    const ac = [...AstUtils.streamAst(ast)].find(
      (n) => n.$type === "Requirement" && (n as { name: string }).name === "AC-001",
    )!;
    const next = printRequirementText({
      name: "AC-001",
      parent: "US-002",
      type: "AcceptanceCriteria",
      title: "Valid credentials grant access",
    });
    const updated = spliceNode(SRC2, ac, next);
    const reparsed = parseDdd(updated);
    expect(reparsed.parserErrors).toEqual([]);
    const acAfter = [...AstUtils.streamAst(reparsed.ast)].find(
      (n) => n.$type === "Requirement" && (n as { name: string }).name === "AC-001",
    ) as { parent?: { $refText: string } } | undefined;
    expect(acAfter?.parent?.$refText).toBe("US-002");
  });
});
