// Best-effort type of a lambda's expression body — shared leaf helper.
//
// Used to type `map(λ)` / `min(λ)` / `max(λ)`'s result element at the
// lowering call site (the structural `memberType` pass never sees the
// lambda) AND by the .NET renderer to spell the nullable body-type of a
// `min`/`max` reduction.  Reads the type carried on the common terminal
// ExprIR shapes; returns `undefined` for anything it can't type cheaply,
// so callers fall back to the collection's element type.
//
// Pure data over the shared IR vocabulary: the `ExprIR`/`TypeIR` imports
// are TYPE-ONLY (`import type`), which carries no runtime edge, so this
// leaf under src/util/ stays layering-exempt (consumed by ir/ and
// generator/ alike).

import type { ExprIR, TypeIR } from "../ir/types/loom-ir.js";

/** The static type of an expression ONLY when it is *provably* a `string`
 *  from its own syntactic structure — a string literal, an explicit `→ string`
 *  convert, or a conditional whose branches are each provably string.  Returns
 *  `undefined` for everything else, INCLUDING `member`/`ref` reads.
 *
 *  Why not `bodyTypeOf` for this?  A scaffold-synthesized accessor
 *  (`row.<field>`) is an untyped lambda param, so its `memberType` currently
 *  resolves to `string` for EVERY field (money/bool/int included).  A consumer
 *  that acts on "is this a string?" (the Feliz `Html.text` cast elision) must
 *  therefore not trust a member's type until the accessor-typing work lands —
 *  it can only trust a structurally-guaranteed string.  Once accessors carry
 *  real field types, callers can widen from this to `bodyTypeOf`. */
export function provableStringType(e: ExprIR): TypeIR | undefined {
  const stringType: TypeIR = { kind: "primitive", name: "string" };
  switch (e.kind) {
    case "literal":
      return e.lit === "string" ? stringType : undefined;
    case "paren":
      return provableStringType(e.inner);
    case "convert":
      return e.target === "string" ? stringType : undefined;
    case "ternary":
      return provableStringType(e.then) && provableStringType(e.otherwise) ? stringType : undefined;
    default:
      return undefined;
  }
}

/** Best-effort type of a lambda's expression body.  Returns `undefined`
 *  for shapes it can't type cheaply. */
export function bodyTypeOf(e: ExprIR): TypeIR | undefined {
  switch (e.kind) {
    case "ref":
      return e.type;
    case "member":
      return e.memberType;
    case "paren":
      return bodyTypeOf(e.inner);
    case "convert":
      return { kind: "primitive", name: e.target };
    case "ternary":
      return bodyTypeOf(e.then);
    case "literal":
      switch (e.lit) {
        case "string":
        case "int":
        case "long":
        case "decimal":
        case "money":
        case "bool":
          return { kind: "primitive", name: e.lit };
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}
