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
  /** `shape(embedded)`: reference collections (and containments — see
   *  the entity emitter) fold into jsonb columns instead of join /
   *  part tables (the EF owned-types `.ToJson()` analog). */
  embedded?: boolean;
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
 *  table's parent-FK column (`<snake(owner)>_id`).  `nullable = false`
 *  is load-bearing: it makes Hibernate write the FK in the child INSERT
 *  instead of the insert-then-update dance, which the Flyway DDL's
 *  NOT NULL constraint would reject. */
export function jpaContainmentAnnotations(ownerName: string): string[] {
  return [
    `    @OneToMany(cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.EAGER)`,
    `    @JoinColumn(name = "${snake(ownerName)}_id", nullable = false)`,
  ];
}

/** Single containment, parent side — JPA has no unidirectional
 *  one-to-one with the FK on the part table, so the part carries a
 *  hidden owning `_parent` relation and the root maps the inverse. */
export function jpaSingleContainmentAnnotations(): string[] {
  return [
    `    @OneToOne(mappedBy = "_parent", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.EAGER)`,
  ];
}

/** Single containment, part side — the hidden owning relation writing
 *  the parent-FK column (the part's read-only `parentId` mirrors it). */
export function jpaSingleContainmentParentAnnotations(parentFkColumn: string): string[] {
  return [
    `    @OneToOne(fetch = FetchType.LAZY)`,
    `    @JoinColumn(name = "${parentFkColumn}", nullable = false)`,
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

  // Reference collection (`Target id[]`) → the association's join table
  // (relational), or a jsonb id-array column under `shape(embedded)`.
  if (t.kind === "array" && t.element.kind === "id") {
    const assoc = associationFor(owner, f.name);
    if (!assoc) {
      throw new Error(
        `java jpa: no AssociationIR for reference collection '${owner.name}.${f.name}' — enrichment derives one per aggregate-level Id[] field.`,
      );
    }
    if (opts.embedded) {
      // The `List<TargetId>` can't ride `@JdbcTypeCode(JSON)` alone — the
      // @Embeddable id triggers Hibernate's structured-JSON aggregate path,
      // which bypasses the FormatMapper.  A per-target `AttributeConverter`
      // (emitted in domain.ids) unwraps the list to bare `value`s so the
      // FormatMapper serialises `["v1","v2"]` — the cross-backend jsonb shape.
      return [
        `    @Convert(converter = ${assoc.targetAgg}IdJsonListConverter.class)`,
        `    @JdbcTypeCode(SqlTypes.JSON)`,
        `    @Column(name = "${col}"${f.optional ? "" : ", nullable = false"})`,
      ];
    }
    // `Target id[]` is contractually a set (membership only, no order), so
    // the join table carries no `ordinal` column — the composite (owner,
    // target) PK is the whole row.  Deterministic read-back order is a
    // read-time projection: `@OrderBy` (no argument) sorts by the element
    // value, i.e. the target FK id — matching every other backend.
    return [
      `    @ElementCollection(fetch = FetchType.EAGER)`,
      `    @CollectionTable(name = "${assoc.joinTable}"${schemaAttr(opts.schema)}, joinColumns = @JoinColumn(name = "${assoc.ownerFk}"))`,
      `    @OrderBy`,
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
