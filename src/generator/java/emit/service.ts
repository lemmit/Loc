import { forCreateInput, hasCreate } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  FieldIR,
  RepositoryIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, upperFirst } from "../../../util/naming.js";
import { javaValueTypeForId, renderJavaType } from "../render-expr.js";
import { declaredFinds, isPagedFind } from "./repository.js";
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
}

export function renderJavaService(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  voLookup: ReadonlyMap<string, readonly FieldIR[]>,
  ctx: ServiceCtx,
): string {
  const imports = new Set<string>(["java.util.List"]);
  const idJava = javaValueTypeForId(agg.idValueType);
  if (idJava === "UUID") imports.add("java.util.UUID");
  const hasValidators = aggHasAnyWireValidator(agg);
  const createInputs = forCreateInput(agg.fields);
  const eff = (t: TypeIR, optional: boolean): TypeIR =>
    optional && t.kind !== "optional" ? { kind: "optional", inner: t } : t;

  // --- create -----------------------------------------------------------------
  for (const f of createInputs) collectWireToDomainImports(f.type, imports);
  const createLets = createInputs.map(
    (f) =>
      `        var ${f.name} = ${wireToDomain(eff(f.type, f.optional), `request.${f.name}()`)};`,
  );
  const createArgs = createInputs.map((f) => f.name).join(", ");
  const createLines = hasCreate(agg)
    ? [
        `    public ${agg.name}Id create${agg.name}(Create${agg.name}Request request) {`,
        ...createLets,
        hasValidators ? `        ${agg.name}Validators.create(${createArgs});` : null,
        `        var aggregate = ${agg.name}.create(${createArgs});`,
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
    `    public ${agg.name}Response get${agg.name}ById(${agg.name}Id id) {`,
    `        return repository.findById(id).map(${agg.name}Response::from).orElse(null);`,
    `    }`,
    ``,
    `    @Transactional(readOnly = true)`,
    `    public List<${agg.name}Response> all${agg.name}() {`,
    `        return repository.findAll().stream().map(${agg.name}Response::from).toList();`,
    `    }`,
    ``,
  ];
  const findLines = declaredFinds(repo).flatMap((f) => {
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
  const anyOpUsesUser =
    !!ctx.authed &&
    agg.operations.some((op) => op.visibility === "public" && operationUsesCurrentUser(op));
  const unionReturnNames = new Set<string>();
  const opLines = agg.operations
    .filter((op) => op.visibility === "public")
    .flatMap((op) => {
      const hasParams = op.params.length > 0;
      const reqType = `${upperFirst(op.name)}${agg.name}Request`;
      const paramSig = hasParams ? `${agg.name}Id id, ${reqType} request` : `${agg.name}Id id`;
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
          usesUser ? `        var currentUser = currentUserAccessor.user();` : null,
          `        var aggregate = repository.getById(id);`,
          `        aggregate.check${upperFirst(op.name)}(${args});`,
          `        ${lowerFirst(op.name)}Handler.handle(${handlerArgs});`,
          `        aggregate._assertInvariants();`,
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
        usesUser ? `        var currentUser = currentUserAccessor.user();` : null,
        opHasValidator
          ? `        ${agg.name}Validators.${op.name}(${op.params.map((p) => p.name).join(", ")});`
          : null,
        `        var aggregate = repository.getById(id);`,
        spec
          ? `        var result = aggregate.${op.name}(${args});`
          : `        aggregate.${op.name}(${args});`,
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
          `    public void destroy${agg.name}(${agg.name}Id id) {`,
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

  return lines(
    `package ${ctx.pkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    ``,
    `import org.slf4j.Logger;`,
    `import org.slf4j.LoggerFactory;`,
    `import org.springframework.stereotype.Service;`,
    `import org.springframework.transaction.annotation.Transactional;`,
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
    ``,
    `    public ${agg.name}Service(${[
      `${agg.name}Repository repository`,
      ...externOps.map(
        (op) => `${upperFirst(op.name)}${agg.name}Handler ${lowerFirst(op.name)}Handler`,
      ),
      ...(anyOpUsesUser ? ["CurrentUserAccessor currentUserAccessor"] : []),
    ].join(", ")}) {`,
    `        this.repository = repository;`,
    ...externOps.map(
      (op) => `        this.${lowerFirst(op.name)}Handler = ${lowerFirst(op.name)}Handler;`,
    ),
    anyOpUsesUser ? `        this.currentUserAccessor = currentUserAccessor;` : null,
    `    }`,
    ``,
    ...createLines,
    ...readLines,
    ...findLines,
    ...opLines,
    ...destroyLines,
    ...voMappers,
    `    private void publishEvents(${agg.name} aggregate) {`,
    `        for (var event : aggregate.pullEvents()) {`,
    `            log.info("domain_event type={}", event.getClass().getSimpleName());`,
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
