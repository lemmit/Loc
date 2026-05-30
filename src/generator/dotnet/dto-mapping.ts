import { wireShapeFor } from "../../ir/enrich/enrichments.js";
import { forApiRead } from "../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  EntityPartIR,
  IdValueType,
  TypeIR,
  ValueObjectIR,
} from "../../ir/types/loom-ir.js";
import {
  peelCollection,
  peelNullable,
  type WirePrimitive,
  wireTypeInfo,
} from "../../ir/types/wire-types.js";
import { upperFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Wire-shape DTO mapping helpers.
//
// These functions translate between the IR's domain types (with `X id`,
// value objects, enums) and the wire-shape primitive types used in
// Request / Response DTOs.  Four entry points:
//
//   - `wireType(t, ctx, dir)` — the C# type that appears on a DTO record
//     property.
//   - `wireToCommandArgument(expr, t, ctx)` — wire-shaped C# expression
//     → domain-typed argument expression for a Command constructor.
//   - `projectToResponse(expr, t, ctx)` — domain expression → wire-shape
//     Response counterpart.
//   - `projectEntityExpr(expr, entity, ctx)` — full entity → Response
//     projection (used by query handlers).
//
// All `TypeIR.kind` discrimination lives in `src/ir/wire-types.ts`;
// the helpers below consume `wireTypeInfo` and emit C# strings.
// ---------------------------------------------------------------------------

/** Wire-primitive → C# JSON-on-the-wire type.  Datetime and money cross
 *  the wire as strings (ISO 8601 Z-suffixed; InvariantCulture-formatted
 *  decimal) for cross-backend parity with Hono and Phoenix. */
const CS_WIRE_PRIMITIVE: Record<WirePrimitive, string> = {
  int: "int",
  long: "long",
  decimal: "decimal",
  money: "string",
  string: "string",
  bool: "bool",
  datetime: "string",
  guid: "Guid",
  // Opaque JSON blob — round-trips through System.Text.Json untouched
  // (System.Text.Json serialises a JsonElement back verbatim).
  json: "System.Text.Json.JsonElement",
};

/** C# DTO property type for a `TypeIR`.  `dir` selects the suffix for
 *  nested value-object DTOs (`Request` for inputs, `Response` for
 *  outputs); entities always nest as `<Name>Response`. */
export function wireType(
  t: TypeIR,
  ctx: EnrichedBoundedContextIR,
  dir: "request" | "response",
): string {
  void ctx;
  const info = wireTypeInfo(t, dir);
  let s: string;
  switch (info.refKind) {
    case "primitive":
      s = CS_WIRE_PRIMITIVE[info.primitive!];
      break;
    case "id":
      // Pre-existing divergence: every id crosses the .NET wire as
      // `Guid`, regardless of `idValueType`.  Hono mirrors this; the
      // OpenAPI emitter honours the typed value for path params.
      s = csIdValueClrType("guid");
      break;
    case "enum":
      // Enum crosses the wire as the enum TYPE (not `string`): paired with
      // a global `JsonStringEnumConverter` (registered in Program.cs) the
      // JSON bytes stay the member name (`"Public"`), but Swashbuckle now
      // emits a named string-enum schema — matching Hono/Phoenix, which
      // both publish a named enum component.
      s = info.base;
      break;
    case "valueObject":
      s = `${info.base}${dir === "request" ? "Request" : "Response"}`;
      break;
    case "entity":
      s = `${info.base}Response`;
      break;
  }
  if (info.isCollection) s = `IReadOnlyList<${s}>`;
  if (info.isNullable) s = `${s}?`;
  return s;
}

/** A DTO record positional parameter, marked required when the C# type is
 *  non-nullable.  Swashbuckle's `SupportNonNullableReferenceTypes` does NOT
 *  reliably infer required-ness from positional-record NRT metadata (and
 *  never marks non-nullable *value* types required), so we drive it
 *  explicitly from the IR: a field is required iff `wireType` did not append
 *  `?` — exactly the optional→nullable mapping.  This matches Hono/Phoenix,
 *  which mark every non-optional field required.
 *
 *  Attribute TARGET matters and differs by direction:
 *   - REQUEST DTOs are model-bound + validated.  `[property: Required]` puts
 *     the metadata on the generated property, which ASP.NET's record
 *     validation rejects at runtime —
 *     `ThrowIfRecordTypeHasValidationOnProperties` throws
 *     `InvalidOperationException` ("validation metadata must be associated
 *     with the constructor parameter"), surfacing as a 500 on the FIRST
 *     POST with a required field — before the controller/handler ever runs.
 *     So requests target the constructor PARAMETER: bare `[Required]` (the
 *     default target on a positional-record parameter).  Swashbuckle reads
 *     record constructor-parameter annotations for the request-body schema,
 *     so OpenAPI required-ness is preserved (verified by the strict-parity
 *     `requiredDiffs` gate).
 *   - RESPONSE DTOs are only serialized, never model-bound, so the throw
 *     can't fire; they keep `[property: Required]` so Swashbuckle's
 *     property-based DataAnnotations reader marks them required in the
 *     response schema.
 *
 *  Exception: a non-nullable `bool` in a REQUEST is NOT required.  ASP.NET
 *  model-binding defaults an omitted bool to `false` (no error), matching
 *  Hono's `z.coerce.boolean()` (coerces `undefined` → `false`); both
 *  backends accept the field's omission, so neither marks it required.
 *  Numbers differ — `z.coerce.number()` rejects `undefined`, so numeric
 *  request fields stay required on both sides. */
export function dtoParam(
  csType: string,
  name: string,
  dir: "request" | "response" = "response",
): string {
  const optionalBoolRequest = dir === "request" && csType === "bool";
  const required = !csType.endsWith("?") && !optionalBoolRequest;
  if (!required) return `${csType} ${name}`;
  // Request → parameter target (bare `[Required]`); response → property
  // target (`[property: Required]`).  See the doc comment above.
  const attr = dir === "request" ? "[Required] " : "[property: Required] ";
  return `${attr}${csType} ${name}`;
}

/** Map a wire-shaped expression to a domain-typed argument for a command. */
export function wireToCommandArgument(
  expr: string,
  t: TypeIR,
  ctx: EnrichedBoundedContextIR,
  usings?: Set<string>,
): string {
  const info = wireTypeInfo(t, "request");
  if (info.isNullable) {
    return `(${expr} is null ? null : ${wireToCommandArgument(`${expr}!`, peelNullable(t), ctx, usings)})`;
  }
  if (info.isCollection) {
    return `${expr}.Select(__e => ${wireToCommandArgument("__e", peelCollection(t), ctx, usings)}).ToList()`;
  }
  switch (info.refKind) {
    case "primitive":
      if (info.primitive === "datetime") {
        // Wire is a string; coerce to UTC DateTime regardless of whether
        // the caller sent a Z-suffixed value or a naive datetime-local
        // string.  CultureInfo + DateTimeStyles live in
        // System.Globalization, outside the SDK's implicit-usings set.
        usings?.add("System.Globalization");
        return `DateTime.Parse(${expr}, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal)`;
      }
      if (info.primitive === "money") {
        // Wire string → System.Decimal.  InvariantCulture so a locale's
        // comma-vs-dot doesn't flip the parse.
        usings?.add("System.Globalization");
        return `decimal.Parse(${expr}, CultureInfo.InvariantCulture)`;
      }
      return expr;
    case "id":
      return `new ${info.idTarget}Id(${expr})`;
    case "enum":
      // The request DTO field is already the enum type (deserialized from
      // the wire member name by JsonStringEnumConverter) — pass it through.
      return expr;
    case "valueObject": {
      const vo = ctx.valueObjects.find((v) => v.name === info.base);
      if (!vo) return expr;
      const args = vo.fields
        .map((f) => wireToCommandArgument(`${expr}.${upperFirst(f.name)}`, f.type, ctx, usings))
        .join(", ");
      return `new ${info.base}(${args})`;
    }
    case "entity":
      return expr;
  }
}

/** Project a domain expression to its wire-shape Response. */
export function projectToResponse(
  domainExpr: string,
  t: TypeIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const info = wireTypeInfo(t, "response");
  if (info.isNullable) {
    // C# doesn't narrow `T?` to `T` after `is null` test; unwrap
    // explicitly: value types use `.Value`, reference types use `!`.
    const innerT = peelNullable(t);
    const unwrap = csIsValueType(innerT) ? `${domainExpr}.Value` : `${domainExpr}!`;
    return `(${domainExpr} is null ? null : ${projectToResponse(unwrap, innerT, ctx)})`;
  }
  if (info.isCollection) {
    return `${domainExpr}.Select(__e => ${projectToResponse("__e", peelCollection(t), ctx)}).ToList()`;
  }
  switch (info.refKind) {
    case "primitive":
      if (info.primitive === "datetime") {
        // ISO 8601 with Z suffix — matches Hono so clients see one shape.
        return `${domainExpr}.ToUniversalTime().ToString("o")`;
      }
      if (info.primitive === "money") {
        // System.Decimal → wire string, InvariantCulture for stability.
        return `${domainExpr}.ToString(System.Globalization.CultureInfo.InvariantCulture)`;
      }
      return domainExpr;
    case "id":
      return `${domainExpr}.Value`;
    case "enum":
      // Response DTO field is the enum type; emit the enum value directly
      // (JsonStringEnumConverter serialises it to the wire member name).
      return domainExpr;
    case "valueObject": {
      const vo = ctx.valueObjects.find((v) => v.name === info.base);
      if (!vo) return domainExpr;
      const args = vo.fields
        .map((f) => projectToResponse(`${domainExpr}.${upperFirst(f.name)}`, f.type, ctx))
        .join(", ");
      return `new ${info.base}Response(${args})`;
    }
    case "entity": {
      type Resolved = {
        part: EnrichedAggregateIR | EnrichedEntityPartIR;
        agg: EnrichedAggregateIR;
      };
      const part: Resolved | undefined =
        ctx.aggregates
          .flatMap((a): Resolved[] =>
            a.parts.map((p: EnrichedEntityPartIR) => ({ part: p, agg: a })),
          )
          .find((x) => x.part.name === info.base) ??
        ctx.aggregates
          .map((a): Resolved => ({ part: a, agg: a }))
          .find((x) => x.part.name === info.base);
      if (!part) return domainExpr;
      return projectEntityExpr(domainExpr, part.part, ctx);
    }
  }
}

/** Convert a domain-typed expression to its wire-shape Request form.
 *  Symmetric with `projectToResponse` but wraps VOs as `<VO>Request`. */
export function domainToRequestExpr(
  domainExpr: string,
  t: TypeIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const info = wireTypeInfo(t, "request");
  if (info.isNullable) {
    const innerT = peelNullable(t);
    const unwrap = csIsValueType(innerT) ? `${domainExpr}.Value` : `${domainExpr}!`;
    return `(${domainExpr} is null ? null : ${domainToRequestExpr(unwrap, innerT, ctx)})`;
  }
  if (info.isCollection) {
    return `${domainExpr}.Select(__e => ${domainToRequestExpr("__e", peelCollection(t), ctx)}).ToList()`;
  }
  switch (info.refKind) {
    case "primitive":
      if (info.primitive === "datetime") {
        return `${domainExpr}.ToUniversalTime().ToString("o")`;
      }
      return domainExpr;
    case "id":
      return `${domainExpr}.Value`;
    case "enum":
      // Request DTO field is the enum type — emit the value directly.
      return domainExpr;
    case "valueObject": {
      const vo = ctx.valueObjects.find((v) => v.name === info.base);
      if (!vo) return domainExpr;
      const args = vo.fields
        .map((f) => domainToRequestExpr(`${domainExpr}.${upperFirst(f.name)}`, f.type, ctx))
        .join(", ");
      return `new ${info.base}Request(${args})`;
    }
    case "entity":
      return domainExpr;
  }
}

/** True when `t` lowers to a C# value type — `T?` is `Nullable<T>` and
 *  must be unwrapped with `.Value` before any method call.  `string`
 *  and `List<T>` are reference types; everything else (primitives, ids,
 *  enums) is a value type. */
function csIsValueType(t: TypeIR): boolean {
  const info = wireTypeInfo(t, "response");
  if (info.isCollection) return false;
  switch (info.refKind) {
    case "primitive":
      return info.primitive !== "string";
    case "id":
    case "enum":
      return true;
    case "valueObject":
    case "entity":
      return false;
  }
}

export function projectEntityExpr(
  domainExpr: string,
  entity: EnrichedAggregateIR | EnrichedEntityPartIR,
  ctx: EnrichedBoundedContextIR,
): string {
  // `entity.wireShape` is populated by `enrichLoomModel` and exposed via
  // the `Enriched...` brands threaded through `PlatformSurface.emitProject`.
  // Each wire field maps to one positional argument on `new <Ent>Response(...)`,
  // in the same order the Hono / React Zod schemas emit.  `forApiRead`
  // strips `internal` and `secret` fields.
  const fields = forApiRead(wireShapeFor(entity));
  const args: string[] = [];
  for (const wf of fields) {
    if (wf.source === "id") {
      args.push(`${domainExpr}.Id.Value`);
    } else if (wf.source === "containment") {
      const part = ctx.aggregates
        .flatMap((a) => a.parts)
        .find((p) => p.name === containmentPartName(wf.type));
      if (!part) continue;
      const accessor = `${domainExpr}.${upperFirst(wf.name)}`;
      args.push(
        wireTypeInfo(wf.type, "response").isCollection
          ? `${accessor}.Select(__e => ${projectEntityExpr("__e", part, ctx)}).ToList()`
          : projectEntityExpr(accessor, part, ctx),
      );
    } else {
      args.push(projectToResponse(`${domainExpr}.${upperFirst(wf.name)}`, wf.type, ctx));
    }
  }
  return `new ${entity.name}Response(${args.join(", ")})`;
}

export function aggregateResponseParams(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): string {
  return responseRecordParams(agg, ctx);
}

export function entityResponseParams(
  part: EnrichedEntityPartIR,
  ctx: EnrichedBoundedContextIR,
): string {
  return responseRecordParams(part, ctx);
}

function responseRecordParams(
  ent: EnrichedAggregateIR | EnrichedEntityPartIR,
  ctx: EnrichedBoundedContextIR,
): string {
  // Drop `internal` / `secret` fields so the C# record's param list
  // matches what `projectEntityExpr` projects.
  const fields = forApiRead(wireShapeFor(ent));
  const idValueType = isPart(ent) ? ent.parentIdValueType : ent.idValueType;
  const parts: string[] = [];
  for (const wf of fields) {
    if (wf.source === "id") {
      parts.push(dtoParam(csIdValueClrType(idValueType), "Id"));
    } else {
      parts.push(dtoParam(wireType(wf.type, ctx, "response"), upperFirst(wf.name)));
    }
  }
  return parts.join(", ");
}

function isPart(ent: EnrichedAggregateIR | EnrichedEntityPartIR): ent is EnrichedEntityPartIR {
  return "parentName" in ent;
}

function containmentPartName(t: TypeIR): string | undefined {
  const inner = peelCollection(t);
  return inner.kind === "entity" ? inner.name : undefined;
}

/** Set of value objects reachable from an aggregate's surface. */
export function valueObjectsUsedBy(
  agg: AggregateIR,
  ctx: EnrichedBoundedContextIR,
): ValueObjectIR[] {
  const used = new Set<string>();
  const visit = (t: TypeIR) => {
    if (t.kind === "valueobject") used.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const f of agg.fields) visit(f.type);
  for (const d of agg.derived) visit(d.type);
  for (const op of agg.operations) for (const p of op.params) visit(p.type);
  for (const part of agg.parts) {
    for (const f of part.fields) visit(f.type);
    for (const d of part.derived) visit(d.type);
  }
  return ctx.valueObjects.filter((v) => used.has(v.name));
}

export function csIdValueClrType(idValueType: IdValueType): string {
  switch (idValueType) {
    case "int":
      return "int";
    case "long":
      return "long";
    case "string":
      return "string";
    default:
      return "Guid";
  }
}
