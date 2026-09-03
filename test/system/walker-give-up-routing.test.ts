// Every walker degradation goes through `giveUp()` — so ONE marker finds them all.
//
// The cross-frontend render matrix (`frontend-showcase-render.test.ts`) exists to
// catch a construct that silently fails to render on some target.  It could only
// do that by recognising the give-up comment the walker leaves behind, and until
// the sentinel landed it recognised those by their WORDING — a hand-kept list of
// four strings against the thirty-six the walkers emit.  It saw one.
//
// `Timeline: not yet supported on …` does not contain the `"not supported"` the
// list looked for.  The `Icon` fallback is built from a variable, so it has no
// static wording to list at all.  The other thirty-three were never added — and
// nothing failed when they were not, which is the property that let the list
// stay at four while the walkers grew.
//
// `giveUp()` fixes that by construction: the marker is one constant, imported
// from the emitter side rather than copied.  What this file adds is the part
// that keeps it true — a new give-up cannot skip the helper, because a direct
// `renderComment` call in walker code fails here.
//
// The rule is narrow on purpose.  `renderComment` is still the right seam for a
// comment that is NOT a degradation (HEEx's benign `<op> has no parameters`
// note), so the pin is "route give-ups through the helper", not "never emit a
// comment".  The allowlist below is where a non-degradation comment is declared,
// with the reason it is not one.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { GIVE_UP_SENTINEL } from "../../src/generator/_walker/give-up.js";

const REPO = resolve(import.meta.dirname, "..", "..");

/** The trees whose comments are page-body rendering output.  `src/generator/
 *  elixir/` is in scope for its walker core only — the rest of the Phoenix
 *  emitter writes ordinary source comments. */
const WALKER_GLOBS = [
  "src/generator/_walker/**/*.ts",
  "src/generator/react/**/*.ts",
  "src/generator/vue/**/*.ts",
  "src/generator/svelte/**/*.ts",
  "src/generator/angular/**/*.ts",
  "src/generator/feliz/**/*.ts",
  "src/generator/flutter/**/*.ts",
];

/** Files allowed to call `renderComment` / `renderNotice` directly, each with
 *  the reason the call is not a degradation.  A file that stops calling it fails
 *  as a stale entry, the same ratchet the register rows carry. */
const NOT_A_GIVE_UP: readonly { file: string; why: string }[] = [
  {
    file: "src/generator/_walker/give-up.ts",
    why: "the helper itself — the one place that is allowed to reach the seam",
  },
];

const allowed = new Set(NOT_A_GIVE_UP.map((a) => a.file));

/** Direct `…renderComment(…)` / `…renderNotice(…)` CALLS, excluding the seam's
 *  own declaration and each target's implementation of it (`renderComment: …`),
 *  which are definitions rather than uses. */
function directSeamCalls(): { file: string; line: number; text: string }[] {
  const files = execSync(`git ls-files ${WALKER_GLOBS.map((g) => `'${g}'`).join(" ")}`, {
    cwd: REPO,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  const hits: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    if (allowed.has(file)) continue;
    const src = readFileSync(resolve(REPO, file), "utf8");
    if (!src.includes("renderComment") && !src.includes("renderNotice")) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText();
        if (/(^|\.)render(Comment|Notice)$/.test(callee.replace(/\?\.$/, ""))) {
          hits.push({
            file,
            line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            text: callee,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

describe("walker give-ups all route through the sentinel", () => {
  it("no walker file reaches the comment seam directly", () => {
    const direct = directSeamCalls().map((h) => `${h.file}:${h.line}  ${h.text}(…)`);
    expect(
      direct,
      "a walker degradation is being emitted without the `loom:unrendered` sentinel. " +
        "The cross-frontend render matrix finds silent gaps by that marker, so a give-up " +
        "that skips it is invisible there — which is exactly how the previous wording-list " +
        "version came to recognise 1 of 36. Use `giveUp(ctx.target, …)` (or `giveUpNotice`), " +
        "or, if the comment is NOT a degradation, declare the file in NOT_A_GIVE_UP with why.",
    ).toEqual([]);
  });

  it("allows nothing that no longer needs allowing (a stale entry is a lie)", () => {
    const stale = NOT_A_GIVE_UP.filter((a) => {
      const src = readFileSync(resolve(REPO, a.file), "utf8");
      return !src.includes("renderComment") && !src.includes("renderNotice");
    }).map((a) => a.file);
    expect(stale, "allowlisted files that no longer touch the seam — drop the entry").toEqual([]);
  });

  it("the sentinel is a string generated code cannot plausibly contain", () => {
    // The whole scan rests on this. A marker that occurs naturally in emitted
    // output turns every cell of the matrix into a false positive; one that is
    // too short (the real give-up wordings include `Action(` and `Form(`) does
    // the same, which is why the wording could never be the thing to match on.
    expect(GIVE_UP_SENTINEL).toMatch(/^loom:[a-z]+$/);
    expect(GIVE_UP_SENTINEL.length).toBeGreaterThan(8);
  });
});
