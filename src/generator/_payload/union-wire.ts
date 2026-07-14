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

import {
  forApiRead,
  wireFieldsForAggregate,
  wireFieldsForPart,
  wireFieldsForValueObject,
} from "../../ir/enrich/wire-projection.js";
import { unionInstanceName, variantTag } from "../../ir/stdlib/unions.js";
import type { BoundedContextIR, TypeIR, WireField } from "../../ir/types/loom-ir.js";
import { peelCollection, peelNullable, wireTypeInfo } from "../../ir/types/wire-types.js";

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
    if (agg) return wireToMembers(wireFieldsForAggregate(agg));
    for (const a of ctx.aggregates) {
      const part = a.parts.find((p) => p.name === v.name);
      if (part) return wireToMembers(wireFieldsForPart(part));
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
    return vo ? wireToMembers(wireFieldsForValueObject(vo)) : null;
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

/** Producer-side spec for a union-returning find (payload-transport-layer.md
 *  P4 producer side; absence semantics per exception-less.md).  The IR
 *  validator (`loom.union-find-shape-unsupported`) pins the supported v1
 *  shape — exactly two inline variants: the repository's aggregate plus one
 *  *absent* variant (`none`, or an `error` payload whose only permitted field
 *  is `resource: string`) — so by emission time this resolves for every union
 *  find that reaches a backend.  Returns null for non-union returns. */
export interface FindUnionSpec {
  /** Polymorphic DTO / zod schema name (`OrderOrNotFound`). */
  name: string;
  variants: TypeIR[];
  /** The aggregate success variant's wire tag (the aggregate name). */
  successTag: string;
  /** The absent variant: the `none` unit (stdlib 404) or an error payload. */
  absent: { kind: "none"; tag: "none" } | { kind: "error"; tag: string; hasResource: boolean };
}

export function findUnionSpec(
  returnType: TypeIR,
  aggName: string,
  ctx: BoundedContextIR,
): FindUnionSpec | null {
  if (returnType.kind !== "union") return null;
  const variants = returnType.variants;
  const success = variants.find((v) => v.kind === "entity" && v.name === aggName);
  const other = variants.find((v) => v !== success);
  if (!success || !other || variants.length !== 2) return null;
  const name = unionInstanceName(variants);
  const successTag = variantTag(success);
  if (other.kind === "none") {
    return { name, variants, successTag, absent: { kind: "none", tag: "none" } };
  }
  if (other.kind !== "entity") return null;
  const payload = ctx.payloads.find((p) => p.name === other.name && p.kind === "error");
  if (!payload) return null;
  return {
    name,
    variants,
    successTag,
    absent: {
      kind: "error",
      tag: other.name,
      hasResource: payload.fields.some((f) => f.name === "resource"),
    },
  };
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

/** Raw JSON-schema for a tagged union — one `oneOf` arm per variant: the
 *  `type` discriminator literal plus the variant's wire fields.  Consumed by
 *  the backends whose OpenAPI layer can't express the union through its
 *  native response-model types without publishing extra per-variant
 *  components (FastAPI's install_openapi post-processor, the springdoc
 *  customizer's baked union components).  Structural kinds only — the parity
 *  diff folds formats and does not descend into oneOf arms. */
export function unionJsonSchema(variants: TypeIR[], ctx: BoundedContextIR): unknown {
  const arms = unionMembers(variants, ctx).map((m) => {
    const props: Record<string, unknown> = { type: { type: "string", enum: [m.tag] } };
    const required = ["type"];
    if (m.shape === "scalar") {
      props.value = jsonSchemaType(m.type);
      required.push("value");
    } else if (m.shape === "record") {
      for (const f of m.fields) {
        props[f.name] = jsonSchemaType(f.type);
        if (!f.optional) required.push(f.name);
      }
    }
    return { type: "object", properties: props, required };
  });
  return { oneOf: arms };
}

/** Compact TypeIR → JSON-schema fragment for the union arms above.
 *  Enums / VOs / entities inline as their structural type. */
function jsonSchemaType(t: TypeIR): unknown {
  const info = wireTypeInfo(t, "response");
  if (info.isNullable) return jsonSchemaType(peelNullable(t));
  if (info.isCollection) return { type: "array", items: jsonSchemaType(peelCollection(t)) };
  switch (info.refKind) {
    case "primitive":
      switch (info.primitive) {
        case "int":
        case "long":
          return { type: "integer" };
        case "decimal":
          return { type: "number" };
        case "bool":
          return { type: "boolean" };
        case "json":
          return { type: "object" };
        default:
          // string / guid / datetime / money — all cross as strings.
          return { type: "string" };
      }
    case "id":
      return { type: "string" };
    case "enum":
      return { type: "string" };
    default:
      return { type: "object" };
  }
}
