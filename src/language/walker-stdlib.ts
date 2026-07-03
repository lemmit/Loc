// ---------------------------------------------------------------------------
// Walker stdlib registry — names that are admissible as BuilderCall types
// in body / component-body position without resolving to a user-declared
// type.  The validator consumes these; keeping the surface here (a
// `language/` module) means validator code imports its admissibility sets
// without violating the one-directional layering rule (`language/` knows
// nothing about `generator/`).
//
// The name sets themselves now live in `src/util/walker-primitive-names.ts`
// (shared with the generator body-walker, which used to reach up into this
// module — a `generator → language` value edge the hardened layering gate
// forbids).  This file RE-EXPORTS them so the validator surface and the
// completeness test (`walker-stdlib-completeness.test.ts`) are unchanged.
//
// The sets are DERIVED from the typed dispatch table at
// src/generator/_walker/registry.ts; the completeness test pins them
// mechanically.  Adding a primitive: edit the registry first, then add the
// name in `walker-primitive-names.ts` when the test prompts.
// ---------------------------------------------------------------------------

export {
  isWalkerPrimitive,
  WALKER_LAYOUT_PRIMITIVES,
  WALKER_SUB_PRIMITIVES,
} from "../util/walker-primitive-names.js";
