/**
 * Discriminated-union helpers (payload-transport-layer.md, P4).
 *
 * The P4 analogue of `generics.ts`: the single source of truth for how a
 * `union` TypeIR is canonicalized, keyed, and tagged on the wire.  Both union
 * surfaces lower to the same `union` TypeIR —
 *   - anonymous `A or B` in any type position, and
 *   - named `payload Foo = A | B` (whose arms are these variants),
 * and `T option` lowers to `union[T, none]` — so every consumer (the
 * duplicate-variant check, the `match`-exhaustiveness check, and every
 * backend's tagged-wire emitter) reads one shape.
 *
 * Pure and dependency-free.
 */

import type { TypeIR } from "../types/loom-ir.js";

/** The unit variant of an `option`.  `T option` ≡ `union[T, none]`. */
export const OPTION_NONE: TypeIR = { kind: "none" };

/** Stable structural key for a type — used to detect duplicate union variants
 *  and (later) to dedupe monomorphized union payloads.  A `union`'s key sorts
 *  its variant keys, so the key is associative-commutative: `A or B` and
 *  `B or A` produce the same key (the proposal's "variant set is what
 *  matters" identity rule). */
export function typeKey(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      return `p:${t.name}`;
    case "id":
      return `id:${t.targetName}`;
    case "enum":
      return `e:${t.name}`;
    case "valueobject":
      return `vo:${t.name}`;
    case "entity":
      return `en:${t.name}`;
    case "array":
      return `arr(${typeKey(t.element)})`;
    case "optional":
      return `opt(${typeKey(t.inner)})`;
    case "genericInstance":
      return `${t.ctor}(${typeKey(t.arg)})`;
    case "union":
      return `union{${t.variants.map(typeKey).sort().join("|")}}`;
    case "none":
      return "none";
    case "slot":
      return "slot";
  }
}

/** The wire discriminator value for a union variant — the per-variant tag
 *  serialized under the `type` field (the cross-backend discriminator, pinned
 *  in P4).  A named carrier (entity / value object / enum / payload) tags by
 *  its declared name; an `id`/primitive variant by a readable stem; `none` by
 *  the literal `"none"`.  Shared by every backend so the tag is identical on
 *  the wire. */
export function variantTag(t: TypeIR): string {
  switch (t.kind) {
    case "entity":
    case "valueobject":
    case "enum":
      return t.name;
    case "id":
      return `${t.targetName}Id`;
    case "primitive":
      return t.name;
    case "none":
      return "none";
    case "array":
      return `${variantTag(t.element)}List`;
    case "optional":
      return variantTag(t.inner);
    case "genericInstance":
      return `${variantTag(t.arg)}${t.ctor[0]!.toUpperCase()}${t.ctor.slice(1)}`;
    case "union":
      return t.variants.map(variantTag).join("Or");
    case "slot":
      return "slot";
  }
}

/** Flatten any nested `union` variants into the parent (so `A or B option`,
 *  i.e. `A or union[B, none]`, becomes `union[A, B, none]`) and return a
 *  canonical `union` TypeIR.  Does **not** dedupe — duplicate variants are an
 *  authoring error the validator reports (`loom.union-duplicate-variant`), so
 *  they must survive lowering for it to see them.  Variant *order* is
 *  preserved (significant for reading, not for typing). */
export function canonicalUnion(variants: TypeIR[]): TypeIR {
  const flat: TypeIR[] = [];
  for (const v of variants) {
    if (v.kind === "union") flat.push(...v.variants);
    else flat.push(v);
  }
  return { kind: "union", variants: flat };
}
