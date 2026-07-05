import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serializeSemanticsSpec } from "./semantics-rules.js";

// Drift gate for the derived RS-rule spec artifact.
//
// `semantics-spec.json` is a committed, diffable mirror of the `SEMANTICS_RULES`
// registry (the source of truth in `semantics-rules.ts`). This test fails if the
// registry changes without the JSON being regenerated — the `wire-spec.json` /
// `langium-generated` "derived file + CI drift gate" precedent, so a contract
// change surfaces as a reviewable JSON diff.
//
// Regenerate after editing the registry:
//     UPDATE_SEMANTICS_SPEC=1 npx vitest run test/conformance/semantics-spec-sync.test.ts

const SPEC_PATH = fileURLToPath(new URL("./semantics-spec.json", import.meta.url));

describe("runtime-semantics spec artifact", () => {
  it("committed semantics-spec.json matches the registry (regenerate with UPDATE_SEMANTICS_SPEC=1)", () => {
    const expected = serializeSemanticsSpec();

    if (process.env.UPDATE_SEMANTICS_SPEC) {
      writeFileSync(SPEC_PATH, expected);
      return;
    }

    const actual = readFileSync(SPEC_PATH, "utf8");
    expect(
      actual,
      "semantics-spec.json is stale — regenerate with `UPDATE_SEMANTICS_SPEC=1 npx vitest run test/conformance/semantics-spec-sync.test.ts` and commit the result",
    ).toBe(expected);
  });
});
