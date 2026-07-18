import { forApiRead, wireFieldsFor } from "../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  FieldIR,
  IdValueType,
  PayloadIR,
  TypeIR,
  ValueObjectIR,
} from "../../ir/types/loom-ir.js";
import {
  peelCollection,
  peelNullable,
  type WirePrimitive,
  wireTypeInfo,
} from "../../ir/types/wire-types.js";
import { collectReachableTypes } from "../../ir/util/reachable-types.js";
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

/** C# expression rendering a domain `DateTime` as its canonical wire string:
 *  ISO-8601 UTC with trailing zero fractional seconds trimmed (and the '.'
 *  dropped when the fraction is entirely zero), matching the node (Hono),
 *  Python (`isoformat`) and Java (`Instant.toString()`) backends (RS-4 temporal
 *  round-trip).  `.ToString("o")` alone pads the fraction to a fixed 7 digits
 *  (`…00.0000000Z`); `Regex.Replace(…, @"\.?0+Z$", "Z")` collapses an all-zero
 *  fraction to `…00Z` while keeping genuine precision (`…00.123Z`).  The
 *  emitted `CanonicalInstant.Format` helper (canonical-instant.ts) applies the
 *  same trim to raw-DateTime serialization. */
function csCanonicalInstantWire(domainExpr: string): string {
  return `System.Text.RegularExpressions.Regex.Replace(${domainExpr}.ToUniversalTime().ToString("o"), @"\\.?0+Z$", "Z")`;
}

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
 *   - REQUEST DTOs are model-bound + validated.  A `[property: Required]` on
 *     a positional-record parameter makes ASP.NET's record validation throw
 *     at model-binding time (`ThrowIfRecordTypeHasValidationOnProperties` →
 *     `InvalidOperationException`, a 500 on the FIRST POST with a required
 *     field, before the controller/handler runs).  So requests target the
 *     constructor PARAMETER with a bare `[Required]`.  Swashbuckle's
 *     DataAnnotations reader does NOT pick up parameter-targeted attributes,
 *     so request-body OpenAPI required-ness is restored separately by the
 *     `RequiredFromCtorParamFilter` ISchemaFilter (emit/api.ts), which
 *     reflects the ctor params back into `schema.Required`.  That keeps the
 *     strict-parity `requiredDiffs` gate green without re-introducing the
 *     property-target metadata that triggers the throw.
 *   - RESPONSE DTOs are only serialized, never model-bound, so the throw
 *     can't fire; they keep `[property: Required]` so Swashbuckle's
 *     property-based DataAnnotations reader marks them required in the
 *     response schema directly.
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
  /** Rendered C# literal for an explicitly-defaulted request field.  When
   *  present the parameter becomes optional via a record default value
   *  (`Type Name = <lit>`) and carries no `[Required]` — STJ applies the
   *  default when the field is omitted, dropping it from the required-set. */
  defaultLiteral?: string,
): string {
  if (defaultLiteral !== undefined && dir === "request") {
    return `${csType} ${name} = ${defaultLiteral}`;
  }
  const optionalBoolRequest = dir === "request" && csType === "bool";
  const required = !csType.endsWith("?") && !optionalBoolRequest;
  if (!required) return `${csType} ${name}`;
  // Request → parameter target (bare `[Required]`) so ASP.NET record
  // validation doesn't throw at model-binding time; response → property
  // target (`[property: Required]`).  See the doc comment above.
  //
  // Required STRING request fields carry `AllowEmptyStrings = true`: by
  // default `[Required]` rejects `""` with a 400 model-validation error,
  // which would pre-empt the domain `invariant`/`check` (e.g. `name.length
  // > 0`) that the other backends surface as 422.  Allowing the empty
  // string through the structural layer defers emptiness to the domain
  // invariant, so all backends reject it with the same 422 (cross-backend
  // parity).  Null/omitted still fails `[Required]` (400), as before.  Stays
  // a `RequiredAttribute`, so Swashbuckle's `RequiredFromCtorParamFilter`
  // keeps the field in the OpenAPI required-set.
  const attr =
    dir === "request"
      ? csType === "string"
        ? "[Required(AllowEmptyStrings = true)] "
        : "[Required] "
      : "[property: Required] ";
  return `${attr}${csType} ${name}`;
}

/** Map a wire-shaped expression to a domain-typed argument for a command. */
export function wireToCommandArgument(
  expr: string,
  t: TypeIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const info = wireTypeInfo(t, "request");
  if (info.isNullable) {
    // C# doesn't narrow `T?` to `T` after the `is null` test, and the
    // null-forgiving `!` only silences the warning — the value stays nullable.
    // Value-type targets (an id ctor, an enum, a numeric primitive) need the
    // non-nullable backing via `.Value`; reference-typed wires (string, VO,
    // entity) and the string-encoded primitives (money/datetime) stay as `!`.
    // On the .NET wire every id crosses as `Guid` (a value type), so a nullable
    // id ref is always `Guid?` → `.Value`.
    const innerT = peelNullable(t);
    const inner = wireTypeInfo(innerT, "request");
    const valueWire =
      inner.refKind === "id" ||
      inner.refKind === "enum" ||
      (inner.refKind === "primitive" &&
        inner.primitive !== "string" &&
        inner.primitive !== "money" &&
        inner.primitive !== "datetime");
    const unwrap = valueWire ? `${expr}!.Value` : `${expr}!`;
    return `(${expr} is null ? null : ${wireToCommandArgument(unwrap, innerT, ctx)})`;
  }
  if (info.isCollection) {
    return `${expr}.Select(__e => ${wireToCommandArgument("__e", peelCollection(t), ctx)}).ToList()`;
  }
  switch (info.refKind) {
    case "primitive":
      if (info.primitive === "datetime") {
        // Wire is a string; coerce to UTC DateTime regardless of whether
        // the caller sent a Z-suffixed value or a naive datetime-local
        // string.  CultureInfo + DateTimeStyles live in
        // System.Globalization, outside the SDK's implicit-usings set
        // (declared via collectWireUsings on the emitter side).
        return `DateTime.Parse(${expr}, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal)`;
      }
      if (info.primitive === "money") {
        // Wire string → System.Decimal.  InvariantCulture so a locale's
        // comma-vs-dot doesn't flip the parse.
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
        .map((f) => wireToCommandArgument(`${expr}.${upperFirst(f.name)}`, f.type, ctx))
        .join(", ");
      return `new ${info.base}(${args})`;
    }
    case "entity":
      return expr;
  }
}

/** Namespaces the wire→command conversion of `t` reaches into beyond the
 *  SDK's implicit usings — `System.Globalization` for the datetime/money
 *  parse helpers `wireToCommandArgument` emits.  Pure mirror of that
 *  function's recursion (nullable / collection peel, value-object field
 *  recursion); emitters call it over the same types they convert to build
 *  their `using` header. */
export function collectWireUsings(
  t: TypeIR,
  ctx: EnrichedBoundedContextIR,
  into: Set<string> = new Set(),
): Set<string> {
  const info = wireTypeInfo(t, "request");
  if (info.isNullable) return collectWireUsings(peelNullable(t), ctx, into);
  if (info.isCollection) return collectWireUsings(peelCollection(t), ctx, into);
  if (info.refKind === "primitive") {
    if (info.primitive === "datetime" || info.primitive === "money") {
      into.add("System.Globalization");
    }
    return into;
  }
  if (info.refKind === "valueObject") {
    const vo = ctx.valueObjects.find((v) => v.name === info.base);
    if (vo) for (const f of vo.fields) collectWireUsings(f.type, ctx, into);
  }
  return into;
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
        // Canonical ISO-8601 UTC with Z suffix — matches Hono/Python/Java so
        // clients see one shape (RS-4).  See `csCanonicalInstantWire`.
        return csCanonicalInstantWire(domainExpr);
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
        return csCanonicalInstantWire(domainExpr);
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

/** The positional constructor arguments of an entity's wire projection —
 *  shared by `projectEntityExpr` (the `<Ent>Response` DTO) and the union
 *  variant records (`<Union>_<Agg>`, whose parameter list is the same
 *  `forApiRead(wireShape)` field set via `unionMembers`). */
export function projectEntityArgs(
  domainExpr: string,
  entity: EnrichedAggregateIR | EnrichedEntityPartIR,
  ctx: EnrichedBoundedContextIR,
  /** Provenance (provenance.md): the `<Ent>Response` record carries one trailing
   *  `<Field>Provenance` param per provenanced field, so its projection appends
   *  the matching `domainExpr.<Field>Provenance` args by default — keeping the
   *  record + projection in lockstep.  A discriminated-union variant record
   *  (`<Union>_<Tag>`, params from `unionMembers`) does NOT carry the provenance
   *  params, so that one call site sets `unionVariant` to suppress them. */
  opts?: { unionVariant?: boolean },
): string {
  // `wireFieldsFor` recomputes the wire shape from the enriched node's fields.
  // Each wire field maps to one positional argument on `new <Ent>Response(...)`,
  // in the same order the Hono / React Zod schemas emit.  A runtime projection
  // reads DOMAIN getters by name, so it stays keyed to the domain-derived wire
  // shape (not a hand-diverged contract record).  `forApiRead` strips `internal`
  // and `secret` fields.
  const fields = forApiRead(wireFieldsFor(entity));
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
      // An OPTIONAL single containment may be unset (the owned nav is null), so
      // guard the projection — `found.Note.Id.Value` on a null nav throws a
      // NullReferenceException.  A collection never nulls; a required single
      // containment is defaulted, so both project unguarded.
      const single = !wireTypeInfo(wf.type, "response").isCollection;
      args.push(
        wireTypeInfo(wf.type, "response").isCollection
          ? `${accessor}.Select(__e => ${projectEntityExpr("__e", part, ctx)}).ToList()`
          : single && wf.optional
            ? `${accessor} is null ? null : ${projectEntityExpr(accessor, part, ctx)}`
            : projectEntityExpr(accessor, part, ctx),
      );
    } else {
      args.push(projectToResponse(`${domainExpr}.${upperFirst(wf.name)}`, wf.type, ctx));
    }
  }
  // Provenance: trailing `<Field>Provenance` lineage args, in field order,
  // matching the response record's trailing params (see `responseRecordParams`).
  if (!opts?.unionVariant) {
    for (const f of entity.fields.filter((pf) => pf.provenanced)) {
      args.push(`${domainExpr}.${upperFirst(f.name)}Provenance`);
    }
  }
  return args.join(", ");
}

export function projectEntityExpr(
  domainExpr: string,
  entity: EnrichedAggregateIR | EnrichedEntityPartIR,
  ctx: EnrichedBoundedContextIR,
  opts?: { unionVariant?: boolean },
): string {
  return `new ${entity.name}Response(${projectEntityArgs(domainExpr, entity, ctx, opts)})`;
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

/** Build the `<Agg>Response` record's positional params from a DECLARED
 *  `response <Agg>Response` payload record (M-T5.10) instead of the aggregate's
 *  `wireShape`.  Byte-identical to `responseRecordParams(agg, ctx)` for a
 *  scaffolded aggregate whose author record mirrors the apiRead matrix — the
 *  read-path replacement for the auto-derivation, keyed on the declared record.
 *
 *  The payload record carries NO `id` field (grammar-reserved), so the leading
 *  `Guid Id` is re-prepended here; provenance lineage params are re-appended
 *  from the aggregate's provenanced fields — both exactly as
 *  `responseRecordParams` derives them from the synthetic wire-shape id row and
 *  the same `agg.fields` filter. */
export function responseParamsFromPayload(
  agg: EnrichedAggregateIR,
  payload: PayloadIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const parts: string[] = [];
  // The DTO leads with `Guid Id` even though the record omits it.
  parts.push(dtoParam(csIdValueClrType(agg.idValueType), "Id"));
  for (const f of payload.fields) {
    parts.push(dtoParam(payloadFieldCsType(f.type, ctx), upperFirst(f.name)));
  }
  // Provenance — identical trailing logic to `responseRecordParams`.
  for (const f of agg.fields.filter((pf) => pf.provenanced)) {
    parts.push(`ProvLineage? ${upperFirst(f.name)}Provenance`);
  }
  return parts.join(", ");
}

/** C# DTO type for a field of a DECLARED `response` payload record.
 *
 *  Fields are of two shapes (M-T5.10 PR1): a value-object / scalar / enum / id
 *  field carries its DOMAIN type (`total: Money`), so `wireType` maps it to the
 *  wire form exactly as the wireShape path does; a CONTAINMENT field is ALREADY
 *  the wire name (`lines: LineResponse[]`) — context scope can't reference a raw
 *  entity part, so PR1 rewrote it to the sibling `<Part>Response` record, which
 *  lowers to an `entity` TypeIR whose name is a declared `response` payload.
 *  That name must be rendered DIRECTLY (peel collection + nullable, re-wrap
 *  `IReadOnlyList<...>` / `?`); running it through `wireType` would append a
 *  second `Response` (`LineResponseResponse`). */
function payloadFieldCsType(t: TypeIR, ctx: EnrichedBoundedContextIR): string {
  const info = wireTypeInfo(t, "response");
  if (info.refKind === "entity" && isResponsePayloadName(ctx, info.base)) {
    let s = info.base;
    if (info.isCollection) s = `IReadOnlyList<${s}>`;
    if (info.isNullable) s = `${s}?`;
    return s;
  }
  return wireType(t, ctx, "response");
}

/** True iff `name` is a declared `response` payload in the context — i.e. a
 *  containment field's already-wire type, which must not be re-suffixed. */
function isResponsePayloadName(ctx: EnrichedBoundedContextIR, name: string): boolean {
  return ctx.payloads.some((p) => p.kind === "response" && p.name === name);
}

function responseRecordParams(
  ent: EnrichedAggregateIR | EnrichedEntityPartIR,
  ctx: EnrichedBoundedContextIR,
): string {
  // Drop `internal` / `secret` fields so the C# record's param list
  // matches what `projectEntityExpr` projects.  (The declared-`<Agg>Response`-
  // record path is `responseParamsFromPayload`; this is the part / no-record
  // fallback, which recomputes via `wireFieldsFor`.)
  const fields = forApiRead(wireFieldsFor(ent));
  const idValueType = isPart(ent) ? ent.parentIdValueType : ent.idValueType;
  const parts: string[] = [];
  for (const wf of fields) {
    if (wf.source === "id") {
      parts.push(dtoParam(csIdValueClrType(idValueType), "Id"));
    } else {
      // A containment's wire type is a bare `entity` (its optionality rides the
      // WireField `optional` flag, not the type), so an OPTIONAL single
      // containment needs the `?` appended explicitly — otherwise the response
      // record declares it `[Required] MemoResponse` and the read of an unset
      // (null) containment fails.  Scalar/VO fields already carry their own
      // nullability in the type, so the `endsWith("?")` guard keeps this idempotent.
      let csType = wireType(wf.type, ctx, "response");
      if (wf.optional && !csType.endsWith("?")) csType = `${csType}?`;
      parts.push(dtoParam(csType, upperFirst(wf.name)));
    }
  }
  // Provenance (provenance.md): expose each provenanced field's current lineage
  // as a trailing nullable `<Field>Provenance` response param (no `[Required]` —
  // a never-written field has null lineage).  Lockstep with `projectEntityArgs`.
  for (const f of ent.fields.filter((pf) => pf.provenanced)) {
    parts.push(`ProvLineage? ${upperFirst(f.name)}Provenance`);
  }
  return parts.join(", ");
}

/** True iff the entity exposes any provenanced field on its response (so the
 *  emitter adds the `using <ns>.Domain.Common;` the `ProvLineage?` param needs). */
export function entityExposesProvenance(ent: { fields: FieldIR[] }): boolean {
  return ent.fields.some((f) => f.provenanced);
}

function isPart(ent: EnrichedAggregateIR | EnrichedEntityPartIR): ent is EnrichedEntityPartIR {
  return "parentName" in ent;
}

function containmentPartName(t: TypeIR): string | undefined {
  const inner = peelCollection(t);
  return inner.kind === "entity" ? inner.name : undefined;
}

/** Value objects reachable from an aggregate's surface — TRANSITIVELY
 *  through value objects' own fields.  The DTO emitters render a
 *  `<Vo>Response` / `<Vo>Request` record per returned VO whose params
 *  reference each field's wire type, so a VO nested inside another VO
 *  (e.g. `A { b: B }` where the aggregate uses `A` but not `B` directly)
 *  must be included — otherwise `AResponse` references an unemitted
 *  `BResponse` and the project fails to compile.  (Enums need no entry
 *  here: the .NET backend emits every enum of the context as a first-class
 *  type, mapped directly.) */
export function valueObjectsUsedBy(
  agg: AggregateIR,
  ctx: EnrichedBoundedContextIR,
): ValueObjectIR[] {
  const seeds = function* (): Generator<TypeIR> {
    for (const f of agg.fields) yield f.type;
    for (const d of agg.derived) yield d.type;
    for (const op of agg.operations) for (const p of op.params) yield p.type;
    for (const part of agg.parts) {
      for (const f of part.fields) yield f.type;
      for (const d of part.derived) yield d.type;
    }
  };
  const { valueObjects } = collectReachableTypes(seeds(), ctx.valueObjects);
  return ctx.valueObjects.filter((v) => valueObjects.has(v.name));
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
