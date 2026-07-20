import { isEntityPart, isNamedType, type Property } from "./generated/ast.js";

// `contains` is optional sugar.  A value `Property` whose declared type is a
// bare name resolving to a locally-declared `entity` part IS a containment —
// `line: OrderLine` means exactly what `contains line: OrderLine` means, because
// an entity part is owned by its aggregate root, never referenced by value.
// This predicate is the single source of truth for that "inferred containment"
// classification, shared by the validator (`src/language`) and lowering
// (`src/ir/lower`), so both agree on which properties are really containments.
//
// It is deliberately narrow.  Only a plain `NamedType` head that resolves to an
// entity part qualifies:
//   - `X id` (an `IdType`) is a cross-aggregate REFERENCE, not containment.
//   - a union type (`A or B`) is a payload/response shape, never a part.
//   - a generic carrier (`paged` / `envelope` / `option`) wraps a wire shape.
//   - a primitive / value-object / enum type is a value, held by value.
// `[]` (collection) and `?` (optional) are the two modifiers `contains` itself
// supports, so a bare `OrderLine[]` / `OrderLine?` field classifies too.
export function isInferredContainment(p: Property): boolean {
  const t = p.type;
  if (!t) return false;
  // `A or B` and `T paged`/`envelope`/`option` are wire shapes, not parts.
  if (t.alternatives.length > 0 || t.ctors.length > 0) return false;
  if (!isNamedType(t.base)) return false;
  const target = t.base.target?.ref;
  return !!target && isEntityPart(target);
}
