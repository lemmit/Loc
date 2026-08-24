// The harness gates its own fixtures — a self-test for `test/_helpers/generate.ts`.
//
// `generateSystemFiles` refuses a `.ddd` fixture that fails phase ① (syntax),
// phase ④ (AST validation) or phase ⑦ (`validateLoomModel`), because a fixture
// the CLI would exit non-zero on emits output no user can obtain — a test
// asserting on it asserts on output that does not exist in the product
// (#2489, #2512, M-T9.34).
//
// Why this file exists rather than a one-off mutation proof: the drain that made
// phase ⑦ assertable left the suite green, so nothing else in the tree fails if
// the gate silently stops gating.  A gate whose only evidence is "the suite is
// green" is exactly the shape M-T9.34 was written to close (`experience_gathered`
// §59, §63 — a check that never reaches the thing it names reads as a pass).
// Each case below is one of the mutations used to prove the gate by hand,
// frozen so it stays proven.

import { describe, expect, it } from "vitest";
import { generateSystemFiles, generateSystemFilesUnchecked } from "../_helpers/generate.js";

/** A minimal, fully VALID system — the baseline every case below perturbs. */
const VALID = `
  system S {
    subdomain M {
      context C {
        aggregate Order { code: string }
        repository Orders for Order { }
      }
    }
    api A from M
    storage db { type: postgres }
    resource cState { for: C, kind: state, use: db }
    deployable api { platform: node, contexts: [C], dataSources: [cState], serves: A, port: 3000 }
  }
`;

describe("generateSystemFiles — the fixture gate", () => {
  it("accepts a valid fixture (the baseline the negative cases perturb)", async () => {
    const files = await generateSystemFiles(VALID);
    expect(files.size).toBeGreaterThan(0);
  });

  it("refuses a SYNTAX error (phase ①) rather than emitting from a recovered AST", async () => {
    // Langium error-recovers, so this would otherwise "generate" from a model
    // that silently dropped what the parser could not consume (#2328).
    await expect(
      generateSystemFiles(VALID.replace("aggregate Order {", "aggregate {")),
    ).rejects.toThrow(/syntax error/);
  });

  it("refuses an AST-validation error (phase ④), naming the phase", async () => {
    // `from` takes a Subdomain; naming a context is an AST-level link failure.
    await expect(
      generateSystemFiles(VALID.replace("api A from M", "api A from Nope")),
    ).rejects.toThrow(/phase ④/);
  });

  it("refuses an IR-validation error (phase ⑦), naming the phase AND the code", async () => {
    // Drop the dataSource binding: the deployable hosts an aggregate with no
    // matching dataSource.  This is the single largest class the M-T9.34 drain
    // cleared (636 generations), so it is the one worth freezing.
    const err = await generateSystemFiles(VALID.replace(" dataSources: [cState],", "")).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/phase ⑦/);
    expect((err as Error).message).toMatch(/loom\.persistence-mode-unsupported/);
  });

  it("refuses an inline effect handler (phase ⑦, a different code)", async () => {
    // A second, structurally unrelated code — so the gate is shown to carry
    // `validateLoomModel`'s verdict generally, not one special-cased check.
    const withInlineEffect = VALID.replace(
      "    api A from M",
      `    ui W {
      page P { route: "/p"  state { n: int = 0 }  body: Button { "+", onClick: e => { n := n + 1 } } }
    }
    api A from M`,
    ).replace(
      "port: 3000 }",
      "port: 3000 }\n    deployable web { platform: static, targets: api, ui: W, port: 3001 }",
    );
    await expect(generateSystemFiles(withInlineEffect)).rejects.toThrow(/loom\.effect-in-lambda/);
  });

  it("names the escape hatch in the failure message", async () => {
    // The message has to tell the next author what to do, or the gate just
    // reads as breakage.
    await expect(generateSystemFiles(VALID.replace(" dataSources: [cState],", ""))).rejects.toThrow(
      /generateSystemFilesUnchecked/,
    );
  });
});

describe("generateSystemFilesUnchecked — the deliberate exception", () => {
  it("emits from a phase-⑦-rejected model, which is its whole purpose", async () => {
    const files = await generateSystemFilesUnchecked(
      VALID.replace(" dataSources: [cState],", ""),
      "the self-test for the escape hatch — a rejected model must still reach the emitter",
    );
    expect(files.size).toBeGreaterThan(0);
  });

  it("still refuses a SYNTAX error — a recovered AST is meaningless whatever the subject", async () => {
    await expect(
      generateSystemFilesUnchecked(
        VALID.replace("aggregate Order {", "aggregate {"),
        "a syntax error must stay fatal even on the unchecked path",
      ),
    ).rejects.toThrow(/syntax error/);
  });

  it("demands a real reason, so the exception is a sentence in the diff", async () => {
    await expect(generateSystemFilesUnchecked(VALID, "because")).rejects.toThrow(
      /needs a real reason/,
    );
  });
});
