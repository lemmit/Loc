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
import { namesInGroup } from "../../../src/generator/_walker/registry.js";
import {
  WALKER_LAYOUT_PRIMITIVES,
  WALKER_SUB_PRIMITIVES,
} from "../../../src/language/walker-stdlib.js";

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
});
