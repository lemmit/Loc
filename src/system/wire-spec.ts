import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  EnrichedSystemIR,
  EnrichedValueObjectIR,
  SubdomainIR,
  TypeIR,
  WireField,
} from "../ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// `<system>/.loom/wire-spec.json` artifact.
//
// One JSON-Schema-flavoured document per system, listing every
// aggregate / part / value object's canonical wire shape.  Inspectable,
// diffable, language-agnostic.  Users can `git diff
// .loom/wire-spec.json` between regens to see backend wire-contract
// changes at a glance — without booting a backend or comparing
// generated code.
//
// The schema mirrors `WireField[]` from the IR (which `enrichLoomModel`
// already populates).  The format is JSON-Schema-shaped (with
// `properties`/`required`/`additionalProperties: false`) so it can be
// consumed by tooling that already understands JSON Schema, but kept
// minimal — no `$schema` URI / draft pinning, since this artifact is
// for review more than for runtime validation.
// ---------------------------------------------------------------------------

export interface WireSpecDoc {
  system: string;
  aggregates: Record<string, JsonSchemaObject>;
  parts: Record<string, JsonSchemaObject>;
  valueObjects: Record<string, JsonSchemaObject>;
}

interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: false;
}

type JsonSchemaProperty =
  | { type: "string"; format?: "date-time" | "uuid" | "decimal" }
  | { type: "number" }
  | { type: "integer" }
  | { type: "boolean" }
  | { type: "array"; items: JsonSchemaProperty }
  /** Opaque JSON blob (the `json` primitive) — freeform object, no
   *  further constraints.  `additionalProperties` left default. */
  | { type: "object" }
  | { $ref: string };

export function buildWireSpec(sys: EnrichedSystemIR): WireSpecDoc {
  const doc: WireSpecDoc = {
    system: sys.name,
    aggregates: {},
    parts: {},
    valueObjects: {},
  };
  // System modules each carry their own bounded contexts; collect every
  // one (a context can in theory appear under multiple modules — last
  // write wins, all entries are structurally identical).
  for (const m of sys.subdomains) {
    for (const ctx of m.contexts) collectContext(ctx, doc);
  }
  return doc;
}

function collectContext(ctx: EnrichedBoundedContextIR, doc: WireSpecDoc): void {
  for (const a of ctx.aggregates) {
    doc.aggregates[a.name] = aggregateSchema(a);
    for (const p of a.parts) doc.parts[p.name] = partSchema(p);
  }
  for (const v of ctx.valueObjects) {
    doc.valueObjects[v.name] = valueObjectSchema(v);
  }
}

function aggregateSchema(a: EnrichedAggregateIR): JsonSchemaObject {
  return objectSchemaFromWireShape(a.wireShape);
}

function partSchema(p: EnrichedEntityPartIR): JsonSchemaObject {
  return objectSchemaFromWireShape(p.wireShape);
}

function valueObjectSchema(v: EnrichedValueObjectIR): JsonSchemaObject {
  return objectSchemaFromWireShape(v.wireShape);
}

function objectSchemaFromWireShape(fields: WireField[]): JsonSchemaObject {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.name] = jsonPropertyForType(f.type);
    if (!f.optional) required.push(f.name);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function jsonPropertyForType(t: TypeIR): JsonSchemaProperty {
  switch (t.kind) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: inner switch on the primitive name union is exhaustive (every arm returns)
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return { type: "integer" };
        case "decimal":
          return { type: "number" };
        case "money":
          // Precise decimal — string-on-wire per OpenAPI finance
          // convention.  Every backend's host-language precise-decimal
          // type (decimal.js, System.Decimal, Elixir Decimal, rust_decimal)
          // round-trips through a JSON string without precision loss.
          return { type: "string", format: "decimal" };
        case "string":
          return { type: "string" };
        case "bool":
          return { type: "boolean" };
        case "datetime":
          return { type: "string", format: "date-time" };
        case "guid":
          return { type: "string", format: "uuid" };
        case "json":
          // Opaque blob — freeform object at the JSON boundary.
          return { type: "object" };
      }
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: inner switch on the id valueType union is exhaustive (every arm returns)
    case "id":
      // Id wire shape mirrors the underlying value-type: guid → uuid
      // string, int/long → integer, plain string → string with no
      // format.  Matches what each backend emits at the JSON boundary.
      switch (t.valueType) {
        case "guid":
          return { type: "string", format: "uuid" };
        case "int":
        case "long":
          return { type: "integer" };
        case "string":
          return { type: "string" };
      }
    case "enum":
      return { type: "string" };
    case "valueobject":
      return { $ref: `#/valueObjects/${t.name}` };
    case "entity":
      return { $ref: `#/parts/${t.name}` };
    case "array":
      return { type: "array", items: jsonPropertyForType(t.element) };
    case "optional":
      return jsonPropertyForType(t.inner);
    case "action":
    case "slot":
      throw new Error(
        "jsonPropertyForType: 'slot' type is UI-only and has no wire-spec representation.",
      );
    case "genericInstance":
      throw new Error(
        `jsonPropertyForType: generic carrier '${t.ctor}' is not emittable yet (P3b); IR-validate should have rejected it.`,
      );
    case "union":
    case "none":
      throw new Error(
        `jsonPropertyForType: discriminated unions are not emittable yet (P4); IR-validate should have rejected '${t.kind}'.`,
      );
  }
}

/** Convenience: serialise to a stable, pretty-printed JSON string with
 * a trailing newline.  Stable ordering is guaranteed by the IR
 * (aggregate / part / VO order matches source order). */
export function renderWireSpec(sys: EnrichedSystemIR): string {
  return JSON.stringify(buildWireSpec(sys), null, 2) + "\n";
}

// Re-export so `system/index.ts` can import without depending on
// internal naming.  Prevents accidental coupling.
export type { SubdomainIR };
