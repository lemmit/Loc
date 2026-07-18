// Dart wire-model emitter for the Flutter frontend — the Dart analogue of
// `feliz/wire.ts`'s record + Thoth-decoder blocks and of the React/Svelte zod
// schemas.  One `class` per aggregate / entity-part / value-object / event /
// payload (DTO) wire shape, built off `wireShape` (via the `wire-projection`
// helpers) exactly as `zod-schemas.ts` consumes it, so the Dart model carries
// the same field set, in the same order, as every other target's wire contract.
//
// Each class has: `final` fields typed via `dart-types.ts`, a `const`
// constructor, and hand-written `factory X.fromJson(...)` / `toJson()` — no
// `json_serializable` / `build_runner` codegen needed.
//
// TODO(flutter full-parity): discriminated payload unions (`payload Foo = A | B`)
// should emit a Dart-3 `sealed class` hierarchy + a `switch`-based
// `fromJson`/`toJson` keyed on the `type` tag.  The skeleton skips union
// payloads (record payloads still emit); see `dartRecordForPayload`.

import {
  forApiRead,
  wireFieldsForAggregate,
  wireFieldsForPart,
  wireFieldsForValueObject,
} from "../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  BoundedContextIR,
  EntityPartIR,
  EventIR,
  FieldIR,
  PayloadIR,
  TypeIR,
  ValueObjectIR,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { upperFirst } from "../../util/naming.js";
import { dartFromJson, dartToJson, dartType, isIdentityJson } from "./dart-types.js";

/** One field of a Dart wire model — the JSON key (kept verbatim from the wire
 *  shape), its domain type, and whether it is optional (nullable). */
export interface DartField {
  name: string;
  type: TypeIR;
  optional: boolean;
}

/** A Dart wire model — a class name + its ordered fields.  The neutral shape
 *  every collector produces and `renderDartModel` consumes. */
export interface DartRecord {
  className: string;
  fields: DartField[];
}

/** Peel a single `optional` layer (optionality is carried by `DartField`). */
function base(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

/** The `final <type> <name>;` field declaration line. */
function fieldDecl(f: DartField): string {
  const b = base(f.type);
  const t = dartType(b) + (f.optional ? "?" : "");
  return `  final ${t} ${f.name};`;
}

/** The constructor parameter for a field — `required this.x` for a required
 *  field, `this.x` for an optional (nullable) one. */
function ctorParam(f: DartField): string {
  return f.optional ? `    this.${f.name},` : `    required this.${f.name},`;
}

/** The `fromJson` entry decoding one field out of the JSON map. */
function fromJsonEntry(f: DartField): string {
  const access = `json['${f.name}']`;
  if (f.optional) {
    return `        ${f.name}: ${access} == null ? null : ${dartFromJson(base(f.type), access)},`;
  }
  return `        ${f.name}: ${dartFromJson(f.type, access)},`;
}

/** The `toJson` entry encoding one field into the JSON map. */
function toJsonEntry(f: DartField): string {
  if (f.optional && !isIdentityJson(base(f.type))) {
    return `        '${f.name}': ${f.name} == null ? null : ${dartToJson(base(f.type), `${f.name}!`)},`;
  }
  return `        '${f.name}': ${dartToJson(f.type, f.name)},`;
}

/** Emit one Dart wire-model `class` — `final` fields, a `const` constructor,
 *  and hand-written `fromJson` / `toJson`. */
export function renderDartModel(record: DartRecord): string {
  const { className, fields } = record;
  return lines(
    `class ${className} {`,
    ...fields.map(fieldDecl),
    "",
    `  const ${className}({`,
    ...fields.map(ctorParam),
    "  });",
    "",
    `  factory ${className}.fromJson(Map<String, dynamic> json) => ${className}(`,
    ...fields.map(fromJsonEntry),
    "      );",
    "",
    "  Map<String, dynamic> toJson() => {",
    ...fields.map(toJsonEntry),
    "      };",
    "}",
  );
}

// ---------------------------------------------------------------------------
// Collectors — IR node → `DartRecord`, each off the canonical wire shape.
// ---------------------------------------------------------------------------

function toDartField(w: { name: string; type: TypeIR; optional: boolean }): DartField {
  return { name: w.name, type: w.type, optional: w.optional || w.type.kind === "optional" };
}

/** The Dart wire model for an aggregate (its `wireShape`, api-read filtered). */
export function dartRecordForAggregate(agg: AggregateIR): DartRecord {
  return {
    className: upperFirst(agg.name),
    fields: forApiRead(wireFieldsForAggregate(agg)).map(toDartField),
  };
}

/** The Dart wire model for an entity part (nested containment record). */
export function dartRecordForPart(part: EntityPartIR): DartRecord {
  return {
    className: upperFirst(part.name),
    fields: forApiRead(wireFieldsForPart(part)).map(toDartField),
  };
}

/** The Dart wire model for a value object. */
export function dartRecordForValueObject(vo: ValueObjectIR): DartRecord {
  return {
    className: upperFirst(vo.name),
    fields: wireFieldsForValueObject(vo).map(toDartField),
  };
}

/** The Dart wire model for an event (flat field record — no synthesized id). */
export function dartRecordForEvent(ev: EventIR): DartRecord {
  return {
    className: upperFirst(ev.name),
    fields: ev.fields.map((f: FieldIR) => toDartField(f)),
  };
}

/** The Dart wire model for a record-shaped payload (command / query / response /
 *  error DTO).  Returns null for a discriminated union payload — deferred to
 *  full parity (see the file-header TODO). */
export function dartRecordForPayload(p: PayloadIR): DartRecord | null {
  if (p.variants) return null; // TODO(flutter full-parity): sealed-class union
  return {
    className: upperFirst(p.name),
    fields: p.fields.map((f: FieldIR) => toDartField(f)),
  };
}

/** Emit every Dart wire model a system's contexts declare — value objects,
 *  events, record payloads, aggregates and their entity parts — deduped by
 *  class name, concatenated into one Dart library body.  The integrator wires
 *  this into `flutter/index.ts`; the collectors above stay available for
 *  finer-grained use. */
export function renderDartModels(contexts: readonly BoundedContextIR[]): string {
  const seen = new Set<string>();
  const records: DartRecord[] = [];
  const add = (r: DartRecord | null): void => {
    if (!r || seen.has(r.className)) return;
    seen.add(r.className);
    records.push(r);
  };
  for (const ctx of contexts) {
    for (const vo of ctx.valueObjects) add(dartRecordForValueObject(vo));
    for (const ev of ctx.events) add(dartRecordForEvent(ev));
    for (const p of ctx.payloads) add(dartRecordForPayload(p));
    for (const agg of ctx.aggregates) {
      add(dartRecordForAggregate(agg));
      for (const part of agg.parts) add(dartRecordForPart(part));
    }
  }
  if (records.length === 0) return "";
  return lines(
    "// Wire models — one class per aggregate / part / value-object / event /",
    "// payload wire shape.  Generated by the Loom Flutter target; do not edit.",
    "",
    ...records.flatMap((r, i) => (i === 0 ? [renderDartModel(r)] : ["", renderDartModel(r)])),
  );
}
