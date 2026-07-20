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
// Discriminated payload unions (`payload Foo = A | B`, and `A or B` in any
// transport position) emit a Dart-3 `sealed class` hierarchy: a `sealed class
// <Union>` base with a `switch`-based `factory fromJson` keyed on the `type`
// discriminator, plus one `final class <Union><Tag> extends <Union>` per
// variant (each carrying its own `final` fields + `const` ctor + `toJson`).
// Because the base is `sealed`, a Dart-3 `switch` over an instance is
// exhaustive with no default — the payoff that mirrors Loom's `match`.  See
// `renderDartUnion`; the record/scalar/`none` variant shapes come from the
// shared `unionMembers` resolver, so the wire is byte-identical to every other
// backend's tagged union.

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
import { type UnionMember, unionMembers } from "../_payload/union-wire.js";
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

/** The `copyWith` parameter type for a field — always the nullable form so an
 *  omitted arg keeps `this` (`field ?? this.field`).  A field that is already
 *  optional keeps its single `?`. */
function copyWithParam(f: DartField): string {
  const b = base(f.type);
  const t = dartType(b);
  return `    ${t}? ${f.name},`;
}

/** The `copyWith` body entry — `field: field ?? this.field`. */
function copyWithEntry(f: DartField): string {
  return `        ${f.name}: ${f.name} ?? this.${f.name},`;
}

/** The `copyWith({...}) => X(...)` method lines for a wire model — the immutable
 *  rebuild a nested page-state write (`order.shipping.zip := v`) folds into
 *  (`state.order.copyWith(shipping: …)`).  Mirrors the `<Page>State` copyWith
 *  shape (`renderStateDataClass`); an omitted arg keeps the current value, so a
 *  write can't clear a field to null — the nested-write use never needs to. */
function copyWithMethod(className: string, fields: readonly DartField[]): string[] {
  if (fields.length === 0) return [];
  return [
    "",
    `  ${className} copyWith({`,
    ...fields.map(copyWithParam),
    "  }) =>",
    `      ${className}(`,
    ...fields.map(copyWithEntry),
    "      );",
  ];
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
    ...copyWithMethod(className, fields),
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
 *  error DTO).  Returns null for a discriminated *union* payload — those emit a
 *  whole `sealed class` hierarchy (multiple classes) via `renderDartUnion`, not
 *  a single record, so `renderDartModels` routes them there directly. */
export function dartRecordForPayload(p: PayloadIR): DartRecord | null {
  if (p.variants) return null; // union → renderDartUnion (sealed-class hierarchy)
  return {
    className: upperFirst(p.name),
    fields: p.fields.map((f: FieldIR) => toDartField(f)),
  };
}

// ---------------------------------------------------------------------------
// Discriminated-union sealed classes.
// ---------------------------------------------------------------------------

/** The `final` fields a union variant contributes: a record variant flattens
 *  its wire fields; a scalar variant carries a single `value`; `none` is
 *  empty. */
function unionVariantFields(m: UnionMember): DartField[] {
  if (m.shape === "record") return m.fields.map(toDartField);
  if (m.shape === "scalar") return [{ name: "value", type: m.type, optional: false }];
  return [];
}

/** Emit one `final class <Union><Tag> extends <Union>` variant — its `final`
 *  fields, a `const` constructor, a `fromJson` reading the flattened variant
 *  body, and an `@override toJson()` that re-stamps the `type` discriminator. */
function renderUnionVariant(unionName: string, m: UnionMember): string {
  const className = `${unionName}${upperFirst(m.tag)}`;
  const fields = unionVariantFields(m);
  const tagEntry = `        'type': '${m.tag}',`;

  if (fields.length === 0) {
    // `none` (or any empty variant): a bare tagged object.  `json` is unused
    // (nothing to decode) — flutter_lints doesn't flag an unused parameter.
    return lines(
      `final class ${className} extends ${unionName} {`,
      `  const ${className}();`,
      "",
      `  factory ${className}.fromJson(Map<String, dynamic> json) => const ${className}();`,
      "",
      "  @override",
      "  Map<String, dynamic> toJson() => {",
      tagEntry,
      "      };",
      "}",
    );
  }

  return lines(
    `final class ${className} extends ${unionName} {`,
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
    "  @override",
    "  Map<String, dynamic> toJson() => {",
    tagEntry,
    ...fields.map(toJsonEntry),
    "      };",
    "}",
  );
}

/** Emit the full Dart-3 `sealed class` hierarchy for a discriminated union: a
 *  `sealed class <Union>` base whose `factory fromJson` switches on the `type`
 *  discriminator into the right variant, plus one `final class` per variant.
 *  A `switch` over an instance of the sealed base is exhaustive with no
 *  `default` — the consumer-side payoff that mirrors Loom's `match`. */
export function renderDartUnion(name: string, variants: TypeIR[], ctx: BoundedContextIR): string {
  const members = unionMembers(variants, ctx);
  const base = lines(
    `sealed class ${name} {`,
    `  const ${name}();`,
    "",
    `  factory ${name}.fromJson(Map<String, dynamic> json) {`,
    "    switch (json['type'] as String) {",
    ...members.flatMap((m) => [
      `      case '${m.tag}':`,
      `        return ${name}${upperFirst(m.tag)}.fromJson(json);`,
    ]),
    "      default:",
    `        throw ArgumentError('Unknown ${name} variant: \${json['type']}');`,
    "    }",
    "  }",
    "",
    "  Map<String, dynamic> toJson();",
    "}",
  );
  return lines(base, ...members.flatMap((m) => ["", renderUnionVariant(name, m)]));
}

/** Emit every Dart wire model a system's contexts declare — value objects,
 *  events, record payloads, aggregates and their entity parts — deduped by
 *  class name, concatenated into one Dart library body.  The integrator wires
 *  this into `flutter/index.ts`; the collectors above stay available for
 *  finer-grained use. */
export function renderDartModels(contexts: readonly BoundedContextIR[]): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  const addRecord = (r: DartRecord | null): void => {
    if (!r || seen.has(r.className)) return;
    seen.add(r.className);
    blocks.push(renderDartModel(r));
  };
  const addUnion = (p: PayloadIR, ctx: BoundedContextIR): void => {
    const name = upperFirst(p.name);
    if (!p.variants || seen.has(name)) return;
    seen.add(name);
    blocks.push(renderDartUnion(name, p.variants, ctx));
  };
  for (const ctx of contexts) {
    for (const vo of ctx.valueObjects) addRecord(dartRecordForValueObject(vo));
    for (const ev of ctx.events) addRecord(dartRecordForEvent(ev));
    for (const p of ctx.payloads) {
      if (p.variants) addUnion(p, ctx);
      else addRecord(dartRecordForPayload(p));
    }
    for (const agg of ctx.aggregates) {
      addRecord(dartRecordForAggregate(agg));
      for (const part of agg.parts) addRecord(dartRecordForPart(part));
    }
  }
  if (blocks.length === 0) return "";
  return lines(
    "// Wire models — one class per aggregate / part / value-object / event /",
    "// payload wire shape (discriminated unions → a `sealed class` hierarchy).",
    "// Generated by the Loom Flutter target; do not edit.",
    "",
    ...blocks.flatMap((b, i) => (i === 0 ? [b] : ["", b])),
  );
}
