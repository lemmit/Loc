// ---------------------------------------------------------------------------
// Centralised TypeIR → wire-type information.
//
// Four backends (Hono / .NET / React / Phoenix-LiveView) emit DTO fields
// that translate between the platform-neutral `WireField.type` (a
// `TypeIR`) and a per-platform string shape.  Before this helper landed,
// each backend carried its own exhaustive `switch (t.kind)` over
// `TypeIR.kind` — ~400 LOC of parallel code.  When PR #517 missed a
// `Form` variant in one place, the fix had to land in four files.
//
// The contract here collapses the *structural* dispatch into one function
// (`wireTypeInfo`) plus small structural accessors (`peelNullable`,
// `peelCollection`).  Each backend's residual code becomes the *string
// emission* for each canonical wire shape — no `switch (t.kind)` at the
// call site.
//
// Scope: this file owns the kind-discrimination of `TypeIR`.  Per-platform
// string emission (e.g. .NET `IReadOnlyList<X>` vs TS `X[]`) and
// expression construction (e.g. wrapping a wire string in
// `new XId(...)`) stay in the backend — they consume `WireTypeInfo` and
// dispatch on its `refKind` / `primitive` / collection / nullable flags.
//
// Notes on intentional divergences preserved from the legacy code:
//   - .NET `wireType` emits id as `Guid` regardless of the source id's
//     `valueType`.  The OpenAPI emitter, in contrast, does honour
//     `valueType` for path-param schemas.  Both behaviours are kept;
//     `WireTypeInfo` exposes `idValueType` so callers can choose.
//   - Hono / React `zod` request emission lowers `entity` to
//     `z.unknown()` whereas response emission lowers it to
//     `<Name>Response`.  Both directions are reflected via the `dir`
//     argument and `refKind` discrimination; the backend handles the
//     direction-specific string.
//   - The IR canonicalises `T?[]` as `optional(array(T))` (lower-expr.ts
//     applies array first, optional outermost).  `wireTypeInfo` peels
//     in the opposite order and assumes that canonical shape.  If the
//     lower phase ever emits `array(optional(T))`, this helper will
//     still surface the same leaf, but the nullable-of-element marker
//     will be lost.  No source today exercises that path.
// ---------------------------------------------------------------------------

import type { IdValueType, TypeIR } from "./loom-ir.js";

/** Which side of the wire contract a field appears on.  `request`
 *  selects the input/create shape (e.g. nested value objects emit as
 *  `<Vo>Request` in .NET); `response` selects the output shape
 *  (`<Vo>Response`). */
export type WireDirection = "request" | "response";

/** Canonical wire-primitive identifiers.  Loom's `TypeIR.primitive`
 *  variants map onto these with no extra distinctions; backends
 *  re-spell these names per their own type system (.NET `int`,
 *  TS `number`, OpenAPI `:integer`, …).
 *
 *  Note: the IR's source-level `money` primitive is preserved as
 *  `"money"` here rather than collapsed to `"decimal"` — backends
 *  treat it as a decimal-on-the-wire-but-string-in-JSON contract
 *  (see `.loom/wire-spec.json`) and need the discriminator. */
export type WirePrimitive =
  | "string"
  | "int"
  | "long"
  | "decimal"
  | "money"
  | "bool"
  | "datetime"
  | "guid"
  | "json";

/** Category of the leaf type referenced.  `primitive`/`id` carry their
 *  full info on `WireTypeInfo` (`primitive`, `idTarget`, `idValueType`);
 *  `valueObject`/`entity`/`enum` indicate a user-defined name that the
 *  backend will join with its own suffix (`Request`, `Response`,
 *  `Schema`, …). */
export type WireRefKind = "primitive" | "id" | "valueObject" | "entity" | "enum";

/** Single-leaf summary of a `TypeIR` for wire-shape emission.
 *
 *  `isCollection` / `isNullable` capture the canonical outer wrappers
 *  (`array(...)` / `optional(...)`); the leaf's full identity is on
 *  `base` + the typed discriminator fields.  See `wireTypeInfo` for
 *  the exact peeling order. */
export interface WireTypeInfo {
  /** Platform-neutral name of the leaf type.
   *
   *  Primitives use their `PrimitiveName` ("string", "int", …); ids
   *  surface the aggregate name (`idTarget`); refs surface the
   *  user-defined name (vo / entity / enum).  Disambiguate against
   *  `refKind` — a primitive `string` and an enum literally named
   *  `string` would share `base` but differ in `refKind`. */
  base: string;
  /** Discriminator for `base`.  `primitive` and `id` carry extra
   *  info on `WireTypeInfo`; the others are pure names. */
  refKind: WireRefKind;
  /** True iff the canonical outer shape is `array(...)` (after peeling
   *  one nullable wrapper, if present). */
  isCollection: boolean;
  /** True iff the canonical outer shape is `optional(...)`. */
  isNullable: boolean;
  /** Populated iff `refKind === "primitive"`.  The wire-primitive
   *  variant of the leaf. */
  primitive?: WirePrimitive;
  /** Populated iff `refKind === "id"`.  The name of the aggregate the
   *  id targets (caller pairs this with its own suffix, e.g. `${idTarget}Id`). */
  idTarget?: string;
  /** Populated iff `refKind === "id"`.  The underlying value type
   *  (`guid` / `int` / `long` / `string`).  Used by the OpenAPI
   *  emitter for path-param schemas; the .NET wire helper deliberately
   *  ignores it (every id crosses the .NET wire as Guid for historical
   *  symmetry with the Hono path). */
  idValueType?: IdValueType;
  /** Direction that produced this info — preserved so callers that
   *  build secondary expression strings (e.g. nested DTO names) can
   *  echo it without re-threading the argument. */
  dir: WireDirection;
}

/** Strip one layer of `optional(...)`.  Returns the inner type; leaves
 *  non-optional types untouched.  Use this to recurse expression
 *  walkers into a nullable's content without dispatching on `t.kind`
 *  at the call site. */
export function peelNullable(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

/** Strip one layer of `array(...)`.  Returns the element type; leaves
 *  non-array types untouched.  Use this to recurse expression walkers
 *  into a collection's element. */
export function peelCollection(t: TypeIR): TypeIR {
  return t.kind === "array" ? t.element : t;
}

/** True iff the (single) outer wrapper is `optional(...)`.  Provided
 *  so callers can branch without inspecting `t.kind` directly. */
export function isNullable(t: TypeIR): boolean {
  return t.kind === "optional";
}

/** True iff the (post-nullable) outer wrapper is `array(...)`. */
export function isCollection(t: TypeIR): boolean {
  return peelNullable(t).kind === "array";
}

/** Single, exhaustive dispatch over `TypeIR.kind`.  Peels one
 *  optional then one array layer (the canonical lower-expr ordering)
 *  and classifies the leaf.
 *
 *  `dir` is echoed onto the returned info so backends that build
 *  multi-name DTOs (e.g. `<Vo>Request` vs `<Vo>Response`) can choose
 *  the suffix without re-threading the argument through their own
 *  recursion. */
export function wireTypeInfo(t: TypeIR, dir: WireDirection): WireTypeInfo {
  // Peel optional first (the IR canonicalises `T?[]` as
  // `optional(array(T))` — see `lowerType` in src/ir/lower-expr.ts).
  let cur = t;
  let nullable = false;
  if (cur.kind === "optional") {
    nullable = true;
    cur = cur.inner;
  }
  let collection = false;
  if (cur.kind === "array") {
    collection = true;
    cur = cur.element;
  }
  // Element of an array may itself be nullable in some hand-built IR
  // (not in source today, but defend against it so we don't lose the
  // marker silently).  Element nullability folds into the outer
  // `isNullable` — backends treat `T?[]` and `T[]?` identically on
  // the wire (both are "nullable list of T").
  if (cur.kind === "optional") {
    nullable = true;
    cur = cur.inner;
  }

  switch (cur.kind) {
    case "primitive":
      // A5: `duration` is expression-only (not in the grammar's type rule),
      // so it can never appear in a wire position — `WirePrimitive`
      // deliberately excludes it.
      if (cur.name === "duration") {
        throw new Error("internal: 'duration' is expression-only and never reaches the wire");
      }
      return {
        base: cur.name,
        refKind: "primitive",
        isCollection: collection,
        isNullable: nullable,
        primitive: cur.name,
        dir,
      };
    case "id":
      return {
        base: cur.targetName,
        refKind: "id",
        isCollection: collection,
        isNullable: nullable,
        idTarget: cur.targetName,
        idValueType: cur.valueType,
        dir,
      };
    case "enum":
      return {
        base: cur.name,
        refKind: "enum",
        isCollection: collection,
        isNullable: nullable,
        dir,
      };
    case "valueobject":
      return {
        base: cur.name,
        refKind: "valueObject",
        isCollection: collection,
        isNullable: nullable,
        dir,
      };
    case "entity":
      return {
        base: cur.name,
        refKind: "entity",
        isCollection: collection,
        isNullable: nullable,
        dir,
      };
    // The two wrapper kinds are handled by the peeling above.  After
    // peeling at most one optional + one array + one optional, the
    // only way to land here is a malformed (deeply-nested) TypeIR.
    // Treat as opaque string so we don't silently lose information.
    case "array":
    case "optional":
      return {
        base: "unknown",
        refKind: "primitive",
        isCollection: collection,
        isNullable: nullable,
        primitive: "string",
        dir,
      };
    case "action":
    case "slot":
      throw new Error("wireTypeInfo: 'slot' type is UI-only and has no wire representation.");
    case "genericInstance":
      throw new Error(
        `wireTypeInfo: generic carrier '${cur.ctor}' is not emittable yet (P3b); IR-validate should have rejected it.`,
      );
    case "union":
    case "none":
      throw new Error(
        `wireTypeInfo: discriminated unions are not emittable yet (payload-transport-layer.md, P4); IR-validate should have rejected '${cur.kind}'.`,
      );
  }
}
