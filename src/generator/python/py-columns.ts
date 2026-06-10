import type { AssociationIR, BoundedContextIR, FieldIR, TypeIR } from "../../ir/types/loom-ir.js";
import { snake } from "../../util/naming.js";

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

/** Row-model class name for an association's join table
 *  (`trainer_party` → `TrainerPartyRow`). */
export function joinRowClassName(assoc: AssociationIR): string {
  const pascal = assoc.joinTable
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
      return [{ attr, pyType: "str", saType: "Text", optional: opt }];
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
