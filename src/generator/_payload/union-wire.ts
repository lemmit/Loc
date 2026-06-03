// Tagged-wire shape for discriminated unions (payload-transport-layer.md, P4b).
//
// The single source of truth for how a `union` payload serializes — every
// backend renders the *same* shape from these member specs, so the wire is
// identical by construction (the union analogue of `genericShape`).
//
// Each variant is an object carrying a `type: "<tag>"` discriminator (the
// pinned field name) plus its data:
//   - a record variant (aggregate / value-object → its `wireShape`, or a
//     payload / event → its fields) flattens its fields alongside `type`;
//   - a scalar variant (primitive / id) carries a single `value` field;
//   - the `none` unit carries nothing — just `{ type: "none" }`.
//
// Pure + dependency-free apart from the IR; the per-field Zod / type rendering
// stays in each backend (which owns its primitive mapping), so this module
// only resolves *which* fields each variant contributes.

import { forApiRead } from "../../ir/enrich/wire-projection.js";
import { variantTag } from "../../ir/stdlib/unions.js";
import type { BoundedContextIR, TypeIR, WireField } from "../../ir/types/loom-ir.js";

/** A normalized field contributed by a record-shaped union variant. */
export interface UnionMemberField {
  name: string;
  type: TypeIR;
  optional: boolean;
  /** True for an aggregate / part `id` — backends emit it as a bare string. */
  isId: boolean;
}

export type UnionMember =
  | { tag: string; shape: "record"; fields: UnionMemberField[] }
  | { tag: string; shape: "scalar"; type: TypeIR }
  | { tag: string; shape: "none" };

/** Resolve a union's variants to their tagged-wire member specs in source
 *  order.  Record variants (aggregate / value-object / payload / event) expose
 *  their read-side wire fields; scalar variants wrap a `value`; `none` is the
 *  empty unit. */
export function unionMembers(variants: TypeIR[], ctx: BoundedContextIR): UnionMember[] {
  return variants.map((v) => {
    const tag = variantTag(v);
    if (v.kind === "none") return { tag, shape: "none" };
    const fields = recordFields(v, ctx);
    return fields ? { tag, shape: "record", fields } : { tag, shape: "scalar", type: v };
  });
}

/** The read-side wire fields of a record-shaped variant, or null when the
 *  variant is a scalar (primitive / id) that has no field list. */
function recordFields(v: TypeIR, ctx: BoundedContextIR): UnionMemberField[] | null {
  if (v.kind === "entity") {
    const agg = ctx.aggregates.find((a) => a.name === v.name);
    if (agg) return wireToMembers(agg.wireShape);
    for (const a of ctx.aggregates) {
      const part = a.parts.find((p) => p.name === v.name);
      if (part) return wireToMembers(part.wireShape);
    }
    // A payload / event variant (`payload Foo = OrderPlaced | …`).  Named-union
    // variants are not re-expanded here (they reference their own schema in P4+).
    const payload = ctx.payloads.find((p) => p.name === v.name && !p.variants);
    if (payload) {
      return payload.fields.map((f) => ({
        name: f.name,
        type: f.type,
        optional: f.optional ?? false,
        isId: false,
      }));
    }
    return null;
  }
  if (v.kind === "valueobject") {
    const vo = ctx.valueObjects.find((o) => o.name === v.name);
    return vo ? wireToMembers(vo.wireShape) : null;
  }
  return null;
}

function wireToMembers(wire: readonly WireField[] | undefined): UnionMemberField[] {
  return forApiRead(wire ?? []).map((wf) => ({
    name: wf.name,
    type: wf.type,
    optional: wf.optional,
    isId: wf.source === "id",
  }));
}

/** Render each member as a `z.object({ type: z.literal("tag"), … })` literal,
 *  delegating per-field and scalar Zod to the backend (which owns its
 *  primitive → Zod mapping).  Record fields flatten alongside `type`; a scalar
 *  variant gets a `value` field; `none` is bare. */
export function unionMemberObjects(
  members: UnionMember[],
  fieldZod: (f: UnionMemberField) => string,
  scalarZod: (t: TypeIR) => string,
): string[] {
  return members.map((m) => {
    const head = `type: z.literal(${JSON.stringify(m.tag)})`;
    if (m.shape === "none") return `z.object({ ${head} })`;
    if (m.shape === "scalar") return `z.object({ ${head}, value: ${scalarZod(m.type)} })`;
    const body = m.fields.map((f) => `${f.name}: ${fieldZod(f)}`).join(", ");
    return `z.object({ ${head}${body ? `, ${body}` : ""} })`;
  });
}

/** Assemble the `z.discriminatedUnion("type", [...])` string from already-
 *  rendered member object literals.  Shared by every Zod-emitting backend. */
export function discriminatedUnionZod(memberObjects: string[]): string {
  return `z.discriminatedUnion("type", [${memberObjects.join(", ")}])`;
}
