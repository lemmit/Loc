import { forCreateInput, hasCreate } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedEntityPartIR,
  FieldIR,
  IdValueType,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { upperFirst } from "../../../util/naming.js";
import type { UnionMember } from "../../_payload/union-wire.js";
import {
  collectJavaExprImports,
  collectJavaTypeImports,
  type JavaRenderContext,
  renderJavaExpr,
  renderJavaType,
} from "../render-expr.js";
import { collectJavaStmtImports, renderJavaStatements } from "../render-stmt.js";
import {
  jpaClassAnnotations,
  jpaContainmentAnnotations,
  jpaFieldAnnotations,
  jpaIdAnnotations,
  jpaParentIdAnnotations,
  jpaSingleContainmentAnnotations,
  jpaSingleContainmentParentAnnotations,
  needsHibernateTypes,
} from "./jpa-annotations.js";

/** True for a field type that is a collection of references
 * (`Id<T>[]`) — persisted via a join table, not a column. */
function isRefCollection(t: TypeIR): boolean {
  return t.kind === "array" && t.element.kind === "id";
}

// ---------------------------------------------------------------------------
// Aggregate root + entity-part class emission for Java.
//
// Shape: a plain (non-final — Hibernate proxies) class with
// package-private fields, record-style public accessors (`name()`),
// a package-private no-arg constructor (JPA hydrates reflectively — no
// `State` class is needed, unlike .NET), a public `create(...)` factory
// gated on constructibility, `pullEvents()` drainage on roots, and a
// `_create(parentId, …fields)` positional factory on parts (the target
// of the renderer's `new <Part>` arm).  Mutation happens through fields
// (operations are methods ON the class; the aggregate writes through its
// containments because parts share its package in both layouts).
//
// Collection fields are non-final (Hibernate replaces them on load) but
// initialised inline; `_domainEvents` is `transient` so JPA ignores it
// without annotations.
// ---------------------------------------------------------------------------

/** Abstract-base info for a concrete subtype (`extends`).  Mirrors the
 *  dotnet SuperTypeInfo: `sharesIdentity` marks TPH (the concrete
 *  inherits the base's `<Base>Id`); TPC concretes keep their own id. */
export interface JavaSuperTypeInfo {
  readonly name: string;
  readonly fieldNames: ReadonlySet<string>;
  readonly derivedNames?: ReadonlySet<string>;
  readonly sharesIdentity?: boolean;
  readonly idValueType?: IdValueType;
  /** Package the base class lives in — imported when it differs from the
   *  concrete's package (byLayer puts each aggregate in its own
   *  per-plural package; base fields are `protected` for exactly this). */
  readonly pkg?: string;
}

export interface JavaEntityOptions {
  emitTrace?: boolean;
  superType?: JavaSuperTypeInfo;
  operationReturnUnions?: Map<string, { name: string; members: UnionMember[] }>;
  /** Event name → declared field order (from the context's EventIR) —
   *  threaded into the statement renderer so `emit` constructs records
   *  positionally in declaration order. */
  eventFields?: Map<string, readonly string[]>;
  /** JPA mapping inputs — when present the class is annotated against
   *  the Flyway-owned schema (`schemaFromModule` naming).  The
   *  orchestrator always passes it; absent only in focused unit tests. */
  persistence?: {
    /** This entity's table — `plural(snake(name))`. */
    tableName: string;
    schema?: string;
    /** Parts: the parent-FK column (`<snake(owner)>_id`). */
    parentFkColumn?: string;
    /** The aggregate that physically owns the parent table (differs from
     *  the root name for TPH concretes) — names containment FK columns. */
    containmentOwnerName?: string;
    /** Parts that are the target of a root-level *single* containment:
     *  the root entity class.  The part then carries the hidden owning
     *  `_parent` @OneToOne (JPA has no unidirectional one-to-one with
     *  the FK on the part table) and its `_create` factory takes the
     *  parent entity instead of the parent id. */
    oneToOneParentOf?: string;
    voLookup: ReadonlyMap<string, readonly FieldIR[]>;
  };
}

export function renderJavaEntity(
  entity: EnrichedAggregateIR | EnrichedEntityPartIR,
  isRoot: boolean,
  basePkg: string,
  /** Package this file lives in — resolved by the layout adapter. */
  pkg: string,
  rootName: string,
  options: JavaEntityOptions = {},
): string {
  const isAgg = (e: typeof entity): e is EnrichedAggregateIR => "operations" in e;
  const emitTrace = !!options.emitTrace;
  const superType = options.superType;
  const _idValueType = isAgg(entity) ? entity.idValueType : "guid";
  const idClass = superType?.sharesIdentity ? `${superType.name}Id` : `${entity.name}Id`;
  const operations = isAgg(entity) ? entity.operations : [];
  const createInputFieldList = isAgg(entity) ? forCreateInput(entity.fields) : [];
  const eventSourced = isAgg(entity) && entity.persistedAs === "eventLog";
  const appliers = isAgg(entity) ? (entity.appliers ?? []) : [];
  const esCreate = isAgg(entity) ? entity.creates?.[0] : undefined;
  const hasExtern = operations.some((o) => o.extern);

  const javaImports = new Set<string>(["java.util.List"]);
  for (const f of entity.fields) collectJavaTypeImports(f.type, javaImports);
  for (const d of entity.derived) {
    collectJavaExprImports(d.expr, javaImports);
    collectJavaTypeImports(d.type, javaImports);
  }
  for (const fn of entity.functions) {
    collectJavaExprImports(fn.body, javaImports);
    collectJavaTypeImports(fn.returnType, javaImports);
    for (const p of fn.params) collectJavaTypeImports(p.type, javaImports);
  }
  for (const inv of entity.invariants) {
    collectJavaExprImports(inv.expr, javaImports);
    if (inv.guard) collectJavaExprImports(inv.guard, javaImports);
  }
  for (const op of operations) {
    collectJavaStmtImports(op.statements, javaImports);
    for (const p of op.params) collectJavaTypeImports(p.type, javaImports);
    if (op.returnType) collectJavaTypeImports(op.returnType, javaImports);
  }
  for (const ap of appliers) collectJavaStmtImports(ap.statements, javaImports);
  if (esCreate) {
    collectJavaStmtImports(esCreate.statements, javaImports);
    for (const p of esCreate.params) collectJavaTypeImports(p.type, javaImports);
  }
  // Containment collections + the root's event list need ArrayList.
  if (
    isRoot ||
    entity.contains.some((c) => c.collection) ||
    entity.fields.some((f) => isRefCollection(f.type))
  ) {
    javaImports.add("java.util.ArrayList");
  }

  const renderCtx: JavaRenderContext = {
    thisName: "this",
    agg: isAgg(entity) ? entity : undefined,
    eventFields: options.eventFields,
  };
  const anyOpUsesCurrentUser = operations.some(operationUsesCurrentUser);

  // --- fields --------------------------------------------------------------
  const persistence = options.persistence;
  const fieldLines: string[] = [];
  if (!superType?.sharesIdentity) {
    if (persistence) fieldLines.push(...jpaIdAnnotations());
    fieldLines.push(`    ${idClass} id;`);
  }
  if (!isRoot) {
    if (persistence?.oneToOneParentOf && persistence.parentFkColumn) {
      fieldLines.push(...jpaSingleContainmentParentAnnotations(persistence.parentFkColumn));
      fieldLines.push(`    ${persistence.oneToOneParentOf} _parent;`);
    }
    if (persistence?.parentFkColumn) {
      fieldLines.push(...jpaParentIdAnnotations(persistence.parentFkColumn));
    }
    fieldLines.push(`    ${rootName}Id parentId;`);
  }
  for (const f of entity.fields) {
    if (superType?.fieldNames.has(f.name)) continue;
    if (persistence) fieldLines.push(...jpaFieldAnnotations(f, entity, persistence));
    if (isRefCollection(f.type)) {
      fieldLines.push(`    ${renderJavaType(f.type)} ${f.name} = new ArrayList<>();`);
    } else {
      fieldLines.push(`    ${renderJavaType(f.type)} ${f.name};`);
    }
  }
  for (const c of entity.contains) {
    if (c.collection) {
      if (persistence) {
        fieldLines.push(
          ...jpaContainmentAnnotations(persistence.containmentOwnerName ?? entity.name),
        );
      }
      fieldLines.push(`    List<${c.partName}> ${c.name} = new ArrayList<>();`);
    } else {
      // Inverse side of the part's hidden owning `_parent` @OneToOne
      // (part-declared single containments stay gated upstream:
      // loom.java-single-containment-unsupported).
      if (persistence) fieldLines.push(...jpaSingleContainmentAnnotations());
      fieldLines.push(`    ${c.partName} ${c.name};`);
    }
  }
  if (isRoot) {
    fieldLines.push("");
    fieldLines.push(
      `    private final transient List<DomainEvent> _domainEvents = new ArrayList<>();`,
    );
  }

  // --- accessors -----------------------------------------------------------
  const accessorLines: string[] = [];
  const accessor = (type: string, name: string, expr = name): void => {
    accessorLines.push(`    public ${type} ${name}() {`);
    accessorLines.push(`        return ${expr};`);
    accessorLines.push(`    }`);
    accessorLines.push("");
  };
  if (!superType?.sharesIdentity) accessor(idClass, "id");
  if (!isRoot) accessor(`${rootName}Id`, "parentId");
  for (const f of entity.fields) {
    if (superType?.fieldNames.has(f.name)) continue;
    if (isRefCollection(f.type)) {
      accessor(renderJavaType(f.type), f.name, `List.copyOf(${f.name})`);
    } else {
      accessor(renderJavaType(f.type), f.name);
    }
  }
  for (const c of entity.contains) {
    if (c.collection) {
      accessor(`List<${c.partName}>`, c.name, `List.copyOf(${c.name})`);
    } else {
      accessor(c.partName, c.name);
    }
  }

  // --- derived / functions ---------------------------------------------------
  const ownDerived = superType?.derivedNames
    ? entity.derived.filter((d) => !superType.derivedNames!.has(d.name))
    : entity.derived;
  const derivedLines = ownDerived.flatMap((d) => [
    `    public ${renderJavaType(d.type)} ${d.name}() {`,
    `        return ${renderJavaExpr(d.expr, renderCtx)};`,
    `    }`,
    ``,
  ]);
  // Roots with an `inspect` derived get a delegating toString — useful in
  // exceptions / debugger / log destructuring (mirrors .NET).
  if (isRoot && entity.derived.some((d) => d.name === "inspect")) {
    derivedLines.push(
      `    @Override`,
      `    public String toString() {`,
      `        return inspect();`,
      `    }`,
      ``,
    );
  }
  const fnLines = entity.functions.flatMap((fn) => {
    const params = fn.params.map((p) => `${renderJavaType(p.type)} ${p.name}`).join(", ");
    return [
      `    private ${renderJavaType(fn.returnType)} ${fn.name}(${params}) {`,
      `        return ${renderJavaExpr(fn.body, renderCtx)};`,
      `    }`,
      ``,
    ];
  });

  // --- operations ------------------------------------------------------------
  const opLines: string[] = [];
  for (const op of operations) {
    const usesUser = operationUsesCurrentUser(op);
    const baseParams = op.params.map((p) => `${renderJavaType(p.type)} ${p.name}`).join(", ");
    const params = [baseParams, usesUser ? "User currentUser" : ""].filter(Boolean).join(", ");
    const traceCtx = { emitTrace, aggregate: entity.name, op: op.name, eventSourced };
    if (op.extern) {
      // Extern op: `check<Op>` runs preconditions only; the user-supplied
      // handler owns the business decision (wired by the API slice).
      opLines.push(`    public void check${upperFirst(op.name)}(${params}) {`);
      const body = renderJavaStatements(op.statements, renderCtx, traceCtx);
      if (body.length > 0) opLines.push(body);
      opLines.push(`    }`);
      opLines.push("");
      continue;
    }
    const visibility = op.visibility === "public" ? "public" : "private";
    const retUnion = options.operationReturnUnions?.get(op.name);
    const retType = op.returnType ? renderJavaType(op.returnType) : "void";
    opLines.push(`    ${visibility} ${retType} ${op.name}(${params}) {`);
    const body = renderJavaStatements(
      op.statements,
      retUnion ? { ...renderCtx, returnUnion: retUnion } : renderCtx,
      traceCtx,
    );
    if (body.length > 0) opLines.push(body);
    if (!op.returnType) {
      opLines.push(
        emitTrace
          ? `        this._assertInvariants("${op.name}");`
          : `        this._assertInvariants();`,
      );
    }
    opLines.push(`    }`);
    opLines.push("");
  }

  // --- extern hooks / pullEvents ----------------------------------------------
  const externHookLines: string[] =
    isRoot && hasExtern
      ? [
          `    /** Raise a domain event from a user-supplied extern handler. */`,
          `    public void _raiseEvent(DomainEvent ev) {`,
          `        _domainEvents.add(ev);`,
          `    }`,
          ``,
        ]
      : [];
  const pullEventsLines = isRoot
    ? [
        `    public List<DomainEvent> pullEvents() {`,
        `        var copy = List.copyOf(_domainEvents);`,
        `        _domainEvents.clear();`,
        `        return copy;`,
        `    }`,
        ``,
      ]
    : [];

  // --- event-sourcing fold (appliers) ------------------------------------------
  const applierLines: string[] = [];
  if (isRoot && eventSourced && appliers.length > 0) {
    for (const ap of appliers) {
      applierLines.push(`    private void _apply${ap.event}(${ap.event} ${ap.param}) {`);
      const body = renderJavaStatements(ap.statements, renderCtx, {
        emitTrace,
        aggregate: entity.name,
        op: `apply(${ap.event})`,
        eventSourced,
      });
      if (body.length > 0) applierLines.push(body);
      applierLines.push(`    }`);
      applierLines.push("");
    }
    applierLines.push(`    void _apply(DomainEvent ev) {`);
    applierLines.push(`        switch (ev) {`);
    for (const ap of appliers) {
      applierLines.push(`            case ${ap.event} e -> _apply${ap.event}(e);`);
    }
    applierLines.push(`            default -> { }`);
    applierLines.push(`        }`);
    applierLines.push(`    }`);
    applierLines.push("");
    applierLines.push(
      `    public static ${entity.name} _fromEvents(${idClass} id, List<DomainEvent> events) {`,
    );
    applierLines.push(`        var e = new ${entity.name}();`);
    applierLines.push(`        e.id = id;`);
    applierLines.push(`        for (var ev : events) e._apply(ev);`);
    applierLines.push(
      emitTrace ? `        e._assertInvariants("<init>");` : `        e._assertInvariants();`,
    );
    applierLines.push(`        return e;`);
    applierLines.push(`    }`);
    applierLines.push("");
  }

  // --- event-sourced construction ----------------------------------------------
  const esCreateFactoryLines: string[] =
    isRoot && eventSourced && esCreate
      ? [
          `    public static ${entity.name} create(${esCreate.params
            .map((p) => `${renderJavaType(p.type)} ${p.name}`)
            .join(", ")}) {`,
          `        var e = new ${entity.name}();`,
          `        e.id = ${idClass}.newId();`,
          `        e._init(${esCreate.params.map((p) => p.name).join(", ")});`,
          `        return e;`,
          `    }`,
          ``,
          `    private void _init(${esCreate.params
            .map((p) => `${renderJavaType(p.type)} ${p.name}`)
            .join(", ")}) {`,
          renderJavaStatements(esCreate.statements, renderCtx, {
            emitTrace,
            aggregate: entity.name,
            op: esCreate.name,
            eventSourced,
          }),
          `    }`,
          ``,
        ]
      : [];

  // --- invariants -----------------------------------------------------------------
  const invariantLines = entity.invariants.flatMap((inv, i) => {
    const thrown = `throw new DomainException(${JSON.stringify(`Invariant violated: ${inv.source}`)})`;
    if (!emitTrace) {
      const check = inv.guard
        ? `if ((${renderJavaExpr(inv.guard, renderCtx)}) && !(${renderJavaExpr(inv.expr, renderCtx)}))`
        : `if (!(${renderJavaExpr(inv.expr, renderCtx)}))`;
      return [`        ${check} ${thrown};`];
    }
    const ok = `__inv_${i}_ok`;
    const traceCall = `DomainLog.trace("invariant_evaluated", "${entity.name}", __op, ${JSON.stringify(inv.source)}, ${ok});`;
    if (inv.guard) {
      return [
        `        if (${renderJavaExpr(inv.guard, renderCtx)}) {`,
        `            var ${ok} = (${renderJavaExpr(inv.expr, renderCtx)});`,
        `            ${traceCall}`,
        `            if (!${ok}) ${thrown};`,
        `        }`,
      ];
    }
    return [
      `        var ${ok} = (${renderJavaExpr(inv.expr, renderCtx)});`,
      `        ${traceCall}`,
      `        if (!${ok}) ${thrown};`,
    ];
  });
  const assertLines = [
    `    public void _assertInvariants(${emitTrace ? "String __op" : ""}) {`,
    ...invariantLines,
    `    }`,
  ];

  // --- factories --------------------------------------------------------------------
  // Public create — constructible, state-based roots only (event-sourced
  // construction goes through the `_init` emit-and-fold path above).
  const createPublicLines: string[] =
    isRoot && isAgg(entity) && hasCreate(entity) && !eventSourced
      ? [
          `    public static ${entity.name} create(${createInputFieldList
            .map((f) => `${renderJavaType(f.type)} ${f.name}`)
            .join(", ")}) {`,
          `        var e = new ${entity.name}();`,
          `        e.id = ${idClass}.newId();`,
          ...createInputFieldList.map((f) => `        e.${f.name} = ${f.name};`),
          emitTrace ? `        e._assertInvariants("<init>");` : `        e._assertInvariants();`,
          `        return e;`,
          `    }`,
          ``,
        ]
      : [];
  // Part factory — the target of the renderer's `new <Part>` arm:
  // positional (parent first, then every declared field in order).
  // Single-containment parts take the parent *entity* (the hidden
  // owning `_parent` @OneToOne needs the instance); collection parts
  // take the parent id (their FK is written by the root's @JoinColumn).
  const oneToOneParent = persistence?.oneToOneParentOf;
  const partFactoryLines: string[] = !isRoot
    ? [
        `    public static ${entity.name} _create(${[
          oneToOneParent ? `${oneToOneParent} parent` : `${rootName}Id parentId`,
          ...entity.fields.map((f) => `${renderJavaType(f.type)} ${f.name}`),
        ].join(", ")}) {`,
        `        var p = new ${entity.name}();`,
        `        p.id = ${entity.name}Id.newId();`,
        ...(oneToOneParent
          ? [`        p._parent = parent;`, `        p.parentId = parent.id();`]
          : [`        p.parentId = parentId;`]),
        ...entity.fields.map((f) => `        p.${f.name} = ${f.name};`),
        emitTrace ? `        p._assertInvariants("<init>");` : `        p._assertInvariants();`,
        `        return p;`,
        `    }`,
        ``,
      ]
    : [];

  const jmolecules = isRoot
    ? "@org.jmolecules.ddd.annotation.AggregateRoot"
    : // jakarta.persistence.Entity shares the simple name — keep both
      // fully-qualified on parts so neither import shadows the other.
      "@org.jmolecules.ddd.annotation.Entity";

  const body = [
    ...derivedLines,
    ...fnLines,
    ...opLines,
    ...externHookLines,
    ...pullEventsLines,
    ...assertLines,
    "",
    ...createPublicLines,
    ...partFactoryLines,
    ...applierLines,
    ...esCreateFactoryLines,
  ];
  while (body.length > 0 && body[body.length - 1] === "") body.pop();

  const usesHibernateTypes = persistence && needsHibernateTypes(entity.fields);
  return lines(
    `package ${pkg};`,
    ``,
    ...[...javaImports].sort().map((i) => `import ${i};`),
    ``,
    persistence ? `import jakarta.persistence.*;` : null,
    usesHibernateTypes ? `import org.hibernate.annotations.JdbcTypeCode;` : null,
    usesHibernateTypes ? `import org.hibernate.type.SqlTypes;` : null,
    persistence ? `` : null,
    `import ${basePkg}.domain.common.*;`,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.events.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    anyOpUsesCurrentUser ? `import ${basePkg}.auth.User;` : null,
    superType?.pkg && superType.pkg !== pkg ? `import ${superType.pkg}.${superType.name};` : null,
    ``,
    persistence
      ? jpaClassAnnotations(persistence.tableName, {
          schema: persistence.schema,
          voLookup: persistence.voLookup,
        })
      : null,
    jmolecules,
    `public class ${entity.name}${superType ? ` extends ${superType.name}` : ""} {`,
    ...fieldLines,
    ``,
    `    ${entity.name}() {`,
    `    }`,
    ``,
    ...accessorLines,
    ...body,
    `}`,
    ``,
  );
}

/** The abstract base class for TPC / TPH hierarchies.  TPH bases own the
 *  shared `<Base>Id`; TPC bases are id-less (each concrete keeps its own
 *  typed id).  Fields are package-private like every entity; accessors
 *  public. */
export function renderJavaAbstractBaseEntity(
  base: EnrichedAggregateIR,
  basePkg: string,
  pkg: string,
  options: {
    tph?: boolean;
    persistence?: { schema?: string; voLookup: ReadonlyMap<string, readonly FieldIR[]> };
  } = {},
): string {
  const renderCtx: JavaRenderContext = { thisName: "this", agg: base };
  const persistence = options.persistence;
  const javaImports = new Set<string>();
  for (const f of base.fields) collectJavaTypeImports(f.type, javaImports);
  for (const d of base.derived) {
    collectJavaExprImports(d.expr, javaImports);
    collectJavaTypeImports(d.type, javaImports);
  }
  // `protected` — concretes may live in a different package (byLayer)
  // and their factories / operations write through these fields.
  const idLines = options.tph ? [`    protected ${base.name}Id id;`] : [];
  const idAccessor = options.tph
    ? [`    public ${base.name}Id id() {`, `        return id;`, `    }`, ``]
    : [];
  const fieldLines = base.fields.flatMap((f) => [
    // TPC bases are @MappedSuperclass — their column mappings flatten
    // into each concrete's own table (the schema merges base + own
    // fields per concrete), so annotate here and the concretes inherit.
    ...(persistence && !options.tph
      ? jpaFieldAnnotations(f, base, { schema: persistence.schema, voLookup: persistence.voLookup })
      : []),
    `    protected ${renderJavaType(f.type)} ${f.name};`,
  ]);
  const accessorLines = base.fields.flatMap((f) => [
    `    public ${renderJavaType(f.type)} ${f.name}() {`,
    `        return ${f.name};`,
    `    }`,
    ``,
  ]);
  const derivedLines = base.derived.flatMap((d) => [
    `    public ${renderJavaType(d.type)} ${d.name}() {`,
    `        return ${renderJavaExpr(d.expr, renderCtx)};`,
    `    }`,
    ``,
  ]);
  const body = [...accessorLines, ...derivedLines];
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  return lines(
    `package ${pkg};`,
    ``,
    ...[...javaImports].sort().map((i) => `import ${i};`),
    javaImports.size > 0 ? `` : null,
    persistence ? `import jakarta.persistence.*;` : null,
    persistence && needsHibernateTypes(base.fields)
      ? `import org.hibernate.annotations.JdbcTypeCode;`
      : null,
    persistence && needsHibernateTypes(base.fields) ? `import org.hibernate.type.SqlTypes;` : null,
    persistence ? `` : null,
    `import ${basePkg}.domain.common.*;`,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    ``,
    options.tph
      ? `// Abstract TPH base — the hierarchy maps to one shared table owning the id.`
      : `// Abstract TPC base — never instantiated; each concrete maps base + own`,
    options.tph ? null : `// columns onto its own table (JPA @MappedSuperclass).`,
    persistence && !options.tph ? `@MappedSuperclass` : null,
    `public abstract class ${base.name} {`,
    ...idLines,
    ...fieldLines,
    ``,
    ...idAccessor,
    ...body,
    `}`,
    ``,
  );
}
