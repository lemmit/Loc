import { forCreateInput, hasCreate } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedEntityPartIR,
  ExprIR,
  FieldIR,
  IdValueType,
  StmtIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake } from "../../../util/naming.js";
import type { UnionMember } from "../../_payload/union-wire.js";
import type { SourceMapSubRegion } from "../../_trace/sourcemap.js";
import { promotedFilters, sqlRestrictionFilters } from "../capability-filter.js";
import {
  buildJavaRegexFields,
  collectJavaExprImports,
  collectJavaRegexLiterals,
  collectJavaTypeImports,
  type JavaRenderContext,
  renderJavaExpr,
  renderJavaType,
} from "../render-expr.js";
import { renderSqlRestriction } from "../render-sql-restriction.js";
import {
  collectJavaStmtImports,
  renderJavaStatementChunks,
  renderJavaStatements,
  statementSubRegions,
} from "../render-stmt.js";
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

/** True when an expression tree contains a domain-service member call
 *  (`Pricing.quote(...)` → a `call` with `callKind: "domain-service"`).
 *  Drives the `domain.services.*` import on the calling entity. */
function exprCallsDomainService(e: ExprIR | undefined): boolean {
  if (!e) return false;
  if (e.kind === "call") {
    if (e.callKind === "domain-service") return true;
    return e.args.some(exprCallsDomainService);
  }
  switch (e.kind) {
    case "method-call":
      return exprCallsDomainService(e.receiver) || e.args.some(exprCallsDomainService);
    case "member":
      return exprCallsDomainService(e.receiver);
    case "binary":
      return exprCallsDomainService(e.left) || exprCallsDomainService(e.right);
    case "ternary":
      return (
        exprCallsDomainService(e.cond) ||
        exprCallsDomainService(e.then) ||
        exprCallsDomainService(e.otherwise)
      );
    case "unary":
      return exprCallsDomainService(e.operand);
    case "paren":
      return exprCallsDomainService(e.inner);
    case "lambda":
      return exprCallsDomainService(e.body);
    case "new":
    case "object":
      return e.fields.some((f) => exprCallsDomainService(f.value));
  }
  return false;
}

/** True when any statement in a body invokes a domain service. */
function stmtCallsDomainService(s: StmtIR): boolean {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      return exprCallsDomainService(s.expr);
    case "assign":
    case "add":
    case "remove":
    case "return":
      return exprCallsDomainService(s.value);
    case "emit":
      return s.fields.some((f) => exprCallsDomainService(f.value));
    case "call":
      return s.args.some(exprCallsDomainService);
  }
  return false;
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

/** One operation body's exact emitted text plus its per-statement
 *  sub-regions — surfaced by `renderJavaEntity` (when `opFragments` is
 *  passed via `JavaEntityOptions`) to the caller that owns the recorder and
 *  the final file content (`src/generator/java/index.ts`), which anchors it
 *  via `SourceMapRecorder.fragment`.  Covers only the REGULAR (non-extern)
 *  operation-body path — see the call site in `renderJavaEntity` below. */
export interface OpFragment {
  fragmentText: string;
  subRegions: SourceMapSubRegion[];
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
    /** Parts: the DIRECT parent entity's name (the aggregate root for a
     *  root-level part, the sibling part for a nested one).  Types the
     *  read-only `parentId` mirror + the collection `_create` factory's
     *  parent-id arg.  Defaults to the root name, so root-level output is
     *  unchanged. */
    parentEntityName?: string;
    /** The aggregate that physically owns the parent table (differs from
     *  the root name for TPH concretes) — names containment FK columns. */
    containmentOwnerName?: string;
    /** Parts that are the target of a *single* containment: the declaring
     *  entity class (the root, or a sibling part for a nested single).  The
     *  part then carries the hidden owning `_parent` @OneToOne (JPA has no
     *  unidirectional one-to-one with the FK on the part table) and its
     *  `_create` factory takes the parent entity instead of the parent id. */
    oneToOneParentOf?: string;
    /** `shape(embedded)`: containments + reference collections fold
     *  into jsonb columns (no part / join tables); the Hibernate JSON
     *  FormatMapper handles the package-private-field part classes. */
    embedded?: boolean;
    voLookup: ReadonlyMap<string, readonly FieldIR[]>;
  };
  /** The §11.6 PROMOTED non-principal capabilities for this aggregate — those
   *  some read `ignoring`s.  A promoted capability's filter(s) leave the
   *  always-on `@SQLRestriction` and become a bypassable Hibernate named filter
   *  (`@FilterDef` + `@Filter`).  Empty / absent → today's behaviour (every
   *  non-principal cap rides `@SQLRestriction`).  Derived by the orchestrator
   *  from the context's read-decls (`capability-filter.ts`). */
  promotedCaps?: ReadonlySet<string>;
  /** `${ctx.name}.${agg.name}` — construct-id prefix for this aggregate's
   *  own operation bodies (source-map Milestone 3).  Only consulted when
   *  `opFragments` is also passed; entity parts never carry operations, so
   *  neither is ever needed for a part render call. */
  construct?: string;
  /** Collector for per-statement sub-regions across this entity's REGULAR
   *  (non-extern) operation bodies — allocated by the caller only when a
   *  `SourceMapRecorder` is threaded in (zero cost otherwise). */
  opFragments?: OpFragment[];
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
    if ("expr" in fn.body) collectJavaExprImports(fn.body.expr, javaImports);
    else collectJavaStmtImports(fn.body.stmts, javaImports);
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

  // Hoist `string.matches("…")` regex literals (invariants / derived / pure
  // expr-functions — the per-create/update hot path) into reusable
  // `private static final Pattern` fields instead of recompiling on every
  // evaluation.  Statement-body matches keep the inline-compile default.
  const regexLiterals = new Set<string>();
  for (const inv of entity.invariants) {
    collectJavaRegexLiterals(inv.expr, regexLiterals);
    if (inv.guard) collectJavaRegexLiterals(inv.guard, regexLiterals);
  }
  for (const d of entity.derived) collectJavaRegexLiterals(d.expr, regexLiterals);
  for (const fn of entity.functions) {
    if ("expr" in fn.body) collectJavaRegexLiterals(fn.body.expr, regexLiterals);
  }
  const regex = buildJavaRegexFields(regexLiterals);

  const renderCtx: JavaRenderContext = {
    thisName: "this",
    agg: isAgg(entity) ? entity : undefined,
    eventFields: options.eventFields,
    regexFields: regex.fields,
  };
  const anyOpUsesCurrentUser = operations.some(operationUsesCurrentUser);
  // A body that calls a domain service (`Pricing.quote(...)`) needs the
  // `domain.services.*` import so the generated static class resolves.
  const callsDomainService =
    operations.some((op) => op.statements.some(stmtCallsDomainService)) ||
    appliers.some((ap) => ap.statements.some(stmtCallsDomainService)) ||
    (esCreate ? esCreate.statements.some(stmtCallsDomainService) : false) ||
    entity.derived.some((d) => exprCallsDomainService(d.expr)) ||
    entity.functions.some((fn) =>
      "expr" in fn.body
        ? exprCallsDomainService(fn.body.expr)
        : fn.body.stmts.some(stmtCallsDomainService),
    ) ||
    entity.invariants.some(
      (inv) => exprCallsDomainService(inv.expr) || exprCallsDomainService(inv.guard),
    );

  // --- lifecycle-stamp auditing (audit / softDelete capability stamps) --------
  // `contextStamps` (from `stamp onCreate`/`onUpdate`, hand-written or
  // macro-emitted by `with auditable`) drive idiomatic Spring Data JPA
  // auditing rather than a service-called stamp method: each stamped field is
  // annotated so the AuditingEntityListener fills it at persist/flush time —
  // a `now()`-valued stamp → @CreatedDate/@LastModifiedDate (the framework
  // clock); a `currentUser`-valued stamp → @CreatedBy/@LastModifiedBy (the
  // AuditorAware<UUID> bean).  create-event fields are `updatable = false`
  // (set once, on INSERT).  Event-sourced aggregates and principal stamps
  // without auth are gated upstream (loom.java-stamp-unsupported).  See §5b of
  // docs/old/plans/capability-stamp-dedup-simulation.md.
  // A CLAIM-valued principal stamp (`tenantId := currentUser.tenantId`) cannot
  // ride @CreatedBy/@LastModifiedBy — the AuditorAware<UUID> bean injects the
  // actor ID, not the claim (a String claim column would get the actor guid,
  // and the tenancy read filter would never match a stamped row).  Those
  // assignments are triaged out of the annotation path into explicit
  // @PrePersist/@PreUpdate lifecycle hooks reading the ambient principal off
  // CurrentUserAccessor (the same holder the repository's SpEL principal
  // filter resolves through), null-safe so a non-request (seed / system) save
  // stays unstamped.  Bare `currentUser` keeps the annotation path unchanged.
  const auditAnnotationFor = new Map<string, { annotation: string; createEvent: boolean }>();
  const claimStampColumnFor = new Map<string, { createEvent: boolean }>();
  const claimStamps: { field: string; value: ExprIR; createEvent: boolean }[] = [];
  if (isRoot && isAgg(entity)) {
    for (const rule of entity.contextStamps ?? []) {
      const createEvent = rule.event === "create";
      for (const a of rule.assignments) {
        const principal = exprUsesCurrentUser(a.value);
        const bare = a.value.kind === "ref" && a.value.refKind === "current-user";
        if (principal && !bare) {
          claimStampColumnFor.set(a.field, { createEvent });
          claimStamps.push({ field: a.field, value: a.value, createEvent });
          continue;
        }
        const annotation = principal
          ? createEvent
            ? "CreatedBy"
            : "LastModifiedBy"
          : createEvent
            ? "CreatedDate"
            : "LastModifiedDate";
        auditAnnotationFor.set(a.field, { annotation, createEvent });
      }
    }
  }
  const isAuditable = auditAnnotationFor.size > 0;

  // --- fields --------------------------------------------------------------
  const persistence = options.persistence;
  const fieldLines: string[] = [];
  // Hoisted regex patterns first (static finals, compiled once).
  if (regex.decls.length > 0) {
    javaImports.add("java.util.regex.Pattern");
    for (const d of regex.decls) fieldLines.push(`    ${d}`);
  }
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
    fieldLines.push(`    ${persistence?.parentEntityName ?? rootName}Id parentId;`);
  }
  for (const f of entity.fields) {
    if (superType?.fieldNames.has(f.name)) continue;
    const audit = auditAnnotationFor.get(f.name);
    if (audit) {
      // Spring Data auditing field: the @Created*/@LastModified* annotation
      // drives the value; the @Column keeps the explicit snake_case binding
      // against the Flyway-owned schema (`updatable = false` on create-event
      // columns, which are set once on INSERT).
      fieldLines.push(`    @${audit.annotation}`);
      if (persistence) {
        fieldLines.push(
          `    @Column(name = "${snake(f.name)}"${audit.createEvent ? ", updatable = false" : ""})`,
        );
      }
      fieldLines.push(`    ${renderJavaType(f.type)} ${f.name};`);
      continue;
    }
    const claimColumn = claimStampColumnFor.get(f.name);
    if (claimColumn) {
      // Claim-stamped field: filled by the @PrePersist/@PreUpdate hook (no
      // Spring auditing annotation); the @Column keeps the explicit snake_case
      // binding (`updatable = false` on create-event columns, set once on
      // INSERT — same column semantics as the annotation path).
      if (persistence) {
        fieldLines.push(
          `    @Column(name = "${snake(f.name)}"${claimColumn.createEvent ? ", updatable = false" : ""})`,
        );
      }
      fieldLines.push(`    ${renderJavaType(f.type)} ${f.name};`);
      continue;
    }
    // Optimistic concurrency (`versioned`): the synthetic `version` token field
    // becomes the JPA `@Version` column — Hibernate adds `WHERE version = ?` to
    // UPDATEs and increments it, raising ObjectOptimisticLockingFailureException
    // on a stale write.  In the Java backend the domain aggregate class IS the
    // JPA @Entity, so @Version lands beside the existing @Column (a TPH/TPC base
    // carries it once; the concrete subclass skips inherited fields above).
    if (persistence && isAgg(entity) && aggregateIsVersioned(entity) && f.access === "token") {
      fieldLines.push(`    @Version`);
    }
    if (persistence) fieldLines.push(...jpaFieldAnnotations(f, entity, persistence));
    if (isRefCollection(f.type)) {
      fieldLines.push(`    ${renderJavaType(f.type)} ${f.name} = new ArrayList<>();`);
    } else {
      fieldLines.push(`    ${renderJavaType(f.type)} ${f.name};`);
    }
  }
  for (const c of entity.contains) {
    // `shape(embedded)`: the containment folds into a jsonb column —
    // the parts serialize inline (no part table, no relation).
    if (persistence?.embedded) {
      fieldLines.push(
        `    @JdbcTypeCode(SqlTypes.JSON)`,
        `    @Column(name = "${snake(c.name)}", nullable = false)`,
      );
      fieldLines.push(
        c.collection
          ? `    List<${c.partName}> ${c.name} = new ArrayList<>();`
          : `    ${c.partName} ${c.name};`,
      );
      continue;
    }
    if (c.collection) {
      if (persistence) {
        fieldLines.push(
          ...jpaContainmentAnnotations(persistence.containmentOwnerName ?? entity.name),
        );
      }
      fieldLines.push(`    List<${c.partName}> ${c.name} = new ArrayList<>();`);
    } else {
      // Inverse side of the part's hidden owning `_parent` @OneToOne — emitted
      // for the declaring entity whether it's the root or a sibling part (a
      // nested part's owning side FKs to this entity's table via `directParentOf`).
      if (persistence) fieldLines.push(...jpaSingleContainmentAnnotations());
      fieldLines.push(`    ${c.partName} ${c.name};`);
    }
  }
  // Provenance runtime (provenance.md): each `provenanced` ROOT field carries a
  // co-located `<field>Provenance` lineage field (persisted on the row via a
  // jsonb column — Hibernate's JSON FormatMapper) holding the lineage of its
  // current value; `_provTraces` buffers every write's lineage for the
  // repository to drain into provenance_records inside the save transaction.
  // Root-only — operations (the write sites) live on the root; a containment
  // write-through carries no co-located slot (render-stmt's segment guard).
  const provFields = isRoot ? entity.fields.filter((f) => f.provenanced) : [];
  if (provFields.length > 0) {
    fieldLines.push("");
    for (const f of provFields) {
      if (persistence) {
        fieldLines.push(`    @JdbcTypeCode(SqlTypes.JSON)`);
        fieldLines.push(`    @Column(name = "${snake(f.name)}_provenance")`);
      }
      fieldLines.push(`    ProvLineage ${f.name}Provenance;`);
    }
    fieldLines.push(
      `    private final transient List<ProvLineage> _provTraces = new ArrayList<>();`,
    );
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
  if (!isRoot) accessor(`${persistence?.parentEntityName ?? rootName}Id`, "parentId");
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
  // Co-located provenance lineage accessor (current value's lineage; null
  // before the field's first provenanced write) — surfaced on the wire DTO.
  for (const f of provFields) {
    accessor("ProvLineage", `${f.name}Provenance`);
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
    const open = `    private ${renderJavaType(fn.returnType)} ${fn.name}(${params}) {`;
    // Expression form keeps its single `return expr;`; block form
    // (domain-services.md rev. 4) emits its lowered statements.
    const bodyLine =
      "expr" in fn.body
        ? `        return ${renderJavaExpr(fn.body.expr, renderCtx)};`
        : renderJavaStatements(fn.body.stmts, renderCtx);
    return [open, bodyLine, `    }`, ``];
  });

  // --- operations ------------------------------------------------------------
  const opLines: string[] = [];
  for (const op of operations) {
    const usesUser = operationUsesCurrentUser(op);
    const baseParams = op.params.map((p) => `${renderJavaType(p.type)} ${p.name}`).join(", ");
    const params = [baseParams, usesUser ? "User currentUser" : ""].filter(Boolean).join(", ");
    const traceCtx = { emitTrace, aggregate: entity.name, op: op.name, eventSourced };
    if (op.extern) {
      // Extern op (extern-domain-extension-point.md §3a, D2): the op body is a
      // hand-written domain hook Loom can't express.  The generated method runs
      // the preconditions inline, delegates to the co-located, scaffold-once
      // `<Agg>Extern` hook (a static method that reaches this aggregate's
      // package-private fields + `_raiseEvent` natively), then re-asserts
      // invariants — the same load → preconditions → hook → invariants → save
      // flow as before, only *what the hook is* changed (from an injected
      // application-layer handler to a domain-internal extension point).
      opLines.push(`    public void ${op.name}(${params}) {`);
      const body = renderJavaStatements(op.statements, renderCtx, traceCtx);
      if (body.length > 0) opLines.push(body);
      const hookArgs = [
        "this",
        ...op.params.map((p) => p.name),
        ...(usesUser ? ["currentUser"] : []),
      ].join(", ");
      opLines.push(`        ${entity.name}Extern.${op.name}(${hookArgs});`);
      opLines.push(
        emitTrace
          ? `        this._assertInvariants("${op.name}");`
          : `        this._assertInvariants();`,
      );
      opLines.push(`    }`);
      opLines.push("");
      continue;
    }
    const visibility = op.visibility === "public" ? "public" : "private";
    const retUnion = options.operationReturnUnions?.get(op.name);
    const retType = op.returnType ? renderJavaType(op.returnType) : "void";
    opLines.push(`    ${visibility} ${retType} ${op.name}(${params}) {`);
    // Chunked (one string per statement) rather than the pre-joined
    // `renderJavaStatements` here — `renderJavaStatements` IS
    // `chunks.join("\n")` by construction, so `body` below is byte-identical
    // either way, but the per-chunk list lets us surface per-statement
    // sub-regions to the caller that owns the recorder + this file's final
    // content (source-map Milestone 3 — see `OpFragment`).  Extern check
    // bodies and lifecycle appliers are out of scope for this slice.
    const chunks = renderJavaStatementChunks(
      op.statements,
      retUnion ? { ...renderCtx, returnUnion: retUnion } : renderCtx,
      traceCtx,
    );
    const body = chunks.join("\n");
    if (options.opFragments && chunks.length > 0) {
      options.opFragments.push({
        fragmentText: body,
        subRegions: statementSubRegions(op.statements, chunks, `${options.construct}.${op.name}`),
      });
    }
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
  // Drain the per-write lineage buffer after a save (the Java mirror of the
  // Hono/.NET `DrainProv()`); the repository persists one provenance_records
  // row per entry inside the save transaction.
  const drainProvLines =
    provFields.length > 0
      ? [
          `    public List<ProvLineage> drainProv() {`,
          `        var copy = List.copyOf(_provTraces);`,
          `        _provTraces.clear();`,
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
    const thrown = `throw new DomainException(${JSON.stringify(inv.message ? inv.message.text : `Invariant violated: ${inv.source}`)})`;
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
  // A part with its OWN nested containments accepts those children as trailing
  // factory params (`new Shipment { carrier, labels: [...] }`), populating the
  // @OneToMany collections so a cascade persist writes them with the FK stamped
  // from the relationship.  Only parts that declare containments carry these —
  // and part-in-part nesting only exists in nested models, so a plain part is
  // byte-identical.
  const partContainParams = entity.contains.map((c) =>
    c.collection ? `List<${c.partName}> ${c.name}` : `${c.partName} ${c.name}`,
  );
  const partContainPopulate = entity.contains.map((c) =>
    c.collection
      ? `        if (${c.name} != null) p.${c.name}.addAll(${c.name});`
      : `        p.${c.name} = ${c.name};`,
  );
  const partFactoryLines: string[] = !isRoot
    ? [
        `    public static ${entity.name} _create(${[
          oneToOneParent
            ? `${oneToOneParent} parent`
            : `${persistence?.parentEntityName ?? rootName}Id parentId`,
          ...entity.fields.map((f) => `${renderJavaType(f.type)} ${f.name}`),
          ...partContainParams,
        ].join(", ")}) {`,
        `        var p = new ${entity.name}();`,
        `        p.id = ${entity.name}Id.newId();`,
        ...(oneToOneParent
          ? [`        p._parent = parent;`, `        p.parentId = parent.id();`]
          : [`        p.parentId = parentId;`]),
        ...entity.fields.map((f) => `        p.${f.name} = ${f.name};`),
        ...partContainPopulate,
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

  // Claim-valued principal stamps → explicit JPA lifecycle callbacks.  The
  // @PrePersist arm applies create + update assignments (a fresh row is both
  // created and current, matching the @LastModified* fill-on-insert semantics
  // and the node insert branch); the @PreUpdate arm re-applies only the
  // update-event ones.  The principal is read statically off
  // CurrentUserAccessor (entity callbacks can't inject beans) and a
  // principal-less save (seed / system) returns unstamped — the write-side
  // analogue of the repository filter's null-safe SpEL accessor.
  const claimStampHookLines: string[] = [];
  if (persistence && claimStamps.length > 0) {
    const claimAssign = (s: { field: string; value: ExprIR }): string =>
      `        this.${s.field} = ${renderJavaExpr(s.value, renderCtx)};`;
    const updateClaims = claimStamps.filter((s) => !s.createEvent);
    claimStampHookLines.push(
      `    @PrePersist`,
      `    void _stampOnCreate() {`,
      `        var currentUser = CurrentUserAccessor.currentOrNull();`,
      `        if (currentUser == null) return;`,
      ...claimStamps.map(claimAssign),
      `    }`,
      ``,
    );
    if (updateClaims.length > 0) {
      claimStampHookLines.push(
        `    @PreUpdate`,
        `    void _stampOnUpdate() {`,
        `        var currentUser = CurrentUserAccessor.currentOrNull();`,
        `        if (currentUser == null) return;`,
        ...updateClaims.map(claimAssign),
        `    }`,
        ``,
      );
    }
  }

  const body = [
    ...derivedLines,
    ...fnLines,
    ...opLines,
    ...claimStampHookLines,
    ...externHookLines,
    ...pullEventsLines,
    ...drainProvLines,
    ...assertLines,
    "",
    ...createPublicLines,
    ...partFactoryLines,
    ...applierLines,
    ...esCreateFactoryLines,
  ];
  while (body.length > 0 && body[body.length - 1] === "") body.pop();

  const usesHibernateTypes =
    persistence &&
    (needsHibernateTypes(entity.fields) ||
      provFields.length > 0 ||
      (persistence.embedded &&
        (entity.contains.length > 0 || entity.fields.some((f) => isRefCollection(f.type)))));
  // Non-principal capability filters (relational soft-delete et al.) ride
  // Hibernate's @SQLRestriction: one static WHERE fragment appended to every
  // SELECT (the HasQueryFilter analog).  PRINCIPAL (tenancy) filters can't —
  // @SQLRestriction is static SQL with no runtime principal — so they're AND-ed
  // into the repository's per-query JPQL instead (see emit/repository.ts).
  //
  // §11.6 triage: a capability some read `ignoring`s (a PROMOTED cap, threaded
  // in via `options.promotedCaps`) leaves @SQLRestriction — @SQLRestriction is
  // unbypassable by design — and becomes a bypassable Hibernate named filter
  // (`@FilterDef(autoEnabled, applyToLoadByKey)` + `@Filter`).  Everything else
  // (never-bypassed caps + bare filters) keeps today's @SQLRestriction.
  const promotedCaps =
    isRoot && isAgg(entity) ? (options.promotedCaps ?? new Set<string>()) : new Set<string>();
  const contextFilters = isRoot && isAgg(entity) ? sqlRestrictionFilters(entity, promotedCaps) : [];
  const sqlRestriction =
    persistence && contextFilters.length > 0
      ? `@SQLRestriction(${JSON.stringify(contextFilters.map(renderSqlRestriction).join(" and "))})`
      : null;
  // Promoted capabilities → bypassable Hibernate named filters.  `autoEnabled`
  // reproduces @SQLRestriction's always-on semantics with no interceptor;
  // `applyToLoadByKey` keeps by-id / lazy loads filtered (else a promoted filter
  // would leak previously-hidden rows on a primary-key load).  The condition is
  // a constant SQL fragment (parameterless — the validator gates principal /
  // non-relational shapes off java), so no `@ParamDef`/resolver is needed.
  const promoted =
    persistence && isRoot && isAgg(entity) ? promotedFilters(entity, promotedCaps) : [];
  const filterDefAnnotations: string[] = [];
  const filterAnnotations: string[] = [];
  for (const p of promoted) {
    filterDefAnnotations.push(
      `@FilterDef(name = ${JSON.stringify(p.cap)}, autoEnabled = true, applyToLoadByKey = true)`,
    );
    filterAnnotations.push(
      `@Filter(name = ${JSON.stringify(p.cap)}, condition = ${JSON.stringify(p.condition)})`,
    );
  }
  const hasNamedFilters = promoted.length > 0;
  return lines(
    `package ${pkg};`,
    ``,
    ...[...javaImports].sort().map((i) => `import ${i};`),
    ``,
    persistence ? `import jakarta.persistence.*;` : null,
    usesHibernateTypes ? `import org.hibernate.annotations.JdbcTypeCode;` : null,
    sqlRestriction ? `import org.hibernate.annotations.SQLRestriction;` : null,
    hasNamedFilters ? `import org.hibernate.annotations.Filter;` : null,
    hasNamedFilters ? `import org.hibernate.annotations.FilterDef;` : null,
    usesHibernateTypes ? `import org.hibernate.type.SqlTypes;` : null,
    // Spring Data JPA auditing: the @Created*/@LastModified* field annotations
    // + the listener that fills them at persist time (§5b).
    ...(isAuditable
      ? [
          ...[...new Set([...auditAnnotationFor.values()].map((a) => a.annotation))]
            .sort()
            .map((a) => `import org.springframework.data.annotation.${a};`),
          `import org.springframework.data.jpa.domain.support.AuditingEntityListener;`,
        ]
      : []),
    persistence ? `` : null,
    `import ${basePkg}.domain.common.*;`,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.events.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    callsDomainService ? `import ${basePkg}.domain.services.*;` : null,
    anyOpUsesCurrentUser ? `import ${basePkg}.auth.User;` : null,
    // Claim-valued stamps read the ambient principal statically off the
    // request-scoped holder (the same one the SpEL principal filter uses).
    claimStampHookLines.length > 0 ? `import ${basePkg}.auth.CurrentUserAccessor;` : null,
    superType?.pkg && superType.pkg !== pkg ? `import ${superType.pkg}.${superType.name};` : null,
    ``,
    // TPH concretes (sharesIdentity) inherit the base's shared @Table —
    // they carry only @Entity + their @DiscriminatorValue (= the kind
    // value every backend stamps).
    persistence && superType?.sharesIdentity
      ? [`@Entity`, `@DiscriminatorValue("${entity.name}")`]
      : persistence
        ? jpaClassAnnotations(persistence.tableName, {
            schema: persistence.schema,
            voLookup: persistence.voLookup,
          })
        : null,
    sqlRestriction,
    ...filterDefAnnotations,
    ...filterAnnotations,
    // Compose the auditing listener (it stacks with inheritance — no
    // @MappedSuperclass needed, so it doesn't collide with `extends`).
    isAuditable ? `@EntityListeners(AuditingEntityListener.class)` : null,
    jmolecules,
    `public class ${entity.name}${superType ? ` extends ${superType.name}` : ""}${
      isAuditable ? ` implements Auditable` : ""
    } {`,
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
  const idLines = options.tph
    ? [
        ...(persistence
          ? [
              `    @EmbeddedId`,
              `    @AttributeOverride(name = "value", column = @Column(name = "id"))`,
            ]
          : []),
        `    protected ${base.name}Id id;`,
      ]
    : [];
  const idAccessor = options.tph
    ? [`    public ${base.name}Id id() {`, `        return id;`, `    }`, ``]
    : // TPC bases are id-less (each concrete owns its typed id), but the base's
      // derived members (e.g. `inspect`) may read `id`.  Declare an abstract
      // getter the concretes covariantly override (`<Concrete>Id id()` is a
      // subtype of `Object id()`), so the base compiles standalone.
      [`    public abstract Object id();`, ``];
  const fieldLines = base.fields.flatMap((f) => [
    // TPC bases are @MappedSuperclass — their column mappings flatten
    // into each concrete's own table (the schema merges base + own
    // fields per concrete).  TPH bases are real @Entity roots of the
    // SINGLE_TABLE hierarchy — same per-field bindings, shared table.
    ...(persistence
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
  // TPC bases have no `id` field — base-field/id reads in a derived body must
  // go through the public accessors (`this.id()` / `this.label()`), not direct
  // field access.  TPH bases own the shared id field, so keep field reads.
  const derivedRenderCtx: JavaRenderContext = options.tph
    ? renderCtx
    : { ...renderCtx, accessorProps: true };
  const derivedLines = base.derived.flatMap((d) => [
    `    public ${renderJavaType(d.type)} ${d.name}() {`,
    `        return ${renderJavaExpr(d.expr, derivedRenderCtx)};`,
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
      ? `// Abstract TPH base — the hierarchy maps to one shared table owning the id`
      : `// Abstract TPC base — never instantiated; each concrete maps base + own`,
    options.tph
      ? `// (JPA SINGLE_TABLE; concretes carry @DiscriminatorValue over the kind column).`
      : `// columns onto its own table (JPA @MappedSuperclass).`,
    ...(persistence && options.tph
      ? [
          `@Entity`,
          `@Table(name = "${plural(snake(base.name))}"${persistence.schema ? `, schema = "${persistence.schema}"` : ""})`,
          `@Inheritance(strategy = InheritanceType.SINGLE_TABLE)`,
          `@DiscriminatorColumn(name = "kind")`,
        ]
      : []),
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
