import { hasCreate } from "../../../ir/enrich/wire-projection.js";
import type { EnrichedAggregateIR, RepositoryIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { javaValueTypeForId, renderJavaType } from "../render-expr.js";
import { declaredFinds } from "./repository.js";

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
}

export function renderJavaController(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: ControllerCtx,
): string {
  const route = snake(plural(agg.name));
  const idJava = javaValueTypeForId(agg.idValueType);
  const imports = new Set<string>(["java.util.List"]);
  if (idJava === "UUID") imports.add("java.util.UUID");

  // Extern ops route identically — the service dispatches to the
  // user-supplied handler instead of an aggregate method.
  const opRoutes = agg.operations
    .filter((op) => op.visibility === "public")
    .flatMap((op) => {
      const hasParams = op.params.length > 0;
      const reqType = `${upperFirst(op.name)}${agg.name}Request`;
      return [
        `    @PostMapping("/{id}/${snake(op.name)}")`,
        `    @ResponseStatus(HttpStatus.NO_CONTENT)`,
        hasParams
          ? `    public void ${op.name}${agg.name}(@PathVariable ${idJava} id, @RequestBody ${reqType} request) {`
          : `    public void ${op.name}${agg.name}(@PathVariable ${idJava} id) {`,
        hasParams
          ? `        service.${op.name}(new ${agg.name}Id(id), request);`
          : `        service.${op.name}(new ${agg.name}Id(id));`,
        `    }`,
        ``,
      ];
    });

  const findRoutes = declaredFinds(repo).flatMap((f) => {
    const params = f.params
      .map((p) => `@RequestParam ${renderJavaType(p.type)} ${p.name}`)
      .join(", ");
    const args = f.params.map((p) => p.name).join(", ");
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
          `        service.destroy${agg.name}(new ${agg.name}Id(id));`,
          `    }`,
          ``,
        ]
      : [];

  const createRoute = hasCreate(agg)
    ? [
        `    @PostMapping`,
        `    public ResponseEntity<Create${agg.name}Response> create${agg.name}(@RequestBody Create${agg.name}Request request) {`,
        `        var id = service.create${agg.name}(request);`,
        `        log.info("aggregate_created aggregate=${agg.name} id={}", id.value());`,
        `        return ResponseEntity.created(URI.create("/${route}/" + id.value()))`,
        `            .body(new Create${agg.name}Response(id.value()));`,
        `    }`,
        ``,
      ]
    : [];
  const body = [
    ...createRoute,
    `    @GetMapping("/{id}")`,
    `    public ResponseEntity<${agg.name}Response> get${agg.name}ById(@PathVariable ${idJava} id) {`,
    `        var response = service.get${agg.name}ById(new ${agg.name}Id(id));`,
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
    `import org.slf4j.Logger;`,
    `import org.slf4j.LoggerFactory;`,
    `import org.springframework.http.HttpStatus;`,
    `import org.springframework.http.ResponseEntity;`,
    `import org.springframework.web.bind.annotation.*;`,
    ``,
    ctx.applicationPkg !== ctx.pkg ? `import ${ctx.applicationPkg}.*;` : null,
    `import ${ctx.basePkg}.domain.ids.*;`,
    ``,
    `@RestController`,
    `@RequestMapping("/${route}")`,
    `public class ${plural(agg.name)}Controller {`,
    `    private static final Logger log = LoggerFactory.getLogger(${plural(agg.name)}Controller.class);`,
    ``,
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
export function renderApiExceptionAdvice(basePkg: string): string {
  return lines(
    `package ${basePkg}.api;`,
    ``,
    `import java.util.stream.Collectors;`,
    ``,
    `import org.slf4j.Logger;`,
    `import org.slf4j.LoggerFactory;`,
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
    `import ${basePkg}.domain.common.DomainException;`,
    `import ${basePkg}.domain.common.ForbiddenException;`,
    `import ${basePkg}.domain.common.WireValidationException;`,
    ``,
    `@RestControllerAdvice`,
    `public class ApiExceptionAdvice {`,
    `    private static final Logger log = LoggerFactory.getLogger(ApiExceptionAdvice.class);`,
    ``,
    `    @ExceptionHandler(WireValidationException.class)`,
    `    public ResponseEntity<ProblemDetail> onValidation(WireValidationException e, WebRequest request) {`,
    `        var problem = problem(422, "Validation failed", "One or more fields are invalid.", request);`,
    `        problem.setProperty("errors", e.errors().stream()`,
    `            .map(err -> java.util.Map.of("pointer", err.pointer(), "message", err.message()))`,
    `            .collect(Collectors.toList()));`,
    `        return respond(problem, 422);`,
    `    }`,
    ``,
    `    @ExceptionHandler(ForbiddenException.class)`,
    `    public ResponseEntity<ProblemDetail> onForbidden(ForbiddenException e, WebRequest request) {`,
    `        return respond(problem(403, "Forbidden", e.getMessage(), request), 403);`,
    `    }`,
    ``,
    `    @ExceptionHandler(DomainException.class)`,
    `    public ResponseEntity<ProblemDetail> onDomain(DomainException e, WebRequest request) {`,
    `        return respond(problem(400, "Bad Request", e.getMessage(), request), 400);`,
    `    }`,
    ``,
    `    @ExceptionHandler(AggregateNotFoundException.class)`,
    `    public ResponseEntity<ProblemDetail> onNotFound(AggregateNotFoundException e, WebRequest request) {`,
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
    `        log.error("internal_error error={} status=500", e.getMessage(), e);`,
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
    `}`,
    ``,
  );
}
