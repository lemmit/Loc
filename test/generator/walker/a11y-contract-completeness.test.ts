// Completeness gate for the per-primitive accessibility contract
// (docs/old/proposals/accessibility.md, Phase 1).
//
// The `a11y` field on `PrimitiveDef` is REQUIRED, so the compiler already
// forces every WALKER_PRIMITIVES entry to declare a contract — adding a
// primitive without an a11y decision fails `tsc`.  This test is the runtime
// twin of that guarantee: it pins that every registered primitive carries a
// WELL-FORMED contract (`"presentational"` or a structurally valid
// `A11yObligation`), so a malformed or accidentally-`undefined` contract
// (e.g. via a cast) fails CI rather than shipping a silent screen-reader gap.
//
// Layer 1 of the proposal: "every primitive declares an `a11y` contract or is
// explicitly `presentational` — drift fails CI, exactly like the
// required-primitives gate."

import { describe, expect, it } from "vitest";
import type { A11yObligation } from "../../../src/generator/_walker/a11y.js";
import { WALKER_PRIMITIVES } from "../../../src/generator/_walker/registry.js";

const KEYBOARD = new Set(["activate", "arrows"]);
const FOCUS = new Set(["trap-restore", "move"]);
const LANDMARK = new Set(["navigation", "region", "form", "search"]);
const LIVE = new Set(["polite", "assertive"]);

/** Structural validity of an A11yObligation object — every present field
 *  holds a value the type permits.  Mirrors the union members in a11y.ts so
 *  a widened/typo'd literal is caught here. */
function isWellFormedObligation(o: A11yObligation): boolean {
  if (typeof o !== "object" || o === null) return false;
  if (o.role !== undefined && typeof o.role !== "string") return false;
  if (o.owns !== undefined && typeof o.owns !== "string") return false;
  for (const flag of [o.needsName, o.needsAlt, o.modal, o.busy, o.nesting, o.decorativeByDefault]) {
    if (flag !== undefined && typeof flag !== "boolean") return false;
  }
  if (o.labelled !== undefined && o.labelled !== "associate") return false;
  if (o.headingLevel !== undefined && o.headingLevel !== "derive") return false;
  if (o.keyboard !== undefined && !KEYBOARD.has(o.keyboard)) return false;
  if (o.focus !== undefined && !FOCUS.has(o.focus)) return false;
  if (o.landmark !== undefined && !LANDMARK.has(o.landmark)) return false;
  if (o.live !== undefined && !LIVE.has(o.live)) return false;
  // A non-presentational obligation must assert at least one fact.
  return Object.values(o).some((v) => v !== undefined);
}

describe("a11y contract completeness (accessibility.md Phase 1)", () => {
  const entries = Object.entries(WALKER_PRIMITIVES);

  it("every registered primitive declares an a11y contract", () => {
    const missing = entries.filter(([, def]) => def.a11y === undefined).map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it.each(entries)("%s carries a well-formed a11y contract", (_name, def) => {
    const c = def.a11y;
    const ok = c === "presentational" || isWellFormedObligation(c);
    expect(ok).toBe(true);
  });

  it("`owns` targets name a real sub-group primitive", () => {
    for (const [, def] of entries) {
      if (def.a11y !== "presentational" && def.a11y.owns) {
        const target = WALKER_PRIMITIVES[def.a11y.owns];
        expect(target, `owns → ${def.a11y.owns}`).toBeDefined();
      }
    }
  });

  it("`needsAlt` is reserved for the image family", () => {
    const withAlt = entries
      .filter(([, d]) => d.a11y !== "presentational" && d.a11y.needsAlt)
      .map(([n]) => n)
      .sort();
    expect(withAlt).toEqual(["Avatar", "Image"]);
  });
});
