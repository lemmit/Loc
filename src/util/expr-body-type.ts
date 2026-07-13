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
