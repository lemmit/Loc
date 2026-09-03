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
  WireField,
} from "../../ir/types/loom-ir.js";
import {
  peelCollection,
  peelNullable,
  type WirePrimitive,
  wireTypeInfo,
} from "../../ir/types/wire-types.js";
import { collectReachableTypes } from "../../ir/util/reachable-types.js";
import { snake, upperFirst } from "../../util/naming.js";
import { numericEncode } from "../_numeric/target.js";
import { PROVENANCED_REQUEST_ERROR } from "../_payload/provenanced-wire.js";
import { csProvSibling, PROVENANCED_CS_RECORD } from "./emit/provenance.js";
import { CS_NUMERIC } from "./numeric-codec.js";
import { renderCsExpr } from "./render-expr.js";

/** Allocator for the C# pattern-variable names `maskWrap` binds.
 *
 *  `x is { } name` declares `name` in the ENCLOSING BLOCK, not in the
 *  conditional expression that tests it — so a fixed name collides (CS0128
 *  "a local variable named '…' is already defined in this scope") the moment
 *  ONE method body renders two masked projections.  That happens routinely:
 *  two `mask unless` fields on one aggregate (two wraps in one `new
 *  <Agg>Response(...)`), and — the case this allocator was introduced for — an
 *  `audited` operation, whose handler serializes the wire projection TWICE (the
 *  `__before` and `__after` snapshots) into the same handler body.  A lambda
 *  body would be no escape either, so the nested containment projections share
 *  the namer: C# forbids shadowing an enclosing local (CS0136).  (A contained
 *  PART cannot carry a mask today — `wireFieldsForPart` drops `maskUnless` —
 *  but threading it costs nothing and removes the trap if that changes.)
 *
 *  So the name is allocated, never hard-coded.  One namer spans one C# SCOPE:
 *  every emitter that renders more than one projection into a single method
 *  body threads ONE namer through all of them (see `cqrs/commands.ts`'s
 *  audited-operation handler and `workflow-emit.ts`'s inline audited op-call);
 *  an emitter with a single projection lets `projectEntityArgs` default one.
 *  Names are handed out in field order, so output stays deterministic. */
export interface MaskNamer {
  /** The next unused pattern-variable name in this scope. */
  next(): string;
}

/** A fresh `MaskNamer` — one per C# scope that renders masked projections. */
export function maskNamer(): MaskNamer {
  let n = 0;
  return {
    next: () => `__maskUser${n++}`,
  };
}

/** Wrap a masked field's projected value in a fail-closed read redaction
 *  (`mask unless`, authorization.md §5): the value is shown only when the
 *  caller's ambient principal satisfies the predicate, else `null`.  Reads the
 *  request-scoped principal via `RequestContext.Current` (the same ambient
 *  accessor the read-side filter uses — no DI threading), so an unauthenticated
 *  request (`CurrentUser` null) redacts.  `wf.maskUnless` absent ⇒ unchanged.
 *  The pattern variable is drawn from `names` — see `MaskNamer` for why it
 *  cannot be a fixed identifier. */
function maskWrap(
  valueExpr: string,
  wf: WireField,
  ctx: EnrichedBoundedContextIR,
  names: MaskNamer,
): string {
  if (!wf.maskUnless) return valueExpr;
  let t = wireType(wf.type, ctx, "response");
  if (!t.endsWith("?")) t = `${t}?`;
  const maskUser = names.next();
  const pred = renderCsExpr(wf.maskUnless, { thisName: "this", currentUserExpr: maskUser });
  return `(RequestContext.Current?.CurrentUser is { } ${maskUser} && (${pred})) ? (${t})(${valueExpr}) : null`;
}

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
  // Passive wire-only leaf — the shared FileRef reference record
  // (bytes live in object storage; the DTO carries only the reference).
  File: "FileRef",
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
      // A plain `decimal` leaves the .NET wire as a `double` (#2563).  RS-24
      // fixes it as a JSON NUMBER, and the other four backends all carry that
      // number through an IEEE-754 double — node `Number(...)`, python
      // `float(...)`, java's provider `Double`, elixir `Decimal.to_float` — so
      // a value needing more than `System.Decimal`'s ~15 significant digits
      // (any non-terminating `avg`) serialized differently on .NET alone:
      // `2.33333333333333` against everyone else's `2.3333333333333335`.
      //
      // RESPONSE only.  On the REQUEST side `decimal` stays `decimal`: a
      // `double` field would accept a JSON number outside decimal's range and
      // then throw `OverflowException` converting it to the domain type — a 500
      // where the current parse gives a 400.  The asymmetry costs nothing on
      // the wire, since a client may send more precision than it reads back
      // (which is already true of every other backend).
      s =
        dir === "response" && info.primitive === "decimal"
          ? "double"
          : CS_WIRE_PRIMITIVE[info.primitive!];
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
    case "provenanced":
      // `Provenanced<int> Total` — the shared generic record from
      // Domain.Common (see `renderProvLineage`).  The carried type recurses
      // through this same function, so a `Money provenanced` lands as
      // `Provenanced<string>` exactly as the bare money field would.
      s = `${PROVENANCED_CS_RECORD}<${wireType(info.carried!, ctx, dir)}>`;
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
 *  Exception: a non-nullable `bool` in a CREATE request is NOT required.
 *  ASP.NET model-binding defaults an omitted bool to `false` (no error), and
 *  Hono's create slot spells the same rule explicitly as
 *  `z.boolean().default(false)`; both backends accept the field's omission,
 *  so neither marks it required.  Numbers differ — `z.coerce.number()`
 *  rejects `undefined`, so numeric request fields stay required on both
 *  sides.  This is a CREATE-slot exception only (`slot`, below): on an
 *  operation body an omitted bool is a client error (RS-26), which is why
 *  Hono's body slot is an UNCOERCED `z.boolean()` — `z.coerce.boolean()`
 *  is `Boolean(input)` and would accept `undefined` as `false`. */
export function dtoParam(
  csType: string,
  name: string,
  dir: "request" | "response" = "response",
  /** Rendered C# literal for an explicitly-defaulted request field.  When
   *  present the parameter becomes optional via a record default value
   *  (`Type Name = <lit>`) and carries no `[Required]` — STJ applies the
   *  default when the field is omitted, dropping it from the required-set. */
  defaultLiteral?: string,
  /** Which request slot this DTO is.  `create` keeps the implicit-bool
   *  optionality (RS-6); `operation` requires every declared param (RS-26). */
  slot: "create" | "operation" = "create",
  /** True when this member is a VALUE TYPE on the wire ({@link isWireValueType}).
   *  Such a member needs `[property: JsonRequired]` in EVERY request slot, not
   *  just `operation` — see below. */
  wireValueType = false,
): string {
  if (defaultLiteral !== undefined && dir === "request") {
    return `${csType} ${name} = ${defaultLiteral}`;
  }
  const optionalBoolRequest = dir === "request" && csType === "bool" && slot === "create";
  const required = !csType.endsWith("?") && !optionalBoolRequest;
  if (!required) return `${csType} ${name}`;
  // RS-26 on an OPERATION body: `[Required]` alone cannot reject an omitted
  // VALUE TYPE.  RequiredAttribute tests for null, and a missing `int qty` /
  // `bool active` binds to the CLR default (0/false) — non-null, so validation
  // passes and the update silently overwrites stored state with a zero value.
  // `[property: JsonRequired]` moves the check to deserialization, where the
  // question is "was the MEMBER present", which is the one actually being
  // asked.  Deliberately not applied to create bodies: there an omitted field
  // is legitimately absent (RS-6 / a declared `= default`), and adding it would
  // change the create contract this rule is not about.
  // Emitted ALONGSIDE `[Required]`, not instead of it: the two answer different
  // questions.  JsonRequired asks "was the member present"; Required asks "is
  // the bound value null".  Dropping Required here would let an explicit
  // `"name": null` reach the domain, which it does not today.
  //
  // The same hole exists in EVERY request slot, not only `operation` — the
  // exemption above is about an omitted field being legitimately absent, which
  // is a statement about the CREATE CONTRACT, not about whether `[Required]`
  // can see the absence. It cannot, for any value type, anywhere.
  //
  // Measured on a booted .NET app (`POST /api/widgets`, every one of these
  // marked `required` in the published schema):
  //
  //     omit name  (string)          422   ← reference type, [Required] sees null
  //     omit price (record)          422   ← reference type
  //     omit qty   (int)             201   ← VALUE TYPE, bound to 0
  //     omit ratio (decimal)         201   ← VALUE TYPE, bound to 0
  //     omit price.amount (decimal)  201   ← VALUE TYPE, bound to 0
  //     omit active (bool)           201   ← correct: RS-6 keeps it OPTIONAL,
  //                                          and the schema agrees (not in
  //                                          `required`), so nothing is claimed
  //                                          that is not enforced.
  //
  // A zero-priced product / a zero-quantity widget is written from a body the
  // published contract forbids (schemathesis F30). So the guard follows the
  // question it answers — "can `[Required]` see this absence?" — rather than
  // the slot. Reference-typed members are deliberately NOT given it: their
  // `[Required]` already answers 422, and adding JsonRequired would move them
  // to the 400 arm.
  const jsonRequired =
    dir === "request" && (slot === "operation" || wireValueType) ? "[property: JsonRequired] " : "";
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
    jsonRequired +
    (dir === "request"
      ? csType === "string"
        ? "[Required(AllowEmptyStrings = true)] "
        : "[Required] "
      : "[property: Required] ");
  return `${attr}${csType} ${name}`;
}

/** How a wire→command conversion reports a MALFORMED value (M-T6.48).
 *
 *  `money` and `datetime` cross the wire as strings and used to be parsed with
 *  a bare `decimal.Parse` / `DateTime.Parse`.  `{"price": "12,50"}` therefore
 *  threw `FormatException`, which no `DomainExceptionFilter` arm catches — the
 *  caller got a **500** for input the server itself rejected, while node
 *  answered 422 with `errors: [{ pointer, message }]` from `moneySchema`.
 *
 *  Both halves are needed at the leaf: `ns` to name the exception the filter
 *  matches (`Domain.Common` is only conditionally imported by the controller,
 *  so the throw is fully qualified), and `pointer` to say WHICH field was
 *  malformed — the same RFC-6901 pointer node's zod issue carries. */
export interface WireArgSite {
  /** Project root namespace. */
  readonly ns: string;
  /** RFC-6901 pointer to the offending wire field, e.g. `/newPrice`. */
  readonly pointer: string;
}

/** A C# expression that parses `expr` or throws a typed 422.
 *
 *  `throw` is an expression in C# 7+, and `out var` in an argument position
 *  declares into the enclosing block, so the whole guard fits where the bare
 *  `Parse(...)` used to sit — no statement hoisting, no emitter restructuring:
 *
 *      decimal.TryParse(request.NewPrice, NumberStyles.Number,
 *          CultureInfo.InvariantCulture, out var __wp_request_NewPrice)
 *        ? __wp_request_NewPrice
 *        : throw new global::D.Domain.Common.WireFormatException(
 *            "/newPrice", "Invalid decimal: \"12,50\"")
 *
 *  The out-variable name is derived from `expr`, so two fields in one argument
 *  list never collide and the same field twice would be the same declaration
 *  (which cannot happen — one wire field maps to one command argument).
 *  A collection element parses inside its own `.Select(__e => …)` lambda, whose
 *  body is its own scope.
 *
 *  `label` mirrors the noun node's Zod issue uses (`Invalid decimal: "…"`), so
 *  the two backends' `errors[].message` read identically. */
function wireParseGuard(
  expr: string,
  site: WireArgSite,
  label: string,
  tryParse: (outVar: string) => string,
): string {
  const outVar = `__wp_${expr.replace(/[^A-Za-z0-9]/g, "_")}`;
  // Interpolated so the message quotes the value the caller actually sent.
  // `{{` / `}}` are not needed: the only interpolation hole is the raw value.
  const message = `$"Invalid ${label}: \\"{${expr}}\\""`;
  return (
    `${tryParse(outVar)}\n                ? ${outVar}\n                : throw new global::${site.ns}` +
    `.Domain.Common.WireFormatException(${JSON.stringify(site.pointer)}, ${message})`
  );
}

/** Map a wire-shaped expression to a domain-typed argument for a command. */
export function wireToCommandArgument(
  expr: string,
  t: TypeIR,
  ctx: EnrichedBoundedContextIR,
  /** Where this value came from on the wire — see {@link WireArgSite}.
   *  Required: an omitted site is a bare parse, i.e. a 500 on bad input. */
  site: WireArgSite,
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
    const unwrap = isWireValueType(innerT) ? `${expr}!.Value` : `${expr}!`;
    return `(${expr} is null ? null : ${wireToCommandArgument(unwrap, innerT, ctx, site)})`;
  }
  if (info.isCollection) {
    return `${expr}.Select(__e => ${wireToCommandArgument("__e", peelCollection(t), ctx, site)}).ToList()`;
  }
  switch (info.refKind) {
    case "primitive":
      if (info.primitive === "datetime") {
        // Wire is a string; coerce to UTC DateTime regardless of whether
        // the caller sent a Z-suffixed value or a naive datetime-local
        // string.  CultureInfo + DateTimeStyles live in
        // System.Globalization, outside the SDK's implicit-usings set
        // (declared via collectWireUsings on the emitter side).
        //
        // TryParse, not Parse: a malformed value is the CALLER's error, so it
        // becomes a typed 422 (see `wireParseGuard`), not an uncaught
        // FormatException the filter renders as 500.
        return wireParseGuard(
          expr,
          site,
          "datetime",
          (out) =>
            `DateTime.TryParse(${expr}, CultureInfo.InvariantCulture, ` +
            `DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var ${out})`,
        );
      }
      if (info.primitive === "money") {
        // Wire string → System.Decimal.  InvariantCulture so a locale's
        // comma-vs-dot doesn't flip the parse — and TryParse so `"12,50"`
        // answers 422 like node's `moneySchema` instead of 500 (M-T6.48).
        return wireParseGuard(
          expr,
          site,
          "decimal",
          (out) =>
            `decimal.TryParse(${expr}, NumberStyles.Number, CultureInfo.InvariantCulture, ` +
            `out var ${out})`,
        );
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
        .map((f) =>
          wireToCommandArgument(`${expr}.${upperFirst(f.name)}`, f.type, ctx, {
            ...site,
            pointer: `${site.pointer}/${f.name}`,
          }),
        )
        .join(", ");
      return `new ${info.base}(${args})`;
    }
    case "entity":
      return expr;
    case "provenanced":
      throw new Error(PROVENANCED_REQUEST_ERROR);
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
      // `CultureInfo` + `DateTimeStyles` + `NumberStyles` all live here.  The
      // `WireFormatException` the guard throws is fully qualified at the call
      // site, so it needs no using of its own — `Domain.Common` is only
      // conditionally imported by the controller.
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

/** Project a domain expression to its wire-shape Response.  `names` is the
 *  enclosing scope's mask-variable allocator, threaded so an entity nested in
 *  the projected value gets collision-free pattern variables (see
 *  `MaskNamer`); omitted, a scope-local one is allocated on demand. */
export function projectToResponse(
  domainExpr: string,
  t: TypeIR,
  ctx: EnrichedBoundedContextIR,
  names?: MaskNamer,
): string {
  const info = wireTypeInfo(t, "response");
  if (info.isNullable) {
    // C# doesn't narrow `T?` to `T` after `is null` test; unwrap
    // explicitly: value types use `.Value`, reference types use `!`.
    const innerT = peelNullable(t);
    const unwrap = csIsValueType(innerT) ? `${domainExpr}.Value` : `${domainExpr}!`;
    return `(${domainExpr} is null ? null : ${projectToResponse(unwrap, innerT, ctx, names)})`;
  }
  if (info.isCollection) {
    return `${domainExpr}.Select(__e => ${projectToResponse("__e", peelCollection(t), ctx, names)}).ToList()`;
  }
  switch (info.refKind) {
    case "primitive":
      if (info.primitive === "datetime") {
        // Canonical ISO-8601 UTC with Z suffix — matches Hono/Python/Java so
        // clients see one shape (RS-4).  See `csCanonicalInstantWire`.
        return csCanonicalInstantWire(domainExpr);
      }
      if (info.primitive === "money") {
        // System.Decimal → wire string at the FIXED money scale (RS-12): the
        // bare `.ToString()` echoes the value's own scale (`12.5` vs `12.50`),
        // so format to the canonical `NUMERIC(19,4)` scale for a wire value
        // byte-consistent with the other backends.  InvariantCulture pins the
        // decimal separator.  (`CS_NUMERIC.money["dto-map"]`, `_numeric/
        // target.ts` — M-T9.36.)
        return numericEncode(CS_NUMERIC, "money", "dto-map", domainExpr);
      }
      if (info.primitive === "decimal") {
        // The domain keeps `System.Decimal`; the RESPONSE field is a `double`
        // (#2563 — see `wireType`), so the narrowing happens here, once, at the
        // wire boundary.  It must be CORRECTLY ROUNDED — a `(double)` cast is
        // not (F10/M-T6.47); see `csDecimalToWireDouble` (`./numeric-codec.js`).
        // Reading the column as `double` at the provider seam (#2631's fix for
        // the dapper aggregate) is not available here: the DOMAIN property has
        // to stay `System.Decimal` for domain arithmetic, so the narrowing
        // belongs at the wire boundary, once.
        return numericEncode(CS_NUMERIC, "decimal", "dto-map", domainExpr);
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
        .map((f) => projectToResponse(`${domainExpr}.${upperFirst(f.name)}`, f.type, ctx, names))
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
      return projectEntityExpr(domainExpr, part.part, ctx, { maskNames: names });
    }
    case "provenanced": {
      // Fold the domain's two co-located members into the one wire carrier.
      // `domainExpr` is the VALUE property (`found.Total`); its lineage sibling
      // is named by the same rule the entity emitter declared it with.
      const value = projectToResponse(domainExpr, info.carried!, ctx, names);
      return `new ${PROVENANCED_CS_RECORD}<${wireType(info.carried!, ctx, "response")}>(${value}, ${csProvSibling(domainExpr)})`;
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
    case "provenanced":
      throw new Error(PROVENANCED_REQUEST_ERROR);
  }
}

/** True when `t` lowers to a C# value type — `T?` is `Nullable<T>` and
 *  must be unwrapped with `.Value` before any method call.  `string`
 *  and `List<T>` are reference types; everything else (primitives, ids,
 *  enums) is a value type. */
/** Is this type a VALUE TYPE **on the wire** — i.e. as it appears on a request
 *  DTO member?
 *
 *  Distinct from {@link csIsValueType}, which asks about the DOMAIN
 *  representation: `money` and `datetime` are `decimal` / `DateTime` in the
 *  domain but cross the wire as STRINGS, so their DTO members are reference
 *  types. `File` crosses as the `FileRef` record for the same reason.
 *
 *  Two consumers, and they must agree:
 *    • `wireToCommandArgument` — a nullable wire value type unwraps `.Value`,
 *      a reference one unwraps `!`.
 *    • `dtoParam` — a REQUIRED wire value type needs `[property: JsonRequired]`,
 *      because `[Required]` alone cannot see its absence (below). */
export function isWireValueType(t: TypeIR): boolean {
  const info = wireTypeInfo(t, "request");
  if (info.isCollection || info.isNullable) return false;
  return (
    info.refKind === "id" ||
    info.refKind === "enum" ||
    (info.refKind === "primitive" &&
      info.primitive !== "string" &&
      info.primitive !== "money" &&
      info.primitive !== "datetime" &&
      info.primitive !== "File")
  );
}

function csIsValueType(t: TypeIR): boolean {
  const info = wireTypeInfo(t, "response");
  if (info.isCollection) return false;
  switch (info.refKind) {
    case "primitive":
      // The question is about the DOMAIN representation, not the wire one:
      // `money` and `datetime` render as wire strings but ARE `decimal` /
      // `DateTime` in the domain, so `T?` is a `Nullable<T>` and `.Value`
      // unwraps it. Two Loom primitives are reference types on the domain side
      // and must be unwrapped with `!` instead:
      //   • `string`
      //   • `File` — the shared `FileRef` RECORD (see the CS_PRIMITIVE map
      //     above). An optional `File?` field projected `.Value` on it, which
      //     is CS1061; no fixture had a nullable `File` until `file-download`
      //     (M-T6.39), so no compile tier had ever reached this arm.
      return info.primitive !== "string" && info.primitive !== "File";
    case "id":
    case "enum":
      return true;
    case "valueObject":
    case "entity":
    // The carrier is a `record` (a reference type), so `T?` is a plain
    // nullable reference — no `.Value` unwrap.
    case "provenanced":
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
  opts?: {
    unionVariant?: boolean;
    /** The enclosing C# SCOPE's mask-variable allocator.  Pass one shared namer
     *  when a single method body renders more than one projection (an `audited`
     *  operation's before/after snapshots); omit it and this projection gets a
     *  private one.  See `MaskNamer`. */
    maskNames?: MaskNamer;
    /** Project the raw value for every `mask unless` field instead of the
     *  redacting wrap (M-T3.9).
     *
     *  `maskWrap` reads the REQUEST's principal, so a projection that feeds the
     *  AUDIT TRAIL recorded whatever the writer happened to be allowed to see:
     *  the same operation, run by two actors, wrote two different `before` /
     *  `after` snapshots, and the one written by the less-privileged actor
     *  recorded `null` for the very field the audit exists to evidence.  An
     *  audit record is not an API read — it is never returned to the actor who
     *  produced it — so it projects unmasked.  NOT for any wire path. */
    unmasked?: boolean;
  },
): string {
  // `wireFieldsFor` recomputes the wire shape from the enriched node's fields.
  // Each wire field maps to one positional argument on `new <Ent>Response(...)`,
  // in the same order the Hono / React Zod schemas emit.  A runtime projection
  // reads DOMAIN getters by name, so it stays keyed to the domain-derived wire
  // shape (not a hand-diverged contract record).  `forApiRead` strips `internal`
  // and `secret` fields.
  const fields = forApiRead(wireFieldsFor(entity));
  const names = opts?.maskNames ?? maskNamer();
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
      // The nested projection shares this scope's namer.  A C# lambda body is
      // not an escape hatch (shadowing an enclosing local is CS0136), so were a
      // contained part ever to carry a mask it must not reuse an outer name.
      const nested = { maskNames: names, ...(opts?.unmasked ? { unmasked: true } : {}) };
      args.push(
        wireTypeInfo(wf.type, "response").isCollection
          ? `${accessor}.Select(__e => ${projectEntityExpr("__e", part, ctx, nested)}).ToList()`
          : single && wf.optional
            ? `${accessor} is null ? null : ${projectEntityExpr(accessor, part, ctx, nested)}`
            : projectEntityExpr(accessor, part, ctx, nested),
      );
    } else {
      const projected = projectToResponse(
        `${domainExpr}.${upperFirst(wf.name)}`,
        wf.type,
        ctx,
        names,
      );
      // The record's parameter for a masked field is already nullable, so the
      // unmasked (non-null) value fits it without a cast.
      args.push(opts?.unmasked ? projected : maskWrap(projected, wf, ctx, names));
    }
  }
  // (M-T6.12) No trailing `<Field>Provenance` args any more: the lineage rides
  // inside the provenanced field's own `Provenanced<T>` argument, folded by
  // `projectToResponse`'s `provenanced` arm.
  return args.join(", ");
}

export function projectEntityExpr(
  domainExpr: string,
  entity: EnrichedAggregateIR | EnrichedEntityPartIR,
  ctx: EnrichedBoundedContextIR,
  opts?: { unionVariant?: boolean; maskNames?: MaskNamer; unmasked?: boolean },
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
  // A declared record names DOMAIN types (`total: int`), so a field the
  // aggregate declares `provenanced` is wrapped in the wire carrier here — the
  // same wrap `wireTypeForField` applies on the wireShape path, so the record's
  // params still line up with `projectEntityArgs`'s carrier argument.
  const provenanced = new Set(agg.fields.filter((f) => f.provenanced).map((f) => f.name));
  for (const f of payload.fields) {
    const t: TypeIR = provenanced.has(f.name)
      ? { kind: "genericInstance", ctor: "provenanced", arg: f.type }
      : f.type;
    parts.push(dtoParam(payloadFieldCsType(t, ctx), upperFirst(f.name)));
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
      // A `mask unless` field is redacted to null for callers who fail the
      // predicate (see `maskWrap`), so its response param must be nullable.
      if ((wf.optional || wf.maskUnless) && !csType.endsWith("?")) csType = `${csType}?`;
      parts.push(dtoParam(csType, upperFirst(wf.name)));
    }
  }
  // (M-T6.12) No trailing `<Field>Provenance` param any more: the provenanced
  // field's own param is `Provenanced<T>`, carrying the lineage with the value.
  return parts.join(", ");
}

/** True iff the entity exposes any provenanced field on its response — so the
 *  DTO's `Provenanced<T>` component (and its `ProvLineage` member) need
 *  `using <ns>.Domain.Common;`. */
export function entityExposesProvenance(ent: { fields: FieldIR[] }): boolean {
  return ent.fields.some((f) => f.provenanced);
}

/**
 * True iff PROJECTING this aggregate to its response DTO emits an expression
 * that NAMES a type from `<ns>.Domain.Common` — so every emitter that inlines
 * `projectEntityExpr` / `projectToResponse` into a file must add that using or
 * the file fails to compile.
 *
 * Two triggers, and they are different from the DTO's own
 * (`entityExposesProvenance`) because a projection can name a Common type the
 * record declaration doesn't, and vice versa:
 *
 *   - `mask unless` — `maskWrap` reads `RequestContext.Current`.
 *   - `provenanced` — the projection CONSTRUCTS the carrier,
 *     `new Provenanced<int>(found.Total, found.TotalProvenance)` (M-T6.12).
 *     Before the carrier this arm was a bare property read
 *     (`found.TotalProvenance`), which named no type and so needed no using —
 *     which is exactly why every read handler over a provenanced aggregate
 *     started failing `CS0246: The type or namespace name 'Provenanced<>'
 *     could not be found`.
 */
export function projectionNamesDomainCommon(agg: EnrichedAggregateIR): boolean {
  return (
    agg.fields.some((f) => f.maskUnless) ||
    entityExposesProvenance(agg) ||
    agg.parts.some((p) => entityExposesProvenance(p))
  );
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
