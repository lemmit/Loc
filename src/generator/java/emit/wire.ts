import type { TypeIR } from "../../../ir/types/loom-ir.js";
import { MONEY_WIRE_SCALE } from "../../money-scale.js";
import { javaValueTypeForId } from "../render-expr.js";
import { JAVA_PROVENANCED_RECORD } from "./provenance.js";

// ---------------------------------------------------------------------------
// Wire-type mapping for the Java DTO layer.  The cross-backend wire
// contract (see the dotnet Requests/Responses emitters):
//
//   money    → STRING on the wire (precise-decimal string; parsed with
//              `new BigDecimal(s)` inbound, `toPlainString()` outbound)
//   datetime → STRING (ISO-8601; `Instant.parse` / `toString`)
//   id       → the bare id value (uuid string / int / long)
//   enum     → the enum (serialises by name — DSL casing IS the wire)
//   VO       → nested `<Vo>Request` / `<Vo>Response` record
//
// DTOs are records, so component order is declaration order — the
// emitters declare them in wireShape order and Jackson preserves it.
// ---------------------------------------------------------------------------

export type WireDir = "Request" | "Response";

/** The Java type a domain type takes inside a request/response record. */
export function wireJavaType(t: TypeIR, dir: WireDir, boxed = false): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
          return boxed ? "Integer" : "int";
        case "long":
          return boxed ? "Long" : "long";
        case "bool":
          return boxed ? "Boolean" : "boolean";
        case "decimal":
          return "BigDecimal";
        case "money":
        case "datetime":
          return "String";
        case "string":
          return "String";
        case "guid":
          return "UUID";
        case "json":
          return "JsonNode";
        case "File":
          // Passive wire-only leaf — the shared FileRef record is both the
          // domain and the wire shape, so no conversion (M-T1.2).
          return "FileRef";
      }
      return "Object";
    case "id":
      return javaValueTypeForId(t.valueType);
    case "enum":
      return t.name;
    case "valueobject":
      return `${t.name}${dir}`;
    case "entity":
      // Containments carry the part's response record.
      return `${t.name}Response`;
    case "array":
      return `List<${wireJavaType(t.element, dir, true)}>`;
    case "optional":
      return wireJavaType(t.inner, dir, true);
    case "genericInstance":
      // `Provenanced<Integer>` (M-T6.12).  The carried type is BOXED — a Java
      // generic argument cannot be a primitive — which is also why the value
      // keeps its identity in the published schema instead of collapsing to
      // the `Object` the default arm would have produced.
      if (t.ctor === "provenanced") {
        return `${JAVA_PROVENANCED_RECORD}<${wireJavaType(t.arg, dir, true)}>`;
      }
      return "Object";
    default:
      return "Object";
  }
}

/** Imports the wire type needs (java.* only; generated records are
 *  package-local or wildcard-imported). */
export function collectWireImports(t: TypeIR, into: Set<string>): Set<string> {
  switch (t.kind) {
    case "primitive":
      if (t.name === "decimal") into.add("java.math.BigDecimal");
      if (t.name === "guid") into.add("java.util.UUID");
      if (t.name === "json") into.add("tools.jackson.databind.JsonNode");
      return into;
    case "id":
      if (t.valueType === "guid") into.add("java.util.UUID");
      return into;
    case "array":
      into.add("java.util.List");
      return collectWireImports(t.element, into);
    case "optional":
      return collectWireImports(t.inner, into);
    case "genericInstance":
      // The carrier itself is a generated `domain.common` record — imported by
      // the DTO emitter, which knows the base package.  Only its ARGUMENT can
      // pull in a java.* import.
      return collectWireImports(t.arg, into);
    default:
      return into;
  }
}

/** Expression converting a DOMAIN value (`expr`, already a typed Java
 *  expression) to its wire form for a response record. */
export function domainToWire(t: TypeIR, expr: string): string {
  switch (t.kind) {
    case "primitive":
      // money → wire string at the FIXED money scale (RS-12): bare
      // `toPlainString()` echoes the value's own scale (`12.5` vs `12.50`), so
      // pin it to the canonical `NUMERIC(19,4)` scale for a wire value
      // byte-consistent with the other backends.
      if (t.name === "money")
        return `${expr}.setScale(${MONEY_WIRE_SCALE}, java.math.RoundingMode.HALF_UP).toPlainString()`;
      if (t.name === "datetime") return `${expr}.toString()`;
      return expr;
    case "id":
      return `${expr}.value()`;
    case "valueobject":
      return `${t.name}Response.from(${expr})`;
    case "entity":
      // Single containments start null (created empty, filled by an op).
      return `${expr} == null ? null : ${t.name}Response.from(${expr})`;
    case "array": {
      const mapped = elementMapper(t.element);
      return mapped ? `${expr}.stream().map(${mapped}).toList()` : expr;
    }
    case "optional": {
      const inner = domainToWire(t.inner, "__v");
      if (inner === "__v") return expr;
      return `${expr} == null ? null : ${domainToWire(t.inner, `(${expr})`)}`;
    }
    default:
      return expr;
  }
}

function elementMapper(element: TypeIR): string | null {
  switch (element.kind) {
    case "primitive":
      if (element.name === "money")
        return `__x -> __x.setScale(${MONEY_WIRE_SCALE}, java.math.RoundingMode.HALF_UP).toPlainString()`;
      if (element.name === "datetime") return "__x -> __x.toString()";
      return null;
    case "id":
      return "__x -> __x.value()";
    case "valueobject":
      return `${element.name}Response::from`;
    case "entity":
      return `${element.name}Response::from`;
    default:
      return null;
  }
}

/** Expression converting a WIRE value (`expr`, a request-record read) to
 *  its domain form. */
export function wireToDomain(t: TypeIR, expr: string): string {
  switch (t.kind) {
    case "primitive":
      if (t.name === "money") return `new BigDecimal(${expr})`;
      if (t.name === "datetime") return `Instant.parse(${expr})`;
      return expr;
    case "id":
      return `new ${t.targetName}Id(${expr})`;
    case "valueobject":
      return `to${t.name}(${expr})`;
    case "array": {
      const el = t.element;
      const mapped = wireToDomain(el, "__x");
      if (mapped === "__x") return expr;
      // MUTABLE copy, not `Stream.toList()`.  This value is assigned straight
      // onto a domain field, and on a value-object collection that field is a
      // JPA `@ElementCollection`.  Hibernate's merge REPLACES a collection in
      // place — `CollectionType.replaceElements` calls `clear()` on the target
      // — so an immutable `Stream.toList()` result made every UPDATE of an
      // aggregate with a `Money[]`-shaped field answer 500
      // (`UnsupportedOperationException` from `ImmutableCollections.uoe`).
      // CREATE never hit it: a fresh entity is persisted, never merged, which
      // is why the compile tier and the create-only e2e both stayed green.
      // Found by the caller census's `update` drain on `value-collections`.
      return `new java.util.ArrayList<>(${expr}.stream().map(__x -> ${mapped}).toList())`;
    }
    case "optional": {
      const inner = wireToDomain(t.inner, expr);
      if (inner === expr) return expr;
      return `${expr} == null ? null : ${inner}`;
    }
    default:
      return expr;
  }
}

/** Imports the inbound conversion needs. */
export function collectWireToDomainImports(t: TypeIR, into: Set<string>): Set<string> {
  switch (t.kind) {
    case "primitive":
      if (t.name === "money") into.add("java.math.BigDecimal");
      if (t.name === "datetime") into.add("java.time.Instant");
      return into;
    case "array":
      return collectWireToDomainImports(t.element, into);
    case "optional":
      return collectWireToDomainImports(t.inner, into);
    default:
      return into;
  }
}

/** Value objects referenced (transitively) by a list of wire types —
 *  drives nested `<Vo>Request`/`<Vo>Response` record emission. */
export function referencedValueObjects(types: readonly TypeIR[], into: Set<string>): Set<string> {
  for (const t of types) {
    if (t.kind === "valueobject") into.add(t.name);
    else if (t.kind === "array") referencedValueObjects([t.element], into);
    else if (t.kind === "optional") referencedValueObjects([t.inner], into);
  }
  return into;
}
