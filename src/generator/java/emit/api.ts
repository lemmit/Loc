import { emitsRestCreate } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { lines } from "../../../util/code-builder.js";
import {
  defaultErrorStatus,
  errorTitle,
  errorTypeUri,
  resolveErrorStatus,
} from "../../../util/error-defaults.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { findUnionSpec } from "../../_payload/union-wire.js";
import { javaValueTypeForId, renderJavaType } from "../render-expr.js";
import { declaredFinds, isPagedFind } from "./repository.js";
import { returnUnionSpec, unionWireCtorArgs } from "./unions.js";

// ---------------------------------------------------------------------------
// REST controllers + the shared exception advice.  Route shape mirrors
// the other backends (the OpenAPI-parity contract):
//
//   POST   /<plural_snake>              → 201 `{ id }` + Location
//   GET    /<plural_snake>/{id}         → 200 <Agg>Response | 404 (bare)
//   GET    /<plural_snake>              → 200 [<Agg>Response]
//   GET    /<plural_snake>/<find_snake> → 200 [<Agg>Response] (query params)
//   POST   /<plural_snake>/{id}/<op_snake> → 204
//   DELETE /<plural_snake>/{id}         → 204 (lifecycle destroy)
//
// Errors flow through ApiExceptionAdvice → RFC 7807 problem+json:
// DomainException 400, ForbiddenException 403, AggregateNotFound 404,
// WireValidationException 422 (+ `errors[]` extension), fallback 500.
// ---------------------------------------------------------------------------

export interface ControllerCtx {
  basePkg: string;
  pkg: string;
  /** Package of the DTOs + service (imported wildcard when different). */
  applicationPkg: string;
  /** Package the domain unions live in (entity package). */
  entityPkg?: string;
  /** The enclosing context — resolves exception-less return unions. */
  boundedContext?: EnrichedBoundedContextIR;
  /** Strongly-typed id class (default `<Agg>Id`); a TPH concrete passes
   *  its base's `<Base>Id` (the shared single-table key). */
  idClass?: string;
  /** Prepended to @RequestMapping (fullstack mode passes "/api" so the
   *  SPA owns the un-prefixed route space).  Empty for standalone. */
  routePrefix?: string;
}

export function renderJavaController(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: ControllerCtx,
): string {
  const route = snake(plural(agg.name));
  const idClass = ctx.idClass ?? `${agg.name}Id`;
  // Optimistic concurrency (`versioned`): a mutation carries the client's
  // expected version in the `If-Match` header (think-time CAS), forwarded to the
  // service.  Non-versioned aggregates thread nothing → byte-identical routes.
  const versioned = aggregateIsVersioned(agg);
  const ifMatchHeaderParam = versioned
    ? `, @RequestHeader(value = "If-Match", required = false) Integer ifMatch`
    : "";
  const ifMatchServiceArg = versioned ? ", ifMatch" : "";
  const idJava = javaValueTypeForId(agg.idValueType);
  const imports = new Set<string>(["java.util.List"]);
  if (idJava === "UUID") imports.add("java.util.UUID");
  // Find params surface as raw `@RequestParam <JavaType> <name>` declarations
  // on the controller itself (unlike operation params, which travel inside
  // generated request records that collect their own imports) — so pull in
  // the non-java.lang types their rendered spellings reference.
  for (const f of declaredFinds(repo)) {
    for (const p of f.params) {
      const rendered = renderJavaType(p.type);
      if (rendered.includes("BigDecimal")) imports.add("java.math.BigDecimal");
      if (rendered.includes("Instant")) imports.add("java.time.Instant");
      if (rendered.includes("UUID")) imports.add("java.util.UUID");
    }
  }

  const unionImports = new Set<string>();
  let anyUnionProblem = false;
  const anyReturnUnion =
    !!ctx.boundedContext &&
    agg.operations.some(
      (op) => op.visibility === "public" && returnUnionSpec(op, ctx.boundedContext!),
    );
  // Extern ops route identically — the service dispatches to the
  // user-supplied handler instead of an aggregate method.
  // The side-effect-free `can_<op>` companion of a `when`-gated operation
  // (criterion.md, use site 2): GET → loads the aggregate, evaluates the
  // predicate, returns `{ allowed }` so a UI can enable/disable the action
  // without invoking it.  The service owns the load + predicate; the
  // controller wraps the boolean in the shared `CanResponse` record.
  const canRouteLines = (op: (typeof agg.operations)[number]): string[] =>
    op.when
      ? [
          `    @GetMapping("/{id}/can_${snake(op.name)}")`,
          `    public CanResponse can${upperFirst(op.name)}${agg.name}(@PathVariable ${idJava} id) {`,
          `        return new CanResponse(service.can${upperFirst(op.name)}(new ${idClass}(id)));`,
          `    }`,
          ``,
        ]
      : [];
  const opRoutes = agg.operations
    .filter((op) => op.visibility === "public")
    .flatMap((op) => {
      const hasParams = op.params.length > 0;
      const reqType = `${upperFirst(op.name)}${agg.name}Request`;
      const spec = ctx.boundedContext ? returnUnionSpec(op, ctx.boundedContext) : undefined;
      if (spec) {
        // Exception-less return: switch the tagged domain union — error
        // variants → RFC-7807 ProblemDetail at their mapped status,
        // success variants → 200 with the polymorphic wire record.
        if (ctx.entityPkg && ctx.entityPkg !== ctx.pkg) {
          unionImports.add(`${ctx.entityPkg}.${spec.name}`);
          for (const m of spec.members) unionImports.add(`${ctx.entityPkg}.${spec.name}_${m.tag}`);
        }
        const arms = spec.arms.flatMap((a) => {
          if (a.isError) {
            return [
              `            case ${spec.name}_${a.tag} v -> {`,
              `                var problem = ProblemDetail.forStatus(${a.status});`,
              `                problem.setTitle(${JSON.stringify(a.title)});`,
              `                problem.setType(URI.create(${JSON.stringify(a.typeUri)}));`,
              `                problem.setDetail(${JSON.stringify(a.title)});`,
              `                yield ResponseEntity.status(${a.status}).contentType(MediaType.APPLICATION_PROBLEM_JSON).body(problem);`,
              `            }`,
            ];
          }
          const ctor = `new ${spec.name}Response_${a.tag}(${unionWireCtorArgs(a.member).join(", ")})`;
          return [
            `            case ${spec.name}_${a.tag} v ->`,
            `                ResponseEntity.ok((${spec.name}Response) ${ctor});`,
          ];
        });
        return [
          `    @PostMapping("/{id}/${snake(op.name)}")`,
          hasParams
            ? `    public ResponseEntity<?> ${op.name}${agg.name}(@PathVariable ${idJava} id, @RequestBody ${reqType} request${ifMatchHeaderParam}) {`
            : `    public ResponseEntity<?> ${op.name}${agg.name}(@PathVariable ${idJava} id${ifMatchHeaderParam}) {`,
          `        CatalogLog.event("operation_invoked", "info", "aggregate", "${agg.name}", "op", "${op.name}", "id", id);`,
          hasParams
            ? `        var result = service.${op.name}(new ${idClass}(id), request${ifMatchServiceArg});`
            : `        var result = service.${op.name}(new ${idClass}(id)${ifMatchServiceArg});`,
          `        return switch (result) {`,
          ...arms,
          `        };`,
          `    }`,
          ``,
          ...canRouteLines(op),
        ];
      }
      return [
        `    @PostMapping("/{id}/${snake(op.name)}")`,
        `    @ResponseStatus(HttpStatus.NO_CONTENT)`,
        hasParams
          ? `    public void ${op.name}${agg.name}(@PathVariable ${idJava} id, @RequestBody ${reqType} request${ifMatchHeaderParam}) {`
          : `    public void ${op.name}${agg.name}(@PathVariable ${idJava} id${ifMatchHeaderParam}) {`,
        `        CatalogLog.event("operation_invoked", "info", "aggregate", "${agg.name}", "op", "${op.name}", "id", id);`,
        hasParams
          ? `        service.${op.name}(new ${idClass}(id), request${ifMatchServiceArg});`
          : `        service.${op.name}(new ${idClass}(id)${ifMatchServiceArg});`,
        `    }`,
        ``,
        ...canRouteLines(op),
      ];
    });

  const findRoutes = declaredFinds(repo).flatMap((f) => {
    const declared = f.params.map((p) => `@RequestParam ${renderJavaType(p.type)} ${p.name}`);
    const params = declared.join(", ");
    const args = f.params.map((p) => p.name).join(", ");
    // Union find (`Order or NotFound` / `Order option`): the service returns
    // the success variant's `<Agg>Response` (or null).  Per exception-less.md
    // §4 the 200 body is that success variant DIRECTLY — never a tagged union
    // component (an error variant belongs at its status, not in a 200 schema) —
    // so found → 200 `<Agg>Response`, absent → bare 404 (`none`) or an RFC-7807
    // ProblemDetail at the error's mapped status (with the `resource` extension
    // when declared).  Wire-identical to `<Agg>?` / `<Agg> option`.
    const spec = ctx.boundedContext
      ? findUnionSpec(f.returnType, agg.name, ctx.boundedContext)
      : null;
    if (spec) {
      const absent =
        spec.absent.kind === "none"
          ? [`            return ResponseEntity.notFound().build();`]
          : (() => {
              const tag = spec.absent.tag;
              const status =
                ctx.boundedContext?.errorStatusOverrides?.[tag] ?? defaultErrorStatus(tag);
              return [
                `            var problem = ProblemDetail.forStatus(${status});`,
                `            problem.setTitle(${JSON.stringify(errorTitle(tag))});`,
                `            problem.setType(URI.create(${JSON.stringify(errorTypeUri(tag))}));`,
                `            problem.setDetail(${JSON.stringify(errorTitle(tag))});`,
                ...(spec.absent.hasResource
                  ? [`            problem.setProperty("resource", "${agg.name}");`]
                  : []),
                `            return ResponseEntity.status(${status}).contentType(MediaType.APPLICATION_PROBLEM_JSON).body(problem);`,
              ];
            })();
      if (spec.absent.kind !== "none") anyUnionProblem = true;
      return [
        `    @GetMapping("/${snake(f.name)}")`,
        `    public ResponseEntity<?> ${f.name}${agg.name}(${params}) {`,
        `        var r = service.${f.name}(${args});`,
        `        if (r == null) {`,
        ...absent,
        `        }`,
        `        return ResponseEntity.ok(r);`,
        `    }`,
        ``,
      ];
    }
    if (isPagedFind(f)) {
      const pagedParams = [
        ...declared,
        `@RequestParam(defaultValue = "1") int page`,
        `@RequestParam(defaultValue = "20") int pageSize`,
      ].join(", ");
      const pagedArgs = [args, "page, pageSize"].filter(Boolean).join(", ");
      return [
        `    @GetMapping("/${snake(f.name)}")`,
        `    public Paged<${agg.name}Response> ${f.name}${agg.name}(${pagedParams}) {`,
        `        return service.${f.name}(${pagedArgs});`,
        `    }`,
        ``,
      ];
    }
    const single = f.returnType.kind !== "array";
    const retType = single ? `ResponseEntity<${agg.name}Response>` : `List<${agg.name}Response>`;
    return [
      `    @GetMapping("/${snake(f.name)}")`,
      `    public ${retType} ${f.name}${agg.name}(${params}) {`,
      single
        ? `        var response = service.${f.name}(${args});`
        : `        return service.${f.name}(${args});`,
      single
        ? `        return response == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(response);`
        : null,
      `    }`,
      ``,
    ].filter((l): l is string => l !== null);
  });

  const destroyRoutes =
    (agg.destroys?.length ?? 0) > 0
      ? [
          `    @DeleteMapping("/{id}")`,
          `    @ResponseStatus(HttpStatus.NO_CONTENT)`,
          `    public void destroy${agg.name}(@PathVariable ${idJava} id) {`,
          `        service.destroy${agg.name}(new ${idClass}(id));`,
          `    }`,
          ``,
        ]
      : [];

  const createRoute = emitsRestCreate(agg)
    ? [
        `    @PostMapping`,
        `    public ResponseEntity<Create${agg.name}Response> create${agg.name}(@RequestBody Create${agg.name}Request request) {`,
        `        var id = service.create${agg.name}(request);`,
        `        CatalogLog.event("aggregate_created", "info", "aggregate", "${agg.name}", "id", id.value());`,
        `        return ResponseEntity.created(URI.create("${ctx.routePrefix ?? ""}/${route}/" + id.value()))`,
        `            .body(new Create${agg.name}Response(id.value()));`,
        `    }`,
        ``,
      ]
    : [];
  const body = [
    ...createRoute,
    `    @GetMapping("/{id}")`,
    `    public ResponseEntity<${agg.name}Response> get${agg.name}ById(@PathVariable ${idJava} id) {`,
    `        var response = service.get${agg.name}ById(new ${idClass}(id));`,
    `        return response == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(response);`,
    `    }`,
    ``,
    ...opRoutes,
    `    @GetMapping`,
    `    public List<${agg.name}Response> all${agg.name}() {`,
    `        return service.all${agg.name}();`,
    `    }`,
    ``,
    ...findRoutes,
    ...destroyRoutes,
  ];
  while (body[body.length - 1] === "") body.pop();

  return lines(
    `package ${ctx.pkg};`,
    ``,
    `import java.net.URI;`,
    ...[...imports].sort().map((i) => `import ${i};`),
    ``,
    `import org.springframework.http.HttpStatus;`,
    anyReturnUnion || anyUnionProblem ? `import org.springframework.http.MediaType;` : null,
    anyReturnUnion || anyUnionProblem ? `import org.springframework.http.ProblemDetail;` : null,
    `import org.springframework.http.ResponseEntity;`,
    `import org.springframework.web.bind.annotation.*;`,
    ``,
    ctx.applicationPkg !== ctx.pkg ? `import ${ctx.applicationPkg}.*;` : null,
    ...[...unionImports].sort().map((i) => `import ${i};`),
    declaredFinds(repo).some(isPagedFind) ? `import ${ctx.basePkg}.domain.common.Paged;` : null,
    `import ${ctx.basePkg}.domain.ids.*;`,
    `import ${ctx.basePkg}.domain.enums.*;`,
    `import ${ctx.basePkg}.config.CatalogLog;`,
    ``,
    `@RestController`,
    `@RequestMapping("${ctx.routePrefix ?? ""}/${route}")`,
    `public class ${plural(agg.name)}Controller {`,
    `    private final ${agg.name}Service service;`,
    ``,
    `    public ${plural(agg.name)}Controller(${agg.name}Service service) {`,
    `        this.service = service;`,
    `    }`,
    ``,
    ...body,
    `}`,
    ``,
  );
}

/** RFC 7807 problem+json advice — the DomainExceptionFilter / Hono
 *  onError analog: same statuses, same envelope, same 422 `errors[]`
 *  extension shape, so the frontend ACL works against any backend. */
export function renderApiExceptionAdvice(
  basePkg: string,
  hasUniqueKeys = false,
  hasVersioned = false,
  /** App-wide `httpStatus` overrides for the structural-conflict built-ins
   *  (M-T3.4a). Every hardcoded 409 site below resolves through it, defaulting
   *  to 409 → byte-identical output with no override. */
  structuralErrorStatuses?: Record<string, number>,
): string {
  // Structural-conflict statuses resolved through the `httpStatus` mapper
  // (expressible-builtins.md §3 / M-T3.4a): a literal 409 by default, or the
  // api's `httpStatus <Conflict> <Code>` override. Baked into the emitted Java
  // so the runtime arm and the OpenAPI declaration can't drift.
  const disallowedStatus = resolveErrorStatus("Disallowed", structuralErrorStatuses);
  const uniquenessStatus = resolveErrorStatus("UniquenessConflict", structuralErrorStatuses);
  const referencedInUseStatus = resolveErrorStatus("ReferencedInUse", structuralErrorStatuses);
  const concurrencyStatus = resolveErrorStatus("ConcurrencyConflict", structuralErrorStatuses);
  return lines(
    `package ${basePkg}.api;`,
    ``,
    `import java.util.stream.Collectors;`,
    ``,
    // The 23505 → 409 handler (+ its import) is emitted only when some aggregate
    // declares a `unique (...)` key — a unique-free project stays byte-identical.
    hasUniqueKeys && `import org.springframework.dao.DataIntegrityViolationException;`,
    // The optimistic-lock → 409 handler (+ its import) is emitted only when some
    // aggregate is `versioned` — a version-free project stays byte-identical.
    hasVersioned && `import org.springframework.orm.ObjectOptimisticLockingFailureException;`,
    `import org.springframework.http.HttpStatus;`,
    `import org.springframework.http.MediaType;`,
    `import org.springframework.http.ProblemDetail;`,
    `import org.springframework.http.ResponseEntity;`,
    `import org.springframework.http.converter.HttpMessageNotReadableException;`,
    `import org.springframework.web.bind.annotation.ExceptionHandler;`,
    `import org.springframework.web.bind.annotation.RestControllerAdvice;`,
    `import org.springframework.web.context.request.WebRequest;`,
    ``,
    `import ${basePkg}.domain.common.AggregateNotFoundException;`,
    `import ${basePkg}.domain.common.DisallowedException;`,
    `import ${basePkg}.domain.common.DomainException;`,
    `import ${basePkg}.domain.common.ForbiddenException;`,
    `import ${basePkg}.domain.common.WireValidationException;`,
    `import ${basePkg}.config.CatalogLog;`,
    ``,
    `@RestControllerAdvice`,
    `public class ApiExceptionAdvice {`,
    ``,
    `    @ExceptionHandler(WireValidationException.class)`,
    `    public ResponseEntity<ProblemDetail> onValidation(WireValidationException e, WebRequest request) {`,
    `        CatalogLog.event("domain_error", "warn", "message", "Validation failed", "status", 422);`,
    `        var problem = problem(422, "Validation failed", "One or more fields are invalid.", request);`,
    `        problem.setProperty("errors", e.errors().stream()`,
    `            .map(err -> java.util.Map.of("pointer", err.pointer(), "message", err.message()))`,
    `            .collect(Collectors.toList()));`,
    `        return respond(problem, 422);`,
    `    }`,
    ``,
    `    @ExceptionHandler(ForbiddenException.class)`,
    `    public ResponseEntity<ProblemDetail> onForbidden(ForbiddenException e, WebRequest request) {`,
    `        CatalogLog.event("forbidden", "warn", "message", e.getMessage(), "status", 403);`,
    `        return respond(problem(403, "Forbidden", e.getMessage(), request), 403);`,
    `    }`,
    ``,
    `    @ExceptionHandler(DomainException.class)`,
    `    public ResponseEntity<ProblemDetail> onDomain(DomainException e, WebRequest request) {`,
    `        CatalogLog.event("domain_error", "warn", "message", e.getMessage(), "status", 400);`,
    `        return respond(problem(400, "Bad Request", e.getMessage(), request), 400);`,
    `    }`,
    ``,
    `    @ExceptionHandler(DisallowedException.class)`,
    `    public ResponseEntity<ProblemDetail> onDisallowed(DisallowedException e, WebRequest request) {`,
    `        CatalogLog.event("disallowed", "warn", "message", e.getMessage(), "status", ${disallowedStatus});`,
    `        return respond(problem(${disallowedStatus}, "Disallowed", e.getMessage(), request), ${disallowedStatus});`,
    `    }`,
    ``,
    hasUniqueKeys && [
      `    @ExceptionHandler(DataIntegrityViolationException.class)`,
      `    public ResponseEntity<ProblemDetail> onConflict(DataIntegrityViolationException e, WebRequest request) {`,
      `        // A DB constraint tripped; Spring translates it to DataIntegrityViolationException.`,
      `        // Discriminate by Postgres SQLState so a still-referenced delete (23503`,
      `        // foreign_key_violation → \`ReferencedInUse\`) is not conflated with a`,
      `        // \`unique (...)\` breach (23505 unique_violation → \`UniquenessConflict\`).`,
      `        // Either way return a friendly conflict instead of leaking a 500.`,
      `        if ("23503".equals(sqlState(e))) {`,
      `            CatalogLog.event("conflict", "warn", "message", "This resource is still referenced and cannot be deleted.", "status", ${referencedInUseStatus});`,
      `            return respond(problem(${referencedInUseStatus}, "Conflict", "This resource is still referenced and cannot be deleted.", request), ${referencedInUseStatus});`,
      `        }`,
      `        CatalogLog.event("disallowed", "warn", "message", "A resource with these values already exists.", "status", ${uniquenessStatus});`,
      `        return respond(problem(${uniquenessStatus}, "Conflict", "A resource with these values already exists.", request), ${uniquenessStatus});`,
      `    }`,
      ``,
    ],
    hasVersioned && [
      `    @ExceptionHandler(org.springframework.orm.ObjectOptimisticLockingFailureException.class)`,
      `    public ResponseEntity<ProblemDetail> onConcurrencyConflict(ObjectOptimisticLockingFailureException e, WebRequest request) {`,
      `        // A \`versioned\` aggregate's optimistic-lock check failed — either the`,
      `        // client's If-Match expected version was stale (think-time CAS) or the`,
      `        // load→save window lost a race (Hibernate @Version write-time CAS).`,
      `        // Return a friendly 409 instead of leaking a 500.`,
      `        CatalogLog.event("conflict", "warn", "message", "The resource was modified by another request; reload and retry.", "status", ${concurrencyStatus});`,
      `        return respond(problem(${concurrencyStatus}, "Conflict", "The resource was modified by another request; reload and retry.", request), ${concurrencyStatus});`,
      `    }`,
      ``,
    ],
    `    @ExceptionHandler(AggregateNotFoundException.class)`,
    `    public ResponseEntity<ProblemDetail> onNotFound(AggregateNotFoundException e, WebRequest request) {`,
    `        CatalogLog.event("not_found", "warn", "status", 404);`,
    `        return respond(problem(404, "Not Found", e.getMessage(), request), 404);`,
    `    }`,
    ``,
    `    @ExceptionHandler(HttpMessageNotReadableException.class)`,
    `    public ResponseEntity<ProblemDetail> onUnreadable(HttpMessageNotReadableException e, WebRequest request) {`,
    `        return respond(problem(400, "Bad Request", "Malformed request body.", request), 400);`,
    `    }`,
    ``,
    `    @ExceptionHandler(Exception.class)`,
    `    public ResponseEntity<ProblemDetail> onUnhandled(Exception e, WebRequest request) {`,
    `        CatalogLog.event("internal_error", "error", "error", e.getMessage(), "status", 500);`,
    `        e.printStackTrace();`,
    `        return respond(problem(500, "Internal Server Error", "internal", request), 500);`,
    `    }`,
    ``,
    `    private static ProblemDetail problem(int status, String title, String detail, WebRequest request) {`,
    `        var problem = ProblemDetail.forStatus(HttpStatus.valueOf(status));`,
    `        problem.setTitle(title);`,
    `        problem.setDetail(detail);`,
    `        return problem;`,
    `    }`,
    ``,
    `    private static ResponseEntity<ProblemDetail> respond(ProblemDetail problem, int status) {`,
    `        return ResponseEntity.status(status)`,
    `            .contentType(MediaType.APPLICATION_PROBLEM_JSON)`,
    `            .body(problem);`,
    `    }`,
    // The SQLState reader is emitted only alongside the DataIntegrityViolation
    // handler that calls it (gated on `hasUniqueKeys`), so a unique-free project
    // stays byte-identical.
    hasUniqueKeys && [
      ``,
      `    /** First Postgres SQLState in a DataAccessException's cause chain, or null`,
      `     *  — 23503 = foreign_key_violation (still referenced), 23505 = unique. */`,
      `    private static String sqlState(Throwable e) {`,
      `        for (Throwable t = e; t != null; t = t.getCause()) {`,
      `            if (t instanceof java.sql.SQLException sql) return sql.getSQLState();`,
      `        }`,
      `        return null;`,
      `    }`,
    ],
    `}`,
    ``,
  );
}
