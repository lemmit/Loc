import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  FieldIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { collectJavaTypeImports, renderJavaType } from "../render-expr.js";
import {
  jpaClassAnnotations,
  jpaFieldAnnotations,
  needsHibernateTypes,
} from "./jpa-annotations.js";

// ---------------------------------------------------------------------------
// Persisted workflow-correlation state (Java / JPA) — the saga-instance row
// keyed by the correlation field, with the remaining state fields as columns.
// The Java counterpart of dotnet's `workflow-state-emit.ts`: a `@Entity` bound
// to the Flyway-owned `plural(snake(wf.name))` table (DDL derived
// platform-neutrally by `workflowStateTableShape` in the migrations builder)
// plus a Spring Data `JpaRepository` over it.  This is the persistence
// foundation the in-process dispatcher (load-or-allocate / route-or-drop) and
// the read-only instance endpoints build on — slice 1 of the Java saga track
// (docs/plans/workflow-debt-backend-parity.md).
//
// Field mapping mirrors the aggregate entity emitter (jpa-annotations.ts):
// `X id` → `@Embedded`/`@EmbeddedId` record over one column, enums →
// `@Enumerated(STRING)`, scalars → `@Column`.  Fields are package-private with
// record-style public accessors, exactly like aggregate entities.
// ---------------------------------------------------------------------------

/** Workflows that carry a persisted correlation row (the saga state table). */
export function correlationWorkflows(workflows: readonly WorkflowIR[]): WorkflowIR[] {
  return workflows.filter((wf) => !!wf.correlationField);
}

/** The state entity class name (`OrderFulfillmentState`). */
export function workflowStateClass(wf: WorkflowIR): string {
  return `${upperFirst(wf.name)}State`;
}

/** The JavaBean setter name for a state field (`attempts` → `setAttempts`) —
 *  the write seam a workflow body's own-state `:=` targets. */
export function setterName(field: string): string {
  return `set${upperFirst(field)}`;
}

/** The saga table name — matches `workflowStateTableShape` in the migrations
 *  builder and dotnet's `workflowStateTable`. */
export function workflowStateTable(wf: WorkflowIR): string {
  return plural(snake(wf.name));
}

function correlationField(wf: WorkflowIR): FieldIR {
  const corr = wf.correlationField as string;
  const f = (wf.stateFields ?? []).find((x) => x.name === corr);
  if (!f) {
    throw new Error(
      `java saga-state: correlation field '${corr}' not among '${wf.name}' stateFields`,
    );
  }
  return f;
}

/** The correlation field's id class (`OrderId`) — it is always id-shaped (the
 *  IR validator enforces exactly one id-shaped state field as the key). */
function corrIdClass(wf: WorkflowIR): string {
  const t = correlationField(wf).type;
  const inner = t.kind === "optional" ? t.inner : t;
  if (inner.kind !== "id") {
    throw new Error(`java saga-state: correlation field of '${wf.name}' must be id-typed`);
  }
  return `${inner.targetName}Id`;
}

/** The saga-state `@Entity` — correlation field as `@EmbeddedId`, the rest as
 *  mapped columns, with a package-private no-arg ctor + public accessors. */
export function renderWorkflowStateEntity(
  wf: WorkflowIR,
  ctx: EnrichedBoundedContextIR,
  basePkg: string,
  pkg: string,
  /** The workflow's owning-context schema for the saga-state `@Table`.
   *  Undefined ⇒ unqualified, byte-identical. */
  schema?: string,
): string {
  const corr = wf.correlationField as string;
  const fields = wf.stateFields ?? [];
  const stateOnly = fields.filter((f) => f.name !== corr);
  const voLookup = new Map(ctx.valueObjects.map((v) => [v.name, v.fields] as const));
  // Saga state has no reference/value collections, so jpaFieldAnnotations never
  // touches `associations` — a bare owner satisfies the type.
  const owner = { name: wf.name, associations: [] } as unknown as EnrichedAggregateIR;

  const javaImports = new Set<string>();
  for (const f of fields) collectJavaTypeImports(f.type, javaImports);

  const fieldLines: string[] = [
    `    @EmbeddedId`,
    `    @AttributeOverride(name = "value", column = @Column(name = "${snake(corr)}"))`,
    `    ${corrIdClass(wf)} ${corr};`,
  ];
  for (const f of stateOnly) {
    fieldLines.push(...jpaFieldAnnotations(f, owner, { voLookup }));
    fieldLines.push(`    ${renderJavaType(f.type)} ${f.name};`);
  }

  // Public allocate factory — the dispatcher (a different package) seeds a new
  // saga row keyed by the correlation id, with typed defaults for every
  // required non-correlation state field (optional fields stay null).  Sets the
  // package-private fields directly (same class), so no setters are exposed.
  const allocateSeeds = stateOnly
    .filter((f) => !(f.optional || f.type.kind === "optional"))
    .map((f) => `        __s.${f.name} = ${javaStateDefault(f, ctx)};`);
  const allocate = [
    `    public static ${workflowStateClass(wf)} _allocate(${corrIdClass(wf)} ${corr}) {`,
    `        var __s = new ${workflowStateClass(wf)}();`,
    `        __s.${corr} = ${corr};`,
    ...allocateSeeds,
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
  // Public setters for the non-correlation state fields — a workflow body's
  // own-state `:=` (`attempts := 1`) writes through these from the dispatcher
  // package (the fields themselves are package-private, so a cross-package
  // direct write wouldn't compile).  The correlation field stays write-only via
  // `_allocate` (it's the immutable key).  Mirrors dotnet's `{ get; set; }`.
  const setter = (type: string, name: string): string[] => [
    `    public void ${setterName(name)}(${type} ${name}) {`,
    `        this.${name} = ${name};`,
    `    }`,
    ``,
  ];
  const accessors = [
    ...accessor(corrIdClass(wf), corr),
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
    ...jpaClassAnnotations(workflowStateTable(wf), { voLookup, schema }),
    `public class ${workflowStateClass(wf)} {`,
    ...fieldLines,
    ``,
    `    ${workflowStateClass(wf)}() {`,
    `    }`,
    ``,
    ...allocate,
    ...accessors,
    `}`,
    ``,
  );
}

/** A typed Java zero for a required saga-state column at allocation — the Java
 *  analogue of dotnet's `csStateDefault` / python's `zeroFor`.  The correlation
 *  field is seeded from the routing key, never this.  Shared with the
 *  event-sourced fold class (`_fromEvents` seeds required non-corr fields). */
export function javaStateDefault(f: FieldIR, ctx: EnrichedBoundedContextIR): string {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
        return "0";
      case "long":
        return "0L";
      case "decimal":
      case "money":
        return "java.math.BigDecimal.ZERO";
      case "bool":
        return "false";
      case "datetime":
        return "java.time.Instant.now()";
      default:
        return '""';
    }
  }
  if (t.kind === "enum") {
    const e = ctx.enums.find((x) => x.name === t.name);
    const first = e?.values[0];
    return first ? `${t.name}.${first}` : "null";
  }
  // `X id` non-correlation state field — uncommon; left null (optional in
  // practice; a required one would need an explicit seed the model doesn't give).
  return "null";
}

/** The Spring Data repository over the saga-state entity, keyed by the
 *  correlation id — the read-model handle the dispatcher + instance endpoints
 *  load/save through. */
export function renderWorkflowStateRepository(
  wf: WorkflowIR,
  basePkg: string,
  pkg: string,
  entityPkg: string,
): string {
  const cls = workflowStateClass(wf);
  const idClass = corrIdClass(wf);
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
