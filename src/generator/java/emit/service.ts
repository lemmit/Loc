import { emitsRestCreate, forCreateInput } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  FieldIR,
  ParamIR,
  RepositoryIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { lines } from "../../../util/code-builder.js";
import { upperFirst } from "../../../util/naming.js";
import { isServerSourcedDefault } from "../../_frontend/server-default.js";
import {
  collectJavaExprImports,
  collectJavaTypeImports,
  javaValueTypeForId,
  renderJavaExpr,
  renderJavaType,
} from "../render-expr.js";
import {
  declaredFinds,
  isPagedAutoAll,
  isPagedFind,
  unionFindAsOptionalTwin,
} from "./repository.js";
import { returnUnionSpec } from "./unions.js";
import { collectWireToDomainImports, wireToDomain } from "./wire.js";

// ---------------------------------------------------------------------------
// Application service per aggregate — the layered style's
// Controller → Service → Repository middle.  Owns: request → domain
// mapping (typed parses live here, like the .NET command construction),
// the wire-validator call, the load-mutate-save flow for operations,
// response mapping, and domain-event drainage after save.
// ---------------------------------------------------------------------------

export interface ServiceCtx {
  basePkg: string;
  pkg: string;
  entityPkg: string;
  domainRepoPkg: string;
  /** auth: required + system user block — gates currentUser threading. */
  authed?: boolean;
  /** The enclosing context — resolves exception-less return unions. */
  boundedContext: EnrichedBoundedContextIR;
  /** Strongly-typed id class (default `<Agg>Id`); a TPH concrete passes
   *  its base's `<Base>Id` (the shared single-table key). */
  idClass?: string;
  /** Event-sourced create-input override: the `create` action's params. */
  esCreateParams?: readonly ParamIR[];
}

export function renderJavaService(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  voLookup: ReadonlyMap<string, readonly FieldIR[]>,
  ctx: ServiceCtx,
): string {
  const imports = new Set<string>(["java.util.List"]);
  const idClass = ctx.idClass ?? `${agg.name}Id`;
  // When the context has channel-routed subscriptions, drained domain events
  // are published to the in-process bus (Spring ApplicationEventPublisher →
  // the `<Ctx>Dispatcher`'s @EventListener handlers) instead of just logged.
  // No subscriptions ⇒ the log-only path stays byte-identical.
  // Domain events raised by an aggregate are ALWAYS published through Spring's
  // ApplicationEventPublisher — uniform with .NET (every repository dispatches
  // through `IDomainEventDispatcher`, Noop when unsubscribed) and Hono/Python/
  // Elixir (which always route through the in-process dispatcher).  Gating the
  // publish on "this context has a subscriber" silently DROPPED an event whose
  // context had none (audit §S5c: Java's `publishEvents` only logged, so e.g.
  // `BuildPromoted` never reached the bus).  Publishing with no listener is a
  // harmless no-op (the framework always provides the publisher) and keeps the
  // dispatch seam ready for an out-of-process relay (the outbox upgrade path).
  const dispatches = true;
  const idJava = javaValueTypeForId(agg.idValueType);
  if (idJava === "UUID") imports.add("java.util.UUID");
  const createInputs = forCreateInput(agg.fields);
  const eff = (t: TypeIR, optional: boolean): TypeIR =>
    optional && t.kind !== "optional" ? { kind: "optional", inner: t } : t;

  // --- create -----------------------------------------------------------------
  // Event-sourced aggregates are constructible through their `create`
  // action's params (the command shape) instead of the field set.
  const createParams: readonly { name: string; type: TypeIR; optional?: boolean }[] =
    ctx.esCreateParams ?? createInputs;
  for (const f of createParams) collectWireToDomainImports(f.type, imports);
  const createLets = createParams.map((f) => {
    const raw = `request.${f.name}()`;
    // A create-input field with a declared default (`field: T = <expr>`) is
    // boxed/nullable in the request record (see dto.ts): an omitted key arrives
    // null, so materialize the declared default here — parity with node/python
    // (RS-6 / RST-10).  Fields without a default keep their existing mapping.
    const dflt = ctx.esCreateParams ? undefined : (f as FieldIR).default;
    if (dflt) {
      // The rendered default may reference an imported domain type (e.g. a
      // `decimal` default → `new BigDecimal("0")`, needing java.math.BigDecimal)
      // that the wire→domain conversion alone doesn't pull in.
      collectJavaExprImports(dflt, imports);
      return `        var ${f.name} = ${raw} != null ? ${wireToDomain(f.type, raw)} : ${renderJavaExpr(dflt)};`;
    }
    return `        var ${f.name} = ${wireToDomain(eff(f.type, !!f.optional), raw)};`;
  });
  const createArgs = createParams.map((f) => f.name).join(", ");
  // A `currentUser.*` create-field default coalesces to the ambient principal
  // (`... : currentUser.<claim>()`), so the create method needs `currentUser`
  // bound off the accessor — the same binding the operations use.  (A bare
  // `now()` default renders `Instant.now()` and needs nothing.)
  const createDefaultUsesUser =
    !!ctx.authed &&
    !ctx.esCreateParams &&
    createParams.some((f) => {
      const dflt = (f as FieldIR).default;
      return dflt !== undefined && isServerSourcedDefault(dflt) && exprUsesCurrentUser(dflt);
    });
  // Lifecycle stamps (audit / softDelete) are persist-time on Java: the entity
  // carries Spring Data JPA auditing annotations (@CreatedDate / @CreatedBy /
  // @LastModifiedDate / @LastModifiedBy) filled by the AuditingEntityListener
  // at flush — there is no service call site (the §5 dedup move).  The
  // JpaAuditingConfig's AuditorAware<UUID> supplies the principal for
  // @CreatedBy / @LastModifiedBy, so the service no longer threads currentUser
  // for stamping.  See §5c of docs/old/plans/capability-stamp-dedup-simulation.md.
  // Audited lifecycle (audit-and-logging.md): the route-driving create / the
  // canonical destroy stage an audit_records row in the SAME @Transactional
  // method as the save / delete.  The route-driving create is the ES `create`
  // for an event-sourced aggregate, else the canonical create.
  const createAction = agg.persistedAs === "eventLog" ? agg.creates?.[0] : agg.canonicalCreate;
  const auditCreate = !!createAction?.audited;
  const auditDestroy = !!agg.canonicalDestroy?.audited;
  // create: before is JSON null (NullNode → the `null` token, satisfying the
  // NOT NULL jsonb column), after is the freshly-created wire snapshot, keyed by
  // the generated id; actor + correlation/scope/parent ids from RequestContext.
  const createAuditLines = auditCreate
    ? [
        `        var __after = ${agg.name}Response.from(aggregate);`,
        `        auditRecords.save(new AuditRecord(`,
        `            UUID.randomUUID().toString(),`,
        `            ${JSON.stringify(`create${agg.name}`)},`,
        `            "create",`,
        `            ${JSON.stringify(agg.name)},`,
        `            aggregate.id().value().toString(),`,
        `            ${ctx.authed ? "currentUserAccessor.user()" : "null"},`,
        `            NullNode.getInstance(),`,
        `            __after,`,
        `            OffsetDateTime.now(),`,
        `            "ok",`,
        `            RequestContext.correlationId(),`,
        `            RequestContext.scopeId(),`,
        `            RequestContext.parentId()));`,
        `        CatalogLog.event("audit_recorded", "debug", "action", "create", "target", ${JSON.stringify(agg.name)}, "actor", RequestContext.actorId());`,
      ]
    : [];
  const createLines = emitsRestCreate(agg)
    ? [
        `    public ${idClass} create${agg.name}(Create${agg.name}Request request) {`,
        createDefaultUsesUser ? `        var currentUser = currentUserAccessor.user();` : null,
        ...createLets,
        `        var aggregate = ${agg.name}.create(${createArgs});`,
        `        repository.save(aggregate);`,
        ...createAuditLines,
        `        publishEvents(aggregate);`,
        `        return aggregate.id();`,
        `    }`,
        ``,
      ].filter((l): l is string => l !== null)
    : [];

  // --- reads -------------------------------------------------------------------
  const readLines = [
    `    @Transactional(readOnly = true)`,
    `    public ${agg.name}Response get${agg.name}ById(${idClass} id) {`,
    `        return repository.findById(id).map(${agg.name}Response::from).orElse(null);`,
    `    }`,
    ``,
    ...(isPagedAutoAll(repo)
      ? [
          // Paged relational findAll (M-T2.6): delegate to the repository's
          // bounded `findAllPaged` and map each page item to its response DTO.
          `    @Transactional(readOnly = true)`,
          `    public Paged<${agg.name}Response> all${agg.name}(int page, int pageSize, String sort, String dir) {`,
          `        var result = repository.findAllPaged(page, pageSize, sort, dir);`,
          `        return new Paged<>(result.items().stream().map(${agg.name}Response::from).toList(),`,
          `            result.page(), result.pageSize(), result.total(), result.totalPages());`,
          `    }`,
          ``,
        ]
      : [
          `    @Transactional(readOnly = true)`,
          `    public List<${agg.name}Response> all${agg.name}() {`,
          `        return repository.findAll().stream().map(${agg.name}Response::from).toList();`,
          `    }`,
          ``,
        ]),
  ];
  const findLines = declaredFinds(repo)
    .map((f) => unionFindAsOptionalTwin(f, agg.name))
    .flatMap((f) => {
      const params = f.params.map((p) => `${renderJavaType(p.type)} ${p.name}`).join(", ");
      const args = f.params.map((p) => p.name).join(", ");
      // Finder params are DOMAIN-typed (`renderJavaType`) and passed straight
      // through to the repository — collect the domain-type import (BigDecimal
      // for decimal, UUID for a bare guid, …) to match the rendered signature,
      // not the wire→domain collector (which only covers money/datetime).
      for (const p of f.params) collectJavaTypeImports(p.type, imports);
      if (isPagedFind(f)) {
        const pagedParams = [params, "int page, int pageSize, String sort, String dir"]
          .filter(Boolean)
          .join(", ");
        const pagedArgs = [args, "page, pageSize, sort, dir"].filter(Boolean).join(", ");
        return [
          `    @Transactional(readOnly = true)`,
          `    public Paged<${agg.name}Response> ${f.name}(${pagedParams}) {`,
          `        var result = repository.${f.name}(${pagedArgs});`,
          `        return new Paged<>(result.items().stream().map(${agg.name}Response::from).toList(),`,
          `            result.page(), result.pageSize(), result.total(), result.totalPages());`,
          `    }`,
          ``,
        ];
      }
      if (f.returnType.kind !== "array") {
        return [
          `    @Transactional(readOnly = true)`,
          `    public ${agg.name}Response ${f.name}(${params}) {`,
          `        var found = repository.${f.name}(${args});`,
          `        return found == null ? null : ${agg.name}Response.from(found);`,
          `    }`,
          ``,
        ];
      }
      return [
        `    @Transactional(readOnly = true)`,
        `    public List<${agg.name}Response> ${f.name}(${params}) {`,
        `        return repository.${f.name}(${args}).stream().map(${agg.name}Response::from).toList();`,
        `    }`,
        ``,
      ];
    });

  // --- operations ----------------------------------------------------------------
  // `when` canCommand state gate (criterion.md, use site 2): load the
  // aggregate, evaluate the predicate over its current state, and throw
  // DisallowedException (→ 409) before mutating.  The predicate reads the
  // loaded entity through its record-style accessors (`aggregate.status()`),
  // enum values resolving to `<Enum>.<Value>` — the same expression the
  // can_<op> companion returns.
  const gatedOps = agg.operations.filter((op) => op.visibility === "public" && !!op.when);
  if (gatedOps.length > 0) imports.add(`${ctx.basePkg}.domain.common.DisallowedException`);
  const whenGateLine = (op: (typeof agg.operations)[number]): string | null =>
    op.when
      ? `        if (!(${renderJavaExpr(op.when, { thisName: "aggregate", accessorProps: true })})) throw new DisallowedException("operation '${op.name}' is not allowed in the current state of ${agg.name}.");`
      : null;
  const anyOpUsesUser =
    !!ctx.authed &&
    agg.operations.some((op) => op.visibility === "public" && operationUsesCurrentUser(op));
  // Audit: any audited COMMAND ACTION — public operation OR lifecycle
  // create/destroy — needs the AuditRecordRepository injected + the
  // OffsetDateTime / UUID / RequestContext imports.  Lifecycle audit also pulls
  // in Jackson's NullNode for the JSON-null side of the before/after asymmetry.
  const anyOpAudited = agg.operations.some((op) => op.visibility === "public" && op.audited);
  const anyLifecycleAudited = auditCreate || auditDestroy;
  const anyAudited = anyOpAudited || anyLifecycleAudited;
  if (anyAudited) {
    imports.add("java.time.OffsetDateTime");
    imports.add("java.util.UUID");
  }
  if (anyLifecycleAudited) {
    imports.add("tools.jackson.databind.node.NullNode");
  }
  // The audit-record actor reads `currentUserAccessor.user()` on an authed
  // system even when no operation otherwise uses the current user, so the
  // accessor must be injected whenever audit + auth are both present — not only
  // when `anyOpUsesUser`, or the audit call references an uninjected field.
  const needsUserAccessor = anyOpUsesUser || (anyAudited && !!ctx.authed) || createDefaultUsesUser;
  // Optimistic concurrency (`versioned`): every public mutation threads the
  // client's expected version from the `If-Match` request header (think-time
  // CAS).  When supplied and it disagrees with the freshly-loaded aggregate's
  // `@Version`, we raise ObjectOptimisticLockingFailureException up-front — the
  // same exception Hibernate raises for the load→save race (write-time CAS) — so
  // both surface through the ApiExceptionAdvice 409 arm.  A non-versioned
  // aggregate threads nothing and stays byte-identical.
  const versioned = aggregateIsVersioned(agg);
  const ifMatchParam = versioned ? ", Integer ifMatch" : "";
  const ifMatchGuard = versioned
    ? `        if (ifMatch != null && aggregate.version() != ifMatch) throw new ObjectOptimisticLockingFailureException(${agg.name}.class, id.value());`
    : null;
  const unionReturnNames = new Set<string>();
  const opLines = agg.operations
    .filter((op) => op.visibility === "public")
    .flatMap((op) => {
      const hasParams = op.params.length > 0;
      const reqType = `${upperFirst(op.name)}${agg.name}Request`;
      const paramSig =
        (hasParams ? `${idClass} id, ${reqType} request` : `${idClass} id`) + ifMatchParam;
      const lets = op.params.map(
        (p) => `        var ${p.name} = ${wireToDomain(p.type, `request.${p.name}()`)};`,
      );
      for (const p of op.params) collectWireToDomainImports(p.type, imports);
      const usesUser = !!ctx.authed && operationUsesCurrentUser(op);
      const args = [...op.params.map((p) => p.name), ...(usesUser ? ["currentUser"] : [])].join(
        ", ",
      );
      if (op.extern) {
        // Extern op (extern-domain-extension-point.md §3a, Phase 2): the op is a
        // real aggregate method now — it runs its preconditions, delegates to the
        // co-located scaffold-once `<Agg>Extern` hook, and re-asserts invariants
        // internally (all inside `aggregate.<op>(...)`).  The service just loads,
        // guards, calls, saves, drains — identical to a plain void operation; the
        // injected handler + `ExternHandlerException` wrap are gone.
        return [
          `    public void ${op.name}(${paramSig}) {`,
          ...lets,
          usesUser ? `        var currentUser = currentUserAccessor.user();` : null,
          `        var aggregate = repository.getById(id);`,
          ifMatchGuard,
          whenGateLine(op),
          `        aggregate.${op.name}(${args});`,
          `        repository.save(aggregate);`,
          `        publishEvents(aggregate);`,
          `    }`,
          ``,
        ].filter((l): l is string => l !== null);
      }
      // Exception-less return: the aggregate produces a tagged domain
      // union — capture, save, return (the controller owns the wire /
      // ProblemDetail translation).
      const spec = returnUnionSpec(op, ctx.boundedContext);
      if (spec) unionReturnNames.add(spec.name);
      // Per-operation audit (audit-and-logging.md): an `audited` op records a
      // who/what/when + before/after wire snapshot.  before/after are the
      // aggregate's wire projection either side of the mutation; the record is
      // persisted INSIDE this @Transactional method (same txn as the state
      // change) via the injected AuditRecordRepository.  The actor / correlation
      // / scope / parent ids are stamped from the ambient RequestContext.
      const audited = !!op.audited;
      return [
        `    public ${spec ? spec.name : "void"} ${op.name}(${paramSig}) {`,
        ...lets,
        usesUser ? `        var currentUser = currentUserAccessor.user();` : null,
        `        var aggregate = repository.getById(id);`,
        ifMatchGuard,
        whenGateLine(op),
        audited ? `        var __before = ${agg.name}Response.from(aggregate);` : null,
        spec
          ? `        var result = aggregate.${op.name}(${args});`
          : `        aggregate.${op.name}(${args});`,
        `        repository.save(aggregate);`,
        audited ? `        var __after = ${agg.name}Response.from(aggregate);` : null,
        audited ? `        auditRecords.save(new AuditRecord(` : null,
        audited ? `            UUID.randomUUID().toString(),` : null,
        audited ? `            ${JSON.stringify(`${op.name}${agg.name}`)},` : null,
        audited ? `            ${JSON.stringify(op.name)},` : null,
        audited ? `            ${JSON.stringify(agg.name)},` : null,
        audited ? `            id.value().toString(),` : null,
        audited ? `            ${ctx.authed ? "currentUserAccessor.user()" : "null"},` : null,
        audited ? `            __before,` : null,
        audited ? `            __after,` : null,
        audited ? `            OffsetDateTime.now(),` : null,
        audited ? `            "ok",` : null,
        audited ? `            RequestContext.correlationId(),` : null,
        audited ? `            RequestContext.scopeId(),` : null,
        audited ? `            RequestContext.parentId()));` : null,
        audited
          ? `        CatalogLog.event("audit_recorded", "debug", "action", ${JSON.stringify(op.name)}, "target", ${JSON.stringify(agg.name)}, "actor", RequestContext.actorId());`
          : null,
        `        publishEvents(aggregate);`,
        spec ? `        return result;` : null,
        `    }`,
        ``,
      ].filter((l): l is string => l !== null);
    });

  // --- destroy (lifecycle) ----------------------------------------------------------
  // Audited destroy: snapshot the loaded wire shape, persist the audit row
  // (before = the last snapshot, after = JSON null via NullNode → satisfies the
  // NOT NULL jsonb column), THEN hard-delete — all in this @Transactional method
  // so the audit insert + the delete commit or roll back together.
  const destroyLines =
    (agg.destroys?.length ?? 0) > 0
      ? [
          `    public void destroy${agg.name}(${idClass} id) {`,
          `        var aggregate = repository.getById(id);`,
          ...(auditDestroy
            ? [
                `        var __before = ${agg.name}Response.from(aggregate);`,
                `        auditRecords.save(new AuditRecord(`,
                `            UUID.randomUUID().toString(),`,
                `            ${JSON.stringify(`destroy${agg.name}`)},`,
                `            "destroy",`,
                `            ${JSON.stringify(agg.name)},`,
                `            id.value().toString(),`,
                `            ${ctx.authed ? "currentUserAccessor.user()" : "null"},`,
                `            __before,`,
                `            NullNode.getInstance(),`,
                `            OffsetDateTime.now(),`,
                `            "ok",`,
                `            RequestContext.correlationId(),`,
                `            RequestContext.scopeId(),`,
                `            RequestContext.parentId()));`,
                `        CatalogLog.event("audit_recorded", "debug", "action", "destroy", "target", ${JSON.stringify(agg.name)}, "actor", RequestContext.actorId());`,
              ]
            : []),
          `        repository.delete(aggregate);`,
          `    }`,
          ``,
        ]
      : [];

  // --- VO request mappers --------------------------------------------------------
  const voNames = new Set<string>();
  for (const f of createInputs) collectVoNames(f.type, voNames);
  for (const op of agg.operations) for (const p of op.params) collectVoNames(p.type, voNames);
  const voMappers = [...voNames].sort().flatMap((vo) => {
    const fields = voLookup.get(vo) ?? [];
    const args = fields
      .map((f) => wireToDomain(eff(f.type, f.optional), `request.${f.name}()`))
      .join(", ");
    for (const f of fields) collectWireToDomainImports(f.type, imports);
    return [
      `    private static ${vo} to${vo}(${vo}Request request) {`,
      `        return new ${vo}(${args});`,
      `    }`,
      ``,
    ];
  });

  // --- can_<op> companions ---------------------------------------------------------
  // The side-effect-free twin of each `when`-gated op: load the aggregate and
  // return the predicate verbatim (the controller wraps it in `CanResponse`),
  // so a UI can enable/disable the action without invoking it.
  const canLines = gatedOps.flatMap((op) => [
    `    public boolean can${upperFirst(op.name)}(${idClass} id) {`,
    `        var aggregate = repository.getById(id);`,
    `        return ${renderJavaExpr(op.when!, { thisName: "aggregate", accessorProps: true })};`,
    `    }`,
    ``,
  ]);

  return lines(
    `package ${ctx.pkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    ``,
    `import org.springframework.stereotype.Service;`,
    `import org.springframework.transaction.annotation.Transactional;`,
    dispatches ? `import org.springframework.context.ApplicationEventPublisher;` : null,
    versioned ? `import org.springframework.orm.ObjectOptimisticLockingFailureException;` : null,
    ``,
    ctx.entityPkg !== ctx.pkg ? `import ${ctx.entityPkg}.${agg.name};` : null,
    ...(ctx.entityPkg !== ctx.pkg
      ? [...unionReturnNames].sort().map((u) => `import ${ctx.entityPkg}.${u};`)
      : []),
    ctx.domainRepoPkg !== ctx.pkg ? `import ${ctx.domainRepoPkg}.${agg.name}Repository;` : null,
    needsUserAccessor ? `import ${ctx.basePkg}.auth.CurrentUserAccessor;` : null,
    needsUserAccessor ? `import ${ctx.basePkg}.auth.User;` : null,
    anyAudited ? `import ${ctx.basePkg}.config.RequestContext;` : null,
    anyAudited ? `import ${ctx.basePkg}.infrastructure.persistence.AuditRecord;` : null,
    anyAudited ? `import ${ctx.basePkg}.infrastructure.persistence.AuditRecordRepository;` : null,
    declaredFinds(repo).some(isPagedFind) || isPagedAutoAll(repo)
      ? `import ${ctx.basePkg}.domain.common.Paged;`
      : null,
    `import ${ctx.basePkg}.domain.enums.*;`,
    `import ${ctx.basePkg}.domain.ids.*;`,
    `import ${ctx.basePkg}.domain.valueobjects.*;`,
    `import ${ctx.basePkg}.config.CatalogLog;`,
    ``,
    `@Service`,
    `@Transactional`,
    `public class ${agg.name}Service {`,
    `    private final ${agg.name}Repository repository;`,
    needsUserAccessor ? `    private final CurrentUserAccessor currentUserAccessor;` : null,
    dispatches ? `    private final ApplicationEventPublisher eventPublisher;` : null,
    anyAudited ? `    private final AuditRecordRepository auditRecords;` : null,
    ``,
    `    public ${agg.name}Service(${[
      `${agg.name}Repository repository`,
      ...(needsUserAccessor ? ["CurrentUserAccessor currentUserAccessor"] : []),
      ...(dispatches ? ["ApplicationEventPublisher eventPublisher"] : []),
      ...(anyAudited ? ["AuditRecordRepository auditRecords"] : []),
    ].join(", ")}) {`,
    `        this.repository = repository;`,
    needsUserAccessor ? `        this.currentUserAccessor = currentUserAccessor;` : null,
    dispatches ? `        this.eventPublisher = eventPublisher;` : null,
    anyAudited ? `        this.auditRecords = auditRecords;` : null,
    `    }`,
    ``,
    ...createLines,
    ...readLines,
    ...findLines,
    ...opLines,
    ...canLines,
    ...destroyLines,
    ...voMappers,
    `    private void publishEvents(${agg.name} aggregate) {`,
    `        for (var event : aggregate.pullEvents()) {`,
    // The domain-event narrative line fires at the dispatch seam regardless of
    // whether the event has in-process subscribers — when it does, the in-VM
    // publish follows.
    `            CatalogLog.event("event_dispatched", "info", "event_type", event.getClass().getSimpleName(), "aggregate", "${agg.name}");`,
    dispatches ? `            eventPublisher.publishEvent(event);` : null,
    `        }`,
    `    }`,
    `}`,
    ``,
  );
}

function collectVoNames(t: TypeIR, into: Set<string>): void {
  if (t.kind === "valueobject") into.add(t.name);
  else if (t.kind === "array") collectVoNames(t.element, into);
  else if (t.kind === "optional") collectVoNames(t.inner, into);
}
