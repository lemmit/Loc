import type {
  AssociationIR,
  EnrichedAggregateIR,
  EnrichedEntityPartIR,
  FieldIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { valueCollectionsFor } from "../../../ir/util/value-collections.js";
import { snake } from "../../../util/naming.js";

// ---------------------------------------------------------------------------
// JPA annotation lines for the generated domain classes.  The mapping is
// the mirror image of `schemaFromModule` (src/system/migrations-builder.ts)
// — table names `plural(snake(name))`, snake_case columns, flattened
// value-object columns `<field>_<vofield>`, join tables from
// `AssociationIR`, value-collection child tables from `ValueCollectionIR`.
// DDL is owned by the Flyway migrations (ddl-auto: none); these
// annotations only bind the ORM to that schema, so every name is
// explicit rather than relying on a naming strategy.
//
// Typed ids ride JPA embeddables: `@EmbeddedId` / `@Embedded` +
// `@AttributeOverride(name = "value", …)` (Hibernate 6.2+ instantiates
// records natively; converters are off the table because JPA's
// autoApply skips @Id attributes).
// ---------------------------------------------------------------------------

export interface JpaOpts {
  /** Postgres schema the aggregate's tables live in (binding-resolved);
   *  undefined in legacy single-context mode → unqualified. */
  schema?: string;
  /** VO name → field list, for flattening attribute overrides. */
  voLookup: ReadonlyMap<string, readonly FieldIR[]>;
}

const schemaAttr = (schema: string | undefined): string => (schema ? `, schema = "${schema}"` : "");

export function jpaClassAnnotations(tableName: string, opts: JpaOpts): string[] {
  return [`@Entity`, `@Table(name = "${tableName}"${schemaAttr(opts.schema)})`];
}

/** `@EmbeddedId` mapping the id record's `value` onto the `id` column. */
export function jpaIdAnnotations(): string[] {
  return [
    `    @EmbeddedId`,
    `    @AttributeOverride(name = "value", column = @Column(name = "id"))`,
  ];
}

/** A part's parentId mirrors the FK column the containment association
 *  owns — read-only so the two mappings don't fight over writes. */
export function jpaParentIdAnnotations(parentFkColumn: string): string[] {
  return [
    `    @Embedded`,
    `    @AttributeOverride(name = "value", column = @Column(name = "${parentFkColumn}", insertable = false, updatable = false))`,
  ];
}

/** Containment collection — unidirectional one-to-many owning the part
 *  table's parent-FK column (`<snake(owner)>_id`). */
export function jpaContainmentAnnotations(ownerName: string): string[] {
  return [
    `    @OneToMany(cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.EAGER)`,
    `    @JoinColumn(name = "${snake(ownerName)}_id")`,
  ];
}

/** Recursively flatten a value object into attribute overrides:
 *  property path `city` / `inner.zip` → column `<prefix>_city` /
 *  `<prefix>_inner_zip` (matching `flattenValueObject` in the
 *  migrations builder). */
function voOverrides(
  pathPrefix: string,
  columnPrefix: string,
  voName: string,
  voLookup: JpaOpts["voLookup"],
): string[] {
  const fields = voLookup.get(voName) ?? [];
  return fields.flatMap((vf) => {
    const path = pathPrefix ? `${pathPrefix}.${vf.name}` : vf.name;
    const column = `${columnPrefix}_${snake(vf.name)}`;
    const base = vf.type.kind === "optional" ? vf.type.inner : vf.type;
    if (base.kind === "valueobject") {
      return voOverrides(path, column, base.name, voLookup);
    }
    return [`    @AttributeOverride(name = "${path}", column = @Column(name = "${column}"))`];
  });
}

/** Top-level (unprefixed) overrides for a value-collection's element —
 *  the child table's columns are the VO's bare flattened names. */
function voElementOverrides(voName: string, voLookup: JpaOpts["voLookup"]): string[] {
  const fields = voLookup.get(voName) ?? [];
  return fields.flatMap((vf) => {
    const base = vf.type.kind === "optional" ? vf.type.inner : vf.type;
    if (base.kind === "valueobject") {
      return voOverrides(vf.name, snake(vf.name), base.name, voLookup);
    }
    return [
      `    @AttributeOverride(name = "${vf.name}", column = @Column(name = "${snake(vf.name)}"))`,
    ];
  });
}

function unwrap(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

/** Annotation lines for one stored field.  `owner` resolves reference
 *  collections (associations) and value collections by field name. */
export function jpaFieldAnnotations(
  f: FieldIR,
  owner: EnrichedAggregateIR | EnrichedEntityPartIR,
  opts: JpaOpts,
): string[] {
  const t = unwrap(f.type);
  const col = snake(f.name);

  // Reference collection (`Target id[]`) → the association's join table.
  if (t.kind === "array" && t.element.kind === "id") {
    const assoc = associationFor(owner, f.name);
    if (!assoc) {
      throw new Error(
        `java jpa: no AssociationIR for reference collection '${owner.name}.${f.name}' — enrichment derives one per aggregate-level Id[] field.`,
      );
    }
    return [
      `    @ElementCollection(fetch = FetchType.EAGER)`,
      `    @CollectionTable(name = "${assoc.joinTable}"${schemaAttr(opts.schema)}, joinColumns = @JoinColumn(name = "${assoc.ownerFk}"))`,
      `    @OrderColumn(name = "ordinal")`,
      `    @AttributeOverride(name = "value", column = @Column(name = "${assoc.targetFk}"))`,
    ];
  }

  // Value-object array (`charges: Money[]`) → the id-less child table.
  if (t.kind === "array" && t.element.kind === "valueobject") {
    const vc = valueCollectionsFor(owner).find((v) => v.fieldName === f.name);
    if (!vc) {
      throw new Error(`java jpa: no ValueCollectionIR for '${owner.name}.${f.name}'.`);
    }
    return [
      `    @ElementCollection(fetch = FetchType.EAGER)`,
      `    @CollectionTable(name = "${vc.childTable}"${schemaAttr(opts.schema)}, joinColumns = @JoinColumn(name = "${vc.parentFk}"))`,
      `    @OrderColumn(name = "ordinal")`,
      ...voElementOverrides(t.element.name, opts.voLookup),
    ];
  }

  // Primitive / enum array → a native Postgres array column.
  if (t.kind === "array") {
    return [`    @JdbcTypeCode(SqlTypes.ARRAY)`, `    @Column(name = "${col}")`];
  }

  // `X id` reference → embedded id record over one column.
  if (t.kind === "id") {
    return [
      `    @Embedded`,
      `    @AttributeOverride(name = "value", column = @Column(name = "${col}"))`,
    ];
  }

  // Value object → embedded record over flattened `<field>_<vf>` columns.
  if (t.kind === "valueobject") {
    return [`    @Embedded`, ...voOverrides("", col, t.name, opts.voLookup)];
  }

  if (t.kind === "enum") {
    return [`    @Enumerated(EnumType.STRING)`, `    @Column(name = "${col}")`];
  }

  if (t.kind === "primitive" && t.name === "json") {
    return [`    @JdbcTypeCode(SqlTypes.JSON)`, `    @Column(name = "${col}")`];
  }

  // Scalars (string / int / long / decimal / money / bool / datetime / guid).
  return [`    @Column(name = "${col}")`];
}

function associationFor(
  owner: EnrichedAggregateIR | EnrichedEntityPartIR,
  fieldName: string,
): AssociationIR | undefined {
  const withAssocs = owner as Partial<EnrichedAggregateIR>;
  return withAssocs.associations?.find((a) => a.fieldName === fieldName);
}

/** True when any stored field needs the Hibernate type annotations
 *  (`@JdbcTypeCode` / `SqlTypes`) — json columns and primitive arrays. */
export function needsHibernateTypes(fields: readonly FieldIR[]): boolean {
  return fields.some((f) => {
    const t = unwrap(f.type);
    if (t.kind === "primitive" && t.name === "json") return true;
    return t.kind === "array" && t.element.kind !== "id" && t.element.kind !== "valueobject";
  });
}
