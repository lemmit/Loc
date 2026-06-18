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

  const accessor = (type: string, name: string): string[] => [
    `    public ${type} ${name}() {`,
    `        return ${name};`,
    `    }`,
    ``,
  ];
  const accessors = [
    ...accessor(corrIdClass(wf), corr),
    ...stateOnly.flatMap((f) => accessor(renderJavaType(f.type), f.name)),
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
    ...jpaClassAnnotations(workflowStateTable(wf), { voLookup }),
    `public class ${workflowStateClass(wf)} {`,
    ...fieldLines,
    ``,
    `    ${workflowStateClass(wf)}() {`,
    `    }`,
    ``,
    ...accessors,
    `}`,
    ``,
  );
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
