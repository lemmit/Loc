import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  codeOfMessageKey,
  DIAGNOSTIC_MESSAGES,
  type DiagnosticMessageKey,
} from "../../src/diagnostics/messages.js";
import { FIX_HINT_CODES } from "../../src/language/fix-hints.js";

// ---------------------------------------------------------------------------
// The fix-hint coverage ratchet.
//
// Two surfaces offer a repair for a diagnostic: the provider registry in
// `src/language/fix-hints.ts` (node-addressed `ModelPatch`es, which the agent
// loop applies without ever reading generated code) and the editor's
// `DddCodeActionProvider` (LSP quick fixes over the same registry).  Nothing
// pinned either one, and the cost was DEAD CODE that read as a feature: the
// editor shipped a quick fix for `loom.framework-mismatch`, a code no validator
// has ever emitted, so its lightbulb could not appear.  It sat there through
// every green CI run, and the docs advertised it.
//
// Invariant 1 closes that class: a repair may only name a code the wording
// catalog knows — the catalog being the single home for every `loom.*` code a
// user can see, and therefore the closest thing to a registry of real codes.
//
// Invariant 2 is the ratchet.  Coverage was 8 codes of 419 when this landed;
// the floor exists so that DELETING a repair is a visible act in the diff
// rather than a silent regression, since nothing else would notice.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every `loom.*` code the wording catalog knows — the universe a repair may
 *  legitimately name.  A code outside it is misspelled, renamed, or extinct. */
const CATALOGED: ReadonlySet<string> = new Set(
  (Object.keys(DIAGNOSTIC_MESSAGES) as DiagnosticMessageKey[]).map(codeOfMessageKey),
);

/** `loom.*` string literals in a source file — the editor provider's hardcoded
 *  arms, if any survive its delegation to the registry. */
function loomCodesIn(rel: string): string[] {
  const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
  return [...new Set([...text.matchAll(/"(loom\.[a-z0-9-]+)"/g)].map((m) => m[1]!))];
}

/** The count below is a FLOOR, not a target.  Raise it when you add providers;
 *  lowering it should be argued for in the PR that does it. */
const COVERAGE_FLOOR = 15;

describe("fix-hint coverage", () => {
  it("every fix-hint provider names a code the catalog actually knows", () => {
    const extinct = FIX_HINT_CODES.filter((c) => !CATALOGED.has(c));
    expect(extinct, "providers keyed to codes no validator emits — unreachable repairs").toEqual(
      [],
    );
  });

  it("the editor's own code-action arms name real codes too", () => {
    const extinct = loomCodesIn(path.join("src", "language", "lsp", "ddd-code-actions.ts")).filter(
      (c) => !CATALOGED.has(c),
    );
    expect(extinct, "quick fixes wired to codes nothing emits — dead lightbulbs").toEqual([]);
  });

  it("coverage only goes up", () => {
    expect(FIX_HINT_CODES.length).toBeGreaterThanOrEqual(COVERAGE_FLOOR);
  });
});
