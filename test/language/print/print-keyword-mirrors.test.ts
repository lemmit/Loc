// Completeness guard for the `.ddd` printer's Platform / DesignPack keyword
// mirrors (src/language/print/print-structural.ts).
//
// `PLATFORM_KEYWORDS` / `DESIGN_KEYWORDS` decide whether the printer emits a
// platform / design-pack value bare (a grammar keyword) or re-quotes it (the
// STRING alternative).  They were hand-maintained and drifted: missing
// python/vue/angular + current packs, still listing retired phoenix forms.
//
// This pins them mechanically against the grammar's `Platform` / `DesignPack`
// datatype rules — the same discipline `walker-stdlib-completeness.test.ts`
// applies to the walker mirror.  A keyword added to (or removed from) the
// grammar rule without updating the printer set now fails CI.

import { AstUtils, GrammarAST } from "langium";
import { describe, expect, it } from "vitest";
import { DddGrammar } from "../../../src/language/generated/grammar.js";
import {
  DESIGN_KEYWORDS,
  PLATFORM_KEYWORDS,
} from "../../../src/language/print/print-structural.js";

/** Every literal keyword alternative of a `returns string` datatype rule. */
function ruleKeywords(ruleName: string): Set<string> {
  const grammar = DddGrammar();
  const rule = grammar.rules.find((r) => r.name === ruleName);
  if (!rule) throw new Error(`grammar rule '${ruleName}' not found`);
  const ks = new Set<string>();
  for (const node of AstUtils.streamAllContents(rule)) {
    if (GrammarAST.isKeyword(node)) ks.add(node.value);
  }
  return ks;
}

describe("`.ddd` printer keyword mirrors vs the grammar", () => {
  it("PLATFORM_KEYWORDS equals the grammar's Platform keyword alternatives", () => {
    expect([...PLATFORM_KEYWORDS].sort()).toEqual([...ruleKeywords("Platform")].sort());
  });

  it("DESIGN_KEYWORDS equals the grammar's DesignPack keyword alternatives", () => {
    expect([...DESIGN_KEYWORDS].sort()).toEqual([...ruleKeywords("DesignPack")].sort());
  });
});
