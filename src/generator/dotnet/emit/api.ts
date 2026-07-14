import { emitsRestCreate } from "../../../ir/enrich/wire-projection.js";
import type { AggregateIR, RepositoryIR } from "../../../ir/types/loom-ir.js";
import { errorStatuses, type OpErrorKind } from "../../../ir/util/openapi-errors.js";
import {
  camelId,
  type OpIdTokens,
  opCreate,
  opDestroy,
  opFind,
  opGetById,
  opOperation,
} from "../../../ir/util/openapi-ids.js";
import { lines } from "../../../util/code-builder.js";
import { resolveErrorStatus } from "../../../util/error-defaults.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { renderDotnetLogCall, renderDotnetLogCallWithException } from "../../_obs/render-dotnet.js";
import type { ReturnUnionSpec } from "../cqrs/controller.js";

/** Controller action method name = PascalCase of the shared operationId,
 *  so Program.cs's `CustomOperationIds` (lower-first of the action name)
 *  yields the exact camelCase operationId Hono/Phoenix emit. */
function actionName(tokens: OpIdTokens): string {
  return upperFirst(camelId(tokens));
}

/** `[ProducesResponseType]` attribute lines declaring the RFC 7807 error
 *  responses for an operation kind (from the shared matrix).  A Swashbuckle
 *  operation filter (see Program.cs) rewrites their content-type to
 *  `application/problem+json` so the emitted spec matches Hono/Phoenix. */
function producesProblem(
  kind: OpErrorKind,
  guarded = false,
  indent = "    ",
  /** Resolver for the structural-conflict built-ins (M-T3.4a) — threads the
   *  api's `httpStatus` overrides so `destroy`'s FK-restrict 409
   *  (`ReferencedInUse`) declaration moves in lockstep with its runtime arm.
   *  Omitted ⇒ literal 409 (byte-identical default). */
  resolve?: (name: string) => number,
): string[] {
  return errorStatuses(kind, guarded, resolve).map(
    (s) => `${indent}[ProducesResponseType(typeof(ProblemDetails), ${s})]`,
  );
}

// ASP.NET Core controller emission.  One controller per aggregate root,
// dispatching every endpoint through Mediator (`ISender`).  The
// controller never sees the domain class — only the request/response
// DTOs and the matching command/query records.

/** Compile-time --trace context — when `emitTrace` is true, the
 *  controller's operation routes get a `_log.LogTrace(...)` line for
 *  the catalog's `wire_in` event after binding `[FromBody]`.  Op
 *  param names (lowerCamel — matching the wire JSON key set the
 *  request was de-serialised from) flow through `publicOps[i].paramNames`. */
export interface ControllerShape {
  /** The strongly-typed id class to construct from a route id (default
   *  `<Agg>Id`; a TPH concrete uses its base's `<Base>Id`). */
  idClass?: string;
  idClrType: string;
  createCmdArgs: string[];
  /** When true, the aggregate has a canonical `create` — emit a
   *  `POST /` action dispatching `Create<Agg>Command`.  A non-constructible
   *  aggregate (no explicit/`crudish` create) emits no create action,
   *  request DTO, command, or response. */
  createAction?: boolean;
  /** When true, the aggregate has a canonical `destroy` — emit a
   *  `DELETE /{id}` action dispatching `Destroy<Agg>Command`. */
  destroyAction?: boolean;
  publicOps: Array<{
    name: string;
    routeSlug?: string;
    cmdArgs: string[];
    paramNames: string[];
    /** Has a `requires` guard → declares 403 (authorization denied). */
    guarded: boolean;
    /** Has a `when` canCommand gate → declares 409 (Disallowed) on the
     *  action and emits the side-effect-free `GET {id}/can_<op>` companion
     *  returning `CanResponse { allowed }` (criterion.md use site 2). */
    whenGated?: boolean;
    /** A versioned aggregate's `update` → declares 409 (stale `If-Match`
     *  optimistic-concurrency conflict), mirroring the Hono contract. */
    versionedUpdate?: boolean;
    /** Exception-less return-typed op: the Domain-union → HTTP translation spec.
     *  When set, the action returns the mapped ProblemDetails / wire DTO instead
     *  of 204 (exception-less.md). */
    returnUnion?: ReturnUnionSpec;
  }>;
  finds: Array<{
    name: string;
    isRoot: boolean;
    queryRouteParams: string;
    queryConstructorArgs: string;
    /** Cardinality of the response, derived from the IR find's
     * `returnType`.  Drives the controller's `Task<ActionResult<...>>`
     * type + the body's `Ok(result)` / `result is null ? NotFound()`
     * shape.  Must agree with the matching Hono Zod schema for the
     * cross-platform contract check to pass. */
    returnShape: "list" | "optional" | "single" | "paged" | "union";
    /** Explicit response type name, set only for `returnShape: "union"` — the
     *  success variant's `<Agg>Response` (exception-less.md §4).  Other shapes
     *  derive their type from the aggregate name. */
    responseType?: string;
    /** Union-find absence translation (validator-pinned shape): a null result's
     *  HTTP edge — `none` maps to the optional-find 404, an `error` payload to
     *  ProblemDetails at its mapped status.  The error variant is never part of
     *  the 200 schema. */
    unionAbsent?:
      | { kind: "none" }
      | {
          kind: "error";
          status: number;
          title: string;
          typeUri: string;
          /** Aggregate name for the `resource` extension member, or `undefined`
           *  when the error payload doesn't declare a `resource` field. */
          resource?: string;
        };
  }>;
  /** Prefix prepended to the controller's `[Route(...)]` (e.g.
   *  `"api/"` for fullstack-dotnet — leaves `/orders/*` paths free
   *  for the SPA's client-side router and namespaces controllers
   *  under `/api/orders/*`).  Empty for standalone .NET (controllers
   *  stay at root, matching the v0 behaviour). */
  routePrefix?: string;
  /** When true, controllers emit a `wire_in` trace line right after
   *  `[FromBody]` binding so the parsed request's key set is observable
   *  on the structured stream.  Off keeps the operation handler at its
   *  pre-trace shape exactly. */
  emitTrace?: boolean;
  /** Persistence selection (D-REALIZATION-AXES): when true (`persistence:
   *  dapper`), the destroy handler omits the EF `DbUpdateException` catch —
   *  the dapper schema emits no FK constraints, so the foreign_key_violation →
   *  409 path can't fire, and `Microsoft.EntityFrameworkCore` isn't referenced. */
  usingDapper?: boolean;
  /** Extra namespaces accumulated by the upstream
   *  `wireToCommandArgument` calls (e.g. `System.Globalization` when
   *  a datetime field needs `DateTime.Parse(..., CultureInfo, …)`).
   *  Spliced into the using block so each controller imports only
   *  the namespaces its own argument lowering touched. */
  extraUsings?: readonly string[];
  /** App-wide resolved HTTP statuses for the structural-conflict built-ins
   *  (M-T3.4a) — the api's `httpStatus` override map, each defaulting to 409.
   *  Drives the destroy FK-restrict arm (`ReferencedInUse`) + its OpenAPI
   *  declaration, and the per-op `when`/versioned 409 declarations
   *  (`Disallowed` / `ConcurrencyConflict`). Undefined ⇒ 409 everywhere
   *  (byte-identical default). */
  structuralStatuses?: Record<string, number>;
}

/** The `return …` line(s) for a union-find's absent variant.  `none` rides the
 *  optional-find 404.  An `error` payload returns a ProblemDetails at its mapped
 *  status: the bare `Problem(...)` helper carries no extension members, so when
 *  the payload declares `resource` we build an explicit `ProblemDetails` +
 *  `ObjectResult` and set `Extensions["resource"]` — `[JsonExtensionData]`
 *  serializes it at the body root, matching the cross-backend absent shape. */
function absentReturnLines(
  ua:
    | Extract<ControllerShape["finds"][number]["unionAbsent"], { kind: "error" }>
    | { kind: "none" },
): string[] {
  if (ua.kind === "none") return ["            return NotFound();"];
  const detail = JSON.stringify(ua.title);
  if (!ua.resource) {
    return [
      `            return Problem(statusCode: ${ua.status}, title: ${JSON.stringify(
        ua.title,
      )}, type: ${JSON.stringify(ua.typeUri)}, detail: ${detail});`,
    ];
  }
  return [
    "        {",
    `            var problem = new ProblemDetails { Status = ${ua.status}, Title = ${JSON.stringify(
      ua.title,
    )}, Type = ${JSON.stringify(ua.typeUri)}, Detail = ${detail} };`,
    `            problem.Extensions["resource"] = ${JSON.stringify(ua.resource)};`,
    `            return new ObjectResult(problem) { StatusCode = ${ua.status}, ContentTypes = { "application/problem+json" } };`,
    "        }",
  ];
}

export function renderController(
  agg: AggregateIR,
  _repo: RepositoryIR | undefined,
  ns: string,
  shape: ControllerShape,
): string {
  const className = `${plural(upperFirst(agg.name))}Controller`;
  const route = `${shape.routePrefix ?? ""}${snake(plural(agg.name))}`;
  const idClass = shape.idClass ?? `${agg.name}Id`;
  // Structural-conflict status resolver (M-T3.4a) — routes the hardcoded 409s
  // through the api's `httpStatus` override map, defaulting each to 409. With
  // no override the resolved value is 409, so output stays byte-identical.
  const resolveStruct = (name: string): number =>
    resolveErrorStatus(name, shape.structuralStatuses);
  // FK-restrict destroy → 409 by default, or the `httpStatus ReferencedInUse`
  // override. The default keeps the `Conflict(...)` helper (its 409 == the
  // resolved value, byte-identical); an override switches to `StatusCode(...)`
  // so the HTTP status matches the remapped value the OpenAPI declaration
  // advertises (the `Conflict()` helper is hardwired to 409).
  const referencedInUseStatus = resolveStruct("ReferencedInUse");
  const fkConflictReturn =
    referencedInUseStatus === 409
      ? `            return Conflict(new ProblemDetails { Title = "Conflict", Status = 409, Detail = "${agg.name} is still referenced and cannot be deleted." });`
      : `            return StatusCode(${referencedInUseStatus}, new ProblemDetails { Title = "Conflict", Status = ${referencedInUseStatus}, Detail = "${agg.name} is still referenced and cannot be deleted." });`;

  const createBody = renderCmdConstructorBody(shape.createCmdArgs, "            ");

  const opBlocks = shape.publicOps.flatMap((op) =>
    renderOperationActionBlock(agg, op, {
      idClass,
      idClrType: shape.idClrType,
      emitTrace: shape.emitTrace,
      structuralStatuses: shape.structuralStatuses,
    }),
  );

  const findBlocks = shape.finds.flatMap((f) => {
    const responseType =
      f.returnShape === "union"
        ? f.responseType!
        : f.returnShape === "paged"
          ? `Paged<${agg.name}Response>`
          : f.returnShape === "list"
            ? `IReadOnlyList<${agg.name}Response>`
            : f.returnShape === "optional"
              ? `${agg.name}Response?`
              : `${agg.name}Response`;
    // Optional finds map a null result to 404 — same convention as
    // GetById.  A union find translates its absent variant at the edge
    // (P4c producer side): the `none` unit → 404 (the optional convention),
    // an `error` payload → RFC-7807 ProblemDetails at its mapped status.
    // List / paged / single (and the union success variant) return
    // Ok(result) directly.
    const ua = f.unionAbsent;
    const returnLines =
      f.returnShape === "optional"
        ? ["        return result is null ? NotFound() : Ok(result);"]
        : ua
          ? [
              // Union find: the handler yields the success `<Agg>Response` or
              // null; a null maps to the absent variant's status (exception-less
              // §4), a value returns the success variant directly at 200.
              "        if (result is null)",
              ...absentReturnLines(ua),
              "        return Ok(result);",
            ]
          : ["        return Ok(result);"];
    // Non-nullable success type for [ProducesResponseType] (typeof can't
    // carry a `?` nullable annotation).
    const successType =
      f.returnShape === "union"
        ? f.responseType!
        : f.returnShape === "paged"
          ? `Paged<${agg.name}Response>`
          : f.returnShape === "list"
            ? `IReadOnlyList<${agg.name}Response>`
            : `${agg.name}Response`;
    // The OpenAPI error set: optional finds (and union-`none`) declare the
    // 404; a union-`error` declares its mapped ProblemDetails status.
    const problemDecls =
      ua?.kind === "error"
        ? [`    [ProducesResponseType(typeof(ProblemDetails), ${ua.status})]`]
        : producesProblem(
            f.returnShape === "optional" || ua?.kind === "none"
              ? "findOptional"
              : f.returnShape === "list" || f.returnShape === "paged"
                ? "findList"
                : "findSingle",
          );
    return [
      `    [HttpGet${f.isRoot ? "" : `("${snake(f.name)}")`}]`,
      `    [ProducesResponseType(typeof(${successType}), 200)]`,
      ...problemDecls,
      `    public async Task<ActionResult<${responseType}>> ${actionName(opFind(agg.name, f.name))}(${f.queryRouteParams})`,
      "    {",
      `        var result = await _mediator.Send(new ${upperFirst(f.name)}Query(${f.queryConstructorArgs}));`,
      ...returnLines,
      "    }",
      "",
    ];
  });

  const extraUsingsLines = (shape.extraUsings ?? []).map((n) => `using ${n};`);
  // The `Commands` namespace exists only when at least one command file is
  // emitted for the aggregate (cqrs-emit gates them on exactly these three
  // facts): a REST create, a canonical destroy, or an operation.  A read-only
  // aggregate emits none, so `using …Commands;` would reference a namespace
  // that does not exist (CS0234 under `/warnaserror`).  (Queries/Requests/
  // Responses always have at least the auto findAll + Response DTO.)
  const hasCommands = emitsRestCreate(agg) || !!agg.canonicalDestroy || agg.operations.length > 0;
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      "using System.Linq;",
      "using System.Threading.Tasks;",
      ...extraUsingsLines,
      "using Mediator;",
      "using Microsoft.AspNetCore.Mvc;",
      "using Microsoft.Extensions.Logging;",
      hasCommands ? `using ${ns}.Application.${plural(agg.name)}.Commands;` : null,
      `using ${ns}.Application.${plural(agg.name)}.Queries;`,
      `using ${ns}.Application.${plural(agg.name)}.Requests;`,
      `using ${ns}.Application.${plural(agg.name)}.Responses;`,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      "",
      `namespace ${ns}.Api;`,
      "",
      "[ApiController]",
      `[Route("${route}")]`,
      `public sealed class ${className} : ControllerBase`,
      "{",
      "    private readonly IMediator _mediator;",
      // ILogger field — drives the catalog-event emission below.  Same
      // per-class injection idiom DomainExceptionFilter uses, so the
      // pattern stays consistent across the generated codebase.
      `    private readonly ILogger<${className}> _log;`,
      `    public ${className}(IMediator mediator, ILogger<${className}> log) { _mediator = mediator; _log = log; }`,
      "",
      // Create — POST / (gated on a canonical create; non-constructible
      // aggregates emit no create action/command/DTO/response).
      ...(shape.createAction !== false
        ? [
            "    [HttpPost]",
            `    [ProducesResponseType(typeof(Create${agg.name}Response), 201)]`,
            ...producesProblem("create"),
            `    public async Task<ActionResult<Create${agg.name}Response>> ${actionName(opCreate(agg.name))}([FromBody] Create${agg.name}Request request)`,
            "    {",
            `        var cmd = new Create${agg.name}Command(`,
            ...createBody,
            "        );",
            "        var id = await _mediator.Send(cmd);",
            // aggregate_created — business narrative, after the Mediator
            // command's Send resolves with the new id.  Mirrors the Hono
            // emission so cross-backend log consumers see the same event +
            // fields ({Aggregate}, {Id}).
            `        ${renderDotnetLogCall("aggregateCreated", [
              { name: "aggregate", valueExpr: `"${agg.name}"` },
              { name: "id", valueExpr: "id.Value" },
            ])}`,
            `        return CreatedAtAction(nameof(${actionName(opGetById(agg.name))}), new { id = id.Value }, new Create${agg.name}Response(id.Value));`,
            "    }",
            "",
          ]
        : []),
      '    [HttpGet("{id}")]',
      `    [ProducesResponseType(typeof(${agg.name}Response), 200)]`,
      ...producesProblem("getById"),
      `    public async Task<ActionResult<${agg.name}Response>> ${actionName(opGetById(agg.name))}([FromRoute] ${shape.idClrType} id)`,
      "    {",
      `        var response = await _mediator.Send(new Get${agg.name}ByIdQuery(new ${idClass}(id)));`,
      "        return response is null ? NotFound() : Ok(response);",
      "    }",
      "",
      // Canonical destroy → DELETE /{id} (hard delete).  Gated; reuses the
      // getById error shape (404).  crudish's destroy is empty-bodied, so
      // the command carries only the id.
      ...(shape.destroyAction
        ? [
            '    [HttpDelete("{id}")]',
            "    [ProducesResponseType(204)]",
            ...producesProblem("destroy", false, "    ", resolveStruct),
            `    public async Task<IActionResult> ${actionName(opDestroy(agg.name))}([FromRoute] ${shape.idClrType} id)`,
            "    {",
            // EF wraps a Postgres foreign_key_violation in DbUpdateException
            // when the row is still referenced (cross-aggregate `X id` FK is
            // ON DELETE RESTRICT) → 409 Conflict.  Caught locally so the
            // shared DomainExceptionFilter stays untouched.  Dapper v1 emits no
            // FK constraints, so it skips the catch (and the EF reference).
            ...(shape.usingDapper
              ? [`        await _mediator.Send(new Destroy${agg.name}Command(new ${idClass}(id)));`]
              : [
                  "        try",
                  "        {",
                  `            await _mediator.Send(new Destroy${agg.name}Command(new ${idClass}(id)));`,
                  "        }",
                  "        catch (Microsoft.EntityFrameworkCore.DbUpdateException)",
                  "        {",
                  fkConflictReturn,
                  "        }",
                ]),
            "        return NoContent();",
            "    }",
            "",
          ]
        : []),
      ...opBlocks,
      ...findBlocks,
      "}",
    ) + "\n"
  );
}

/** The per-OPERATION controller action block (F5d decomposition): the
 *  `can_<op>` companion (when-gated), the `[HttpPost("{id}/<slug>")]`
 *  action with its response declarations, trace lines, command
 *  construction, and dispatch tail.  `renderController` flatMaps this
 *  per public op; the cqrs StyleAdapter's `emitEndpoint(op)` calls it
 *  directly for one op. */
export function renderOperationActionBlock(
  agg: AggregateIR,
  op: ControllerShape["publicOps"][number],
  shape: {
    idClass?: string;
    idClrType: string;
    emitTrace?: boolean;
    /** App-wide resolved structural-conflict statuses (M-T3.4a) — routes the
     *  per-op `when` (Disallowed) / versioned-update (ConcurrencyConflict) 409
     *  declarations through the `httpStatus` mapper. Undefined ⇒ 409. */
    structuralStatuses?: Record<string, number>;
  },
): string[] {
  const idClass = shape.idClass ?? `${agg.name}Id`;
  const cmdArgs = [`new ${idClass}(id)`, ...op.cmdArgs];
  const cmdBody = renderCmdConstructorBody(cmdArgs, "            ");
  // wire_in (trace) — the structural shape (keys only, no values) of
  // the parsed request, emitted right after `[FromBody]` binding so
  // a downstream filter pivoting on wire_in sees the same field set
  // Hono emits via `Object.keys(body)`.  Keys are lowerCamel
  // (matching the JSON wire under ASP.NET's default
  // JsonNamingPolicy.CamelCase).  Skipped entirely when --trace is off.
  const wireInLine = shape.emitTrace
    ? [
        `        ${renderDotnetLogCall("wireIn", [
          {
            name: "keys",
            // Empty arrays need an explicit element type so C# can
            // infer the `params object[]` overload of LogTrace —
            // `new[] { }` is a compile error.  Common case (op with
            // params) uses the implicit array literal.
            valueExpr:
              op.paramNames.length === 0
                ? "Array.Empty<string>()"
                : `new[] { ${op.paramNames.map((n) => `"${n}"`).join(", ")} }`,
          },
        ])}`,
      ]
    : [];
  // Exception-less return-typed op (exception-less.md): the action dispatches
  // the command, then translates the Domain union — an error variant to an
  // RFC-7807 ProblemDetails (status from the api `httpStatus` override or the
  // stdlib default), a success variant to 200 wrapped in the Application wire
  // DTO (cast to the polymorphic base so it serializes with the `type` tag).
  const ru = op.returnUnion;
  const STD = new Set<number>([400, 422, 404, ...(op.guarded ? [403] : [])]);
  // A `when` state gate declares 409 (Disallowed); a versioned `update` can also
  // 409 on a stale `If-Match` (ConcurrencyConflict). Each status resolves
  // through the `httpStatus` mapper (M-T3.4a) — deduped, so with no override
  // both collapse to a single `409` attribute (byte-identical); an override
  // splits them into their distinct declarations.
  const when409Statuses = new Set<number>();
  if (op.whenGated) when409Statuses.add(resolveErrorStatus("Disallowed", shape.structuralStatuses));
  if (op.versionedUpdate)
    when409Statuses.add(resolveErrorStatus("ConcurrencyConflict", shape.structuralStatuses));
  const when409 = [...when409Statuses]
    .sort((a, b) => a - b)
    .map((s) => `    [ProducesResponseType(typeof(ProblemDetails), ${s})]`);
  const responseDecls = ru
    ? [
        `    [ProducesResponseType(typeof(${ru.appNs}.${ru.unionName}), 200)]`,
        ...producesProblem("operation", op.guarded),
        ...when409,
        ...ru.errorStatuses
          .filter((s) => !STD.has(s))
          .map((s) => `    [ProducesResponseType(${s})]`),
      ]
    : ["    [ProducesResponseType(204)]", ...producesProblem("operation", op.guarded), ...when409];
  const dispatchTail = ru
    ? [
        "        var result = await _mediator.Send(cmd);",
        "        switch (result)",
        "        {",
        ...ru.arms.flatMap((a) => {
          const variant = `${ru.domainNs}.${ru.unionName}_${a.tag}`;
          if (a.isError) {
            return [
              `            case ${variant} _:`,
              `                return Problem(statusCode: ${a.status}, title: ${JSON.stringify(a.title)}, type: ${JSON.stringify(a.typeUri)}, detail: ${JSON.stringify(a.title)});`,
            ];
          }
          const bind = a.ctorArgs.length > 0 ? "v" : "_";
          const ctor = `new ${ru.appNs}.${ru.unionName}_${a.tag}(${a.ctorArgs.join(", ")})`;
          return [
            `            case ${variant} ${bind}:`,
            `                return Ok((${ru.appNs}.${ru.unionName})${ctor});`,
          ];
        }),
        "            default:",
        '                return Problem(statusCode: 500, title: "Internal Server Error");',
        "        }",
      ]
    : ["        await _mediator.Send(cmd);", "        return NoContent();"];
  // The side-effect-free can_<op> companion (criterion.md use site 2):
  // GET → loads the aggregate, evaluates the `when` predicate, returns
  // `{ allowed }` so a UI can enable/disable the action without invoking it.
  const canBlock = op.whenGated
    ? [
        `    [HttpGet("{id}/can_${snake(op.routeSlug ?? op.name)}")]`,
        `    [ProducesResponseType(typeof(CanResponse), 200)]`,
        `    [ProducesResponseType(typeof(ProblemDetails), 404)]`,
        `    public async Task<ActionResult<CanResponse>> ${actionName(opOperation(agg.name, `can_${op.name}`))}([FromRoute] ${shape.idClrType} id)`,
        "    {",
        `        var result = await _mediator.Send(new Can${upperFirst(op.name)}Query(new ${idClass}(id)));`,
        "        return Ok(result);",
        "    }",
        "",
      ]
    : [];
  return [
    ...canBlock,
    `    [HttpPost("{id}/${snake(op.routeSlug ?? op.name)}")]`,
    // Declare the success response explicitly — once any
    // [ProducesResponseType] is present, Swashbuckle stops inferring the
    // 2xx body from the action signature, so it must be spelled out.
    ...responseDecls,
    `    public async Task<IActionResult> ${actionName(opOperation(agg.name, op.name))}([FromRoute] ${shape.idClrType} id, [FromBody] ${upperFirst(op.name)}${agg.name}Request request)`,
    "    {",
    ...wireInLine,
    // Business-narrative line — what the controller was asked to do,
    // before Mediator dispatches the command.  Mirrors the
    // operation_invoked emission on the Hono side so a cross-backend
    // log consumer sees the same event with the same field set.
    `        ${renderDotnetLogCall("operationInvoked", [
      { name: "aggregate", valueExpr: `"${agg.name}"` },
      { name: "op", valueExpr: `"${op.name}"` },
      { name: "id", valueExpr: "id" },
    ])}`,
    `        var cmd = new ${upperFirst(op.name)}Command(`,
    ...cmdBody,
    "        );",
    ...dispatchTail,
    "    }",
    "",
  ];
}

function renderCmdConstructorBody(args: string[], indent: string): string[] {
  return args.map((a, i) => `${indent}${a}${i < args.length - 1 ? "," : ""}`);
}

export function renderExceptionFilter(
  ns: string,
  options?: {
    usesValidators?: boolean;
    usingDapper?: boolean;
    hasUniqueKeys?: boolean;
    hasVersioned?: boolean;
    /** App-wide resolved structural-conflict statuses (M-T3.4a) — the api's
     *  `httpStatus` override map, each defaulting to 409. Routes this global
     *  filter's hardcoded 409 arms (Disallowed / UniquenessConflict /
     *  ConcurrencyConflict) through the mapper. Undefined ⇒ 409 everywhere
     *  (byte-identical default). */
    structuralStatuses?: Record<string, number>;
  },
): string {
  const usesValidators = !!options?.usesValidators;
  // Resolved structural-conflict statuses baked as literals into the arms
  // below — 409 by default, or the api's `httpStatus <Conflict> -> <Code>`
  // override.  Both the log-event `status` field and the ProblemDetails status
  // read the same resolved value so they can't drift.
  const disallowedStatus = resolveErrorStatus("Disallowed", options?.structuralStatuses);
  const uniquenessStatus = resolveErrorStatus("UniquenessConflict", options?.structuralStatuses);
  const concurrencyStatus = resolveErrorStatus("ConcurrencyConflict", options?.structuralStatuses);
  // A project with no `unique (...)` key emits no 23505 → 409 arm, so a model
  // without uniqueness is byte-identical to before the feature (the proposal's
  // strict-additivity guarantee — only a `unique` index can raise 23505).
  const hasUniqueKeys = !!options?.hasUniqueKeys;
  // A project with no `versioned` aggregate emits no concurrency-conflict arm,
  // so a non-versioned model is byte-identical (strict additivity).
  const hasVersioned = !!options?.hasVersioned;
  // Persistence selection (D-REALIZATION-AXES): the EF adapter surfaces a
  // Postgres unique-violation wrapped in `Microsoft.EntityFrameworkCore.
  // DbUpdateException`; the Dapper adapter throws the bare
  // `Npgsql.PostgresException`.  The unwrapped-Npgsql arm covers both driver
  // levels, but the `DbUpdateException` wrapper clause is only emitted for the
  // EF adapter — under `persistence: dapper`, `Microsoft.EntityFrameworkCore`
  // isn't referenced (see the caveat at ~api.ts:119), so naming that type would
  // be a CS0246.
  const usingDapper = !!options?.usingDapper;
  // `Activity.Current` is referenced unconditionally below; the
  // `using System.Diagnostics;` is therefore part of the file's
  // baseline imports rather than something we'd derive from the body.
  // Confined to this file — adding `System.Diagnostics` project-wide
  // would expose `Activity` (a common DDD entity name) to every
  // generated source file.
  // Postgres unique_violation (SQLSTATE 23505) → 409 Conflict — a `unique (...)`
  // domain invariant's DB index rejected the write.  The bare
  // `Npgsql.PostgresException` is the Dapper path; the EF adapter wraps it in a
  // `DbUpdateException`.  Emitted only when the project declares a `unique` key.
  const uniqueConflictArm = hasUniqueKeys
    ? `
        if (context.Exception is Npgsql.PostgresException { SqlState: "23505" }${
          usingDapper
            ? ""
            : `
            || (context.Exception is Microsoft.EntityFrameworkCore.DbUpdateException due
                && due.InnerException is Npgsql.PostgresException { SqlState: "23505" })`
        })
        {
            ${renderDotnetLogCall("disallowed", [
              { name: "message", valueExpr: `"A resource with these values already exists."` },
              { name: "status", valueExpr: `${uniquenessStatus}` },
            ])}
            context.Result = Problem(context, ${uniquenessStatus}, "Conflict", "A resource with these values already exists.", trace_id);
            context.ExceptionHandled = true;
            return;
        }`
    : "";
  // Optimistic concurrency (`versioned`) → 409 Conflict: EF's native
  // concurrency token (efcore.ts `IsConcurrencyToken()` on the `version`
  // column) raises `DbUpdateConcurrencyException` when a guarded UPDATE affects
  // zero rows — i.e. the row was modified since it was read (write-time CAS) or
  // the client's `If-Match` expected version no longer matches (think-time
  // CAS).  Emitted only when some in-scope aggregate is `versioned`, and only on
  // the EF path — the `Microsoft.EntityFrameworkCore` type would be a CS0246
  // under `persistence: dapper` (which has no EF concurrency token anyway).
  const concurrencyConflictArm =
    hasVersioned && !usingDapper
      ? `
        if (context.Exception is Microsoft.EntityFrameworkCore.DbUpdateConcurrencyException)
        {
            ${renderDotnetLogCall("conflict", [
              {
                name: "message",
                valueExpr: `"The resource was modified by another request; reload and retry."`,
              },
              { name: "status", valueExpr: `${concurrencyStatus}` },
            ])}
            context.Result = Problem(context, ${concurrencyStatus}, "Conflict", "The resource was modified by another request; reload and retry.", trace_id);
            context.ExceptionHandled = true;
            return;
        }`
      : "";
  return `// Auto-generated.${usesValidators ? "\nusing System.Collections.Generic;\nusing System.Linq;\nusing System.Text.Json;" : ""}
using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;
using ${ns}.Domain.Common;

namespace ${ns}.Api;

/// <summary>
/// Maps domain-layer exceptions to structured HTTP responses.
/// Domain exceptions get a 400 / 404 with the original message;
/// any unhandled exception falls through to a generic 500 with a
/// safe message (the original is logged but not returned, so
/// internal details don't leak to API consumers).  Mirrors the
/// Hono \`app.onError\` shape so the cross-platform contract
/// stays in lockstep.
/// </summary>
public sealed class DomainExceptionFilter : IExceptionFilter
{
    private readonly ILogger<DomainExceptionFilter> _log;
    public DomainExceptionFilter(ILogger<DomainExceptionFilter> log) => _log = log;

    public void OnException(ExceptionContext context)
    {
        // Correlation id — ASP.NET Core sets Activity.Current
        // automatically on every request via the
        // HostingApplicationDiagnostics.  Surfacing the trace id on
        // the response lets an operator join the response back to
        // the structured log line without scraping headers.  Empty
        // string when no Activity is active (e.g. middleware errors
        // before the pipeline starts).
        var trace_id = Activity.Current?.TraceId.ToString() ?? "";${
          usesValidators
            ? `
        // FluentValidation arm — runs FIRST because validation
        // failures are the most common 4xx cause.  Emits an RFC 7807
        // ProblemDetails with the §3.2 \`errors[]\` extension carried
        // on \`Extensions["errors"]\`, status 422 (Unprocessable
        // Entity, the standard for input-shape errors).  Shape matches
        // Hono's defaultHook output byte-for-byte so the frontend
        // ACL's \`applyServerErrors\` works against either backend.
        // See docs/old/proposals/validation-error-extension.md and
        // docs/old/proposals/frontend-acl.md.
        if (context.Exception is FluentValidation.ValidationException fv)
        {
            var problem = new ProblemDetails
            {
                Type = "about:blank",
                Title = "Validation failed",
                Status = 422,
                Detail = "One or more fields are invalid.",
                Instance = context.HttpContext.Request.Path,
            };
            problem.Extensions["errors"] = fv.Errors
                .Select(e => new { pointer = PointerOf(e.PropertyName), message = e.ErrorMessage })
                .ToArray();
            ${renderDotnetLogCall("domainError", [
              { name: "message", valueExpr: `"Validation failed"` },
              { name: "status", valueExpr: "422" },
            ])}
            context.HttpContext.Response.Headers["x-request-id"] = trace_id;
            context.Result = new ObjectResult(problem)
            {
                StatusCode = 422,
                ContentTypes = { "application/problem+json" },
            };
            context.ExceptionHandled = true;
            return;
        }`
            : ""
        }
        if (context.Exception is ForbiddenException fe)
        {
            ${renderDotnetLogCall("forbidden", [
              { name: "message", valueExpr: "fe.Message" },
              { name: "status", valueExpr: "403" },
            ])}
            context.Result = Problem(context, 403, "Forbidden", fe.Message, trace_id);
            context.ExceptionHandled = true;
            return;
        }
        if (context.Exception is DisallowedException dx)
        {
            ${renderDotnetLogCall("disallowed", [
              { name: "message", valueExpr: "dx.Message" },
              { name: "status", valueExpr: `${disallowedStatus}` },
            ])}
            context.Result = Problem(context, ${disallowedStatus}, "Disallowed", dx.Message, trace_id);
            context.ExceptionHandled = true;
            return;
        }${uniqueConflictArm}${concurrencyConflictArm}
        if (context.Exception is DomainException de)
        {
            ${renderDotnetLogCall("domainError", [
              { name: "message", valueExpr: "de.Message" },
              { name: "status", valueExpr: "400" },
            ])}
            context.Result = Problem(context, 400, "Bad Request", de.Message, trace_id);
            context.ExceptionHandled = true;
            return;
        }
        if (context.Exception is AggregateNotFoundException nf)
        {
            ${renderDotnetLogCall("notFound", [{ name: "status", valueExpr: "404" }])}
            context.Result = Problem(context, 404, "Not Found", nf.Message, trace_id);
            context.ExceptionHandled = true;
            return;
        }
        if (context.Exception is ExternHandlerException xh)
        {
            // 500 — the user handler threw, which is an internal
            // failure from the framework's POV — but the envelope
            // names the offending op + aggregate so operators don't
            // have to grep logs to find the cause.  The original
            // exception (xh.InnerException) is logged in full
            // server-side via the catalog's extern_handler_threw
            // event — same shape the Hono onError arm emits.
            ${renderDotnetLogCallWithException("externHandlerThrew", "xh", [
              { name: "aggregate", valueExpr: "xh.AggName" },
              { name: "op", valueExpr: "xh.OpName" },
              { name: "error", valueExpr: "xh.Message" },
            ])}
            context.Result = Problem(context, 500, "Internal Server Error", xh.Message, trace_id);
            context.ExceptionHandled = true;
            return;
        }
        // Generic 500.  Log the full exception server-side via the
        // catalog's internal_error event; return a sanitized payload
        // to the client.  Matching the Hono fallback envelope.
        ${renderDotnetLogCallWithException("internalError", "context.Exception", [
          { name: "error", valueExpr: "context.Exception.Message" },
          { name: "status", valueExpr: "500" },
        ])}
        context.Result = Problem(context, 500, "Internal Server Error", "internal", trace_id);
        context.ExceptionHandled = true;
    }

    // RFC 7807 problem responder — application/problem+json body +
    // x-request-id header (trace correlation moves off the body so it's
    // byte-identical to Hono / Phoenix).  Shared by every non-validation arm.
    private static ObjectResult Problem(ExceptionContext context, int status, string title, string detail, string traceId)
    {
        context.HttpContext.Response.Headers["x-request-id"] = traceId;
        return new ObjectResult(new ProblemDetails
        {
            Type = "about:blank",
            Title = title,
            Status = status,
            Detail = detail,
            Instance = context.HttpContext.Request.Path,
        })
        {
            StatusCode = status,
            ContentTypes = { "application/problem+json" },
        };
    }${
      usesValidators
        ? `

    // Convert a FluentValidation property path to an RFC 6901 JSON
    // pointer matching the wire shape the frontend ACL expects.  The
    // app's JSON output uses JsonNamingPolicy.CamelCase, so each
    // PascalCase segment is camel-cased; array indexer notation
    // (\`Items[0].Qty\`) becomes a numeric segment (\`/items/0/qty\`).
    // RFC 6901 escapes apply inside each segment (\`~\` → \`~0\`,
    // \`/\` → \`~1\`).  Empty input → empty pointer (the whole document).
    private static string PointerOf(string propertyName)
    {
        if (string.IsNullOrEmpty(propertyName)) return "";
        var segments = new List<string>();
        foreach (var dotPart in propertyName.Split('.'))
        {
            var idx = 0;
            while (idx < dotPart.Length)
            {
                var bracket = dotPart.IndexOf('[', idx);
                if (bracket < 0)
                {
                    segments.Add(JsonNamingPolicy.CamelCase.ConvertName(dotPart.Substring(idx)));
                    break;
                }
                if (bracket > idx)
                {
                    segments.Add(JsonNamingPolicy.CamelCase.ConvertName(dotPart.Substring(idx, bracket - idx)));
                }
                var close = dotPart.IndexOf(']', bracket);
                if (close < 0) break;
                segments.Add(dotPart.Substring(bracket + 1, close - bracket - 1));
                idx = close + 1;
            }
        }
        return "/" + string.Join("/", segments.ConvertAll(s => s.Replace("~", "~0").Replace("/", "~1")));
    }`
        : ""
    }
}
`;
}

/** Swashbuckle operation filter — rewrites every declared 4xx/5xx response
 *  to `application/problem+json` carrying the shared `ProblemDetails`
 *  schema.  `[ProducesResponseType(typeof(ProblemDetails), …)]` on each
 *  action declares WHICH statuses; this filter normalises the content-type
 *  (Swashbuckle defaults error responses to `application/json`) so the
 *  emitted spec's error contract matches Hono / Phoenix (RFC 7807). */
export function renderProblemDetailsFilter(ns: string): string {
  return `// Auto-generated.
using System.Collections.Generic;
using Microsoft.AspNetCore.Mvc;
using Microsoft.OpenApi.Any;
using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace ${ns}.Api;

public sealed class ProblemDetailsResponsesFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        var schema = context.SchemaGenerator.GenerateSchema(typeof(ProblemDetails), context.SchemaRepository);
        AugmentProblemDetailsSchema(context.SchemaRepository);
        foreach (var (code, response) in operation.Responses)
        {
            if (code.Length == 3 && (code[0] == '4' || code[0] == '5'))
            {
                response.Content.Clear();
                response.Content["application/problem+json"] = new OpenApiMediaType { Schema = schema };
            }
        }
    }

    // Augment the auto-generated Microsoft.AspNetCore.Mvc.ProblemDetails
    // OpenAPI schema with the RFC 7807 §3.2 \`errors[]\` extension array
    // (per-field \`{ pointer, message }\`) that the FluentValidation arm
    // of DomainExceptionFilter emits on 422 validation responses.
    // Consumed by the frontend ACL's \`applyServerErrors\`.  Idempotent;
    // safe to run per operation.  See
    // docs/old/proposals/validation-error-extension.md (Phase D).
    private static void AugmentProblemDetailsSchema(SchemaRepository repo)
    {
        if (!repo.Schemas.TryGetValue("ProblemDetails", out var problem)) return;
        if (problem.Properties.ContainsKey("errors")) return;

        problem.Properties["errors"] = new OpenApiSchema
        {
            Type = "array",
            Nullable = true,
            Items = new OpenApiSchema
            {
                Type = "object",
                Required = new HashSet<string> { "pointer", "message" },
                Properties = new Dictionary<string, OpenApiSchema>
                {
                    ["pointer"] = new OpenApiSchema { Type = "string" },
                    ["message"] = new OpenApiSchema { Type = "string" },
                },
            },
        };
    }
}
`;
}

/** Swashbuckle document filter — promotes inline `array<XResponse>` list
 *  responses to named component schemas (`XResponse` → `XListResponse`;
 *  full-form views: `XRow` → `XResponse`), matching the Hono / Phoenix
 *  backends which name the wrapper.  Swashbuckle inlines any IEnumerable
 *  type, so the only reliable way to get a named array component is to
 *  add it + retarget the responses here.  The element→wrapper map is baked
 *  in from the IR (no runtime name guessing). */
export function renderListWrapperFilter(
  ns: string,
  pairs: ReadonlyArray<{ element: string; wrapper: string }>,
): string {
  const wrappersExpr =
    pairs.length === 0
      ? "Array.Empty<(string Element, string Wrapper)>()"
      : `new[]
    {
${pairs.map((p) => `        ("${p.element}", "${p.wrapper}"),`).join("\n")}
    }`;
  return `// Auto-generated.
using System;
using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace ${ns}.Api;

public sealed class ListResponseWrapperFilter : IDocumentFilter
{
    private static readonly (string Element, string Wrapper)[] Wrappers = ${wrappersExpr};

    public void Apply(OpenApiDocument swaggerDoc, DocumentFilterContext context)
    {
        // Add the named wrapper component for each element schema present.
        foreach (var (element, wrapper) in Wrappers)
        {
            if (swaggerDoc.Components.Schemas.ContainsKey(element) && !swaggerDoc.Components.Schemas.ContainsKey(wrapper))
            {
                swaggerDoc.Components.Schemas[wrapper] = new OpenApiSchema
                {
                    Type = "array",
                    Items = new OpenApiSchema
                    {
                        Reference = new OpenApiReference { Type = ReferenceType.Schema, Id = element }
                    }
                };
            }
        }

        // Retarget inline array responses to the named wrapper $ref.
        foreach (var path in swaggerDoc.Paths.Values)
        foreach (var operation in path.Operations.Values)
        foreach (var response in operation.Responses.Values)
        foreach (var media in response.Content.Values)
        {
            var schema = media.Schema;
            if (schema?.Type == "array" && schema.Items?.Reference?.Id is string elementId)
            {
                foreach (var (element, wrapper) in Wrappers)
                {
                    if (element == elementId)
                    {
                        media.Schema = new OpenApiSchema
                        {
                            Reference = new OpenApiReference { Type = ReferenceType.Schema, Id = wrapper }
                        };
                        break;
                    }
                }
            }
        }
    }
}
`;
}

/** Swashbuckle schema filter — marks request-DTO properties `required` in
 *  the OpenAPI schema from the constructor-parameter `[Required]`
 *  attributes.
 *
 *  Why this is needed: request DTOs are positional records whose required
 *  fields carry a PARAMETER-targeted `[Required]` (a PROPERTY-targeted
 *  `[property: Required]` makes ASP.NET's record validation throw at
 *  model-binding time — see `dtoParam`).  But Swashbuckle 6.x's
 *  DataAnnotations reader only honours the PROPERTY-targeted form, so
 *  parameter-targeted `[Required]` never reaches the request-body schema's
 *  `required` array — leaving .NET request bodies marked nothing-required
 *  while Hono/Phoenix mark every non-optional field required.
 *
 *  This filter closes that gap by reflecting each schema's CLR type: for a
 *  positional record, it reads the primary-constructor parameters and adds
 *  the camelCase property name to `schema.Required` for each parameter that
 *  carries `[Required]`.  Response DTOs carry `[property: Required]` on the
 *  property (not the parameter), so they're untouched here and keep
 *  Swashbuckle's own handling — no double-marking.  Mirrors `dtoParam`'s
 *  required predicate exactly (a non-nullable `bool` request field has no
 *  `[Required]`, so it's correctly left optional). */
export function renderRequiredFromCtorParamFilter(ns: string): string {
  return `// Auto-generated.
using System;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace ${ns}.Api;

public sealed class RequiredFromCtorParamFilter : ISchemaFilter
{
    public void Apply(OpenApiSchema schema, SchemaFilterContext context)
    {
        var type = context.Type;
        if (schema.Properties is null || schema.Properties.Count == 0) return;

        // Positional records expose their declared fields via the primary
        // constructor.  Pick the longest constructor (the primary one for a
        // positional record) and mark each [Required] parameter's property.
        var ctor = type.GetConstructors()
            .OrderByDescending(c => c.GetParameters().Length)
            .FirstOrDefault();
        if (ctor is null) return;

        foreach (var p in ctor.GetParameters())
        {
            if (p.Name is null) continue;
            if (p.GetCustomAttribute<RequiredAttribute>() is null) continue;
            // Swashbuckle keys schema properties by the serialized name;
            // the app uses camelCase (PropertyNamingPolicy.CamelCase), so
            // match on camelCase first, then fall back to the exact key.
            var camel = JsonNamingPolicy.CamelCase.ConvertName(p.Name);
            var key = schema.Properties.ContainsKey(camel)
                ? camel
                : (schema.Properties.ContainsKey(p.Name) ? p.Name : null);
            if (key is not null) schema.Required.Add(key);
        }
    }
}
`;
}
