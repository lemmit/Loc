import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  FieldIR,
  ProjectionIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { collectJavaTypeImports, renderJavaType } from "../render-expr.js";
import {
  jpaClassAnnotations,
  jpaFieldAnnotations,
  needsHibernateTypes,
} from "./jpa-annotations.js";
import { setterName } from "./workflow-state.js";

// ---------------------------------------------------------------------------
// Persisted projection read-model row (Java / JPA) — the projection.md read
// half, mirroring the saga-state emitter (`workflow-state.ts`) with the command
// side removed.  A `<Proj>Row` `@Entity` bound to the Flyway-owned
// `plural(snake(proj.name))` read-model table (DDL derived platform-neutrally by
// `projectionTableShape` in the migrations builder): the correlation field is
// the `@EmbeddedId`, the remaining state fields are mapped columns.
//
// The one shape difference from a saga row: every NON-KEY column is nullable (a
// fold upserts only the fields an event carries, so a row is partial until every
// contributing event arrives).  So each non-key field is rendered as if
// `optional: true`, which also makes `_allocate` an EMPTY seed — the correlation
// key is the only thing set at allocation (there are no required non-key
// columns to default).
//
// Field mapping is otherwise identical to the aggregate / saga entity emitters
// (`jpa-annotations.ts`): `X id` → `@Embedded`/`@EmbeddedId`, enums →
// `@Enumerated(STRING)`, scalars → `@Column`.  Fields are package-private with
// record-style accessors + JavaBean setters (the dispatcher's fold writes each
// `:=` through the setter from another package — the fields themselves are
// package-private, so a cross-package direct write wouldn't compile).
// ---------------------------------------------------------------------------

/** The read-model row entity class name (`OrderBookRow`) — matches python's
 *  `<Proj>Row` and the wire DTO / controller references. */
export function projectionRowClass(proj: ProjectionIR): string {
  return `${upperFirst(proj.name)}Row`;
}

/** The read-model table name — matches `projectionTableShape` in the migrations
 *  builder (`plural(snake(name))`). */
export function projectionRowTable(proj: ProjectionIR): string {
  return plural(snake(proj.name));
}

function correlationField(proj: ProjectionIR): FieldIR {
  const corr = proj.correlationField;
  const f = proj.stateFields.find((x) => x.name === corr);
  if (!f) {
    throw new Error(
      `java projection-state: correlation field '${corr}' not among '${proj.name}' stateFields`,
    );
  }
  return f;
}

/** The correlation field's id class (`OrderId`) — always id-shaped (`keyed by`
 *  is required and names an id-typed field, enforced by IR validation). */
export function projectionCorrIdClass(proj: ProjectionIR): string {
  const t = correlationField(proj).type;
  const inner = t.kind === "optional" ? t.inner : t;
  if (inner.kind !== "id") {
    throw new Error(`java projection-state: correlation field of '${proj.name}' must be id-typed`);
  }
  return `${inner.targetName}Id`;
}

/** The read-model row `@Entity` — correlation field as `@EmbeddedId`, the rest
 *  as nullable mapped columns, with a package-private no-arg ctor, an empty-seed
 *  `_allocate`, and record-style accessors + JavaBean setters. */
export function renderProjectionRowEntity(
  proj: ProjectionIR,
  ctx: EnrichedBoundedContextIR,
  basePkg: string,
  pkg: string,
  /** The projection's owning-context schema for the `@Table`.  Undefined ⇒
   *  unqualified, byte-identical. */
  schema?: string,
): string {
  const corr = proj.correlationField;
  // Non-key columns are nullable (partial upsert), so render every non-key
  // field as if optional — this drives the nullable column mapping AND leaves
  // `_allocate` an empty seed (no required non-key defaults).
  const stateOnly = proj.stateFields
    .filter((f) => f.name !== corr)
    .map((f) => ({ ...f, optional: true }) as FieldIR);
  const voLookup = new Map(ctx.valueObjects.map((v) => [v.name, v.fields] as const));
  // A projection row has no reference/value collections, so jpaFieldAnnotations
  // never touches `associations` — a bare owner satisfies the type.
  const owner = { name: proj.name, associations: [] } as unknown as EnrichedAggregateIR;
  const cls = projectionRowClass(proj);
  const idClass = projectionCorrIdClass(proj);

  const javaImports = new Set<string>();
  for (const f of proj.stateFields) collectJavaTypeImports(f.type, javaImports);

  const fieldLines: string[] = [
    `    @EmbeddedId`,
    `    @AttributeOverride(name = "value", column = @Column(name = "${snake(corr)}"))`,
    `    ${idClass} ${corr};`,
  ];
  for (const f of stateOnly) {
    fieldLines.push(...jpaFieldAnnotations(f, owner, { voLookup }));
    fieldLines.push(`    ${renderJavaType(f.type)} ${f.name};`);
  }

  // Empty-seed allocate factory — every non-key column is nullable, so a fresh
  // row is just the correlation key (the dispatcher's fold fills the rest as
  // events arrive).  Sets the package-private field directly (same class).
  const allocate = [
    `    public static ${cls} _allocate(${idClass} ${corr}) {`,
    `        var __s = new ${cls}();`,
    `        __s.${corr} = ${corr};`,
    `        return __s;`,
    `    }`,
    ``,
  ];

  const accessor = (type: string, name: string): string[] => [
    `    public ${type} ${name}() {`,
    `        return ${name};`,
    `    }`,
    ``,
  ];
  // Public setters for the non-key columns — the dispatcher's fold writes each
  // `:=` through these (`state.setStatus(...)`), the fields being package-private.
  // The correlation field stays write-only via `_allocate` (the immutable key).
  const setter = (type: string, name: string): string[] => [
    `    public void ${setterName(name)}(${type} ${name}) {`,
    `        this.${name} = ${name};`,
    `    }`,
    ``,
  ];
  const accessors = [
    ...accessor(idClass, corr),
    ...stateOnly.flatMap((f) => [
      ...accessor(renderJavaType(f.type), f.name),
      ...setter(renderJavaType(f.type), f.name),
    ]),
  ];

  const usesHibernateTypes = needsHibernateTypes(stateOnly);
  return lines(
    `package ${pkg};`,
    ``,
    ...[...javaImports].sort().map((i) => `import ${i};`),
    javaImports.size > 0 ? `` : null,
    usesHibernateTypes ? `import org.hibernate.annotations.JdbcTypeCode;` : null,
    usesHibernateTypes ? `import org.hibernate.type.SqlTypes;` : null,
    `import jakarta.persistence.*;`,
    ``,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    ``,
    ...jpaClassAnnotations(projectionRowTable(proj), { voLookup, schema }),
    `public class ${cls} {`,
    ...fieldLines,
    ``,
    `    ${cls}() {`,
    `    }`,
    ``,
    ...allocate,
    ...accessors,
    `}`,
    ``,
  );
}

/** The Spring Data repository over the read-model row, keyed by the correlation
 *  id — the load/save handle the dispatcher fold + the read routes go through. */
export function renderProjectionRowRepository(
  proj: ProjectionIR,
  basePkg: string,
  pkg: string,
  entityPkg: string,
): string {
  const cls = projectionRowClass(proj);
  const idClass = projectionCorrIdClass(proj);
  return lines(
    `package ${pkg};`,
    ``,
    `import org.springframework.data.jpa.repository.JpaRepository;`,
    ``,
    `import ${entityPkg}.${cls};`,
    `import ${basePkg}.domain.ids.${idClass};`,
    ``,
    `public interface ${cls}Repository extends JpaRepository<${cls}, ${idClass}> {`,
    `}`,
    ``,
  );
}
