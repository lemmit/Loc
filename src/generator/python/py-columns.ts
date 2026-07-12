import type { AssociationIR, BoundedContextIR, FieldIR, TypeIR } from "../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Column mapping shared by the SQLAlchemy schema emitter and the
// repository builder.  Mirrors the Drizzle column rules so the table
// shape matches the shared Postgres DDL (sql-pg.ts):
//   - value-object fields flatten to `<field>_<voField>` columns
//   - `T id[]` reference collections contribute NO column (join table)
//   - scalar / enum collections map to native Postgres arrays
//   - enums store their value text
//   - money is NUMERIC(19,4); ids are TEXT
// ---------------------------------------------------------------------------

export interface PyColumn {
  /** Python attribute name (snake) — also the SQL column name unless
   *  `sqlName` overrides it (part parent FKs). */
  attr: string;
  sqlName?: string;
  /** Inner python type for the `Mapped[…]` annotation (pre-optional). */
  pyType: string;
  /** SQLAlchemy column type expression (`Text`, `Numeric(19, 4)`, …). */
  saType: string;
  optional: boolean;
  primaryKey?: boolean;
}

/** SQLAlchemy row-model class name for an aggregate / part. */
export function rowClassName(name: string): string {
  return `${name}Row`;
}

/** SQLAlchemy row-model class name for the single per-context event log
 *  (`<ctx>_events`) — the shared event-sourcing store every ES aggregate and
 *  ES workflow in the context appends to, discriminated by `stream_type`
 *  (event-log-architecture.md). */
export function contextEventRowClassName(ctxName: string): string {
  return `${upperFirst(ctxName)}EventRow`;
}

/** The per-context event-log table name (`<ctx>_events`), matching the shared
 *  DDL (`migrations-builder.eventLogTableForStream`). */
export function contextEventsTableName(ctxName: string): string {
  return `${snake(ctxName)}_events`;
}

/** Row-model class name for an association's join table
 *  (`trainer_party` → `TrainerPartyRow`). */
export function joinRowClassName(assoc: AssociationIR): string {
  const pascal = assoc.joinTable
    .split("_")
    .map((p) => (p.length === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join("");
  return `${pascal}Row`;
}

/** SQLAlchemy row-model class name for a value-collection child table
 *  (`order_charges` → `OrderChargesRow`).  Derived from the shared
 *  `childTable` so the schema and repository reference the same class. */
export function valueCollectionRowClassName(childTable: string): string {
  const pascal = childTable
    .split("_")
    .map((p) => (p.length === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join("");
  return `${pascal}Row`;
}

/** True for `T id[]` reference-collection fields (persisted via a join
 *  table, no column on the owner). */
export function isRefCollectionField(f: FieldIR): boolean {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  return t.kind === "array" && t.element.kind === "id";
}

/** True for `<VO>[]` value-collection fields (id-less child table —
 *  deferred; see the schema emitter's note). */
export function isValueCollectionField(f: FieldIR): boolean {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  return t.kind === "array" && t.element.kind === "valueobject";
}

/** The value object's flattened columns for an id-less value-collection
 *  child table — bare VO field names (`amount`, `currency`), recursively
 *  flattened for nested value objects (`outer_inner`).  Mirrors the shared
 *  migration's `valueObjectChildColumns` (no field-name prefix) so the
 *  SQLAlchemy model matches the DDL exactly.  The owner FK + `ordinal` are
 *  added by the schema emitter; this is only the VO payload. */
export function valueCollectionChildColumns(
  voName: string,
  ctx: BoundedContextIR,
  prefix = "",
): PyColumn[] {
  const vo = ctx.valueObjects.find((v) => v.name === voName);
  if (!vo) return [];
  return vo.fields.flatMap((vf) => {
    const name = prefix ? `${prefix}_${snake(vf.name)}` : snake(vf.name);
    const inner = vf.type.kind === "optional" ? vf.type.inner : vf.type;
    if (inner.kind === "valueobject") {
      return valueCollectionChildColumns(inner.name, ctx, name);
    }
    // Reuse the scalar column mapping, but force the flattened name.
    return columnsFor(name, inner, vf.optional || vf.type.kind === "optional", ctx).map((c) => ({
      ...c,
      attr: name,
    }));
  });
}

/** Flattened column list for a field set (VOs expand; ref/VO
 *  collections contribute nothing). */
export function columnsForFields(fields: FieldIR[], ctx: BoundedContextIR): PyColumn[] {
  const out: PyColumn[] = [];
  for (const f of fields) {
    if (isRefCollectionField(f) || isValueCollectionField(f)) continue;
    out.push(...columnsFor(f.name, f.type, f.optional, ctx));
  }
  return out;
}

export function columnsFor(
  fieldName: string,
  t: TypeIR,
  optional: boolean,
  ctx: BoundedContextIR,
): PyColumn[] {
  const inner = t.kind === "optional" ? t.inner : t;
  const opt = optional || t.kind === "optional";
  const attr = snake(fieldName);
  switch (inner.kind) {
    case "primitive":
      switch (inner.name) {
        case "int":
          return [{ attr, pyType: "int", saType: "Integer", optional: opt }];
        case "long":
          return [{ attr, pyType: "int", saType: "BigInteger", optional: opt }];
        case "decimal":
          return [{ attr, pyType: "Decimal", saType: "Numeric", optional: opt }];
        case "money":
          return [{ attr, pyType: "Decimal", saType: "Numeric(19, 4)", optional: opt }];
        case "string":
          return [{ attr, pyType: "str", saType: "Text", optional: opt }];
        case "bool":
          return [{ attr, pyType: "bool", saType: "Boolean", optional: opt }];
        case "datetime":
          return [{ attr, pyType: "datetime", saType: "DateTime(timezone=True)", optional: opt }];
        case "guid":
          return [{ attr, pyType: "str", saType: "Uuid(as_uuid=False)", optional: opt }];
        case "json":
          return [{ attr, pyType: "object", saType: "JSONB", optional: opt }];
        default:
          return [{ attr, pyType: "str", saType: "Text", optional: opt }];
      }
    case "id":
      // The shared DDL types id columns UUID — `Uuid(as_uuid=False)`
      // keeps the python side str while binding/reading uuid cleanly.
      return [{ attr, pyType: "str", saType: "Uuid(as_uuid=False)", optional: opt }];
    case "enum":
      // Stored as the value text (parity with pgEnum's stored form).
      return [{ attr, pyType: "str", saType: "Text", optional: opt }];
    case "valueobject": {
      const vo = ctx.valueObjects.find((v) => v.name === inner.name);
      if (!vo) return [{ attr, pyType: "str", saType: "Text", optional: opt }];
      return vo.fields.flatMap((vf) => columnsFor(`${fieldName}_${vf.name}`, vf.type, opt, ctx));
    }
    case "entity":
      return [{ attr, pyType: "str", saType: "Text", optional: opt }];
    case "array": {
      if (inner.element.kind === "id" || inner.element.kind === "valueobject") return [];
      if (inner.element.kind === "primitive" || inner.element.kind === "enum") {
        const [elem] = columnsFor(fieldName, inner.element, true, ctx);
        if (elem) {
          return [
            {
              attr,
              pyType: `list[${elem.pyType}]`,
              saType: `ARRAY(${elem.saType})`,
              optional: opt,
            },
          ];
        }
      }
      return [{ attr, pyType: "str", saType: "Text", optional: opt }];
    }
    case "optional":
      return columnsFor(fieldName, inner.inner, true, ctx);
    default:
      throw new Error(
        `columnsFor: '${inner.kind}' is not a persistable column shape on the python backend yet.`,
      );
  }
}
