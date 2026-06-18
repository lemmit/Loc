import { forCreateInput, hasCreate } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  FieldIR,
  ParamIR,
  RepositoryIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, upperFirst } from "../../../util/naming.js";
import { javaValueTypeForId, renderJavaExpr, renderJavaType } from "../render-expr.js";
import { declaredFinds, isPagedFind, unionFindAsOptionalTwin } from "./repository.js";
import { returnUnionSpec } from "./unions.js";
import { aggHasAnyWireValidator, renderJavaValidators } from "./validator.js";
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
  const dispatches = (ctx.boundedContext.eventSubscriptions ?? []).length > 0;
  const idJava = javaValueTypeForId(agg.idValueType);
  if (idJava === "UUID") imports.add("java.util.UUID");
  const hasValidators = aggHasAnyWireValidator(agg);
  const createInputs = forCreateInput(agg.fields);
  const eff = (t: TypeIR, optional: boolean): TypeIR =>
    optional && t.kind !== "optional" ? { kind: "optional", inner: t } : t;

  // --- create -----------------------------------------------------------------
  // Event-sourced aggregates are constructible through their `create`
  // action's params (the command shape) instead of the field set.
  const createParams: readonly { name: string; type: TypeIR; optional?: boolean }[] =
    ctx.esCreateParams ?? createInputs;
  for (const f of createParams) collectWireToDomainImports(f.type, imports);
  const createLets = createParams.map(
    (f) =>
      `        var ${f.name} = ${wireToDomain(eff(f.type, !!f.optional), `request.${f.name}()`)};`,
  );
  const createArgs = createParams.map((f) => f.name).join(", ");
  // Lifecycle stamps (audit / softDelete): the entity exposes
  // `_stampOnCreate` / `_stampOnUpdate` the service calls before save.
  // A stamp value that references currentUser resolves to the principal
  // id; the method takes a `User currentUser` arg threaded from the
  // request-scoped accessor.
  const stampRules = (event: "create" | "update") =>
    (agg.contextStamps ?? []).filter((r) => r.event === event).flatMap((r) => r.assignments);
  const hasStamp = (event: "create" | "update"): boolean => stampRules(event).length > 0;
  const stampUsesUser = (event: "create" | "update"): boolean =>
    stampRules(event).some((a) => exprUsesCurrentUser(a.value));
  const stampCall = (event: "create" | "update"): string =>
    `        aggregate._stampOn${upperFirst(event)}(${stampUsesUser(event) ? "currentUser" : ""});`;
  const createLines =
    hasCreate(agg) || ctx.esCreateParams
      ? [
          `    public ${idClass} create${agg.name}(Create${agg.name}Request request) {`,
          ...createLets,
          hasValidators && !ctx.esCreateParams
            ? `        ${agg.name}Validators.create(${createArgs});`
            : null,
          stampUsesUser("create") ? `        var currentUser = currentUserAccessor.user();` : null,
          `        var aggregate = ${agg.name}.create(${createArgs});`,
          hasStamp("create") ? stampCall("create") : null,
          `        repository.save(aggregate);`,
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
    `    @Transactional(readOnly = true)`,
    `    public List<${agg.name}Response> all${agg.name}() {`,
    `        return repository.findAll().stream().map(${agg.name}Response::from).toList();`,
    `    }`,
    ``,
  ];
  const findLines = declaredFinds(repo)
    .map((f) => unionFindAsOptionalTwin(f, agg.name))
    .flatMap((f) => {
      const params = f.params.map((p) => `${renderJavaType(p.type)} ${p.name}`).join(", ");
      const args = f.params.map((p) => p.name).join(", ");
      for (const p of f.params) collectWireToDomainImports(p.type, imports);
      if (isPagedFind(f)) {
        const pagedParams = [params, "int page, int pageSize"].filter(Boolean).join(", ");
        const pagedArgs = [args, "page, pageSize"].filter(Boolean).join(", ");
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
  const anyStampUsesUser = stampUsesUser("create") || stampUsesUser("update");
  const anyOpUsesUser =
    (!!ctx.authed &&
      agg.operations.some((op) => op.visibility === "public" && operationUsesCurrentUser(op))) ||
    anyStampUsesUser;
  const unionReturnNames = new Set<string>();
  const opLines = agg.operations
    .filter((op) => op.visibility === "public")
    .flatMap((op) => {
      const hasParams = op.params.length > 0;
      const reqType = `${upperFirst(op.name)}${agg.name}Request`;
      const paramSig = hasParams ? `${idClass} id, ${reqType} request` : `${idClass} id`;
      const lets = op.params.map(
        (p) => `        var ${p.name} = ${wireToDomain(p.type, `request.${p.name}()`)};`,
      );
      for (const p of op.params) collectWireToDomainImports(p.type, imports);
      const usesUser = !!ctx.authed && operationUsesCurrentUser(op);
      const args = [...op.params.map((p) => p.name), ...(usesUser ? ["currentUser"] : [])].join(
        ", ",
      );
      const opHasValidator = opHasWireValidator(agg, op.name);
      if (op.extern) {
        // Extern op: preconditions gate (check<Op>), then the
        // user-supplied handler owns the business decision, then the
        // invariants re-assert before save.
        const handlerArgs = ["aggregate", ...op.params.map((p) => p.name)].join(", ");
        return [
          `    public void ${op.name}(${paramSig}) {`,
          ...lets,
          usesUser || stampUsesUser("update")
            ? `        var currentUser = currentUserAccessor.user();`
            : null,
          `        var aggregate = repository.getById(id);`,
          whenGateLine(op),
          `        aggregate.check${upperFirst(op.name)}(${args});`,
          `        ${lowerFirst(op.name)}Handler.handle(${handlerArgs});`,
          `        aggregate._assertInvariants();`,
          hasStamp("update") ? stampCall("update") : null,
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
      return [
        `    public ${spec ? spec.name : "void"} ${op.name}(${paramSig}) {`,
        ...lets,
        usesUser || stampUsesUser("update")
          ? `        var currentUser = currentUserAccessor.user();`
          : null,
        opHasValidator
          ? `        ${agg.name}Validators.${op.name}(${op.params.map((p) => p.name).join(", ")});`
          : null,
        `        var aggregate = repository.getById(id);`,
        whenGateLine(op),
        spec
          ? `        var result = aggregate.${op.name}(${args});`
          : `        aggregate.${op.name}(${args});`,
        hasStamp("update") ? stampCall("update") : null,
        `        repository.save(aggregate);`,
        `        publishEvents(aggregate);`,
        spec ? `        return result;` : null,
        `    }`,
        ``,
      ].filter((l): l is string => l !== null);
    });
  const externOps = agg.operations.filter((op) => op.extern);

  // --- destroy (lifecycle) ----------------------------------------------------------
  const destroyLines =
    (agg.destroys?.length ?? 0) > 0
      ? [
          `    public void destroy${agg.name}(${idClass} id) {`,
          `        var aggregate = repository.getById(id);`,
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
    `import org.slf4j.Logger;`,
    `import org.slf4j.LoggerFactory;`,
    `import org.springframework.stereotype.Service;`,
    `import org.springframework.transaction.annotation.Transactional;`,
    dispatches ? `import org.springframework.context.ApplicationEventPublisher;` : null,
    ``,
    ctx.entityPkg !== ctx.pkg ? `import ${ctx.entityPkg}.${agg.name};` : null,
    ...(ctx.entityPkg !== ctx.pkg
      ? [...unionReturnNames].sort().map((u) => `import ${ctx.entityPkg}.${u};`)
      : []),
    ctx.domainRepoPkg !== ctx.pkg ? `import ${ctx.domainRepoPkg}.${agg.name}Repository;` : null,
    anyOpUsesUser ? `import ${ctx.basePkg}.auth.CurrentUserAccessor;` : null,
    anyOpUsesUser ? `import ${ctx.basePkg}.auth.User;` : null,
    declaredFinds(repo).some(isPagedFind) ? `import ${ctx.basePkg}.domain.common.Paged;` : null,
    `import ${ctx.basePkg}.domain.enums.*;`,
    `import ${ctx.basePkg}.domain.ids.*;`,
    `import ${ctx.basePkg}.domain.valueobjects.*;`,
    ``,
    `@Service`,
    `@Transactional`,
    `public class ${agg.name}Service {`,
    `    private static final Logger log = LoggerFactory.getLogger(${agg.name}Service.class);`,
    ``,
    `    private final ${agg.name}Repository repository;`,
    ...externOps.map(
      (op) =>
        `    private final ${upperFirst(op.name)}${agg.name}Handler ${lowerFirst(op.name)}Handler;`,
    ),
    anyOpUsesUser ? `    private final CurrentUserAccessor currentUserAccessor;` : null,
    dispatches ? `    private final ApplicationEventPublisher eventPublisher;` : null,
    ``,
    `    public ${agg.name}Service(${[
      `${agg.name}Repository repository`,
      ...externOps.map(
        (op) => `${upperFirst(op.name)}${agg.name}Handler ${lowerFirst(op.name)}Handler`,
      ),
      ...(anyOpUsesUser ? ["CurrentUserAccessor currentUserAccessor"] : []),
      ...(dispatches ? ["ApplicationEventPublisher eventPublisher"] : []),
    ].join(", ")}) {`,
    `        this.repository = repository;`,
    ...externOps.map(
      (op) => `        this.${lowerFirst(op.name)}Handler = ${lowerFirst(op.name)}Handler;`,
    ),
    anyOpUsesUser ? `        this.currentUserAccessor = currentUserAccessor;` : null,
    dispatches ? `        this.eventPublisher = eventPublisher;` : null,
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
    dispatches
      ? `            eventPublisher.publishEvent(event);`
      : `            log.info("domain_event type={}", event.getClass().getSimpleName());`,
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

/** True when the op's preconditions yield at least one wire rule —
 *  mirrors the validator emitter's method-omission logic. */
function opHasWireValidator(agg: EnrichedAggregateIR, opName: string): boolean {
  // Cheap re-derivation through the validator emitter: render once and
  // check the method exists.  Validators are small; clarity wins.
  const rendered = renderJavaValidators(agg, "p", "b");
  return rendered?.includes(` ${opName}(`) ?? false;
}
