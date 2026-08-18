// Completeness guard for the walker-stdlib registry split.
//
// The single source of truth for walker primitives is the typed
// dispatch table at src/generator/_walker/registry.ts.  The
// language-side admissibility sets in src/language/walker-stdlib.ts
// keep their current shape — three `ReadonlySet<string>` exports the
// validator consults — but they're DERIVED from the registry.  The
// layering rule (`language/` knows nothing about `generator/`)
// forbids importing the registry from walker-stdlib.ts, so this test
// pins the names mechanically: the language-side sets must match the
// registry's per-group keys exactly.
//
// Failure mode: someone added a primitive to the generator-side
// registry but forgot to update the language-side set (or vice versa).
// Without this test the gap shows up at runtime as either:
//   - "unknown layout component" in generated TSX/HEEx, or
//   - a confusing validator diagnostic when source code uses a name
//     that's registered as a primitive but not flagged admissible.

import { describe, expect, it } from "vitest";
import { namesInGroup, WALKER_PRIMITIVES } from "../../../src/generator/_walker/registry.js";
import {
  WALKER_LAYOUT_PRIMITIVES,
  WALKER_SUB_PRIMITIVES,
} from "../../../src/language/walker-stdlib.js";
import { WALKER_SUB_PRIMITIVE_PARENTS } from "../../../src/util/walker-primitive-names.js";

describe("walker stdlib language↔generator alignment", () => {
  it("WALKER_LAYOUT_PRIMITIVES matches the registry's layout group", () => {
    const lang = [...WALKER_LAYOUT_PRIMITIVES].sort();
    const gen = namesInGroup("layout");
    expect(lang).toEqual(gen);
  });

  it("WALKER_SUB_PRIMITIVES matches the registry's sub group", () => {
    const lang = [...WALKER_SUB_PRIMITIVES].sort();
    const gen = namesInGroup("sub");
    expect(lang).toEqual(gen);
  });

  // The PLACEMENT half of the same contract (`loom.sub-primitive-misplaced`).
  // A sub-primitive has no top-level renderer, so it MUST declare which parents
  // may consume it — otherwise the IR gate cannot tell a legal `Tab` from one
  // that will silently degrade to a comment.  Both directions are pinned:
  // every sub-primitive names its parents, and those parents are exactly the
  // registry entries whose `a11y.owns` claims it.
  it("every sub primitive declares its legal parents", () => {
    expect([...WALKER_SUB_PRIMITIVE_PARENTS.keys()].sort()).toEqual(namesInGroup("sub"));
  });

  it("the declared parents are exactly the registry's `a11y.owns` claimants", () => {
    const ownersFromRegistry = new Map<string, string[]>();
    for (const [parent, def] of Object.entries(WALKER_PRIMITIVES)) {
      const owned = typeof def.a11y === "object" ? def.a11y.owns : undefined;
      if (!owned) continue;
      ownersFromRegistry.set(owned, [...(ownersFromRegistry.get(owned) ?? []), parent].sort());
    }
    for (const [child, parents] of WALKER_SUB_PRIMITIVE_PARENTS) {
      expect([...parents].sort()).toEqual(ownersFromRegistry.get(child) ?? []);
    }
  });
});
