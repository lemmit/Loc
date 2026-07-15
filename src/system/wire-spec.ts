import { wireFieldsFor } from "../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
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

/** Resolves a `$ref` string for a referenced part / value object.  Threaded
 *  through so a reference lands on the CONTEXT-QUALIFIED key when the target's
 *  bare name collides across contexts (see the collision handling below). */
type RefResolver = (bucket: "parts" | "valueObjects", name: string) => string;

const bareRef: RefResolver = (bucket, name) => `#/${bucket}/${name}`;

interface CollectedEntry<T> {
  ctx: string;
  name: string;
  node: T;
}

/** Bare names that appear under more than one context with a STRUCTURALLY
 *  DIFFERENT wire shape — a genuine collision.  Identical shapes (e.g. an
 *  ambient root-level VO folded into every context) are NOT collisions: they
 *  dedupe to a single bare-name entry, exactly as before. */
function collidingNames<T>(
  entries: CollectedEntry<T>[],
  shapeOf: (n: T) => WireField[],
): Set<string> {
  const sigsByName = new Map<string, Set<string>>();
  for (const e of entries) {
    let sigs = sigsByName.get(e.name);
    if (!sigs) {
      sigs = new Set();
      sigsByName.set(e.name, sigs);
    }
    sigs.add(JSON.stringify(shapeOf(e.node)));
  }
  const out = new Set<string>();
  for (const [name, sigs] of sigsByName) if (sigs.size > 1) out.add(name);
  return out;
}

export function buildWireSpec(sys: EnrichedSystemIR): WireSpecDoc {
  const doc: WireSpecDoc = {
    system: sys.name,
    aggregates: {},
    parts: {},
    valueObjects: {},
  };
  // Collect every (context, entry) pair first — a bounded context can host an
  // aggregate / part / value object whose BARE NAME clashes with one in a
  // sibling context (`Sales.Order` vs `Billing.Order`).  Keying the doc by bare
  // name alone silently clobbered one of them (last write wins); we detect the
  // clash and qualify only the colliding keys with their context.
  const aggs: CollectedEntry<EnrichedAggregateIR>[] = [];
  const parts: CollectedEntry<EnrichedEntityPartIR>[] = [];
  const vos: CollectedEntry<EnrichedValueObjectIR>[] = [];
  for (const m of sys.subdomains) {
    for (const ctx of m.contexts) {
      for (const a of ctx.aggregates) {
        aggs.push({ ctx: ctx.name, name: a.name, node: a });
        for (const p of a.parts) parts.push({ ctx: ctx.name, name: p.name, node: p });
      }
      for (const v of ctx.valueObjects) vos.push({ ctx: ctx.name, name: v.name, node: v });
    }
  }

  const shapeOf = (n: EnrichedAggregateIR | EnrichedEntityPartIR | EnrichedValueObjectIR) =>
    wireFieldsFor(n);
  const collidedAgg = collidingNames(aggs, shapeOf);
  const collidedPart = collidingNames(parts, shapeOf);
  const collidedVo = collidingNames(vos, shapeOf);

  // A colliding name is written as `Context.Name`; a non-colliding one stays
  // bare (so output is byte-identical for every collision-free model).
  const keyOf = (collided: Set<string>, ctx: string, name: string) =>
    collided.has(name) ? `${ctx}.${name}` : name;
  // `$ref` targets are resolved in the REFERER's context — a part is contained
  // in its aggregate's context, and a VO used by an aggregate is folded into
  // that same context — so a colliding target qualifies with the referer's ctx.
  const refIn =
    (ctx: string): RefResolver =>
    (bucket, name) => {
      const collided = bucket === "parts" ? collidedPart : collidedVo;
      return `#/${bucket}/${collided.has(name) ? `${ctx}.${name}` : name}`;
    };

  for (const e of aggs) {
    doc.aggregates[keyOf(collidedAgg, e.ctx, e.name)] = objectSchemaFromWireShape(
      wireFieldsFor(e.node),
      refIn(e.ctx),
    );
  }
  for (const e of parts) {
    doc.parts[keyOf(collidedPart, e.ctx, e.name)] = objectSchemaFromWireShape(
      wireFieldsFor(e.node),
      refIn(e.ctx),
    );
  }
  for (const e of vos) {
    doc.valueObjects[keyOf(collidedVo, e.ctx, e.name)] = objectSchemaFromWireShape(
      wireFieldsFor(e.node),
      refIn(e.ctx),
    );
  }
  return doc;
}

function objectSchemaFromWireShape(
  fields: WireField[],
  ref: RefResolver = bareRef,
): JsonSchemaObject {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.name] = jsonPropertyForType(f.type, ref);
    if (!f.optional) required.push(f.name);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function jsonPropertyForType(t: TypeIR, ref: RefResolver = bareRef): JsonSchemaProperty {
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
        case "duration":
          // A5: expression-only primitive — never a wire / schema type.
          throw new Error("internal: 'duration' is expression-only and never reaches the wire");
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
      return { $ref: ref("valueObjects", t.name) };
    case "entity":
      return { $ref: ref("parts", t.name) };
    case "array":
      return { type: "array", items: jsonPropertyForType(t.element, ref) };
    case "optional":
      return jsonPropertyForType(t.inner, ref);
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
