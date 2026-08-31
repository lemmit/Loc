import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import type { ApiOperationIR } from "../../../ir/util/api-surface.js";
import {
  apiStatusContext,
  deriveAggregateOperations,
  isAllFind,
  relativeOpPath,
} from "../../../ir/util/api-surface.js";
import { problemTitle, UNPROCESSABLE_ENTITY } from "../../../ir/util/openapi-errors.js";
import { listReadFind } from "../../../ir/util/read-gates.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { lines } from "../../../util/code-builder.js";
import {
  defaultErrorStatus,
  errorTitle,
  errorTypeUri,
  resolveErrorStatus,
} from "../../../util/error-defaults.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { javaLogEvent } from "../../_obs/render-java.js";
import { findUnionSpec } from "../../_payload/union-wire.js";
import {
  collectJavaExprImports,
  javaValueTypeForId,
  renderJavaExpr,
  renderJavaType,
} from "../render-expr.js";
import { javaAuditApiPkg, javaHistoryFind, renderJavaHistoryRoute } from "./audit-history.js";
import { JAVA_FIND_ABSENCE_THROW, JAVA_PAGED_QUERY_PARAMS } from "./common.js";
import { declaredFinds, isPagedAutoAll, isPagedFind } from "./repository.js";
import { returnUnionSpec, unionWireCtorArgs } from "./unions.js";
import { javaCommandValidatorNames } from "./validator.js";
import { collectWireImports, wireJavaType } from "./wire.js";

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
// DomainException 422 (RS-15), ForbiddenException 403, AggregateNotFound 404,
// MethodArgumentNotValidException 422 (+ `errors[]` extension), fallback 500.
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
  // THE UNIFICATION SEAM (api-surface.ts): which routes exist and at which
  // path comes from the shared derivation (the statuses live in the OpenAPI
  // customizer, which reads the same list).  This file keeps what is
  // genuinely java's: DTO/record names, service calls, handler bodies, the
  // union ProblemDetail arms, and the entity-history route (notLifted).
  const derivedOps = ctx.boundedContext
    ? deriveAggregateOperations(agg, repo, apiStatusContext(ctx.boundedContext))
    : deriveAggregateOperations(agg, repo);
  const opEntries = derivedOps.filter((o) => o.kind === "operation");
  const probeByOp = new Map<unknown, ApiOperationIR>(
    derivedOps.filter((o) => o.kind === "gateProbe").map((o) => [o.operation, o]),
  );
  const findEntries = derivedOps.filter((o) => o.kind === "find" && !isAllFind(o));
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
  // A synthesized find (paged-run queryHandler support) is never auto-exposed
  // by the aggregate controller — the queryHandler's own route is the exposure.
  for (const f of declaredFinds(repo).filter((f) => !f.synthesized)) {
    for (const p of f.params) {
      // An id param binds as its raw value type (see findRoutes), so pull the
      // raw type's import — not `renderJavaType`'s `<Agg>Id` wrapper (which never
      // mentions UUID).
      const rendered =
        p.type.kind === "id" ? javaValueTypeForId(p.type.valueType) : renderJavaType(p.type);
      if (rendered.includes("BigDecimal")) imports.add("java.math.BigDecimal");
      if (rendered.includes("Instant")) imports.add("java.time.Instant");
      if (rendered.includes("UUID")) imports.add("java.util.UUID");
    }
  }

  // Authorization gates on finds (default-deny) — a `requires <expr>` runs in
  // the controller action before delegating to the service, throwing
  // ForbiddenException (→ 403 via ApiExceptionAdvice).  When the gate reads the
  // principal the controller injects a
  // `CurrentUserAccessor`; `requires true` needs neither.
  // Entity history (docs/audit.md §3) — the derived `GET /{id}/history`.  Read
  // off the enrichment-derived `historyFind` (which sits BESIDE `finds`), so
  // the route's gate is the one enrichment copied from the aggregate's list
  // read and cannot drift from it.  Its gate joins the find gates for the
  // import / accessor-injection decisions below.
  const historyFind = javaHistoryFind(repo);
  // The LIST read (`find all`).  `declaredFinds` filters it out — the list
  // endpoint has its own route shape (paging controls / the `<Agg>Paged`
  // envelope), emitted below rather than in the named-find loop — so its gate
  // has to be picked up explicitly or it is silently dropped and the list
  // serves ungated (`listReadGate`'s header for why this is a shared helper).
  const listRead = listReadFind(repo);
  const listReadGated = listRead?.requires ? listRead : undefined;
  const gatedFinds = [
    ...declaredFinds(repo).filter((f) => !f.synthesized && f.requires),
    ...(listReadGated ? [listReadGated] : []),
    ...(historyFind?.requires ? [historyFind] : []),
  ];
  const anyFindGate = gatedFinds.length > 0;
  const anyFindGateUsesUser = gatedFinds.some((f) => exprUsesCurrentUser(f.requires));
  for (const f of gatedFinds) collectJavaExprImports(f.requires!, imports);
  /** Gate lines for one find action: bind the principal (when the predicate
   *  reads it) then a 403 on failure. */
  const findGateLines = (f: (typeof gatedFinds)[number]): string[] => {
    const gl: string[] = [];
    if (exprUsesCurrentUser(f.requires)) {
      gl.push(`        var currentUser = currentUserAccessor.user();`);
    }
    gl.push(
      `        if (!(${renderJavaExpr(f.requires!, { thisName: "this" })})) throw new ForbiddenException(${JSON.stringify(
        `Forbidden: find ${f.name}`,
      )});`,
    );
    return gl;
  };

  const unionImports = new Set<string>();
  let anyUnionProblem = false;
  /** Set when a find arm throws the shared find-absence 404 (RS-22/RS-27), so
   *  the controller imports `AggregateNotFoundException` only where it uses it. */
  let anyFindAbsenceThrow = false;
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
  const canRouteLines = (op: (typeof agg.operations)[number]): string[] => {
    const probe = probeByOp.get(op);
    if (!probe) return [];
    return [
      `    @GetMapping("${relativeOpPath(probe)}")`,
      `    public CanResponse can${upperFirst(op.name)}${agg.name}(@PathVariable ${idJava} id) {`,
      `        return new CanResponse(service.can${upperFirst(op.name)}(new ${idClass}(id)));`,
      `    }`,
      ``,
    ];
  };
  const opRoutes = opEntries.flatMap((entry) => {
    const op = entry.operation!;
    // NAMED FIX (unification): the mount honors `routeSlug` — java was the
    // only backend rendering `snake(op.name)` here, so a `urlStyle: resource`
    // op mounted at a URL the other four backends (and every generated
    // client) do not use.
    const opMapping = `    @PostMapping("${relativeOpPath(entry)}")`;
    {
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
            // The error variant's DECLARED FIELDS ride the problem body as 7807
            // extension members — `error NotFound { resource: string }` puts
            // `"resource": "<value>"` alongside type/title/status/detail, which
            // is what the other four backends send and what the emitted OpenAPI
            // for this union already declares.  Omitting them shipped a body
            // whose declared payload was silently empty (RS-19): the arm
            // carried the right STATUS and no DATA, so a client reading
            // `body.resource` got null on java alone.
            const props = a.member.shape === "record" ? a.member.fields : [];
            return [
              `            case ${spec.name}_${a.tag} v -> {`,
              `                var problem = ProblemDetail.forStatus(${a.status});`,
              `                problem.setTitle(${JSON.stringify(a.title)});`,
              `                problem.setType(URI.create(${JSON.stringify(a.typeUri)}));`,
              `                problem.setDetail(${JSON.stringify(a.title)});`,
              ...props.map(
                (f) =>
                  `                problem.setProperty(${JSON.stringify(f.name)}, v.${f.name}()${f.isId ? ".value()" : ""});`,
              ),
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
          opMapping,
          hasParams
            ? `    public ResponseEntity<?> ${op.name}${agg.name}(@PathVariable ${idJava} id, @Valid @RequestBody ${reqType} request${ifMatchHeaderParam}) {`
            : `    public ResponseEntity<?> ${op.name}${agg.name}(@PathVariable ${idJava} id${ifMatchHeaderParam}) {`,
          `        CatalogLog.event(${javaLogEvent("operationInvoked")}, "aggregate", "${agg.name}", "op", "${op.name}", "id", id);`,
          `        httpMetrics.recordDomainOperation("${agg.name}", "${op.name}");`,
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
      if (op.returnType) {
        // Scalar (non-union) return (BUG-003): 200 with the returned value
        // serialized to wire, instead of computing-then-discarding as 204.
        // The service already returns the wire-typed value (domain→wire happens
        // there, parallel to the union path's captured `result`); the controller
        // just wraps it in `ResponseEntity.ok`.  A CONCRETE `ResponseEntity<WireType>`
        // lets springdoc infer the 200 body natively (unlike the union's
        // `ResponseEntity<?>`, which needs the explicit `successRef`).  The
        // type is BOXED (`Boolean`/`Integer`/`Long`, not the primitive) because
        // it sits in a generic position — `ResponseEntity<boolean>` doesn't
        // compile (`operation taken(): bool`).
        const wireRet = wireJavaType(op.returnType, "Response", true);
        collectWireImports(op.returnType, imports);
        return [
          opMapping,
          hasParams
            ? `    public ResponseEntity<${wireRet}> ${op.name}${agg.name}(@PathVariable ${idJava} id, @Valid @RequestBody ${reqType} request${ifMatchHeaderParam}) {`
            : `    public ResponseEntity<${wireRet}> ${op.name}${agg.name}(@PathVariable ${idJava} id${ifMatchHeaderParam}) {`,
          `        CatalogLog.event(${javaLogEvent("operationInvoked")}, "aggregate", "${agg.name}", "op", "${op.name}", "id", id);`,
          `        httpMetrics.recordDomainOperation("${agg.name}", "${op.name}");`,
          hasParams
            ? `        var result = service.${op.name}(new ${idClass}(id), request${ifMatchServiceArg});`
            : `        var result = service.${op.name}(new ${idClass}(id)${ifMatchServiceArg});`,
          `        return ResponseEntity.ok(result);`,
          `    }`,
          ``,
          ...canRouteLines(op),
        ];
      }
      return [
        opMapping,
        `    @ResponseStatus(HttpStatus.NO_CONTENT)`,
        hasParams
          ? `    public void ${op.name}${agg.name}(@PathVariable ${idJava} id, @Valid @RequestBody ${reqType} request${ifMatchHeaderParam}) {`
          : `    public void ${op.name}${agg.name}(@PathVariable ${idJava} id${ifMatchHeaderParam}) {`,
        `        CatalogLog.event(${javaLogEvent("operationInvoked")}, "aggregate", "${agg.name}", "op", "${op.name}", "id", id);`,
        `        httpMetrics.recordDomainOperation("${agg.name}", "${op.name}");`,
        hasParams
          ? `        service.${op.name}(new ${idClass}(id), request${ifMatchServiceArg});`
          : `        service.${op.name}(new ${idClass}(id)${ifMatchServiceArg});`,
        `    }`,
        ``,
        ...canRouteLines(op),
      ];
    }
  });

  const findRoutes = findEntries.flatMap((entry) => {
    const f = entry.find!;
    {
      // An id-typed find param (`find byOrder(order: Order id)`) binds as its
      // RAW underlying type (`UUID`/`long`/…) and wraps into the id class at the
      // service call — Spring has no `String → <Agg>Id` value-type converter, so
      // binding `@RequestParam OrderId` 500s.  Mirrors the getById path variable
      // (`@PathVariable UUID id` → `new OrderId(id)`).
      const declared = f.params.map((p) =>
        p.type.kind === "id"
          ? `@RequestParam ${javaValueTypeForId(p.type.valueType)} ${p.name}`
          : `@RequestParam ${renderJavaType(p.type)} ${p.name}`,
      );
      const params = declared.join(", ");
      const args = f.params
        .map((p) => (p.type.kind === "id" ? `new ${p.type.targetName}Id(${p.name})` : p.name))
        .join(", ");
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
        if (spec.absent.kind === "none") anyFindAbsenceThrow = true;
        const absent =
          spec.absent.kind === "none"
            ? // RS-22/RS-27 — THROW, so the `@RestControllerAdvice` renders the
              // five-member envelope.  `ResponseEntity.notFound().build()` is
              // Spring's own bare 404 with an EMPTY BODY and never reaches the
              // advice; it would also make this controller emit two different
              // wires for shapes `payloads.md` declares wire-identical, since
              // the `error`-variant branch below builds a
              // real ProblemDetail.
              [`            throw ${JAVA_FIND_ABSENCE_THROW};`]
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
          `    @GetMapping("${relativeOpPath(entry)}")`,
          `    public ResponseEntity<?> ${f.name}${agg.name}(${params}) {`,
          ...(f.requires ? findGateLines(f) : []),
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
        const pagedParams = [...declared, ...JAVA_PAGED_QUERY_PARAMS].join(", ");
        const pagedArgs = [args, "page, pageSize, sort, dir"].filter(Boolean).join(", ");
        // F2-W-07 — return the CONCRETE `<Agg>Paged` record, exactly as the
        // auto-findAll route below does.  Returning the raw `Paged<T>` generic
        // made springdoc name the component `Paged<Agg>Response`, while node
        // (`.openapi("<Agg>Paged")`), python (`response_model=<Agg>Paged`),
        // elixir (`<Agg>Paged` schema) and .NET (`CustomSchemaIds` mapping
        // `Paged<T>` → `<Agg>Paged`) all publish `<Agg>Paged` for the same
        // route.  The service still returns `Paged<T>`; the controller wraps.
        return [
          `    @GetMapping("${relativeOpPath(entry)}")`,
          `    public ${agg.name}Paged ${f.name}${agg.name}(${pagedParams}) {`,
          ...(f.requires ? findGateLines(f) : []),
          `        var result = service.${f.name}(${pagedArgs});`,
          `        return new ${agg.name}Paged(result.items(), result.page(), result.pageSize(), result.total(), result.totalPages());`,
          `    }`,
          ``,
        ];
      }
      const single = f.returnType.kind !== "array";
      if (single) anyFindAbsenceThrow = true;
      const retType = single ? `ResponseEntity<${agg.name}Response>` : `List<${agg.name}Response>`;
      return [
        `    @GetMapping("${relativeOpPath(entry)}")`,
        `    public ${retType} ${f.name}${agg.name}(${params}) {`,
        ...(f.requires ? findGateLines(f) : []),
        single
          ? `        var response = service.${f.name}(${args});`
          : `        return service.${f.name}(${args});`,
        single
          ? // RS-22/RS-27 — same repair as the `option` arm above: an OPTIONAL
            // find (`find byEmail(...): Customer?`) is wire-identical to
            // `Customer option`, so its miss must carry the same five-member
            // envelope rather than Spring's bare empty 404.
            `        if (response == null) throw ${JAVA_FIND_ABSENCE_THROW};\n        return ResponseEntity.ok(response);`
          : null,
        `    }`,
        ``,
      ].filter((l): l is string => l !== null);
    }
  });

  // NAMED FIX (unification): the DELETE gate is the shared `emitsRestDestroy`
  // (canonical destroy), not `destroys.length > 0` — a named-only destroy is a
  // domain command, and java was the only backend mounting a generic DELETE
  // for it (a route its own OpenAPI customizer refused to document).
  const destroyEntry = derivedOps.find((o) => o.kind === "destroy");
  const destroyRoutes = destroyEntry
    ? [
        `    @DeleteMapping("${relativeOpPath(destroyEntry)}")`,
        `    @ResponseStatus(HttpStatus.NO_CONTENT)`,
        `    public void destroy${agg.name}(@PathVariable ${idJava} id) {`,
        `        service.destroy${agg.name}(new ${idClass}(id));`,
        `    }`,
        ``,
      ]
    : [];

  const createEntry = derivedOps.find((o) => o.kind === "create");
  const createRoute = createEntry
    ? [
        `    @PostMapping${relativeOpPath(createEntry) === "" ? "" : `("${relativeOpPath(createEntry)}")`}`,
        `    public ResponseEntity<Create${agg.name}Response> create${agg.name}(@Valid @RequestBody Create${agg.name}Request request) {`,
        `        var id = service.create${agg.name}(request);`,
        `        CatalogLog.event(${javaLogEvent("aggregateCreated")}, "aggregate", "${agg.name}", "id", id.value());`,
        `        httpMetrics.recordDomainOperation("${agg.name}", "create");`,
        `        return ResponseEntity.created(URI.create("${ctx.routePrefix ?? ""}/${route}/" + id.value()))`,
        `            .body(new Create${agg.name}Response(id.value()));`,
        `    }`,
        ``,
      ]
    : [];
  const pagedAutoAll = isPagedAutoAll(repo);
  const getByIdEntry = derivedOps.find((o) => o.kind === "getById")!;
  const body = [
    ...createRoute,
    `    @GetMapping("${relativeOpPath(getByIdEntry)}")`,
    `    public ResponseEntity<${agg.name}Response> get${agg.name}ById(@PathVariable ${idJava} id) {`,
    // RS-27 — the service THROWS AggregateNotFoundException on a miss (it
    // never returns null), so the `@RestControllerAdvice` renders the RFC-9457
    // envelope with the `"<Agg> <id> not found"` detail.  Answering
    // `ResponseEntity.notFound().build()` here would send Spring's own bare 404
    // with an EMPTY BODY instead.
    `        return ResponseEntity.ok(service.get${agg.name}ById(new ${idClass}(id)));`,
    `    }`,
    ``,
    // Entity history — two path segments, so no collision with the `/{id}`
    // pattern above.
    ...(historyFind ? renderJavaHistoryRoute(agg, historyFind, idJava, idClass) : []),
    ...opRoutes,
    // Auto-findAll (M-T2.6): paged for a plain relational aggregate — the
    // `<Agg>Paged` envelope + page/pageSize/sort/dir controls, matching every
    // other backend.  A non-paged findAll (document/embedded/inheritance) keeps
    // the bare-array `List<<Agg>Response>`.
    ...(pagedAutoAll
      ? [
          `    @GetMapping`,
          `    public ${agg.name}Paged all${agg.name}(${JAVA_PAGED_QUERY_PARAMS.join(", ")}) {`,
          ...(listReadGated ? findGateLines(listReadGated) : []),
          `        var result = service.all${agg.name}(page, pageSize, sort, dir);`,
          `        return new ${agg.name}Paged(result.items(), result.page(), result.pageSize(), result.total(), result.totalPages());`,
          `    }`,
          ``,
        ]
      : [
          `    @GetMapping`,
          `    public List<${agg.name}Response> all${agg.name}() {`,
          ...(listReadGated ? findGateLines(listReadGated) : []),
          `        return service.all${agg.name}();`,
          `    }`,
          ``,
        ]),
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
    // No `Paged;` import: since F2-W-07 the controller never names the generic
    // — both paged arms (declared find + auto-findAll) return `<Agg>Paged` and
    // bind the service's `Paged<T>` through `var`.
    anyFindGate ? `import ${ctx.basePkg}.domain.common.ForbiddenException;` : null,
    anyFindAbsenceThrow ? `import ${ctx.basePkg}.domain.common.AggregateNotFoundException;` : null,
    anyFindGateUsesUser ? `import ${ctx.basePkg}.auth.CurrentUserAccessor;` : null,
    // Entity history — the shared `AuditEntry` wire record.  Under byLayer the
    // controller already lives in `<base>.api`, so the import is emitted only
    // when the layout routes it elsewhere (byFeature).
    historyFind && ctx.pkg !== javaAuditApiPkg(ctx.basePkg)
      ? `import ${javaAuditApiPkg(ctx.basePkg)}.AuditEntry;`
      : null,
    `import ${ctx.basePkg}.domain.ids.*;`,
    `import ${ctx.basePkg}.domain.enums.*;`,
    `import ${ctx.basePkg}.config.CatalogLog;`,
    `import ${ctx.basePkg}.config.HttpMetrics;`,
    // `@Valid` triggers Bean Validation on the request DTOs (`@Size`/`@Pattern`/…)
    // at the controller boundary; emitted only when the controller takes a body.
    createEntry !== undefined || agg.operations.some((o) => o.params.length > 0)
      ? `import jakarta.validation.Valid;`
      : null,
    // WebDataBinder for the @InitBinder that registers this aggregate's command
    // validators — only when at least one is emitted.
    javaCommandValidatorNames(agg, ctx.boundedContext?.valueObjects ?? []).length > 0
      ? `import org.springframework.web.bind.WebDataBinder;`
      : null,
    ``,
    `@RestController`,
    `@RequestMapping("${ctx.routePrefix ?? ""}/${route}")`,
    `public class ${plural(agg.name)}Controller {`,
    `    private final ${agg.name}Service service;`,
    `    private final HttpMetrics httpMetrics;`,
    anyFindGateUsesUser ? `    private final CurrentUserAccessor currentUserAccessor;` : null,
    ``,
    `    public ${plural(agg.name)}Controller(${agg.name}Service service, HttpMetrics httpMetrics${anyFindGateUsesUser ? ", CurrentUserAccessor currentUserAccessor" : ""}) {`,
    `        this.service = service;`,
    `        this.httpMetrics = httpMetrics;`,
    anyFindGateUsesUser ? `        this.currentUserAccessor = currentUserAccessor;` : null,
    `    }`,
    ``,
    ...initBinderLines(agg, ctx.boundedContext?.valueObjects ?? []),
    ...body,
    `}`,
    ``,
  );
}

/** Register this aggregate's command validators on the controller's
 *  WebDataBinder so `@Valid @RequestBody` runs them.  The per-request binder
 *  targets ONE request DTO, and `addValidators` asserts every added validator
 *  supports that target — so we add only the one matching `binder.getTarget()`.
 *  The Spring seam analogous to .NET registering the FluentValidation pipeline
 *  behavior.  Emitted only when a validator exists. */
function initBinderLines(
  agg: EnrichedAggregateIR,
  vos: readonly import("../../../ir/types/loom-ir.js").ValueObjectIR[],
): (string | null)[] {
  const validators = javaCommandValidatorNames(agg, vos);
  if (validators.length === 0) return [];
  return [
    `    @InitBinder`,
    `    void initBinder(WebDataBinder binder) {`,
    `        var target = binder.getTarget();`,
    ...validators.map(
      (v) =>
        `        if (target instanceof ${v.requestType}) binder.addValidators(new ${v.className}());`,
    ),
    `    }`,
    ``,
  ];
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
  /** True when this project ships `src/main/resources/messages.properties` — the
   *  422 handler then resolves each field error through `MessageSource` for the
   *  request locale.  False ⇒ byte-identical to pre-catalog output (M-T1.11). */
  localizeMessages = false,
): string {
  // Structural-conflict statuses resolved through the `httpStatus` mapper
  // (expressible-builtins.md §3 / M-T3.4a): a literal 409 by default, or the
  // api's `httpStatus <Conflict> -> <Code>` override. Baked into the emitted Java
  // so the runtime arm and the OpenAPI declaration can't drift.
  const disallowedStatus = resolveErrorStatus("Disallowed", structuralErrorStatuses);
  const uniquenessStatus = resolveErrorStatus("UniquenessConflict", structuralErrorStatuses);
  const referencedInUseStatus = resolveErrorStatus("ReferencedInUse", structuralErrorStatuses);
  const concurrencyStatus = resolveErrorStatus("ConcurrencyConflict", structuralErrorStatuses);
  // M-T5.20 — the domain floor and the `requires` denial resolve through the
  // same `httpStatus` map as the structural conflicts above, instead of the
  // same `httpStatus` map; the defaults are those same 422 / 403 literals.
  const domainStatus = resolveErrorStatus("DomainError", structuralErrorStatuses);
  const forbiddenStatus = resolveErrorStatus("Forbidden", structuralErrorStatuses);
  // The domain not-found rung — the ladder's last literal.  The FRAMEWORK 404
  // arm further down (`no route for <verb> <path>`) is a different concern and
  // stays literal, on this backend and on the other four.
  const notFoundStatus = resolveErrorStatus("NotFound", structuralErrorStatuses);
  const domainTitle = problemTitle(domainStatus);
  const forbiddenTitle = problemTitle(forbiddenStatus);
  const notFoundTitle = problemTitle(notFoundStatus);
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
    // MessageSource + the request locale (M-T1.11) — only when this project ships
    // a message bundle, so a message-less app's imports are unchanged.
    localizeMessages && `import java.util.Locale;`,
    localizeMessages && `import org.springframework.context.MessageSource;`,
    localizeMessages && `import org.springframework.context.NoSuchMessageException;`,
    localizeMessages && `import org.springframework.validation.FieldError;`,
    `import org.springframework.http.HttpStatus;`,
    `import org.springframework.http.MediaType;`,
    `import org.springframework.http.ProblemDetail;`,
    `import org.springframework.http.ResponseEntity;`,
    `import org.springframework.http.converter.HttpMessageNotReadableException;`,
    `import org.springframework.web.bind.MethodArgumentNotValidException;`,
    `import org.springframework.web.bind.annotation.ExceptionHandler;`,
    `import org.springframework.web.bind.annotation.RestControllerAdvice;`,
    `import org.springframework.web.context.request.WebRequest;`,
    `import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;`,
    ``,
    `import ${basePkg}.domain.common.AggregateNotFoundException;`,
    `import ${basePkg}.domain.common.DisallowedException;`,
    `import ${basePkg}.domain.common.DomainException;`,
    `import ${basePkg}.domain.common.ForbiddenException;`,
    `import ${basePkg}.config.CatalogLog;`,
    `import ${basePkg}.config.HttpMetrics;`,
    localizeMessages && `import ${basePkg}.config.RequestContext;`,
    ``,
    `@RestControllerAdvice`,
    `public class ApiExceptionAdvice {`,
    `    private final HttpMetrics httpMetrics;`,
    localizeMessages && `    private final MessageSource messages;`,
    ``,
    localizeMessages
      ? `    public ApiExceptionAdvice(HttpMetrics httpMetrics, MessageSource messages) {`
      : `    public ApiExceptionAdvice(HttpMetrics httpMetrics) {`,
    `        this.httpMetrics = httpMetrics;`,
    localizeMessages && `        this.messages = messages;`,
    `    }`,
    ``,
    // Wire-boundary validation (422): the per-command Spring Validators
    // (registered via @InitBinder, run at `@Valid @RequestBody`) reject through
    // `Errors.rejectValue(field, code, message)`, surfaced as
    // MethodArgumentNotValidException.  Map each field error to the cross-backend
    // `{pointer,message,code?}` envelope — `code` only when it's a `msg.` i18n
    // key (a messaged rule); the message-less sentinel code is omitted.
    `    @ExceptionHandler(MethodArgumentNotValidException.class)`,
    `    public ResponseEntity<ProblemDetail> onValidation(MethodArgumentNotValidException e, WebRequest request) {`,
    `        CatalogLog.event(${javaLogEvent("domainError")}, "message", "Validation failed", "status", 422);`,
    `        httpMetrics.recordDomainFault("domain_error");`,
    `        var problem = problem(422, "Validation failed", "One or more fields are invalid.", request);`,
    // The lookup locale is the AMBIENT request locale (D-CTX-SHAPE), not Spring's
    // own LocaleContextHolder: RequestContext.locale() is the one request-stable
    // value every other governance slice reads, and two locale sources could
    // disagree.  It carries the Accept-Language header verbatim, so
    // forLanguageTag gets the first listed tag.
    localizeMessages &&
      `        var locale = Locale.forLanguageTag(RequestContext.locale().split(",")[0].split(";")[0].trim());`,
    `        problem.setProperty("errors", e.getBindingResult().getFieldErrors().stream()`,
    `            .map(err -> {`,
    `                var entry = new java.util.LinkedHashMap<String, Object>();`,
    `                entry.put("pointer", pointerOf(err.getField()));`,
    // A FieldError IS a MessageSourceResolvable: MessageSource tries its codes
    // (the `msg.<hash>` i18n key) and falls back to getDefaultMessage() — the
    // authored English — when the bundle has no entry for this locale.  The
    // message-less sentinel code resolves to nothing and keeps its default, so
    // no branching is needed here (M-T1.11).
    localizeMessages
      ? `                entry.put("message", resolveMessage(err, locale));`
      : `                entry.put("message", err.getDefaultMessage());`,
    `                var code = err.getCode();`,
    `                if (code != null && code.startsWith("msg.")) entry.put("code", code);`,
    `                return entry;`,
    `            })`,
    `            .collect(Collectors.toList()));`,
    `        return respond(problem, 422);`,
    `    }`,
    ``,
    // A FieldError with NO default message (nothing the wire validators emit, but
    // Spring can raise one for a binding failure) would make getMessage throw and
    // turn this 422 into a 500.  Fall back to the pre-catalog behaviour instead —
    // the same "a render must survive a message shape the DSL admits" reasoning as
    // the Phoenix backend's error-opt stringifier.
    localizeMessages && `    private String resolveMessage(FieldError err, Locale locale) {`,
    localizeMessages && `        try {`,
    localizeMessages && `            return messages.getMessage(err, locale);`,
    localizeMessages && `        } catch (NoSuchMessageException ex) {`,
    localizeMessages && `            return err.getDefaultMessage();`,
    localizeMessages && `        }`,
    localizeMessages && `    }`,
    localizeMessages && ``,
    `    @ExceptionHandler(ForbiddenException.class)`,
    `    public ResponseEntity<ProblemDetail> onForbidden(ForbiddenException e, WebRequest request) {`,
    `        CatalogLog.event(${javaLogEvent("forbidden")}, "message", e.getMessage(), "status", ${forbiddenStatus});`,
    `        httpMetrics.recordDomainFault("forbidden");`,
    `        return respond(problem(${forbiddenStatus}, "${forbiddenTitle}", e.getMessage(), request), ${forbiddenStatus});`,
    `    }`,
    ``,
    `    @ExceptionHandler(DomainException.class)`,
    `    public ResponseEntity<ProblemDetail> onDomain(DomainException e, WebRequest request) {`,
    // RS-15 (owner decision, 2026-07-29): a domain-floor rejection — a tripped
    // `precondition`, a violated `invariant` — is 422 by DEFAULT.  The request
    // is well-formed; the domain refuses it on SEMANTIC grounds, which is what
    // RFC 9110 reserves 422 for.  400 stays for a malformed/unparseable
    // request.  M-T5.20 makes the rung remappable via `httpStatus DomainError
    // -> <Code>`, resolved through the SAME map every structural conflict
    // uses, so the runtime arm and its OpenAPI declaration can't drift.
    `        CatalogLog.event(${javaLogEvent("domainError")}, "message", e.getMessage(), "status", ${domainStatus});`,
    `        httpMetrics.recordDomainFault("domain_error");`,
    `        return respond(problem(${domainStatus}, "${domainTitle}", e.getMessage(), request), ${domainStatus});`,
    `    }`,
    ``,
    `    @ExceptionHandler(DisallowedException.class)`,
    `    public ResponseEntity<ProblemDetail> onDisallowed(DisallowedException e, WebRequest request) {`,
    `        CatalogLog.event(${javaLogEvent("disallowed")}, "message", e.getMessage(), "status", ${disallowedStatus});`,
    `        httpMetrics.recordDomainFault("disallowed");`,
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
      `            CatalogLog.event(${javaLogEvent("conflict")}, "message", "This resource is still referenced and cannot be deleted.", "status", ${referencedInUseStatus});`,
      `            httpMetrics.recordDomainFault("conflict");`,
      `            return respond(problem(${referencedInUseStatus}, "Conflict", "This resource is still referenced and cannot be deleted.", request), ${referencedInUseStatus});`,
      `        }`,
      `        CatalogLog.event(${javaLogEvent("disallowed")}, "message", "A resource with these values already exists.", "status", ${uniquenessStatus});`,
      `        httpMetrics.recordDomainFault("disallowed");`,
      `        return respond(problem(${uniquenessStatus}, "Conflict", "A resource with these values already exists.", request), ${uniquenessStatus});`,
      `    }`,
      ``,
    ],
    hasVersioned && [
      `    @ExceptionHandler(org.springframework.orm.ObjectOptimisticLockingFailureException.class)`,
      `    public ResponseEntity<ProblemDetail> onConcurrencyConflict(ObjectOptimisticLockingFailureException e, WebRequest request) {`,
      `        // A \`versioned\` aggregate's optimistic-lock check failed — either the`,
      `        // client's If-Match expected version was stale (think-time CAS) or the`,
      `        // load→save window lost a race (the repository's guarded version bump`,
      `        // matched zero rows — write-time CAS).`,
      `        // Return a friendly 409 instead of leaking a 500.`,
      `        CatalogLog.event(${javaLogEvent("conflict")}, "message", "The resource was modified by another request; reload and retry.", "status", ${concurrencyStatus});`,
      `        httpMetrics.recordDomainFault("conflict");`,
      `        return respond(problem(${concurrencyStatus}, "Conflict", "The resource was modified by another request; reload and retry.", request), ${concurrencyStatus});`,
      `    }`,
      ``,
    ],
    `    @ExceptionHandler(AggregateNotFoundException.class)`,
    `    public ResponseEntity<ProblemDetail> onNotFound(AggregateNotFoundException e, WebRequest request) {`,
    `        CatalogLog.event(${javaLogEvent("notFound")}, "status", ${notFoundStatus});`,
    `        httpMetrics.recordDomainFault("not_found");`,
    `        return respond(problem(${notFoundStatus}, "${notFoundTitle}", e.getMessage(), request), ${notFoundStatus});`,
    `    }`,
    ``,
    `    @ExceptionHandler(HttpMessageNotReadableException.class)`,
    `    public ResponseEntity<ProblemDetail> onUnreadable(HttpMessageNotReadableException e, WebRequest request) {`,
    `        return respond(problem(400, "Bad Request", "Malformed JSON in request body", request), 400);`,
    `    }`,
    ``,
    // A path `{id}` / typed query param that will not CONVERT — `GET
    // /api/orders/not-a-uuid` against `@PathVariable UUID id`.  Spring raises
    // MethodArgumentTypeMismatchException, which — measured on a booted app,
    // not assumed — does NOT implement `ErrorResponse`, so the 4xx branch of
    // `onUnhandled` below never saw it and the catch-all answered
    // `500 "internal"`: a CLIENT fault reported as a server fault, telling the
    // caller to retry a request that can never succeed.
    //
    // `errorStatuses("getById")` PUBLISHES 422 for exactly this failure ("a
    // path `{id}` is parsed as a uuid … and a failure answers the same 422 the
    // body tier does", src/ir/util/openapi-errors.ts), and Hono's
    // `defaultHook` / .NET's `InvalidModelStateResponseFactory` already answer
    // it.  A request-part parse failure is the wire-validation tier on every
    // backend; keep it there on Java too, with the same `errors[]` pointer
    // shape the body tier emits (`/id`, not the whole document).
    `    @ExceptionHandler(MethodArgumentTypeMismatchException.class)`,
    `    public ResponseEntity<ProblemDetail> onParamTypeMismatch(MethodArgumentTypeMismatchException e, WebRequest request) {`,
    `        CatalogLog.event("domain_error", "warn", "message", "Validation failed", "status", ${UNPROCESSABLE_ENTITY});`,
    `        httpMetrics.recordDomainFault("domain_error");`,
    `        var problem = problem(${UNPROCESSABLE_ENTITY}, "Validation failed", "One or more fields are invalid.", request);`,
    `        var entry = new java.util.LinkedHashMap<String, Object>();`,
    `        entry.put("pointer", pointerOf(e.getName()));`,
    `        var required = e.getRequiredType();`,
    `        entry.put("message", required != null`,
    `            ? "Expected " + required.getSimpleName() + "."`,
    `            : "Invalid value.");`,
    `        problem.setProperty("errors", java.util.List.of(entry));`,
    `        return respond(problem, ${UNPROCESSABLE_ENTITY});`,
    `    }`,
    ``,
    // A PAGED BOUND REFUSED — `GET /api/customers?pageSize=0`, outside the
    // `@Min(1)`/`@Max(500)` that `JAVA_PAGED_QUERY_PARAMS` both publishes and
    // enforces.  Spring raises HandlerMethodValidationException, which — unlike
    // the two arms below — DOES implement `ErrorResponse`, carrying 400.  So it
    // was answered correctly-shaped but with the WRONG STATUS: the other four
    // backends all answer 422 for the same request (`z.coerce.number().min(1)`
    // → Hono's `defaultHook`; `Query(ge=1, le=…)` → FastAPI's
    // RequestValidationError; `[Range(1, …)]` → .NET's
    // `InvalidModelStateResponseFactory`), and java's OWN published contract
    // declares 200 + 422 on these routes and no 400.
    //
    // A rejected query parameter is the WIRE-VALIDATION tier on every backend —
    // the same tier as a malformed path `{id}` (the arm below) and a body field
    // (`MethodArgumentNotValidException`, above).  It answers that tier's 422
    // here too, with the same `errors[]` pointer shape, so one client ACL
    // handles all three (schemathesis F25).
    //
    // NOT to be confused with the malformed-query arm that follows: THAT one is
    // an UNPARSEABLE request (400 is right, and stays), this one is a
    // well-formed request carrying an out-of-contract value.
    `    @ExceptionHandler(org.springframework.web.method.annotation.HandlerMethodValidationException.class)`,
    `    public ResponseEntity<ProblemDetail> onParamValidation(org.springframework.web.method.annotation.HandlerMethodValidationException e, WebRequest request) {`,
    `        CatalogLog.event("domain_error", "warn", "message", "Validation failed", "status", ${UNPROCESSABLE_ENTITY});`,
    `        httpMetrics.recordDomainFault("domain_error");`,
    `        var problem = problem(${UNPROCESSABLE_ENTITY}, "Validation failed", "One or more fields are invalid.", request);`,
    `        var entries = new java.util.ArrayList<java.util.Map<String, Object>>();`,
    `        for (var result : e.getParameterValidationResults()) {`,
    // `getParameterName()` needs javac's `-parameters`, which Spring Boot's
    // Gradle plugin sets by default (and the controllers rely on already —
    // their `@RequestParam` declarations name no value). Guarded anyway so a
    // toolchain that drops the flag degrades to the whole-document pointer
    // rather than emitting `/null`.
    `            var name = result.getMethodParameter().getParameterName();`,
    `            for (var err : result.getResolvableErrors()) {`,
    `                var entry = new java.util.LinkedHashMap<String, Object>();`,
    `                entry.put("pointer", pointerOf(name != null ? name : ""));`,
    `                entry.put("message", err.getDefaultMessage() != null ? err.getDefaultMessage() : "Invalid value.");`,
    `                entries.add(entry);`,
    `            }`,
    `        }`,
    `        problem.setProperty("errors", entries);`,
    `        return respond(problem, ${UNPROCESSABLE_ENTITY});`,
    `    }`,
    ``,
    // A MALFORMED QUERY STRING — `GET /api/customers?=%C3%A0`, a parameter with
    // an empty name.  Tomcat refuses to parse the chunk and throws
    // `InvalidParameterException` out of the first `getParameter()` call, which
    // on a paged read is Spring's own argument resolution.  It extends
    // IllegalStateException and does NOT implement `ErrorResponse`, so — exactly
    // like MethodArgumentTypeMismatchException above — it fell past the 4xx
    // branch of `onUnhandled` and the catch-all answered `500 "internal"`: the
    // third instance of this file's recurring bug, a CLIENT fault reported as a
    // server fault (schemathesis F24, `not_a_server_error` on every paged
    // collection read).
    //
    // Measured on a booted backend, not assumed: `GET /api/customers?=%C3%A0`
    // → 500 before this arm, 400 after; `?pageSize=467` (in-contract, and the
    // other half of the fuzzer's repro) answers 200 either way, so the declared
    // `@Max` bound is not involved.
    //
    // Tomcat has already decided the status — `getErrorCode()` is the 400 it
    // would have sent itself — so take it rather than hardcoding one, and fall
    // back to 400 if a future version leaves it unset.  The type is named
    // fully-qualified (no import added, as with the validation annotations in
    // common.ts); `spring-boot-starter-web` is emitted unconditionally and
    // brings Tomcat, so the class is always on the classpath.
    `    @ExceptionHandler(org.apache.tomcat.util.http.InvalidParameterException.class)`,
    `    public ResponseEntity<ProblemDetail> onMalformedQuery(org.apache.tomcat.util.http.InvalidParameterException e, WebRequest request) {`,
    `        var status = e.getErrorCode() >= 400 ? e.getErrorCode() : 400;`,
    `        var reason = HttpStatus.valueOf(status).getReasonPhrase();`,
    `        CatalogLog.event(${javaLogEvent("clientError")}, "error", "Malformed query string", "status", status);`,
    `        return respond(problem(status, reason, "Malformed query string", request), status);`,
    `    }`,
    ``,
    `    @ExceptionHandler(Exception.class)`,
    `    public ResponseEntity<ProblemDetail> onUnhandled(Exception e, WebRequest request) {`,
    // Spring's OWN framework exceptions are CLIENT errors carrying their own
    // 4xx: a wrong verb (HttpRequestMethodNotSupportedException → 405), an
    // unsupported Content-Type (415), a missing query parameter (400), an
    // unknown path (NoResourceFoundException → 404).  Every one of them
    // implements `ErrorResponse` and knows its status.
    //
    // Without this branch they fell through to the catch-all below and were
    // answered `500 "internal"` — telling a caller who used the wrong verb
    // that the SERVER broke and the request is worth retrying.  Measured on a
    // booted backend: `PUT /api/items` → 500.  The other four answer a 4xx.
    //
    // Matching on the INTERFACE rather than enumerating the concrete types
    // keeps this correct for the framework exceptions we did not think of,
    // and for the ones Spring adds later.
    `        if (e instanceof org.springframework.web.ErrorResponse er) {`,
    `            var status = er.getStatusCode().value();`,
    `            var reason = HttpStatus.valueOf(status).getReasonPhrase();`,
    // `getBody().getDetail()` is Spring's own human-readable explanation
    // ("Method 'PUT' is not supported."); it is null for a few, hence the
    // fall back to the reason phrase so `detail` is never absent.
    // RFC 7807 asks `detail` for an explanation specific to THIS occurrence.
    // Spring's own is specific for most faults, but the two ROUTING misses get
    // the wording the cross-backend wire golden pins — those are the entries
    // every backend produces, so they are the ones that have to agree.
    // `WebRequest` carries neither the URI nor the verb — those are
    // `HttpServletRequest`, reached through the servlet-flavoured subtype the
    // MVC stack always passes here.  Fully qualified so the advice's import
    // block stays as it was.
    `            var servletRequest =`,
    `                ((org.springframework.web.context.request.ServletWebRequest) request).getRequest();`,
    `            var path = servletRequest.getRequestURI();`,
    `            var detail = switch (status) {`,
    `                case 404 -> "no route for " + servletRequest.getMethod() + " " + path;`,
    `                case 405 -> "method " + servletRequest.getMethod() + " is not supported for " + path;`,
    `                default -> er.getBody().getDetail() != null ? er.getBody().getDetail() : reason;`,
    `            };`,
    `            CatalogLog.event(${javaLogEvent("clientError")}, "error", detail, "status", status);`,
    `            return respond(problem(status, reason, detail, request), status);`,
    `        }`,
    `        CatalogLog.event(${javaLogEvent("internalError")}, "error", e.getMessage(), "status", 500);`,
    `        e.printStackTrace();`,
    `        return respond(problem(500, "Internal Server Error", "internal", request), 500);`,
    `    }`,
    ``,
    // RS-9 — the RFC 7807 `type` member must be PRESENT and "about:blank",
    // matching node/dotnet/python/elixir byte-for-byte.  Spring's
    // ProblemDetailJacksonMixin annotates getType() @JsonInclude(NON_DEFAULT),
    // so the default about:blank URI is silently DROPPED from the body — legal
    // per RFC 9457 (absent means about:blank) but a cross-backend divergence
    // the wire golden fails on.  Writing it through setProperty routes it via
    // the mixin's @JsonAnyGetter instead, which has no such suppression; the
    // suppressed getType() is why this cannot produce a duplicate key.
    // (`instance` needs no such help — Spring's message converter fills a null
    // instance with the request URI on the way out.)
    `    private static ProblemDetail problem(int status, String title, String detail, WebRequest request) {`,
    `        var problem = ProblemDetail.forStatus(HttpStatus.valueOf(status));`,
    `        problem.setTitle(title);`,
    `        problem.setDetail(detail);`,
    `        problem.setProperty("type", "about:blank");`,
    `        return problem;`,
    `    }`,
    ``,
    `    private static ResponseEntity<ProblemDetail> respond(ProblemDetail problem, int status) {`,
    `        return ResponseEntity.status(status)`,
    `            .contentType(MediaType.APPLICATION_PROBLEM_JSON)`,
    `            .body(problem);`,
    `    }`,
    ``,
    // RFC 6901 JSON pointer for a Spring binding path (M-T9.25 / F1
    // nested-errors-pointer-shape).  Spring spells a nested VO-collection
    // violation `lineTotals[0].unitPrice` — Java property-path notation, NOT a
    // pointer — so a nested `errors[]` entry shipped `/lineTotals[0].unitPrice`
    // while .NET/node/python all shipped `/lineTotals/0/unitPrice` for the same
    // model.  Split on `.`, turn each `[i]` indexer into its own numeric
    // segment, and apply the RFC 6901 escapes (`~` → `~0`, `/` → `~1`) inside
    // each segment.  Java record components are already camelCase, so (unlike
    // .NET's `PointerOf`) no case conversion is needed.  Empty input → the
    // empty pointer (the whole document).
    `    private static String pointerOf(String path) {`,
    `        if (path == null || path.isEmpty()) return "";`,
    `        var segments = new java.util.ArrayList<String>();`,
    `        for (var dotPart : path.split("\\\\.", -1)) {`,
    `            int idx = 0;`,
    `            while (idx < dotPart.length()) {`,
    `                int bracket = dotPart.indexOf('[', idx);`,
    `                if (bracket < 0) {`,
    `                    segments.add(dotPart.substring(idx));`,
    `                    break;`,
    `                }`,
    `                if (bracket > idx) segments.add(dotPart.substring(idx, bracket));`,
    `                int close = dotPart.indexOf(']', bracket);`,
    `                if (close < 0) break;`,
    `                segments.add(dotPart.substring(bracket + 1, close));`,
    `                idx = close + 1;`,
    `            }`,
    `        }`,
    `        var out = new StringBuilder();`,
    `        for (var seg : segments) {`,
    `            out.append('/').append(seg.replace("~", "~0").replace("/", "~1"));`,
    `        }`,
    `        return out.toString();`,
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
