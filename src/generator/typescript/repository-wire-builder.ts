// Repository wire builder — domain → wire DTO serializer (`toWire()`).
//
// Used by the Hono routes layer to serialize responses; the shape
// mirrors the .NET <Agg>Response record so the parity check sees
// identical specs across backends.

import { forApiRead, wireFieldsFor } from "../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  TypeIR,
  WireField,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { MONEY_WIRE_SCALE } from "../money-scale.js";
import { renderTsExpr } from "./render-expr.js";

export function toWireMethod(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): string {
  return lines(
    `  toWire(root: ${agg.name}): unknown {`,
    `    return ${wireProjectionEntity(agg, "root", ctx)};`,
    `  }`,
  );
}

/** The read-masked wire fields of an aggregate (`field: T mask unless <expr>`,
 *  authorization.md §5) — the API-read wire fields whose `maskUnless` predicate
 *  is set.  Empty when the aggregate declares no field mask. */
export function maskedWireFields(agg: AggregateIR): WireField[] {
  return forApiRead(wireFieldsFor(agg)).filter((wf) => wf.maskUnless !== undefined);
}

/** True iff `agg` declares at least one `mask unless` field — the gate for
 *  emitting `toWireMasked` and routing responses through it. */
export function aggHasFieldMask(agg: AggregateIR): boolean {
  return maskedWireFields(agg).length > 0;
}

/** `toWireMasked(root, currentUser)` — the response serializer for an aggregate
 *  with `mask unless` fields.  Projects the full wire DTO via `toWire`, then
 *  REDACTS each masked field to `null` unless the caller's `currentUser`
 *  satisfies the field's predicate (an unauthenticated `currentUser === null`
 *  always redacts — fail-closed).  Internal (non-response) `toWire` uses are
 *  left unmasked; only response boundaries route through this.  Emitted only
 *  when `aggHasFieldMask(agg)` — a mask-free aggregate stays byte-identical. */
export function toWireMaskedMethod(agg: AggregateIR): string {
  const masked = maskedWireFields(agg);
  const body: string[] = [
    `  toWireMasked(root: ${agg.name}, currentUser: User | null): unknown {`,
    `    const wire = this.toWire(root) as Record<string, unknown>;`,
  ];
  for (const wf of masked) {
    // `maskUnless` is a `currentUser`-only predicate; render it with the bare
    // `currentUser` param in scope.  Guard the null caller before evaluating.
    const pred = renderTsExpr(wf.maskUnless!, { thisName: "this", principalExpr: "currentUser" });
    body.push(`    if (!(currentUser !== null && (${pred}))) wire.${wf.name} = null;`);
  }
  body.push(`    return wire;`, `  }`);
  return lines(...body);
}

function wireProjectionEntity(
  ent: EnrichedAggregateIR | EnrichedEntityPartIR,
  varExpr: string,
  ctx: EnrichedBoundedContextIR,
): string {
  // Single canonical walk — `wireFieldsFor` recomputes the wire shape from the
  // enriched node's fields (the scaffold-time helper in wire-projection.ts).
  // This serializer feeds repo.toWire(); its output's keys must line up with
  // the route's response Zod schema and the .NET DTO.  A runtime serializer
  // projects DOMAIN getters by name, so it stays keyed to the domain-derived
  // wire shape (not a hand-diverged contract record, whose fields need not have
  // getters).  `forApiRead` strips `internal` and `secret` fields so the wire
  // output matches the response schema's field set.
  const fields = forApiRead(wireFieldsFor(ent));
  const parts: string[] = [];
  for (const wf of fields) {
    if (wf.source === "id") {
      parts.push(`id: ${varExpr}.id as string`);
      continue;
    }
    if (wf.source === "containment") {
      const partName =
        wf.type.kind === "array" && wf.type.element.kind === "entity"
          ? wf.type.element.name
          : wf.type.kind === "entity"
            ? wf.type.name
            : "";
      const partIR = ctx.aggregates.flatMap((a) => a.parts).find((p) => p.name === partName);
      if (!partIR) continue;
      if (wf.type.kind === "array") {
        parts.push(
          `${wf.name}: ${varExpr}.${wf.name}.map((e: ${partIR.name}) => (${wireProjectionEntity(partIR, "e", ctx)}))`,
        );
      } else if (wf.optional) {
        // Optional single containment — guard the null branch (matches the
        // `<field>?: ...` wire field and the response schema's `.nullable()`).
        parts.push(
          `${wf.name}: ${varExpr}.${wf.name} == null ? null : ${wireProjectionEntity(partIR, `${varExpr}.${wf.name}`, ctx)}`,
        );
      } else {
        // Required single containment is non-null on the wire (parity with the
        // .NET `= default!` owned entity).  The domain getter is typed
        // `Part | null`, so assert before projecting to satisfy strict tsc.
        parts.push(`${wf.name}: ${wireProjectionEntity(partIR, `${varExpr}.${wf.name}!`, ctx)}`);
      }
      continue;
    }
    // property or derived — both reach the value via the same getter
    // on the domain class.
    parts.push(
      `${wf.name}: ${wireProjectionValue(`${varExpr}.${wf.name}`, wf.type, ctx, wf.optional)}`,
    );
  }
  // Co-located provenance rides the wire DTO so any GET surfaces the
  // current lineage inline (the field's own value still emits above).
  for (const f of ent.fields.filter((f) => f.provenanced)) {
    parts.push(`${f.name}_provenance: ${varExpr}.${f.name}_provenance`);
  }
  return `{ ${parts.join(", ")} }`;
}

/** Render one DOMAIN value to its wire form.  Exported because the query-time
 *  projection route emitter must serialise a `select`ed domain value EXACTLY as
 *  the aggregate's own `toWire` does — money's fixed RS-12 scale in particular
 *  (`.toFixed(4)`, not `String(...)`, which decimal.js renders as `"10"`), or a
 *  projection row and an aggregate read disagree on the same column's format. */
export function wireProjectionValue(
  expr: string,
  t: TypeIR,
  ctx: BoundedContextIR,
  optional: boolean,
): string {
  if (t.kind === "optional") {
    return `(${expr} == null ? null : ${wireProjectionValue(expr, t.inner, ctx, true)})`;
  }
  if (t.kind === "primitive") {
    if (t.name === "datetime")
      return optional
        ? `(${expr} == null ? null : (${expr} as Date).toISOString())`
        : `(${expr} as Date).toISOString()`;
    // money carries a FIXED wire scale (RS-12): decimal.js `.toJSON()`
    // normalizes trailing zeros (`"12.50"` → `"12.5"`), so serialize with the
    // canonical scale (4, matching money's NUMERIC(19,4) storage) instead — the
    // wire value is byte-consistent with the other backends' 4-dp money.
    if (t.name === "money")
      return optional
        ? `(${expr} == null ? null : ${expr}.toFixed(${MONEY_WIRE_SCALE}))`
        : `${expr}.toFixed(${MONEY_WIRE_SCALE})`;
    // decimal: JSON number — .NET serializes decimal the same way, so
    // both backends round-trip identically.
    return expr;
  }
  if (t.kind === "id") return `${expr} as string`;
  if (t.kind === "enum") return `${expr} as string`;
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (!vo) return expr;
    const fields = vo.fields
      .map((vf) => `${vf.name}: ${wireProjectionValue(`${expr}.${vf.name}`, vf.type, ctx, false)}`)
      .join(", ");
    if (optional) {
      return `(${expr} == null ? null : { ${fields} })`;
    }
    return `{ ${fields} }`;
  }
  if (t.kind === "array") {
    // Lambda param is contextually typed by `.map` over the element
    // type; an explicit annotation would fight strict-mode inference
    // for branded `T id` element arrays.
    return `${expr}.map((a) => (${wireProjectionValue("a", t.element, ctx, false)}))`;
  }
  if (t.kind === "entity") return expr;
  return expr;
}
