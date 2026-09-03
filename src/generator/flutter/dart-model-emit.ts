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
  ProjectionIR,
  TypeIR,
  ValueObjectIR,
  WireField,
} from "../../ir/types/loom-ir.js";
import {
  AUDIT_ENTRY_TYPE,
  AUDIT_FIELD_CHANGE_TYPE,
  auditEntryWireShape,
  auditFieldChangeWireShape,
} from "../../ir/util/audit-history.js";
import { isFrontendReadableProjection } from "../../ir/util/projection-read.js";
import { lines } from "../../util/code-builder.js";
import { upperFirst } from "../../util/naming.js";
import { type UnionMember, unionMembers } from "../_payload/union-wire.js";
import {
  DART_PROVENANCED,
  dartFromJson,
  dartToJson,
  dartType,
  isIdentityJson,
} from "./dart-types.js";

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
  /** Read-only wire model — never the target of a nested page-state write, so
   *  skip the `copyWith`.  Load-bearing for the audit models: `copyWith` spells
   *  every param as the nullable `<T>?`, and a `json` field's Dart type is
   *  `dynamic` — `dynamic?` is an `unnecessary_question_mark` analyzer error
   *  under flutter_lints, not just noise. */
  omitCopyWith?: boolean;
}

/** Peel a single `optional` layer (optionality is carried by `DartField`). */
function base(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

/** The Dart type spelling for a field — `dartType` of the peeled base, with the
 *  `?` the `DartField.optional` flag carries appended ONLY when the base
 *  spelling isn't already nullable.  A `File` primitive spells `FileRef?` on its
 *  own (`dart-types.ts` — a File holds a FileRef-or-nothing), so blindly
 *  appending produced the non-parsing `FileRef??`.  Mirrors the sibling
 *  `buildStateFields` rule in `riverpod-emit.ts` (`dt.endsWith("?")`). */
function dartFieldType(f: DartField): string {
  const dt = dartType(base(f.type));
  return f.optional && !dt.endsWith("?") ? `${dt}?` : dt;
}

/** Whether the field's DART type is nullable — the only correct test for
 *  null-guarding `fromJson` / `toJson`.  The IR `optional` flag is NOT it: a
 *  required `File` field is non-optional on the wire yet nullable in Dart, and
 *  keying off `optional` emitted `blob.toJson()` on a nullable receiver. */
function isNullableField(f: DartField): boolean {
  return dartFieldType(f).endsWith("?");
}

/** The `final <type> <name>;` field declaration line. */
function fieldDecl(f: DartField): string {
  return `  final ${dartFieldType(f)} ${f.name};`;
}

/** The constructor parameter for a field — `required this.x` for a required
 *  field, `this.x` for an optional (nullable) one. */
function ctorParam(f: DartField): string {
  return f.optional ? `    this.${f.name},` : `    required this.${f.name},`;
}

/** The `fromJson` entry decoding one field out of the JSON map. */
function fromJsonEntry(f: DartField): string {
  const access = `json['${f.name}']`;
  if (isNullableField(f)) {
    return `        ${f.name}: ${access} == null ? null : ${dartFromJson(base(f.type), access)},`;
  }
  return `        ${f.name}: ${dartFromJson(f.type, access)},`;
}

/** The `toJson` entry encoding one field into the JSON map. */
function toJsonEntry(f: DartField): string {
  if (isNullableField(f) && !isIdentityJson(base(f.type))) {
    return `        '${f.name}': ${f.name} == null ? null : ${dartToJson(base(f.type), `${f.name}!`)},`;
  }
  return `        '${f.name}': ${dartToJson(f.type, f.name)},`;
}

/** The `copyWith` parameter type for a field — always the nullable form so an
 *  omitted arg keeps `this` (`field ?? this.field`).  A field that is already
 *  optional keeps its single `?`. */
function copyWithParam(f: DartField): string {
  const t = dartFieldType(f);
  return `    ${t.endsWith("?") ? t : `${t}?`} ${f.name},`;
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
    ...(record.omitCopyWith ? [] : copyWithMethod(className, fields)),
    "}",
  );
}

// ---------------------------------------------------------------------------
// Collectors — IR node → `DartRecord`, each off the canonical wire shape.
// ---------------------------------------------------------------------------

function toDartField(w: { name: string; type: TypeIR; optional: boolean }): DartField {
  return { name: w.name, type: w.type, optional: w.optional || w.type.kind === "optional" };
}

/** True when any aggregate / entity part in these contexts declares a
 *  `provenanced` property — the emit gate for the fixed `ProvLineage` classes,
 *  so a provenance-free app's `models.dart` stays byte-identical. */
export function contextsCarryProvenance(contexts: readonly BoundedContextIR[]): boolean {
  return contexts.some((c) =>
    c.aggregates.some(
      (a) =>
        a.fields.some((f) => f.provenanced) ||
        a.parts.some((p) => p.fields.some((f) => f.provenanced)),
    ),
  );
}

/** The Dart wire model for an aggregate (its `wireShape`, api-read filtered),
 *  (a `provenanced` property's lineage rides inside its own `Provenanced<T>`
 *  field — M-T6.12 — so there is no sibling to append). */
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

/** The Dart wire model for a query-time PROJECTION's row (M-T1.3).
 *
 *  `<Proj>Row`, off the SAME `wireShape` the backend's row DTO and every other
 *  frontend's row type are built from — which is the whole reason a projection
 *  read needs no wire negotiation per frontend.  Named `…Row` rather than after
 *  the projection so it never collides with an aggregate of the same name, and
 *  matching what the JS clients call the object inside their `Response`. */
export function dartRecordForProjection(proj: ProjectionIR): DartRecord {
  return {
    className: `${upperFirst(proj.name)}Row`,
    fields: (proj.wireShape ?? []).map(toDartField),
  };
}

/** A history wire field → `DartField`.  One deviation from `toDartField`: a
 *  `json` leaf spells `dynamic` in Dart, which is ALREADY nullable — carrying
 *  the wire `optional` flag through would emit `dynamic?`, an
 *  `unnecessary_question_mark` analyzer error under flutter_lints.  The decode
 *  is unchanged either way (a `json` value passes through `fromJson`/`toJson`
 *  as identity, null included). */
function auditDartField(w: WireField): DartField {
  const isJson = w.type.kind === "primitive" && w.type.name === "json";
  return { name: w.name, type: w.type, optional: w.optional && !isJson };
}

/** The two entity-history wire models (docs/audit.md) — `AuditFieldChange` and
 *  `AuditEntry`, built off the SAME canonical wire shapes every backend serves
 *  (`auditEntryWireShape` / `auditFieldChangeWireShape` in
 *  `ir/util/audit-history.ts`), so the Dart decode lines up with the
 *  `GET /<coll>/{id}/history` route by construction.  `changes` is `json[]` on
 *  the wire (TypeIR has no nested-record leaf); the client narrows the ELEMENT
 *  to `AuditFieldChange` so `__c.field` resolves in the Timeline — the same
 *  narrowing the JS clients' `z.array(AuditFieldChange)` does.  Both are
 *  read-only (`omitCopyWith`) — see `DartRecord`. */
export function dartAuditRecords(): DartRecord[] {
  const changes: DartField = {
    name: "changes",
    type: { kind: "array", element: { kind: "entity", name: AUDIT_FIELD_CHANGE_TYPE } },
    optional: false,
  };
  return [
    {
      className: AUDIT_FIELD_CHANGE_TYPE,
      fields: auditFieldChangeWireShape().map(auditDartField),
      omitCopyWith: true,
    },
    {
      className: AUDIT_ENTRY_TYPE,
      fields: auditEntryWireShape().map((w) =>
        w.name === "changes" ? changes : auditDartField(w),
      ),
      omitCopyWith: true,
    },
  ];
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
/** The fixed `FileRef` wire object (`url`/`key`/`contentType`/`size`) — the Dart
 *  shape a `File` field / a `FileUpload` `/files` response maps to.  Emitted into
 *  `lib/models.dart` only when a File field or a FileUpload primitive is present
 *  (`fileRef` option), so File-free projects stay byte-identical. */
const FILE_REF_CLASS = lines(
  "class FileRef {",
  "  final String url;",
  "  final String key;",
  "  final String contentType;",
  "  final int size;",
  "",
  "  const FileRef({required this.url, required this.key, required this.contentType, required this.size});",
  "",
  "  factory FileRef.fromJson(Map<String, dynamic> json) => FileRef(",
  "        url: json['url'] as String,",
  "        key: json['key'] as String,",
  "        contentType: json['contentType'] as String,",
  "        size: (json['size'] as num).toInt(),",
  "      );",
  "",
  "  Map<String, dynamic> toJson() => {",
  "        'url': url,",
  "        'key': key,",
  "        'contentType': contentType,",
  "        'size': size,",
  "      };",
  "}",
);

/** The fixed provenance-lineage wire classes — the Dart analogue of the JSX
 *  frontends' `provLineageSchema` and of Feliz's `ProvLineage` record
 *  (docs/provenance.md).  `computedValue` and each input `value` are `unknown`
 *  JSON, so both ride a permissive scalar→String coercion (the same display-only
 *  narrowing every other frontend applies); `target` is dropped (not displayed).
 *  Emitted only when a provenanced property is in scope. */
const PROV_LINEAGE_CLASSES = lines(
  "// Provenance lineage — the `lineage` half of the `Provenanced<T>` wire",
  "// carrier a `provenanced` field ships as.",
  "// `computedValue` / `value` are opaque JSON scalars, coerced to String for",
  "// display (the same narrowing the JSX + Feliz frontends apply).",
  "String _provScalar(dynamic v) => v == null ? '' : v.toString();",
  "",
  "class ProvInput {",
  "  final String path;",
  "  final String value;",
  "",
  "  const ProvInput({required this.path, required this.value});",
  "",
  "  factory ProvInput.fromJson(Map<String, dynamic> json) => ProvInput(",
  "        path: _provScalar(json['path']),",
  "        value: _provScalar(json['value']),",
  "      );",
  "",
  "  Map<String, dynamic> toJson() => {",
  "        'path': path,",
  "        'value': value,",
  "      };",
  "}",
  "",
  "class ProvLineage {",
  "  final String snapshotId;",
  "  final String computedValue;",
  "  final List<ProvInput> inputs;",
  "",
  "  const ProvLineage({required this.snapshotId, required this.computedValue, required this.inputs});",
  "",
  "  factory ProvLineage.fromJson(Map<String, dynamic> json) => ProvLineage(",
  "        snapshotId: _provScalar(json['snapshotId']),",
  "        computedValue: _provScalar(json['computedValue']),",
  "        inputs: ((json['inputs'] as List<dynamic>?) ?? const <dynamic>[])",
  "            .map((e) => ProvInput.fromJson(e as Map<String, dynamic>))",
  "            .toList(),",
  "      );",
  "",
  "  Map<String, dynamic> toJson() => {",
  "        'snapshotId': snapshotId,",
  "        'computedValue': computedValue,",
  "        'inputs': inputs.map((e) => e.toJson()).toList(),",
  "      };",
  "}",
  "",
  "// `Provenanced<T>` — a provenanced field's value and the lineage of the write",
  "// that produced it, travelling together as one JSON object.  The",
  "// same shape every other Loom backend and frontend uses.",
  `class ${DART_PROVENANCED}<T> {`,
  "  final T value;",
  "  final ProvLineage? lineage;",
  "",
  `  const ${DART_PROVENANCED}({required this.value, this.lineage});`,
  "",
  // `fromValue` decodes the carried half, so the carrier stays generic over any
  // wire type (a `datetime` value still parses, a nested VO still builds).
  `  factory ${DART_PROVENANCED}.fromJson(`,
  "    Map<String, dynamic> json,",
  "    T Function(dynamic) fromValue,",
  "  ) =>",
  `      ${DART_PROVENANCED}(`,
  "        value: fromValue(json['value']),",
  "        lineage: json['lineage'] == null",
  "            ? null",
  "            : ProvLineage.fromJson(json['lineage'] as Map<String, dynamic>),",
  "      );",
  "",
  "  Map<String, dynamic> toJson() => {",
  "        'value': value,",
  "        'lineage': lineage?.toJson(),",
  "      };",
  "}",
);

export function renderDartModels(
  contexts: readonly BoundedContextIR[],
  opts: { fileRef?: boolean; auditEntry?: boolean } = {},
): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  if (opts.fileRef) blocks.push(FILE_REF_CLASS);
  if (contextsCarryProvenance(contexts)) blocks.push(PROV_LINEAGE_CLASSES);
  const addRecord = (r: DartRecord | null): void => {
    if (!r || seen.has(r.className)) return;
    seen.add(r.className);
    blocks.push(renderDartModel(r));
  };
  // The entity-history entry DTOs (docs/audit.md) — only when the ui collects a
  // history read (the `history` flag on a `FlutterRead`), so audit-free
  // projects stay byte-identical.
  if (opts.auditEntry) for (const r of dartAuditRecords()) addRecord(r);
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
    // Readable projections only — a keyed / folded one has no frontend route to
    // decode, so emitting its row would be a class no provider can ever fill.
    // The predicate is the SHARED one, never a Flutter-local re-derivation.
    for (const proj of ctx.projections ?? []) {
      if (isFrontendReadableProjection(proj)) addRecord(dartRecordForProjection(proj));
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
