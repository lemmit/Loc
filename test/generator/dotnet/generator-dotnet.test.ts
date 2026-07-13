import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

async function buildModel(file: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

describe(".NET generator", () => {
  it("emits the expected file set for sales.ddd", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const keys = [...files.keys()];
    expect(keys).toContain("Domain/Ids/OrderId.cs");
    expect(keys).toContain("Domain/Orders/Order.cs");
    expect(keys).toContain("Domain/Orders/OrderLine.cs");
    expect(keys).toContain("Domain/Orders/IOrderRepository.cs");
    expect(keys).toContain("Domain/ValueObjects/Money.cs");
    expect(keys).toContain("Domain/Enums/OrderStatus.cs");
    expect(keys).toContain("Domain/Events/OrderConfirmed.cs");
    expect(keys).toContain("Infrastructure/Persistence/AppDbContext.cs");
    expect(keys).toContain("Infrastructure/Persistence/Configurations/OrderConfiguration.cs");
    expect(keys).toContain("Infrastructure/Repositories/OrderRepository.cs");
    expect(keys).toContain("Application/Orders/Commands/ConfirmCommand.cs");
    expect(keys).toContain("Application/Orders/Commands/ConfirmHandler.cs");
    expect(keys).toContain("Application/Orders/Queries/GetOrderByIdQuery.cs");
    expect(keys).toContain("Api/OrdersController.cs");
    expect(keys).toContain("Program.cs");
    expect(keys).toContain("Sales.csproj");
  });

  it("adds per-file `using` directives only where the namespace is actually used", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    // DomainExceptionFilter uses Activity.Current; needs System.Diagnostics.
    const filter = files.get("Api/DomainExceptionFilter.cs")!;
    expect(filter).toMatch(/^using System\.Diagnostics;/m);
    // No file that doesn't reference Activity / Match / IsolationLevel
    // should drag those namespaces in — they expose common names
    // (Activity, Match, Group) that would shadow user domain types if
    // imported globally.
    const order = files.get("Domain/Orders/Order.cs")!;
    expect(order).not.toMatch(/^using System\.Diagnostics;/m);
    expect(order).not.toMatch(/^using System\.Text\.RegularExpressions;/m);
    // No project-wide GlobalUsings.cs — every namespace import is
    // per-file so a user's `Activity` / `Match` aggregate doesn't
    // collide with framework types.
    expect([...files.keys()]).not.toContain("GlobalUsings.cs");
  });

  it("renders Order with idiomatic C#", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const order = files.get("Domain/Orders/Order.cs")!;
    expect(order).toMatch(/public sealed class Order/);
    expect(order).toMatch(/public OrderId Id { get; private set; }/);
    expect(order).toMatch(/public void Confirm\(\)/);
    expect(order).toMatch(/this\.Lines\.Count > 0/);
    expect(order).toMatch(/OrderStatus\.Confirmed/);
    expect(order).toMatch(/_domainEvents\.Add\(new OrderConfirmed/);
  });

  it("emits xUnit test class + test project when `test` blocks are declared", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const tests = files.get("Tests/Sales.Tests/Orders/OrderTests.cs")!;
    expect(tests).toMatch(/using Xunit;/);
    expect(tests).toMatch(/\[Fact\(DisplayName = "money literal builds"\)\]/);
    expect(tests).toMatch(/Assert\.Throws<DomainException>/);
    const testCsproj = files.get("Tests/Sales.Tests/Sales.Tests.csproj")!;
    expect(testCsproj).toMatch(/Microsoft\.NET\.Test\.Sdk/);
    expect(testCsproj).toMatch(/<PackageReference Include="xunit"/);
    expect(testCsproj).toMatch(/<ProjectReference Include="\.\.\/\.\.\/Sales\.csproj" \/>/);
  });

  it("emits Dockerfile + .dockerignore", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const dockerfile = files.get("Dockerfile")!;
    expect(dockerfile).toMatch(/FROM mcr\.microsoft\.com\/dotnet\/sdk:10\.0 AS build/);
    expect(dockerfile).toMatch(/FROM mcr\.microsoft\.com\/dotnet\/aspnet:10\.0 AS runtime/);
    expect(dockerfile).toMatch(/ENTRYPOINT \["dotnet", "Sales\.dll"\]/);
    const dockerignore = files.get(".dockerignore")!;
    expect(dockerignore).toMatch(/\*\*\/bin/);
  });

  it("wires Swashbuckle so the spec is exposed at the aligned /openapi.json", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const csproj = files.get("Sales.csproj")!;
    expect(csproj).toMatch(/<PackageReference Include="Swashbuckle\.AspNetCore"/);
    const program = files.get("Program.cs")!;
    expect(program).toMatch(/AddSwaggerGen/);
    // Doc named "openapi" + RouteTemplate "{documentName}.json" → /openapi.json
    // (aligned with every other backend), not the default /swagger/v1/swagger.json.
    expect(program).toMatch(/SwaggerDoc\("openapi"/);
    expect(program).toMatch(/UseSwagger\(c => c\.RouteTemplate = "\{documentName\}\.json"\)/);
  });

  it("enables CORS + camelCase JSON in Program.cs", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const program = files.get("Program.cs")!;
    expect(program).toMatch(/AddCors/);
    expect(program).toMatch(/UseCors\(\)/);
    expect(program).toMatch(/JsonNamingPolicy\.CamelCase/);
  });

  describe("container basics", () => {
    it("Program.cs fails fast on missing connection string", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const program = files.get("Program.cs")!;
      // Connection-string assertion runs BEFORE AddDbContext so a
      // missing value throws at builder time, not on the first
      // request.
      const assertIdx = program.indexOf("Missing connection string 'Default'");
      const dbIdx = program.indexOf("AddDbContext<AppDbContext>");
      expect(assertIdx).toBeGreaterThan(-1);
      expect(dbIdx).toBeGreaterThan(-1);
      expect(assertIdx).toBeLessThan(dbIdx);
      expect(program).toMatch(/ConnectionStrings__Default/);
    });

    it("Program.cs maps GET /ready that pings the DB and returns 503 on miss", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const program = files.get("Program.cs")!;
      expect(program).toMatch(/app\.MapGet\("\/ready"/);
      // Ping uses CanConnectAsync (cheap, no schema lookup).
      expect(program).toMatch(/db\.Database\.CanConnectAsync\(cancellationToken\)/);
      // 503 with a structured body on failure.
      expect(program).toMatch(/status = "not_ready"/);
      expect(program).toMatch(/statusCode: 503/);
    });

    it("Program.cs wires server-lifecycle catalog events via IHostApplicationLifetime", async () => {
      // Bite 5a: the bare "Shutting down" log was superseded by catalog
      // identity — server_starting / server_listening / server_shutdown
      // / server_drained land on the structured stream with the same
      // event names Hono and Phoenix emit.
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const program = files.get("Program.cs")!;
      expect(program).toMatch(/IHostApplicationLifetime/);
      expect(program).toMatch(/ApplicationStarted\.Register/);
      expect(program).toMatch(/ApplicationStopping\.Register/);
      expect(program).toMatch(/ApplicationStopped\.Register/);
      // Catalog identity via renderDotnetLogCall — same template +
      // placeholder shape every other .NET emit site uses.
      expect(program).toMatch(
        /lifecycleLog\.LogInformation\("\{Event\} port=\{Port\} env=\{Env\}", "server_starting"/,
      );
      expect(program).toMatch(
        /lifecycleLog\.LogInformation\("\{Event\} port=\{Port\}", "server_listening"/,
      );
      expect(program).toMatch(
        /lifecycleLog\.LogInformation\("\{Event\} signal=\{Signal\}", "server_shutdown", "SIGTERM"\)/,
      );
      expect(program).toMatch(/lifecycleLog\.LogInformation\("\{Event\}", "server_drained"\)/);
    });
  });

  describe("request observability", () => {
    it("Program.cs configures structured JSON logging + HTTP request logging", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const program = files.get("Program.cs")!;
      // JSON formatter for every log line.
      expect(program).toMatch(/AddJsonConsole/);
      // Per-request HTTP log: method/path/status/duration.
      expect(program).toMatch(/AddHttpLogging/);
      expect(program).toMatch(/app\.UseHttpLogging\(\)/);
      // Specific fields opted in.
      expect(program).toMatch(/RequestMethod/);
      expect(program).toMatch(/RequestPath/);
      expect(program).toMatch(/ResponseStatusCode/);
      expect(program).toMatch(/Duration/);
      // Runtime log-level knob — LOG_LEVEL (default info) mapped onto the
      // ASP.NET Core LogLevel via SetMinimumLevel.
      expect(program).toMatch(
        /SetMinimumLevel\(\(System\.Environment\.GetEnvironmentVariable\("LOG_LEVEL"\) \?\? "info"\)/,
      );
      expect(program).toMatch(/"trace" => Microsoft\.Extensions\.Logging\.LogLevel\.Trace/);
      expect(program).toMatch(/"debug" => Microsoft\.Extensions\.Logging\.LogLevel\.Debug/);
      expect(program).toMatch(/"warn" => Microsoft\.Extensions\.Logging\.LogLevel\.Warning/);
      expect(program).toMatch(/"error" => Microsoft\.Extensions\.Logging\.LogLevel\.Error/);
      expect(program).toMatch(/_ => Microsoft\.Extensions\.Logging\.LogLevel\.Information/);
    });

    // Bite 4: catalog-identity request log via a custom middleware.
    // Mirrors Phoenix's <App>.Telemetry and Hono's pino access log so the
    // same `request_start` / `request_end` events surface on every
    // backend.  Coexists with UseHttpLogging (the framework's stream is
    // structurally different — both can run, the catalog stream is the
    // one cross-backend tooling pivots on).
    it("emits Middleware/RequestLoggingMiddleware.cs with catalog-identity start/end events", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const mw = files.get("Middleware/RequestLoggingMiddleware.cs");
      expect(mw, "RequestLoggingMiddleware.cs is emitted").toBeDefined();
      // Namespaced under <ns>.Middleware (parallel to <ns>.Auth).
      expect(mw!).toMatch(/namespace \w+\.Middleware;/);
      expect(mw!).toMatch(/public sealed class RequestLoggingMiddleware/);
      // Catalog identity preserved by renderDotnetLogCall — same shape
      // every .NET backend emit site uses.
      expect(mw!).toMatch(
        /_log\.LogInformation\("\{Event\} method=\{Method\} path=\{Path\}", "request_start", ctx\.Request\.Method, ctx\.Request\.Path\.Value \?\? "\/"\);/,
      );
      expect(mw!).toMatch(
        /_log\.LogInformation\("\{Event\} method=\{Method\} path=\{Path\} status=\{Status\} duration_ms=\{DurationMs\}", "request_end", ctx\.Request\.Method, ctx\.Request\.Path\.Value \?\? "\/", ctx\.Response\.StatusCode, sw\.ElapsedMilliseconds\);/,
      );
      // Stopwatch + try/finally so request_end fires even when a
      // downstream middleware/controller throws.
      expect(mw!).toMatch(/Stopwatch\.StartNew/);
      expect(mw!).toMatch(/try[\s\S]*?await _next\(ctx\);[\s\S]*?finally/);
    });

    it("Program.cs registers RequestLoggingMiddleware before MapControllers + UseHttpLogging", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const program = files.get("Program.cs")!;
      // Stopwatch must cover the full pipeline — mount BEFORE routing.
      expect(program).toMatch(/app\.UseMiddleware<\w+\.Middleware\.RequestLoggingMiddleware>\(\);/);
      const ourPos = program.search(/UseMiddleware<\w+\.Middleware\.RequestLoggingMiddleware>/);
      const httpPos = program.indexOf("app.UseHttpLogging()");
      const mapPos = program.indexOf("app.MapControllers()");
      expect(ourPos).toBeGreaterThan(0);
      expect(httpPos).toBeGreaterThan(ourPos);
      expect(mapPos).toBeGreaterThan(ourPos);
    });

    it("DomainExceptionFilter threads the trace id onto the RFC 7807 response", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const filter = files.get("Api/DomainExceptionFilter.cs")!;
      // trace_id pulled off the ambient Activity (set by ASP.NET on
      // every request).  Empty string when no Activity is active.
      expect(filter).toMatch(/var trace_id = Activity\.Current\?\.TraceId\.ToString\(\) \?\? "";/);
      // Trace correlation now rides the x-request-id response header (off
      // the RFC 7807 body); each arm returns a ProblemDetails via Problem(...).
      expect(filter).toMatch(/Response\.Headers\["x-request-id"\] = traceId;/);
      expect(filter).toMatch(/Problem\(context, 403, "Forbidden", fe\.Message, trace_id\)/);
      expect(filter).toMatch(/Problem\(context, 400, "Bad Request", de\.Message, trace_id\)/);
      expect(filter).toMatch(/Problem\(context, 404, "Not Found", nf\.Message, trace_id\)/);
      expect(filter).toMatch(
        /Problem\(context, 500, "Internal Server Error", xh\.Message, trace_id\)/,
      );
      expect(filter).toMatch(
        /Problem\(context, 500, "Internal Server Error", "internal", trace_id\)/,
      );
    });

    it("DomainExceptionFilter logs the fault tier with each fault's real status", async () => {
      // S1 parity: every fault arm emits its catalog event at the real HTTP
      // status (validation 422, domain 400, forbidden 403, disallowed 409,
      // not_found 404) — matching Hono/Python so a `jq select(.event==…)`
      // query is the same shape cross-backend.
      const model = await buildModel("examples/sales.ddd");
      const filter = generateDotnet(model).get("Api/DomainExceptionFilter.cs")!;
      expect(filter).toContain(
        '_log.LogWarning("{Event} message={Message} status={Status}", "forbidden", fe.Message, 403);',
      );
      expect(filter).toContain(
        '_log.LogWarning("{Event} message={Message} status={Status}", "disallowed", dx.Message, 409);',
      );
      expect(filter).toContain(
        '_log.LogWarning("{Event} message={Message} status={Status}", "domain_error", de.Message, 400);',
      );
      expect(filter).toContain('_log.LogWarning("{Event} status={Status}", "not_found", 404);');
    });
  });

  it("auto-includes a GET /<plural> find via the `all` repository method", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const controller = files.get("Api/OrdersController.cs")!;
    // [HttpGet] (root) — followed by an AllOrder(...) action (the action
    // method name is the PascalCase of the shared operationId `allOrder`).
    expect(controller).toMatch(/\[HttpGet\][\s\S]*?AllOrder\(/);
    const repoIface = files.get("Domain/Orders/IOrderRepository.cs")!;
    expect(repoIface).toMatch(/List<Order>[\s\S]*?All\(/);
  });

  it("marks a required find query param [BindRequired] (so Swashbuckle emits required:true)", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const controller = files.get("Api/OrdersController.cs")!;
    // byCustomer(customerId) — a required filter. Without [BindRequired] a
    // non-nullable string query param reads as optional, diverging from
    // Hono/Phoenix (which mark it required). Attribute is fully-qualified
    // to avoid an unused `using` under /warnaserror.
    expect(controller).toMatch(
      /\[FromQuery\] \[Microsoft\.AspNetCore\.Mvc\.ModelBinding\.BindRequired\] \w+ customerId/,
    );
  });

  it("translates `where` filter to a LINQ predicate", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const repo = files.get("Infrastructure/Repositories/OrderRepository.cs")!;
    expect(repo).toMatch(/ActiveForCustomer/);
    expect(repo).toMatch(/x\.CustomerId == forCustomer && x\.Status == OrderStatus\.Draft/);
  });

  it("emits CQRS command for each public operation", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const cmd = files.get("Application/Orders/Commands/AddLineCommand.cs")!;
    expect(cmd).toMatch(/public sealed record AddLineCommand/);
    expect(cmd).toMatch(/ICommand/);
    const handler = files.get("Application/Orders/Commands/AddLineHandler.cs")!;
    expect(handler).toMatch(/ICommandHandler<AddLineCommand,\s*Unit>/);
    expect(handler).toMatch(/_repo\.GetByIdAsync/);
    expect(handler).toMatch(/aggregate\.AddLine\(/);
    expect(handler).toMatch(/_repo\.SaveAsync/);
  });

  it("EF configuration emits HasIndex for find-referenced columns", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const cfg = files.get("Infrastructure/Persistence/Configurations/OrderConfiguration.cs")!;
    expect(cfg).toMatch(/builder\.HasIndex\(x => x\.CustomerId\)/);
    expect(cfg).toMatch(/builder\.HasIndex\(x => x\.Status\)/);
  });

  it("re-homes an extern operation to a domain partial-method hook + scaffold-once impl", async () => {
    // extern (b) Phase 2: an aggregate `operation X() extern` is a DOMAIN
    // extension point (a `private partial XCore` hook the aggregate OWNS), not
    // an injected application-layer `I<Op><Agg>Handler`.  The hook reaches the
    // aggregate's own private state natively — no setter widening (finding S10
    // fixed by construction).
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          customerId: string
          status: OrderStatus
          function isMutable(): bool = status == Draft
          operation confirm() extern {
            precondition isMutable()
          }
        }
        repository Orders for Order { }
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);

    // 1. NONE of the deleted injected apparatus is emitted for the aggregate op.
    expect(files.has("Application/Orders/Handlers/IConfirmOrderHandler.cs")).toBe(false);
    expect(files.has("Application/Orders/Handlers/DevStubConfirmOrderHandler.cs")).toBe(false);

    // 2. The aggregate is `sealed partial`, its op runs preconditions → the
    //    partial hook → invariants, and the hook is declared `private partial`
    //    (a MISSING impl is a compile error, CS8795 — not a silent no-op).
    const order = files.get("Domain/Orders/Order.cs")!;
    expect(order).toMatch(/public sealed partial class Order/);
    expect(order).not.toMatch(/IOrderMutator/);
    expect(order).toMatch(/public void Confirm\(\)/);
    // Precondition, then the hook, then invariants — in that order.
    expect(order).toMatch(/if \(!\(this\.IsMutable\(\)\)\)[\s\S]*ConfirmCore\(\);\s*AssertInvariants\(\);/);
    expect(order).toMatch(/private partial void ConfirmCore\(\);/);
    // No leftover `Check`-only method, no injected handler.
    expect(order).not.toMatch(/public void CheckConfirm\(\)/);

    // 3. Setters stay `private` (S10): no `internal set` leak anywhere, and
    //    AssertInvariants is `private` (no `internal` widening for a hatch).
    expect(order).toMatch(/public OrderStatus Status \{ get; private set; \}/);
    expect(order).not.toMatch(/\{ get; internal set; \}/);
    expect(order).toMatch(/private void AssertInvariants\(/);
    expect(order).not.toMatch(/internal void AssertInvariants\(/);

    // 4. The user-owned scaffold-once partial carries the marker + a
    //    compile-forcing implementing shape that throws until filled.
    const impl = files.get("Domain/Orders/Order.Extern.cs")!;
    expect(impl).toMatch(/^\/\/ loom:scaffold-once/);
    expect(impl).toMatch(/public sealed partial class Order/);
    expect(impl).toMatch(
      /private partial void ConfirmCore\(\)\s*=> throw new NotImplementedException\(/,
    );

    // 5. The auto Mediator handler calls the aggregate method DIRECTLY — no
    //    injected `_user`, no HandleAsync dispatch, no ExternHandlerException.
    const handler = files.get("Application/Orders/Commands/ConfirmHandler.cs")!;
    expect(handler).toMatch(/aggregate\.Confirm\(\);/);
    expect(handler).not.toMatch(/_user\.HandleAsync/);
    expect(handler).not.toMatch(/IConfirmOrderHandler/);

    // 6. No Scrutor scan / boot-verify / package for a system whose only extern
    //    is an aggregate op (Phase 1's extern commandHandler/queryHandler keeps
    //    the scan — this system has none).
    const program = files.get("Program.cs")!;
    expect(program).not.toMatch(/builder\.Services\.Scan\(s => s/);
    expect(program).not.toMatch(/Missing \[ExternHandler\] for/);
    const csproj = files.get("Sales.csproj")!;
    expect(csproj).not.toMatch(/<PackageReference Include="Scrutor"/);
  });

  describe("extern handler exception envelope", () => {
    it("Domain.Common declares ExternHandlerException with op + agg fields", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const common = files.get("Domain/Common/DomainException.cs")!;
      expect(common).toMatch(/public sealed class ExternHandlerException : Exception/);
      expect(common).toMatch(/public string OpName \{ get; \}/);
      expect(common).toMatch(/public string AggName \{ get; \}/);
      // Message embeds both names + the inner exception's message.
      expect(common).toMatch(
        /Extern handler '\{opName\}' on '\{aggName\}' threw: \{inner\.Message\}/,
      );
    });

    it("DomainExceptionFilter maps ExternHandlerException to a 500 with the descriptive envelope", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const filter = files.get("Api/DomainExceptionFilter.cs")!;
      // ExternHandlerException arm exists and lands on a 500 ProblemDetails.
      expect(filter).toMatch(/context\.Exception is ExternHandlerException xh/);
      expect(filter).toMatch(
        /Problem\(context, 500, "Internal Server Error", xh\.Message, trace_id\)/,
      );
      // Logs the inner cause server-side via the neutral log-event
      // catalog (Phase 8 .NET).  Template uses `{Event}` head + per-field
      // `{Pascal}` placeholders so a Serilog/structured sink can filter
      // on `Event = "extern_handler_threw"` — same identity the Hono
      // pino payload's `event` key carries.
      expect(filter).toMatch(
        /_log\.LogError\(xh, "\{Event\} aggregate=\{Aggregate\} op=\{Op\} error=\{Error\}", "extern_handler_threw", xh\.AggName, xh\.OpName, xh\.Message\);/,
      );
      // Fallback 500 — same catalog idiom, internal_error event.
      expect(filter).toMatch(
        /_log\.LogError\(context\.Exception, "\{Event\} error=\{Error\} status=\{Status\}", "internal_error", context\.Exception\.Message, 500\);/,
      );
    });

    it("--trace on: emits DomainLog shim + RequestContext carrier + ExecutionContextBehavior + domain trace injections", async () => {
      // Phase 8 .NET domain-trace v1 — mirrors Hono Phase 6.  Aggregate
      // methods can't take ILogger via constructor (they're POCO
      // entities, not DI-managed), so the compile-time --trace switch
      // surfaces the request logger as a SLICE of the ambient
      // RequestContext: a Domain/Common/DomainLog.cs shim reads
      // RequestContext.Current?.Logger, ExecutionContextBehavior binds it
      // per dispatch, and trace lines render through DomainLog.LogTrace at
      // the catalog's domain seams (value_computed after every scalar
      // assign; precondition_evaluated as a bound-temp wrap).
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model, { emitTrace: true });

      // 1. DomainLog is now a shim over the RequestContext logger slice
      // (no AsyncLocal of its own).
      const log = files.get("Domain/Common/DomainLog.cs")!;
      expect(log).toMatch(/public static class DomainLog/);
      expect(log).toMatch(/public static ILogger\? Current => RequestContext\.Current\?\.Logger;/);
      expect(log).not.toMatch(/AsyncLocal/);
      expect(log).toMatch(/public static void LogTrace\(string template, params object\[\] args\)/);

      // 2. The ambient carrier is emitted (trace-only here: a Logger
      // slice, no CurrentUser since this legacy path has no auth) along
      // with the boundary middleware that opens the root frame.
      const rc = files.get("Domain/Common/RequestContext.cs")!;
      expect(rc).toMatch(/public sealed class RequestContext/);
      expect(rc).toMatch(/AsyncLocal<RequestContext\?> _current/);
      expect(rc).toMatch(/public ILogger\? Logger \{ get; set; \}/);
      expect(rc).not.toMatch(/CurrentUser/);
      expect(files.has("Middleware/RequestContextMiddleware.cs")).toBe(true);
      // The boundary middleware echoes the correlation id on the response and
      // opens a request-wide logging scope binding correlationId + scopeId so
      // every request-bracket log carries them (without touching the catalog).
      const rcm = files.get("Middleware/RequestContextMiddleware.cs")!;
      expect(rcm).toMatch(/ctx\.Response\.Headers\["X-Correlation-Id"\] = correlationId;/);
      expect(rcm).toMatch(/\["correlationId"\] = correlationId,/);
      expect(rcm).toMatch(/\["scopeId"\] = rootFrame\.ScopeId,/);
      expect(rcm).toMatch(/InvokeAsync\(HttpContext ctx, ILogger<RequestContextMiddleware> log\)/);

      // 3. ExecutionContextBehavior opens a per-dispatch child frame (root
      // when none is active), binds the logger slice, and surfaces the
      // correlation / scope / parent ids on a logger scope.  Enter restores
      // the previous frame on exit so reentrant Send calls stack cleanly.
      const behavior = files.get("Application/Common/ExecutionContextBehavior.cs")!;
      expect(behavior).toMatch(/IPipelineBehavior<TMessage, TResponse>/);
      expect(behavior).toMatch(/var parent = RequestContext\.Current;/);
      expect(behavior).toMatch(/RequestContext\.OpenChild\(parent\)/);
      expect(behavior).toMatch(/RequestContext\.OpenRoot\(/);
      expect(behavior).toMatch(/frame\.Logger = _log;/);
      expect(behavior).toMatch(/using \(RequestContext\.Enter\(frame\)\)/);
      expect(behavior).toMatch(/\["scopeId"\] = frame\.ScopeId,/);
      expect(behavior).toMatch(/\["parentId"\] = frame\.ParentId,/);
      expect(behavior).toMatch(/\["actorId"\] = frame\.ActorId,/);
      expect(files.has("Application/Common/DomainLogBehavior.cs")).toBe(false);

      // 3b. The carrier exposes the child-frame factory chaining ParentId
      // to the caller's ScopeId.
      expect(rc).toMatch(/public static RequestContext OpenChild\(RequestContext parent\)/);
      expect(rc).toMatch(/ParentId = parent\.ScopeId,/);

      // 4. Program.cs mounts the boundary middleware first and registers
      // the renamed pipeline behaviour.
      const program = files.get("Program.cs")!;
      expect(program).toMatch(/app\.UseMiddleware<.+\.Middleware\.RequestContextMiddleware>\(\);/);
      expect(program).toMatch(/typeof\(.+\.Application\.Common\.ExecutionContextBehavior<,>\)/);
      expect(program).not.toMatch(/DomainLogBehavior/);

      // 5. Aggregate ops get value_computed + precondition_evaluated.
      const order = files.get("Domain/Orders/Order.cs")!;
      // precondition_evaluated — bound temp + trace + conditional throw.
      expect(order).toMatch(/var __pre_\d+_ok = \(/);
      expect(order).toMatch(
        /DomainLog\.LogTrace\("\{Event\} aggregate=\{Aggregate\} op=\{Op\} expr=\{Expr\} passed=\{Passed\}", "precondition_evaluated", "Order", "[a-zA-Z]+", "[^"]+", __pre_\d+_ok\);/,
      );
      expect(order).toMatch(/if \(!__pre_\d+_ok\) throw new DomainException\(/);
      // value_computed — appended after each scalar assign (the
      // Confirm op assigns Status = OrderStatus.Confirmed).
      expect(order).toMatch(
        /DomainLog\.LogTrace\("\{Event\} aggregate=\{Aggregate\} field=\{Field\} value=\{Value\}", "value_computed", "Order", "status", Status\);/,
      );
    });

    it("--trace off: domain layer stays free of DomainLog shim + behavior + injections (carrier stays for scope_id)", async () => {
      // The whole point of the compile-time switch — off path emits
      // NOTHING domain-trace-related.  No DomainLog.cs, no behavior, no
      // Program.cs registration, no LogTrace calls in entities.  The ambient
      // carrier + boundary middleware DO stay (even with no auth/trace): the
      // always-on request log rides their root-frame `scope_id`, matching the
      // cross-backend observability envelope.  The carrier is just bare — no
      // CurrentUser / Logger slice (those are the auth / --trace layers).
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model); // no emitTrace
      expect(files.has("Domain/Common/DomainLog.cs")).toBe(false);
      expect(files.has("Application/Common/ExecutionContextBehavior.cs")).toBe(false);
      expect(files.has("Application/Common/DomainLogBehavior.cs")).toBe(false);
      // Carrier present for scope_id, but bare (no auth / logger slice).
      const rc = files.get("Domain/Common/RequestContext.cs")!;
      expect(rc).toMatch(/public sealed class RequestContext/);
      expect(rc).not.toMatch(/public User\? CurrentUser/);
      expect(rc).not.toMatch(/public ILogger\? Logger/);
      expect(files.has("Middleware/RequestContextMiddleware.cs")).toBe(true);
      const program = files.get("Program.cs")!;
      expect(program).not.toMatch(/DomainLogBehavior/);
      expect(program).not.toMatch(/ExecutionContextBehavior/);
      expect(program).toMatch(/app\.UseMiddleware<.+\.Middleware\.RequestContextMiddleware>\(\);/);
      const order = files.get("Domain/Orders/Order.cs")!;
      expect(order).not.toMatch(/DomainLog\./);
      expect(order).not.toMatch(/__pre_\d+_ok/);
      expect(order).not.toMatch(/precondition_evaluated/);
      expect(order).not.toMatch(/value_computed/);
    });

    it("--trace on: operation routes emit wire_in after [FromBody] binding (lowerCamel param names)", async () => {
      // Phase 8 .NET wire_in v1 — mirrors Hono Phase 6d.  The catalog's
      // wire_in event surfaces the parsed request's structural shape
      // (keys only, no values) right before operation_invoked.  Keys
      // are the IR field names (lowerCamel), matching the JSON wire
      // under ASP.NET's default JsonNamingPolicy.CamelCase — so the
      // SAME `wire_in` event from Hono and .NET joins seamlessly on
      // the wire-shape key set.
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model, { emitTrace: true });
      const controller = files.get("Api/OrdersController.cs")!;
      // sales.ddd's Order has `addLine(productId: Id<Product>, qty:
      // int, price: Money)` — three lowerCamel param names.
      expect(controller).toMatch(
        /_log\.LogTrace\("\{Event\} keys=\{Keys\}", "wire_in", new\[\] \{ "productId", "qty", "price" \}\);/,
      );
      // And `confirm()` has zero params — Array.Empty<string>() is
      // the safe empty form (the implicit `new[] { }` is a compile
      // error: no element type to infer).  `System.` prefix dropped
      // since the file already imports `using System;` via the SDK's
      // ImplicitUsings — see the per-file using derivation PR.
      expect(controller).toMatch(
        /_log\.LogTrace\("\{Event\} keys=\{Keys\}", "wire_in", Array\.Empty<string>\(\)\);/,
      );
      // wire_in fires BEFORE operation_invoked at every op-route entry —
      // mirroring the Hono order (shape first, narrative next).
      const wireInAt = controller.search(/"wire_in"/);
      const opInvokedAt = controller.search(/"operation_invoked"/);
      expect(wireInAt).toBeGreaterThan(-1);
      expect(wireInAt).toBeLessThan(opInvokedAt);
    });

    it("--trace off: controllers stay free of wire_in lines", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model); // no emitTrace
      const controller = files.get("Api/OrdersController.cs")!;
      expect(controller).not.toMatch(/wire_in/);
      expect(controller).not.toMatch(/System\.Array\.Empty<string>/);
    });

    it("--trace on: AssertInvariants gains an __op param + emits invariant_evaluated per check", async () => {
      // Phase 8 .NET invariants v1 — mirrors Hono Phase 6b.  Invariants
      // run from a shared helper (`AssertInvariants`) that otherwise
      // has no view of the calling op; under --trace the helper takes
      // a `string __op` parameter threaded by every call site (ctor /
      // hydration → "<init>", each public op → its own name), and
      // each invariant body becomes a bound-temp + LogTrace +
      // conditional throw triple.
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model, { emitTrace: true });
      const order = files.get("Domain/Orders/Order.cs")!;

      // Signature carries the __op param with the "<init>" default so the
      // event-sourcing applier / hydration can call AssertInvariants() without
      // args.  (Private since extern (b) Phase 2 — no external caller.)
      expect(order).toMatch(/void AssertInvariants\(string __op = "<init>"\)/);
      // Hydration + Create factory pass "<init>"; each op passes its
      // own name.
      expect(order).toMatch(/e\.AssertInvariants\("<init>"\);/);
      expect(order).toMatch(/AssertInvariants\("confirm"\);/);

      // GUARDED invariant on Order — `lines.count > 0 when status ==
      // Confirmed`.  Under trace, the const+log+throw triple wraps
      // INSIDE the guard's if-body so an inapplicable invariant
      // doesn't pollute the stream.
      expect(order).toMatch(
        /if \(this\.Status == OrderStatus\.Confirmed\)[\s\S]+?var __inv_\d+_ok = \(this\.Lines\.Count > 0\);[\s\S]+?DomainLog\.LogTrace\([^)]+"invariant_evaluated", "Order", __op,/,
      );

      // OrderLine's unguarded invariant `quantity > 0` — straight
      // triple, no guard wrap.
      const orderLine = files.get("Domain/Orders/OrderLine.cs")!;
      expect(orderLine).toMatch(/var __inv_\d+_ok = \(this\.Quantity > 0\);/);
      expect(orderLine).toMatch(
        /DomainLog\.LogTrace\([^)]+"invariant_evaluated", "OrderLine", __op, "quantity > 0", __inv_\d+_ok\);/,
      );
    });

    it("--trace off: AssertInvariants stays parameterless + emits the original if-throw shape", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model); // no emitTrace
      const order = files.get("Domain/Orders/Order.cs")!;
      // No __op, no temp binding, no LogTrace.
      expect(order).toMatch(/void AssertInvariants\(\)/);
      expect(order).not.toMatch(/__inv_\d+_ok/);
      expect(order).not.toMatch(/invariant_evaluated/);
      expect(order).not.toMatch(/string __op/);
      // Original guarded-and-throw shape preserved.
      expect(order).toMatch(
        /if \(\(this\.Status == OrderStatus\.Confirmed\) && !\(this\.Lines\.Count > 0\)\) throw new DomainException/,
      );
    });

    it("--trace on: SaveAsync wraps SaveChangesAsync in tx_begin/commit/rollback", async () => {
      // Phase 8 .NET trace v1 — mirrors Hono Phase 6c.  Trace-off keeps
      // the original one-liner shape; trace-on wraps SaveChangesAsync
      // in try/catch with the catalog's tx_* triple at LogTrace level.
      // repository_save fires AFTER tx_commit (inside the try) so the
      // existing post-save debug line only emits when the underlying
      // commit actually succeeded.
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model, { emitTrace: true });
      const repo = files.get("Infrastructure/Repositories/OrderRepository.cs")!;
      expect(repo).toMatch(
        /_log\.LogTrace\("\{Event\} aggregate=\{Aggregate\} id=\{Id\}", "tx_begin", "Order", aggregate\.Id\.Value\);/,
      );
      expect(repo).toMatch(
        /_log\.LogTrace\("\{Event\} aggregate=\{Aggregate\} id=\{Id\}", "tx_commit", "Order", aggregate\.Id\.Value\);/,
      );
      expect(repo).toMatch(
        /_log\.LogTrace\("\{Event\} aggregate=\{Aggregate\} id=\{Id\} error=\{Error\}", "tx_rollback", "Order", aggregate\.Id\.Value, __txErr\.Message\);/,
      );
      // try/catch shape — rollback path re-throws so the seam's call
      // sites still see the original exception.
      expect(repo).toMatch(/try\s*\n\s*\{[\s\S]+?catch \(Exception __txErr\)/);
      expect(repo).toMatch(/__txErr\.Message[\s\S]+?throw;/);
    });

    it("--trace off: SaveAsync stays at the original one-liner SaveChangesAsync shape", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model); // no emitTrace
      const repo = files.get("Infrastructure/Repositories/OrderRepository.cs")!;
      expect(repo).not.toMatch(/tx_begin/);
      expect(repo).not.toMatch(/tx_commit/);
      expect(repo).not.toMatch(/tx_rollback/);
      expect(repo).not.toMatch(/__txErr/);
      // The bare SaveChangesAsync + LogDebug stays exactly as before.
      expect(repo).toMatch(
        /await _db\.SaveChangesAsync\(cancellationToken\);\n\s+_log\.LogDebug\("\{Event\} aggregate=\{Aggregate\} id=\{Id\}", "repository_save", "Order", aggregate\.Id\.Value\);/,
      );
    });

    it("repository wires ILogger + emits aggregate_loaded / repository_save / event_dispatched / find_executed", async () => {
      // Phase 8 .NET (repo seams) — every per-aggregate EF repository
      // gets an `ILogger<TRepository> _log` field, GetByIdAsync emits
      // aggregate_loaded (debug, with found:bool), SaveAsync emits
      // repository_save (debug) after SaveChangesAsync + event_dispatched
      // (info) per drained event, and each find method emits find_executed
      // (debug) with rows count.  Same event identities the Hono Phase 4
      // wiring emits — a single dashboard query joins both backends.
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const repo = files.get("Infrastructure/Repositories/OrderRepository.cs")!;
      expect(repo).toMatch(/using Microsoft\.Extensions\.Logging;/);
      expect(repo).toMatch(/private readonly ILogger<OrderRepository> _log;/);
      expect(repo).toMatch(
        /OrderRepository\(AppDbContext db, IDomainEventDispatcher events, ILogger<OrderRepository> log\)/,
      );
      // aggregate_loaded — both paths covered by the `found != null` bool.
      expect(repo).toMatch(
        /_log\.LogDebug\("\{Event\} aggregate=\{Aggregate\} id=\{Id\} found=\{Found\}", "aggregate_loaded", "Order", id\.Value, found != null\);/,
      );
      // repository_save fires after the EF transaction commits.
      expect(repo).toMatch(
        /_log\.LogDebug\("\{Event\} aggregate=\{Aggregate\} id=\{Id\}", "repository_save", "Order", aggregate\.Id\.Value\);/,
      );
      // event_dispatched per drained event — `ev.GetType().Name` is the
      // concrete subclass name (same shape as Hono's
      // (event as object).constructor.name).
      expect(repo).toMatch(
        /_log\.LogInformation\("\{Event\} event_type=\{EventType\} aggregate=\{Aggregate\} id=\{Id\}", "event_dispatched", ev\.GetType\(\)\.Name, "Order", aggregate\.Id\.Value\);/,
      );
      // find_executed — array find uses result.Count; the assertion
      // anchors on the catalog shape, not a specific find name.
      expect(repo).toMatch(
        /_log\.LogDebug\("\{Event\} aggregate=\{Aggregate\} find=\{Find\} rows=\{Rows\}", "find_executed", "Order", "[a-zA-Z]+", result\.Count\);/,
      );
    });

    it("controller wires ILogger + emits operation_invoked / aggregate_created from the catalog", async () => {
      // Phase 8 .NET — every per-aggregate controller gets an
      // `ILogger<TController> _log` field (matching the
      // DomainExceptionFilter idiom), Create logs `aggregate_created`
      // after Mediator.Send returns, and each public op handler logs
      // `operation_invoked` before dispatching its command.  Same event
      // identity the Hono backend emits; structured fields use Pascal
      // placeholders so Serilog / ASP.NET sinks pick them up.
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const controller = files.get("Api/OrdersController.cs")!;
      expect(controller).toMatch(/using Microsoft\.Extensions\.Logging;/);
      expect(controller).toMatch(/private readonly ILogger<OrdersController> _log;/);
      expect(controller).toMatch(
        /public OrdersController\(IMediator mediator, ILogger<OrdersController> log\) \{ _mediator = mediator; _log = log; \}/,
      );
      expect(controller).toMatch(
        /_log\.LogInformation\("\{Event\} aggregate=\{Aggregate\} id=\{Id\}", "aggregate_created", "Order", id\.Value\);/,
      );
      // sales.ddd's Order has multiple public ops; any op-handler line
      // satisfies — the assertion captures the catalog shape, not the
      // specific op name.
      expect(controller).toMatch(
        /_log\.LogInformation\("\{Event\} aggregate=\{Aggregate\} op=\{Op\} id=\{Id\}", "operation_invoked", "Order", "[a-zA-Z]+", id\);/,
      );
    });

    it("does NOT touch ValidationProblemDetails (RFC 7807 stays the contract)", async () => {
      // The framework's default 400 envelope for model-binding /
      // data-annotation failures is the published API contract for
      // request-validation errors.  Forking it would break every
      // OpenAPI-generated client.  Pin the absence of any override.
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const program = files.get("Program.cs")!;
      expect(program).not.toMatch(/InvalidModelStateResponseFactory/);
      expect(program).not.toMatch(/ConfigureApiBehaviorOptions/);
      // No custom ValidationFilter file emitted alongside the
      // domain filter.
      expect(files.has("Api/ValidationFilter.cs")).toBe(false);
    });

    // (Removed: the aggregate-op `try { await _user.HandleAsync } catch …
    // ExternHandlerException` wrap.  Since extern (b) Phase 2 an extern
    // aggregate op is an ordinary domain method — a hand-written exception from
    // its hook bubbles as a generic 500, no injected handler to wrap.  The
    // ExternHandlerException type + its DomainExceptionFilter arm are retained
    // for the application-layer extern handler surface, tested above.)
  });

  it("emits a Mediator handler + controller for non-transactional workflow", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Customer {
          name: string
          derived display: string = name
          creditLimit: decimal
          operation deductCredit(amount: decimal) {
            precondition amount > 0
            creditLimit := creditLimit - amount
          }
        }
        aggregate Order {
          customerId: Customer id
          status: OrderStatus
          placedAt: datetime
        }
        repository Customers for Customer { }
        repository Orders for Order { }
        event OrderPlaced { order: Order id, at: datetime }
        workflow placeOrder {
      create(customerId: Customer id, amount: decimal, placedAt: datetime) {
          precondition amount > 0
          let customer = Customers.getById(customerId)
          customer.deductCredit(amount)
          let order = Order.create({
            customerId: customerId,
            status: Draft,
            placedAt: placedAt
          })
          emit OrderPlaced { order: order.id, at: placedAt }
        }
    }
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);

    // Request DTO uses wire types (Guid for X id, string for datetime).
    // Required-ness targets the ctor PARAMETER (bare `[Required]`), not the
    // property — `[property: Required]` on a positional record makes
    // ASP.NET's record validation throw at model-binding time (500 on every
    // POST).  Responses keep `[property: Required]`; see dtoParam.
    const req = files.get("Application/Workflows/PlaceOrderRequest.cs")!;
    // Required strings carry `AllowEmptyStrings = true` (empty → domain 422,
    // not model-validation 400); non-string required fields stay bare.
    expect(req).toMatch(
      /public sealed record PlaceOrderRequest\(\[Required\] Guid CustomerId, \[Required\] decimal Amount, \[Required\(AllowEmptyStrings = true\)\] string PlacedAt\)/,
    );

    // Command uses domain types (CustomerId, DateTime).
    const cmd = files.get("Application/Workflows/PlaceOrderCommand.cs")!;
    expect(cmd).toMatch(
      /public sealed record PlaceOrderCommand\(CustomerId CustomerId, decimal Amount, DateTime PlacedAt\)/,
    );

    // Handler injects both repositories + event dispatcher; statement
    // ordering preserved; saves at exit; event drain after saves.
    const handler = files.get("Application/Workflows/PlaceOrderHandler.cs")!;
    expect(handler).toMatch(/private readonly ICustomerRepository _customers;/);
    expect(handler).toMatch(/private readonly IOrderRepository _orders;/);
    expect(handler).toMatch(/private readonly IDomainEventDispatcher _events;/);
    // Literal `0` opposite a decimal-typed `command.Amount` is elaborated
    // to a decimal IR literal (`lit("decimal", "0")`) by the general
    // literal-promotion seam, so the .NET emitter writes `0m`
    // (canonical C# decimal literal) — still valid C#, just more
    // type-honest than the old implicit-conversion form.
    expect(handler).toMatch(/if \(!\(command\.Amount > 0m\)\) throw new DomainException/);
    // The load is dereferenced (`customer.DeductCredit(...)`), so the nullable
    // `GetByIdAsync` result is guarded with `?? throw` — otherwise CS8602 under
    // /warnaserror.  (A load that's only read to seed a `create`, like sales'
    // `placeOrder`, stays unguarded — see dotnet-dispatch-emission.test.ts.)
    expect(handler).toMatch(
      /var customer = await _customers\.GetByIdAsync\(command\.CustomerId, cancellationToken\)\s*\?\? throw new AggregateNotFoundException\(\$"Customer \{command\.CustomerId\} not found"\);/,
    );
    expect(handler).toMatch(/customer\.DeductCredit\(command\.Amount\);/);
    expect(handler).toMatch(
      /var order = Order\.Create\(customerId: command\.CustomerId, status: OrderStatus\.Draft/,
    );
    expect(handler).toMatch(/_workflowEvents\.Add\(new OrderPlaced\(/);
    // Saves ordered: customer first (declared first), then order.
    const saveCustIdx = handler.indexOf("await _customers.SaveAsync(customer");
    const saveOrderIdx = handler.indexOf("await _orders.SaveAsync(order");
    expect(saveCustIdx).toBeGreaterThan(0);
    expect(saveOrderIdx).toBeGreaterThan(saveCustIdx);
    // Event drain after saves.
    const drainIdx = handler.indexOf("foreach (var ev in _workflowEvents)");
    expect(drainIdx).toBeGreaterThan(saveOrderIdx);
    // Non-transactional: no BeginTransactionAsync.
    expect(handler).not.toMatch(/BeginTransactionAsync/);

    // Controller exposes POST /workflows/place_order.
    const ctrl = files.get("Api/SalesWorkflowsController.cs")!;
    expect(ctrl).toMatch(/\[Route\("workflows"\)\]/);
    expect(ctrl).toMatch(/\[HttpPost\("place_order"\)\]/);
    // Action method name = PascalCase of the shared operationId
    // `placeOrderWorkflow` (Request/Command DTO names keep `PlaceOrder…`).
    expect(ctrl).toMatch(
      /public async Task<IActionResult> PlaceOrderWorkflow\(\[FromBody\] PlaceOrderRequest request\)/,
    );
    expect(ctrl).toMatch(/new PlaceOrderCommand\(\s*new CustomerId\(request\.CustomerId\)/);
  });

  it("fills omitted create inputs in a workflow factory-let with their omission values", async () => {
    // The .NET Create(...) factory takes the full canonical create-input
    // set as required params (no C# default). A workflow `create` that
    // names only a subset must still supply every other create input, or
    // the call fails with CS7036. Each omitted field gets its omission
    // value: an optional → null, a `= default` → the default literal.
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Support {
        aggregate Ticket {
          subject: string
          memo: string?
          rank: int = 3
        }
        repository Tickets for Ticket { }
        workflow openTicket {
      create(subject: string) {
          let ticket = Ticket.create({ subject: subject })
        }
    }
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);
    const handler = files.get("Application/Workflows/OpenTicketHandler.cs")!;
    // Provided field first, then the omitted optional (null) and the
    // omitted defaulted field (its literal) — all named, so order-free.
    expect(handler).toMatch(/Ticket\.Create\(subject: command\.Subject/);
    expect(handler).toMatch(/memo: null/);
    expect(handler).toMatch(/rank: 3/);
  });

  it("emits a transactional workflow with BeginTransactionAsync + Commit + Rollback", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context T {
        aggregate Customer {
          name: string
          derived display: string = name
          creditLimit: decimal
          operation addCredit(amount: decimal) {
            precondition amount > 0
            creditLimit := creditLimit + amount
          }
        }
        repository Customers for Customer { }
        workflow topUp transactional {
      create(customerId: Customer id, amount: decimal) {
          precondition amount > 0
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
    }
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);
    const handler = files.get("Application/Workflows/TopUpHandler.cs")!;
    // Transaction via the domain IUnitOfWork port (audit S7 Slice C), `global::`-
    // anchored so a deployable named `api` (root ns `Api`) doesn't mis-resolve
    // the leading segment against the enclosing namespace.
    expect(handler).toMatch(/private readonly global::T\.Domain\.Common\.IUnitOfWork _uow;/);
    expect(handler).toMatch(
      /await using var tx = await _uow\.BeginTransactionAsync\(cancellationToken\);/,
    );
    expect(handler).toMatch(/await tx\.CommitAsync\(cancellationToken\);/);
    expect(handler).toMatch(/await tx\.RollbackAsync\(cancellationToken\);/);
    // Save inside the try block, before commit.
    const trySaveIdx = handler.indexOf("await _customers.SaveAsync(c, cancellationToken);");
    const commitIdx = handler.indexOf("await tx.CommitAsync(cancellationToken);");
    expect(trySaveIdx).toBeGreaterThan(0);
    expect(commitIdx).toBeGreaterThan(trySaveIdx);
  });

  it("emits a Mediator query/handler + ViewsController + repo method per view", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          customerId: string
          status: OrderStatus
        }
        repository Orders for Order { }
        view ActiveOrders = Order where status == Confirmed
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);

    // 1. Query record (parameterless, returns IReadOnlyList<OrderResponse>).
    const query = files.get("Application/Views/ActiveOrdersQuery.cs")!;
    expect(query).toMatch(
      /public sealed record ActiveOrdersQuery\(\) : IQuery<IReadOnlyList<OrderResponse>>/,
    );

    // 2. Handler injects IOrderRepository, calls _repo.ActiveOrders(cancellationToken),
    //    projects each domain row to OrderResponse via the canonical
    //    projection helper.
    const handler = files.get("Application/Views/ActiveOrdersHandler.cs")!;
    expect(handler).toMatch(/private readonly IOrderRepository _repo;/);
    expect(handler).toMatch(/await _repo\.ActiveOrders\(cancellationToken\);/);
    expect(handler).toMatch(/domain\.Select\(d => new OrderResponse\(/);

    // 3. The .NET repository interface + impl gained the view method
    //    (via the mergeViewsAsFinds synthesis).
    const iface = files.get("Domain/Orders/IOrderRepository.cs")!;
    expect(iface).toMatch(/Task<List<Order>> ActiveOrders\(/);
    const impl = files.get("Infrastructure/Repositories/OrderRepository.cs")!;
    expect(impl).toMatch(/public async Task<List<Order>> ActiveOrders\(/);
    expect(impl).toMatch(
      /_db\.Orders\.Where\(x => x\.Status == OrderStatus\.Confirmed\)\.ToListAsync\(cancellationToken\)/,
    );

    // 4. Controller exposes GET /views/active_orders.
    const ctrl = files.get("Api/SalesViewsController.cs")!;
    expect(ctrl).toMatch(/\[Route\("views"\)\]/);
    expect(ctrl).toMatch(/\[HttpGet\("active_orders"\)\]/);
    expect(ctrl).toMatch(/await _mediator\.Send\(new ActiveOrdersQuery\(\)\)/);
  });

  it("emits a custom-shape view with per-row projection (full form)", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          customerId: string
          status: OrderStatus
          contains lines: OrderLine[]
          entity OrderLine { quantity: int, invariant quantity > 0 }
        }
        repository Orders for Order { }
        view OrderSummary {
          orderId: Order id
          status: OrderStatus
          lineCount: int
          from Order where status == Confirmed
          bind orderId = id, status = status, lineCount = lines.count
        }
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);

    // Wire-typed Row record (Order id → Guid, enum → enum TYPE, int → int).
    // The enum crosses the wire as `OrderStatus` (string-on-wire via the
    // global JsonStringEnumConverter) so Swashbuckle names the enum schema.
    const row = files.get("Application/Views/OrderSummaryRow.cs")!;
    expect(row).toMatch(
      /public sealed record OrderSummaryRow\(\[property: Required\] Guid OrderId, \[property: Required\] OrderStatus Status, \[property: Required\] int LineCount\);/,
    );

    // Query returns IReadOnlyList<OrderSummaryRow>, not <Agg>Response.
    const query = files.get("Application/Views/OrderSummaryQuery.cs")!;
    expect(query).toMatch(/IQuery<IReadOnlyList<OrderSummaryRow>>/);

    // Handler projects through projectToResponse (Id.Value, enum passed
    // through as the enum type, collection .Count via the bind renderer).
    const handler = files.get("Application/Views/OrderSummaryHandler.cs")!;
    expect(handler).toMatch(
      /domain\.Select\(d => new OrderSummaryRow\(d\.Id\.Value, d\.Status, d\.Lines\.Count\)\)\.ToList\(\)/,
    );
  });

  it("rewrites X id follow refs to FindManyByIdsAsync + dictionary lookups", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Customer { name: string, email: string  derived display: string = name }
        aggregate Order {
          customerId: Customer id
          status: OrderStatus
        }
        repository Customers for Customer { }
        repository Orders for Order { }
        view CustomerOrders {
          orderId: Order id
          customerName: string
          customerEmail: string
          status: OrderStatus
          from Order where status == Confirmed
          bind orderId = id, customerName = customerId.name, customerEmail = customerId.email, status = status
        }
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);

    // Handler injects both repos.
    const handler = files.get("Application/Views/CustomerOrdersHandler.cs")!;
    expect(handler).toMatch(/private readonly IOrderRepository _repo;/);
    expect(handler).toMatch(/private readonly ICustomerRepository _customerRepo;/);
    // Bulk load + ToDictionary keyed by Id.
    expect(handler).toMatch(
      /var customerById = \(await _customerRepo\.FindManyByIdsAsync\(domain\.Select\(d => d\.CustomerId\)\.ToList\(\), cancellationToken\)\)\.ToDictionary\(__a => __a\.Id\)/,
    );
    // Projection rewrites the Id-follow refs to dictionary lookups.
    expect(handler).toMatch(
      /new CustomerOrdersRow\(d\.Id\.Value, customerById\[d\.CustomerId\]\.Name, customerById\[d\.CustomerId\]\.Email, d\.Status\)/,
    );

    // Repo interface + impl gained FindManyByIdsAsync.
    const iface = files.get("Domain/Customers/ICustomerRepository.cs")!;
    expect(iface).toMatch(/Task<IReadOnlyList<Customer>> FindManyByIdsAsync/);
    const impl = files.get("Infrastructure/Repositories/CustomerRepository.cs")!;
    expect(impl).toMatch(
      /_db\.Customers\.Where\(x => ids\.Contains\(x\.Id\)\)\.ToListAsync\(cancellationToken\)/,
    );
  });

  it("workflow op-call to a parameterless extern calls the aggregate method directly", async () => {
    // extern (b) Phase 2: an extern op is an ordinary aggregate method (it runs
    // preconditions, calls its `<Op>Core` hook, re-asserts invariants), so a
    // workflow op-call is `order.Confirm()` — no injected handler, no dispatch.
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          customerId: string
          status: OrderStatus
          function isMutable(): bool = status == Draft
          operation confirm() extern { precondition isMutable() }
        }
        repository Orders for Order { }
        workflow placeAndConfirm {
      create(orderId: Order id) {
          let order = Orders.getById(orderId)
          order.confirm()
        }
    }
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);
    const handler = files.get("Application/Workflows/PlaceAndConfirmHandler.cs")!;

    // Direct method call — no injected `IConfirmOrderHandler`, no dispatch dance.
    expect(handler).toMatch(/order\.Confirm\(\);/);
    expect(handler).not.toMatch(/IConfirmOrderHandler/);
    expect(handler).not.toMatch(/\.HandleAsync\(/);
    expect(handler).not.toMatch(/CheckConfirm/);
    expect(handler).not.toMatch(/ConfirmOrderRequest/);
    // Save still happens at workflow exit.
    expect(handler).toMatch(/await _orders\.SaveAsync\(order, cancellationToken\);/);
  });

  it("auto Mediator handler for a parameterized extern calls the aggregate method with domain args", async () => {
    // extern (b) Phase 2: the extern op flows through the regular command path,
    // so the handler calls `aggregate.AddLine(command.ProductId, ...)` with the
    // DOMAIN-typed command params — no wire `<Op><Agg>Request`, no HandleAsync.
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        valueobject Money {
          amount: decimal
          currency: string
          invariant amount >= 0
        }
        aggregate Order {
          customerId: string
          status: string
          function isMutable(): bool = status == "Draft"
          operation addLine(productId: Order id, qty: int, price: Money) extern {
            precondition isMutable()
            precondition qty > 0
          }
        }
        repository Orders for Order { }
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);
    const handler = files.get("Application/Orders/Commands/AddLineHandler.cs")!;
    expect(handler).toMatch(
      /aggregate\.AddLine\(command\.ProductId, command\.Qty, command\.Price\);/,
    );
    expect(handler).not.toMatch(/HandleAsync/);
    expect(handler).not.toMatch(/AddLineOrderRequest/);
    // And the aggregate declares the partial hook + implements it (scaffold-once).
    const order = files.get("Domain/Orders/Order.cs")!;
    expect(order).toMatch(/private partial void AddLineCore\(OrderId productId, int qty, Money price\);/);
    const impl = files.get("Domain/Orders/Order.Extern.cs")!;
    expect(impl).toMatch(/private partial void AddLineCore\(OrderId productId, int qty, Money price\)/);
  });

  it("workflow op-call to a parameterized extern calls the aggregate method with cmd-param args", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        aggregate Order {
          customerId: string
          status: string
          function isMutable(): bool = status == "Draft"
          operation deduct(amount: decimal) extern {
            precondition isMutable()
            precondition amount > 0
          }
        }
        repository Orders for Order { }
        workflow chargeOrder {
      create(orderId: Order id, amount: decimal) {
          let order = Orders.getById(orderId)
          order.deduct(amount)
        }
    }
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);
    const handler = files.get("Application/Workflows/ChargeOrderHandler.cs")!;
    expect(handler).toMatch(/order\.Deduct\(command\.Amount\);/);
    expect(handler).not.toMatch(/HandleAsync/);
    expect(handler).not.toMatch(/DeductOrderRequest/);
  });

  it("multi-hop X id.Y id.field follow loads aggregates in dependency order", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Region { name: string, countryCode: string  derived display: string = name }
        aggregate Customer { name: string, regionId: Region id  derived display: string = name }
        aggregate Order { customerId: Customer id, status: OrderStatus }
        repository Regions for Region { }
        repository Customers for Customer { }
        repository Orders for Order { }
        view OrdersWithRegion {
          orderId: Order id
          regionName: string
          from Order where status == Confirmed
          bind orderId = id,
               regionName = customerId.regionId.name
        }
      }
    `,
      { validation: true },
    );
    const handler = generateDotnet(doc.parseResult.value as Model).get(
      "Application/Views/OrdersWithRegionHandler.cs",
    )!;

    // Both repos injected.
    expect(handler).toMatch(/private readonly ICustomerRepository _customerRepo;/);
    expect(handler).toMatch(/private readonly IRegionRepository _regionRepo;/);
    // Customer loaded first (depends on rows); Region loaded after,
    // sourced from Customer values.
    expect(handler).toMatch(
      /var customerById = \(await _customerRepo\.FindManyByIdsAsync\(domain\.Select\(d => d\.CustomerId\)\.ToList\(\), cancellationToken\)\)\.ToDictionary\(__a => __a\.Id\);/,
    );
    expect(handler).toMatch(
      /var regionByCustomerId = \(await _regionRepo\.FindManyByIdsAsync\(customerById\.Values\.Select\(__a => __a\.RegionId\)\.ToList\(\), cancellationToken\)\)\.ToDictionary\(__a => __a\.Id\);/,
    );
    // Projection walks the chain.
    expect(handler).toMatch(/regionByCustomerId\[customerById\[d\.CustomerId\]\.RegionId\]\.Name/);
  });

  it("emits explicit IsolationLevel for transactional(level) workflows", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context T {
        aggregate Customer {
          name: string
          derived display: string = name
          creditLimit: decimal
          operation addCredit(amount: decimal) {
            precondition amount > 0
            creditLimit := creditLimit + amount
          }
        }
        repository Customers for Customer { }
        workflow ser transactional(serializable) {
      create(customerId: Customer id, amount: decimal) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
    }
        workflow rr transactional(repeatableRead) {
      create(customerId: Customer id, amount: decimal) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
    }
        workflow ru transactional(readUncommitted) {
      create(customerId: Customer id, amount: decimal) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
    }
        workflow rc transactional(readCommitted) {
      create(customerId: Customer id, amount: decimal) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
    }
        workflow plain transactional {
      create(customerId: Customer id, amount: decimal) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
    }
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);
    expect(files.get("Application/Workflows/SerHandler.cs")!).toMatch(
      /BeginTransactionAsync\(IsolationLevel\.Serializable, cancellationToken\)/,
    );
    expect(files.get("Application/Workflows/RrHandler.cs")!).toMatch(
      /BeginTransactionAsync\(IsolationLevel\.RepeatableRead, cancellationToken\)/,
    );
    expect(files.get("Application/Workflows/RuHandler.cs")!).toMatch(
      /BeginTransactionAsync\(IsolationLevel\.ReadUncommitted, cancellationToken\)/,
    );
    expect(files.get("Application/Workflows/RcHandler.cs")!).toMatch(
      /BeginTransactionAsync\(IsolationLevel\.ReadCommitted, cancellationToken\)/,
    );
    // Bare `transactional` doesn't pass an explicit level.
    const plain = files.get("Application/Workflows/PlainHandler.cs")!;
    expect(plain).toMatch(/BeginTransactionAsync\(cancellationToken\)/);
    expect(plain).not.toMatch(/IsolationLevel/);
  });

  it("emits a ListResponseWrapperFilter mapping <Agg>Response → <Agg>ListResponse (#705)", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const filter = files.get("Api/ListResponseWrapperFilter.cs")!;
    expect(filter).toMatch(/class ListResponseWrapperFilter : IDocumentFilter/);
    // Every aggregate gets an element→wrapper pair so the inline list
    // response is promoted to the named component the other backends emit.
    expect(filter).toMatch(/\("OrderResponse", "OrderListResponse"\)/);
    // Registered as a Swashbuckle document filter.
    const program = files.get("Program.cs")!;
    expect(program).toMatch(/c\.DocumentFilter<ListResponseWrapperFilter>\(\)/);
  });

  it("emits a RequiredFromCtorParamFilter that marks request-DTO ctor [Required] params required (#779)", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    // Request DTOs carry parameter-targeted [Required], which Swashbuckle's
    // DataAnnotations reader ignores; this schema filter restores
    // request-body required-ness from the ctor params (cross-backend parity).
    const filter = files.get("Api/RequiredFromCtorParamFilter.cs")!;
    expect(filter).toMatch(/class RequiredFromCtorParamFilter : ISchemaFilter/);
    // Reflects the primary ctor's [Required] params and adds the camelCase
    // property name to schema.Required.
    expect(filter).toMatch(/GetCustomAttribute<RequiredAttribute>\(\)/);
    expect(filter).toMatch(/schema\.Required\.Add\(key\)/);
    expect(filter).toMatch(/JsonNamingPolicy\.CamelCase\.ConvertName/);
    // Registered as a Swashbuckle schema filter, after the NRT support call.
    const program = files.get("Program.cs")!;
    expect(program).toMatch(/c\.SchemaFilter<RequiredFromCtorParamFilter>\(\)/);
  });

  it("DomainExceptionFilter catches unhandled exceptions as sanitized 500", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const filter = files.get("Api/DomainExceptionFilter.cs")!;
    expect(filter).toMatch(/ILogger<DomainExceptionFilter>/);
    // Generic fallback → sanitized 500 ProblemDetails ("internal", no leak).
    expect(filter).toMatch(
      /Problem\(context, 500, "Internal Server Error", "internal", trace_id\)/,
    );
    // The Problem helper builds an RFC 7807 ProblemDetails with the status.
    expect(filter).toMatch(/new ProblemDetails/);
    expect(filter).toMatch(/ContentTypes = \{ "application\/problem\+json" \}/);
    // Domain-specific paths still mapped (400 / 404).
    expect(filter).toMatch(/Problem\(context, 400, "Bad Request", de\.Message, trace_id\)/);
    expect(filter).toMatch(/Problem\(context, 404, "Not Found", nf\.Message, trace_id\)/);
  });

  // -------------------------------------------------------------------------
  // auth scaffolding
  // -------------------------------------------------------------------------

  describe("auth scaffolding", () => {
    async function emitForAuthSystem(src: string): Promise<Map<string, string>> {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(src, { validation: true });
      const { lowerModel } = await import("../../../src/ir/lower/lower.js");
      const { enrichLoomModel } = await import("../../../src/ir/enrich/enrichments.js");
      const { generateDotnetForContexts } = await import("../../../src/generator/dotnet/index.js");
      const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
      const sys = loom.systems[0]!;
      const dep = sys.deployables.find((d) => d.platform === "dotnet")!;
      const contexts = sys.subdomains.flatMap((m) => m.contexts);
      const ns = dep.name[0]!.toUpperCase() + dep.name.slice(1);
      return generateDotnetForContexts(contexts, ns, {
        deployable: dep,
        sys,
      });
    }

    const SRC_AUTH_REQUIRED = `
      system Acme {
        user {
          id: string
          role: string
        }
        subdomain Sales {
          context Orders {
            aggregate Order {
              customerId: string
              status: string
              operation cancel() {
                precondition currentUser.role == "manager"
                status := "cancelled"
              }
            }
            repository Orders for Order { }
          }
        }
        deployable api {
          platform: dotnet
          contexts: [Orders]
          port: 8080
          auth: required
        }
      }
    `;

    const SRC_NO_AUTH = `
      system Acme {
        user { id: string }
        subdomain Sales {
          context Orders {
            aggregate Order { customerId: string }
            repository Orders for Order { }
          }
        }
        deployable api {
          platform: dotnet
          contexts: [Orders]
          port: 8080
        }
      }
    `;

    it("emits Auth/* files when deployable opts in via `auth: required`", async () => {
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      const keys = [...files.keys()];
      expect(keys).toContain("Auth/User.cs");
      expect(keys).toContain("Auth/IUserVerifier.cs");
      expect(keys).toContain("Auth/ICurrentUserAccessor.cs");
      expect(keys).toContain("Auth/HttpContextCurrentUserAccessor.cs");
      expect(keys).toContain("Auth/UserMiddleware.cs");
    });

    // The frontend `auth: ui` guard probes GET /auth/me for the verified
    // session; .NET maps it (not bypassed → UserMiddleware resolves the
    // principal first).  Parity with the Hono backend.
    it("maps GET /auth/me when `auth: required`, and not otherwise", async () => {
      const program = (await emitForAuthSystem(SRC_AUTH_REQUIRED)).get("Program.cs")!;
      expect(program).toContain(
        'app.MapGet("/api/auth/me", (ICurrentUserAccessor accessor) => Results.Json(accessor.User)).ExcludeFromDescription();',
      );
      const noAuth = (await emitForAuthSystem(SRC_NO_AUTH)).get("Program.cs")!;
      expect(noAuth).not.toContain("/api/auth/me");
    });

    // OIDC turnkey auth (D-AUTH-OIDC): an `auth { oidc }` block emits a
    // generated IUserVerifier that validates the IdP's tokens (JWKS) and
    // maps claims onto User, registered last (wins over the dev stub), with
    // the OIDC NuGet refs.  Verified to compile under `dotnet build
    // -warnaserror` (the AnalysisLevel CA gate) out-of-band.
    const SRC_OIDC = `
      system Acme {
        user { id: string role: string permissions: string[] }
        auth {
          provider: keycloak
          oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") }
          claims: { role: "realm_access.roles" }
        }
        subdomain Sales {
          context Orders {
            aggregate Order {
              status: string
              operation cancel() { requires currentUser.role == "admin"  status := "cancelled" }
            }
            repository Orders for Order { }
          }
        }
        deployable api { platform: dotnet contexts: [Orders] port: 8080 auth: required }
      }
    `;

    it("emits + registers the OIDC verifier and adds the NuGet refs under `auth { oidc }`", async () => {
      const files = await emitForAuthSystem(SRC_OIDC);
      const verifier = files.get("Auth/OidcUserVerifier.cs")!;
      expect(verifier).toContain("public sealed class OidcUserVerifier : IUserVerifier");
      expect(verifier).toContain("ConfigurationManager<OpenIdConnectConfiguration>");
      expect(verifier).toContain("ValidateTokenAsync");
      // explicit claim mapping wins; id defaults to `sub`; dotted paths resolve
      expect(verifier).toContain('Role: ClaimString(payload, "realm_access.roles")');
      expect(verifier).toContain('Id: ClaimString(payload, "sub")');
      expect(verifier).toContain('Permissions: ClaimStringList(payload, "permissions")');
      // The verifier also reads the session cookie issued by the handshake.
      expect(verifier).toContain('request.Cookies["session"]');
      const program = files.get("Program.cs")!;
      expect(program).toContain("builder.Services.AddScoped<IUserVerifier, OidcUserVerifier>();");
      const csproj = files.get("Api.csproj")!;
      expect(csproj).toContain("Microsoft.IdentityModel.Protocols.OpenIdConnect");
    });

    it("refreshes the cached OIDC configuration on a signing-key miss (IdP key rotation)", async () => {
      const files = await emitForAuthSystem(SRC_OIDC);
      const verifier = files.get("Auth/OidcUserVerifier.cs")!;
      // An unknown signing key marks the cache stale (RequestRefresh is
      // internally rate-limited by RefreshInterval) and re-validates once
      // against fresh keys — rotation heals without a restart.
      expect(verifier).toContain("result.Exception is SecurityTokenSignatureKeyNotFoundException");
      expect(verifier).toContain("Configuration.RequestRefresh();");
      expect(verifier).toContain("parameters.IssuerSigningKeys = configuration.SigningKeys;");
    });

    it("emits + mounts the /auth/* redirect handshake and bypasses it under `auth { oidc }`", async () => {
      const files = await emitForAuthSystem(SRC_OIDC);
      const handshake = files.get("Auth/AuthHandshake.cs")!;
      expect(handshake).toContain("public static void MapAuthHandshake(this WebApplication app)");
      expect(handshake).toContain('app.MapGet("/api/auth/login"');
      expect(handshake).toContain('app.MapGet("/api/auth/callback"');
      expect(handshake).toContain('app.MapGet("/api/auth/logout"');
      expect(handshake).toContain('"grant_type"] = "authorization_code"');
      // mounted + bypassed (redirect endpoints reachable without a principal)
      expect(files.get("Program.cs")!).toContain("app.MapAuthHandshake();");
      expect(files.get("Auth/UserMiddleware.cs")!).toContain('"/api/auth/login"');
    });

    it("does not emit the OIDC verifier or handshake without an `auth { oidc }` block", async () => {
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      expect(files.has("Auth/OidcUserVerifier.cs")).toBe(false);
      expect(files.has("Auth/AuthHandshake.cs")).toBe(false);
      expect(files.get("Api.csproj")!).not.toContain("Microsoft.IdentityModel");
      expect(files.get("Auth/UserMiddleware.cs")!).not.toContain("/api/auth/login");
    });

    // A `requires`-guarded op / workflow denies with ForbiddenException →
    // 403 at runtime; the controller must DECLARE 403 in [ProducesResponseType].
    const SRC_GUARDED = `
      system Acme {
        user { id: string, role: string }
        subdomain Sales {
          context Orders {
            aggregate Order {
              customerId: string
              status: string
              operation cancel() {
                requires currentUser.role == "admin"
                status := "cancelled"
              }
              operation touch() {
                status := "touched"
              }
            }
            repository Orders for Order { }
            workflow archiveAll {
      create() {
              requires currentUser.role == "admin"
              let o = Order.create({ customerId: "c", status: "archived" })
            }
    }
          }
        }
        deployable api { platform: dotnet, contexts: [Orders], port: 8080, auth: required }
      }
    `;

    it("declares [ProducesResponseType(ProblemDetails, 403)] on guarded ops/workflows, not unguarded ones", async () => {
      const files = await emitForAuthSystem(SRC_GUARDED);
      const ctrl = files.get("Api/OrdersController.cs")!;
      // The guarded `cancel` action carries 403; the unguarded `touch` does not.
      const cancelBlock = ctrl.slice(ctrl.indexOf('[HttpPost("{id}/cancel")]'));
      expect(cancelBlock).toMatch(/\[ProducesResponseType\(typeof\(ProblemDetails\), 403\)\]/);
      const touchBlock = ctrl
        .slice(ctrl.indexOf('[HttpPost("{id}/touch")]'))
        .slice(0, ctrl.slice(ctrl.indexOf('[HttpPost("{id}/touch")]')).indexOf("public async"));
      expect(touchBlock).not.toMatch(/403/);
      // The guarded workflow controller also declares 403.
      const wfCtrl = files.get("Api/OrdersWorkflowsController.cs")!;
      expect(wfCtrl).toMatch(/\[ProducesResponseType\(typeof\(ProblemDetails\), 403\)\]/);
    });

    it("does NOT emit Auth/* files when the deployable has no `auth: required`", async () => {
      const files = await emitForAuthSystem(SRC_NO_AUTH);
      const keys = [...files.keys()];
      expect(keys).not.toContain("Auth/User.cs");
      expect(keys).not.toContain("Auth/UserMiddleware.cs");
    });

    it("Program.cs mounts UseMiddleware<UserMiddleware> between UseSwagger and MapControllers", async () => {
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      const program = files.get("Program.cs")!;
      expect(program).toMatch(/app\.UseMiddleware<UserMiddleware>\(\);/);
      const sw = program.indexOf("UseSwagger(");
      const mw = program.indexOf("UseMiddleware<UserMiddleware>");
      const mc = program.indexOf("MapControllers()");
      expect(sw).toBeGreaterThan(0);
      expect(mw).toBeGreaterThan(sw);
      expect(mc).toBeGreaterThan(mw);
    });

    it("UserMiddleware bypasses /health, /openapi.json, /swagger", async () => {
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      const mw = files.get("Auth/UserMiddleware.cs")!;
      expect(mw).toMatch(/"\/health"/);
      expect(mw).toMatch(/"\/openapi\.json"/);
      expect(mw).toMatch(/"\/swagger"/);
    });

    it("aggregate operation referencing currentUser gains a User parameter and the handler injects ICurrentUserAccessor", async () => {
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      const order = files.get("Domain/Orders/Order.cs")!;
      // Operation method takes the User param.
      expect(order).toMatch(/public void Cancel\(User currentUser\)/);
      // Body references currentUser.Role pascal-cased.
      expect(order).toMatch(/currentUser\.Role/);
      // Handler injects accessor and passes _currentUser.User.
      const handler = files.get("Application/Orders/Commands/CancelHandler.cs")!;
      expect(handler).toMatch(/ICurrentUserAccessor _currentUser/);
      expect(handler).toMatch(/aggregate\.Cancel\(_currentUser\.User\)/);
    });

    it("auth convergence: principal rides the ambient RequestContext (one source of truth)", async () => {
      // The principal is no longer stashed on HttpContext.Items — it is a
      // slice of the ambient RequestContext.  UserMiddleware writes the
      // frame; the accessor (a thin facade) reads it.  See
      // docs/architecture/request-context.md.
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      // Carrier emitted with the CurrentUser slice (auth) and no Logger
      // slice (trace off in this helper).
      const rc = files.get("Domain/Common/RequestContext.cs")!;
      expect(rc).toMatch(/public sealed class RequestContext/);
      expect(rc).toMatch(/public User\? CurrentUser \{ get; set; \}/);
      expect(rc).not.toMatch(/public ILogger\? Logger/);
      // A child frame inherits the principal, so the accessor still resolves
      // currentUser once a Mediator dispatch opens a child under the root.
      expect(rc).toMatch(/CurrentUser = parent\.CurrentUser,/);
      // Boundary middleware emitted and mounted FIRST — before the request
      // log, which is before user verification.
      expect(files.has("Middleware/RequestContextMiddleware.cs")).toBe(true);
      const program = files.get("Program.cs")!;
      const rcm = program.search(/UseMiddleware<[^>]*RequestContextMiddleware>/);
      const rlm = program.search(/UseMiddleware<[^>]*RequestLoggingMiddleware>/);
      const um = program.search(/UseMiddleware<UserMiddleware>/);
      expect(rcm).toBeGreaterThan(-1);
      expect(rcm).toBeLessThan(rlm);
      expect(rlm).toBeLessThan(um);
      // UserMiddleware writes the frame; no HttpContext.Items channel.
      const mw = files.get("Auth/UserMiddleware.cs")!;
      expect(mw).toMatch(/rc\.CurrentUser = user;/);
      expect(mw).not.toMatch(/Items\["currentUser"\]/);
      // The accessor reads the frame — no IHttpContextAccessor dependency.
      const acc = files.get("Auth/HttpContextCurrentUserAccessor.cs")!;
      expect(acc).toMatch(/RequestContext\.Current/);
      expect(acc).toMatch(/return rc\.CurrentUser/);
      expect(acc).not.toMatch(/IHttpContextAccessor/);
    });

    it("system-mode forwards --trace through the platform surface (emitTrace not dropped)", async () => {
      // Guards the platform/dotnet.ts emitProject forward: before the fix
      // emitTrace was never threaded into the generator in system mode, so
      // the trace artefacts silently vanished off the product path (only
      // the legacy single-context generate entry exercised --trace).
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(SRC_AUTH_REQUIRED, { validation: true });
      const { lowerModel } = await import("../../../src/ir/lower/lower.js");
      const { enrichLoomModel } = await import("../../../src/ir/enrich/enrichments.js");
      const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
      const sys = loom.systems[0]!;
      const dep = sys.deployables.find((d) => d.platform === "dotnet")!;
      const contexts = sys.subdomains.flatMap((m) => m.contexts);
      const platform = (await import("../../../src/platform/dotnet.js")).default;
      const files = platform.emitProject({ contexts, deployable: dep, sys, emitTrace: true });
      expect(files.has("Application/Common/ExecutionContextBehavior.cs")).toBe(true);
      expect(files.has("Domain/Common/DomainLog.cs")).toBe(true);
      // With auth AND trace, the carrier carries both slices.
      const rc = files.get("Domain/Common/RequestContext.cs")!;
      expect(rc).toMatch(/public User\? CurrentUser/);
      expect(rc).toMatch(/public ILogger\? Logger/);
    });

    // -----------------------------------------------------------------------
    // currentUser inside find / view filters
    // -----------------------------------------------------------------------

    const SRC_FILTER_AUTH = `
      system Acme {
        user {
          id: string
          customerId: string
        }
        subdomain Sales {
          context Orders {
            aggregate Order {
              customerId: string
              status: string
            }
            repository Orders for Order {
              find mine(): Order[] where customerId == currentUser.customerId
            }
            view MyOrders = Order where customerId == currentUser.customerId
          }
        }
        deployable api {
          platform: dotnet
          contexts: [Orders]
          port: 8080
          auth: required
        }
      }
    `;

    it("repository find filter on currentUser threads User through interface + impl", async () => {
      const files = await emitForAuthSystem(SRC_FILTER_AUTH);
      const iface = files.get("Domain/Orders/IOrderRepository.cs")!;
      const impl = files.get("Infrastructure/Repositories/OrderRepository.cs")!;
      // Both the interface and impl gain a User-typed parameter on the find.
      expect(iface).toMatch(/Mine\(User currentUser/);
      expect(impl).toMatch(/Mine\(User currentUser/);
      // The Auth namespace is pulled in.
      expect(iface).toMatch(/using Api\.Auth;/);
      expect(impl).toMatch(/using Api\.Auth;/);
      // The LINQ predicate closes over currentUser by referencing
      // its Pascal-cased CustomerId property.
      expect(impl).toMatch(/x\.CustomerId == currentUser\.CustomerId/);
    });

    it("find query handler injects ICurrentUserAccessor and passes _currentUser.User", async () => {
      const files = await emitForAuthSystem(SRC_FILTER_AUTH);
      const handler = files.get("Application/Orders/Queries/MineHandler.cs")!;
      expect(handler).toMatch(/ICurrentUserAccessor _currentUser/);
      expect(handler).toMatch(/_repo\.Mine\(_currentUser\.User, cancellationToken\)/);
    });

    it("view handler injects ICurrentUserAccessor when the view filter uses currentUser", async () => {
      const files = await emitForAuthSystem(SRC_FILTER_AUTH);
      const handler = files.get("Application/Views/MyOrdersHandler.cs")!;
      expect(handler).toMatch(/ICurrentUserAccessor _currentUser/);
      expect(handler).toMatch(/_repo\.MyOrders\(_currentUser\.User, cancellationToken\)/);
    });

    // -----------------------------------------------------------------------
    // `requires` clauses
    // -----------------------------------------------------------------------

    const SRC_REQUIRES = `
      system Acme {
        user {
          id: string
          role: string
        }
        subdomain Sales {
          context Orders {
            aggregate Order {
              status: string
              operation cancel() {
                requires currentUser.role == "manager"
                status := "cancelled"
              }
            }
            repository Orders for Order { }
          }
        }
        deployable api {
          platform: dotnet
          contexts: [Orders]
          port: 8080
          auth: required
        }
      }
    `;

    it("`requires` lowers to a ForbiddenException throw inside the operation method", async () => {
      const files = await emitForAuthSystem(SRC_REQUIRES);
      const order = files.get("Domain/Orders/Order.cs")!;
      expect(order).toMatch(/throw new ForbiddenException\(/);
      // The `precondition` 400-mapping path stays distinct.
      expect(order).not.toMatch(/throw new DomainException\([^)]*Forbidden/);
    });

    it("DomainExceptionFilter maps ForbiddenException to 403", async () => {
      const files = await emitForAuthSystem(SRC_REQUIRES);
      const filter = files.get("Api/DomainExceptionFilter.cs")!;
      expect(filter).toMatch(/is ForbiddenException/);
      expect(filter).toMatch(/Problem\(context, 403, "Forbidden", fe\.Message, trace_id\)/);
    });

    it("Domain.Common emits ForbiddenException", async () => {
      const files = await emitForAuthSystem(SRC_REQUIRES);
      const common = files.get("Domain/Common/DomainException.cs")!;
      expect(common).toMatch(/public sealed class ForbiddenException/);
    });
  });

  // -------------------------------------------------------------------
  // wire-boundary validation on the .NET side.
  // -------------------------------------------------------------------
  describe("FluentValidation pipeline", () => {
    it("emits an AbstractValidator per command with single-field invariants", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      // sales.ddd Customer: `invariant email.length > 0` →
      // `RuleFor(x => x.Email).MinimumLength(1)`.
      const customerCreate = files.get(
        "Application/Customers/Commands/CreateCustomerCommandValidator.cs",
      )!;
      expect(customerCreate).toMatch(
        /public sealed class CreateCustomerCommandValidator : AbstractValidator<CreateCustomerCommand>/,
      );
      expect(customerCreate).toMatch(/RuleFor\(x => x\.Email\)\.MinimumLength\(1\)/);
      expect(customerCreate).toMatch(/using FluentValidation;/);
    });

    it("emits an AbstractValidator per public op with single-field preconditions", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      // sales.ddd Order.addLine: `precondition qty > 0` (int qty).
      // The `isMutable()` precondition references a helper-fn — non-
      // translatable, so it doesn't appear here.
      const addLine = files.get("Application/Orders/Commands/AddLineCommandValidator.cs")!;
      expect(addLine).toMatch(/RuleFor\(x => x\.Qty\)\.GreaterThanOrEqualTo\(1\)/);
      // No rule for `isMutable()` — domain-only.
      expect(addLine).not.toMatch(/IsMutable/);
    });

    it("does NOT emit a validator file when no rules apply", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      // Order.confirm() has only server-only preconditions
      // (`isMutable()` + `lines.count > 0`) — no validator file.
      expect(files.has("Application/Orders/Commands/ConfirmCommandValidator.cs")).toBe(false);
    });

    it("does NOT emit a validator for invariants referencing aggregate state", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      // Order has only the cross-aggregate-state invariant
      // `lines.count > 0 when status == Confirmed` — non-
      // translatable.  Product (in sales.ddd) has no invariants
      // either.  CreateOrder has no validator file.
      expect(files.has("Application/Orders/Commands/CreateOrderCommandValidator.cs")).toBe(false);
    });

    it("emits the generic ValidationBehavior pipeline class", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const behavior = files.get("Application/Common/ValidationBehavior.cs")!;
      expect(behavior).toMatch(
        /public sealed class ValidationBehavior<TRequest, TResponse>\s*:\s*IPipelineBehavior<TRequest, TResponse>/,
      );
      expect(behavior).toMatch(/throw new ValidationException\(failures\)/);
    });

    it("Program.cs registers AddValidatorsFromAssembly + ValidationBehavior", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const program = files.get("Program.cs")!;
      expect(program).toMatch(
        /builder\.Services\.AddValidatorsFromAssembly\(typeof\(Program\)\.Assembly\);/,
      );
      expect(program).toMatch(
        /builder\.Services\.AddScoped\(\s*typeof\(Mediator\.IPipelineBehavior<,>\),\s*typeof\(\w+\.Application\.Common\.ValidationBehavior<,>\)\);/,
      );
    });

    it("csproj pulls FluentValidation NuGet refs when validators exist", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const csprojKey = [...files.keys()].find((k) => k.endsWith(".csproj"))!;
      const csproj = files.get(csprojKey)!;
      expect(csproj).toMatch(/<PackageReference Include="FluentValidation" Version="11\.10\.0"/);
      expect(csproj).toMatch(
        /<PackageReference Include="FluentValidation\.DependencyInjectionExtensions"/,
      );
    });

    it("DomainExceptionFilter has a FluentValidation.ValidationException arm", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const filter = files.get("Api/DomainExceptionFilter.cs")!;
      expect(filter).toMatch(/is FluentValidation\.ValidationException fv/);
      // Envelope: RFC 7807 ProblemDetails with the §3.2 `errors[]`
      // extension carried on `Extensions["errors"]`, status 422.
      // Shape matches Hono's defaultHook so the frontend ACL's
      // `applyServerErrors` works against either backend.  See
      // docs/proposals/validation-error-extension.md.
      expect(filter).toMatch(/Title = "Validation failed"/);
      expect(filter).toMatch(/Status = 422/);
      expect(filter).toMatch(/problem\.Extensions\["errors"\] = fv\.Errors/);
      expect(filter).toMatch(
        /new \{ pointer = PointerOf\(e\.PropertyName\), message = e\.ErrorMessage \}/,
      );
      expect(filter).toMatch(/StatusCode = 422/);
      expect(filter).toMatch(/ContentTypes = \{ "application\/problem\+json" \}/);
      // The PointerOf helper encodes RFC 6901 JSON pointers — see the
      // validation-error-extension.test.ts file for the dedicated
      // assertions on its emitted source.
      expect(filter).toMatch(/private static string PointerOf\(string propertyName\)/);
    });

    it("skips the FluentValidation gate entirely when no aggregate has wire-translatable invariants", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
          context Plain {
            aggregate Note {
              title: string
              derived display: string = title
              body:  string
            }
            repository Notes for Note { }
          }
        `,
        { validation: true },
      );
      const files = generateDotnet(doc.parseResult.value as Model);
      // No validator files.
      expect([...files.keys()].some((k) => k.endsWith("CommandValidator.cs"))).toBe(false);
      // No ValidationBehavior either.
      expect(files.has("Application/Common/ValidationBehavior.cs")).toBe(false);
      // csproj omits FluentValidation refs.
      const csprojKey = [...files.keys()].find((k) => k.endsWith(".csproj"))!;
      expect(files.get(csprojKey)!).not.toMatch(/FluentValidation/);
      // Filter omits the FluentValidation arm.
      expect(files.get("Api/DomainExceptionFilter.cs")!).not.toMatch(
        /FluentValidation\.ValidationException/,
      );
      // Program.cs doesn't register the pipeline.
      expect(files.get("Program.cs")!).not.toMatch(/AddValidatorsFromAssembly/);
    });

    it("absorbs `string.matches(literal)` as `RuleFor(x => x.F).Matches(...)`", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
          context Auth {
            aggregate User {
              email: string
              derived display: string = email
              invariant email.matches("^[^@]+@.+$")
              create(email: string) { email := email }
            }
            repository Users for User { }
          }
        `,
        { validation: true },
      );
      const files = generateDotnet(doc.parseResult.value as Model);
      const v = files.get("Application/Users/Commands/CreateUserCommandValidator.cs")!;
      expect(v).toMatch(/RuleFor\(x => x\.Email\)\.Matches\("\^\[\^@\]\+@\.\+\$"\)/);
    });

    it("renders `matches` in domain code as `Regex.IsMatch`", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
          context Auth {
            aggregate User {
              email: string
              derived display: string = email
              invariant email.matches("^[^@]+@.+$")
            }
            repository Users for User { }
          }
        `,
        { validation: true },
      );
      const files = generateDotnet(doc.parseResult.value as Model);
      const userClass = files.get("Domain/Users/User.cs")!;
      // The same predicate appears in AssertInvariants (the floor).
      expect(userClass).toMatch(/Regex\.IsMatch\(this\.Email, "\^\[\^@\]\+@\.\+\$"\)/);
    });

    it("`private invariant` is skipped from FluentValidation but stays in domain", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
          context Acct {
            aggregate User {
              username: string
              derived display: string = username
              private invariant username.length >= 3
            }
            repository Users for User { }
          }
        `,
        { validation: true },
      );
      const files = generateDotnet(doc.parseResult.value as Model);
      // No validator file for CreateUserCommand — the only rule is
      // server-only and the single-field gate filters it out.
      expect(files.has("Application/Users/Commands/CreateUserCommandValidator.cs")).toBe(false);
      // But the domain `AssertInvariants` still enforces it.
      const userClass = files.get("Domain/Users/User.cs")!;
      expect(userClass).toMatch(/this\.Username\.Length >= 3/);
    });

    it("emits cross-field invariants as `RuleFor(x => x).Must(...)` with `.WithName`", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
          context Shop {
            aggregate Reservation {
              fromTime: int
              toTime:   int
              invariant fromTime < toTime
              create(fromTime: int, toTime: int) { fromTime := fromTime  toTime := toTime }
            }
            repository Reservations for Reservation { }
          }
        `,
        { validation: true },
      );
      const files = generateDotnet(doc.parseResult.value as Model);
      const v = files.get(
        "Application/Reservations/Commands/CreateReservationCommandValidator.cs",
      )!;
      // Cross-field rule lowers to a Must predicate.
      expect(v).toMatch(/RuleFor\(x => x\)\.Must\(x => x\.FromTime < x\.ToTime\)/);
      // Field-path attribution.
      expect(v).toMatch(/\.WithName\("FromTime"\)/);
      expect(v).toMatch(/\.WithMessage\("Invariant violated:[^"]+"\)/);
    });
  });

  describe("reference-collection join tables (.NET)", () => {
    // Mirrors `test/generator/join-table.test.ts` (TS/Hono).  Pins the
    // .NET emission seams: join entity + configuration, DbContext
    // wiring, `builder.Ignore` on the aggregate, internal setter, repository
    // load + save diff-sync, and the `this.<refColl>.contains(...)`
    // → subquery lowering.

    it("emits a join entity + EF configuration per Id<T>[] field", async () => {
      const model = await buildModel("examples/roster.ddd");
      const files = generateDotnet(model);
      // Join entity class shape — one per association.
      const tp = files.get("Infrastructure/Persistence/JoinTables/TrainerParty.cs")!;
      expect(tp).toMatch(/public sealed class TrainerParty/);
      expect(tp).toMatch(/public TrainerId TrainerId \{ get; set; \}/);
      expect(tp).toMatch(/public PokemonId PokemonId \{ get; set; \}/);
      // `Id<T>[]` is a set (membership only, no order): the composite
      // (owner, target) PK is the whole row — no Ordinal payload property.
      expect(tp).not.toMatch(/Ordinal/);
      expect(files.has("Infrastructure/Persistence/JoinTables/TrainerCaught.cs")).toBe(true);
      // EF configuration: composite PK + index on target FK + HasConversion on both ids.
      const cfg = files.get(
        "Infrastructure/Persistence/Configurations/TrainerPartyConfiguration.cs",
      )!;
      expect(cfg).toMatch(/builder\.ToTable\("trainer_party"\)/);
      expect(cfg).toMatch(/builder\.HasKey\(x => new \{ x\.TrainerId, x\.PokemonId \}\)/);
      expect(cfg).toMatch(/builder\.HasIndex\(x => x\.PokemonId\)/);
      expect(cfg).toMatch(/HasConversion\(v => v\.Value, v => new TrainerId\(v\)\)/);
      expect(cfg).toMatch(/HasConversion\(v => v\.Value, v => new PokemonId\(v\)\)/);
    });

    it("DbContext exposes a DbSet per join entity and applies its configuration", async () => {
      const model = await buildModel("examples/roster.ddd");
      const files = generateDotnet(model);
      const ctx = files.get("Infrastructure/Persistence/AppDbContext.cs")!;
      expect(ctx).toMatch(/public DbSet<TrainerParty> TrainerParties => Set<TrainerParty>\(\);/);
      expect(ctx).toMatch(/public DbSet<TrainerCaught> TrainerCaughts => Set<TrainerCaught>\(\);/);
      expect(ctx).toMatch(
        /ApplyConfiguration\(new Configurations\.TrainerPartyConfiguration\(\)\)/,
      );
    });

    it("ignores ref-collection properties on the owning aggregate's configuration", async () => {
      const model = await buildModel("examples/roster.ddd");
      const files = generateDotnet(model);
      const trainerCfg = files.get(
        "Infrastructure/Persistence/Configurations/TrainerConfiguration.cs",
      )!;
      // EF auto-mapping of List<PokemonId> as a JSON column would defeat
      // the relational join — explicit Ignore is the load-bearing line.
      expect(trainerCfg).toMatch(/builder\.Ignore\(x => x\.Party\)/);
      expect(trainerCfg).toMatch(/builder\.Ignore\(x => x\.Caught\)/);
    });

    it("widens the entity's ref-collection setters to internal for repo hydration", async () => {
      const model = await buildModel("examples/roster.ddd");
      const files = generateDotnet(model);
      const trainer = files.get("Domain/Trainers/Trainer.cs")!;
      expect(trainer).toMatch(/public List<PokemonId> Party \{ get; internal set; \}/);
      expect(trainer).toMatch(/public List<PokemonId> Caught \{ get; internal set; \}/);
    });

    it("repository GetByIdAsync hydrates ref collections ordered by the target FK id", async () => {
      const model = await buildModel("examples/roster.ddd");
      const files = generateDotnet(model);
      const repo = files.get("Infrastructure/Repositories/TrainerRepository.cs")!;
      expect(repo).toMatch(
        /found\.Party = await _db\.TrainerParties\s+\.Where\(j => j\.TrainerId == id\)\s+\.OrderBy\(j => j\.PokemonId\)\s+\.Select\(j => j\.PokemonId\)\s+\.ToListAsync\(cancellationToken\);/,
      );
      expect(repo).toMatch(/found\.Caught = await _db\.TrainerCaughts/);
    });

    it("repository SaveAsync diff-syncs join rows by membership (no ordinal)", async () => {
      const model = await buildModel("examples/roster.ddd");
      const files = generateDotnet(model);
      const repo = files.get("Infrastructure/Repositories/TrainerRepository.cs")!;
      // Delete removed pairs.
      expect(repo).toMatch(/_db\.TrainerParties\.Remove\(__stale\)/);
      // Set semantics: add the pair only when absent; no Ordinal anywhere.
      expect(repo).not.toMatch(/Ordinal/);
      expect(repo).toMatch(/if \(!__existingParty\.Any\(x => x\.PokemonId == __tid\)\)/);
      expect(repo).toMatch(/_db\.TrainerParties\.Add\(new TrainerParty\(aggregate\.Id, __tid\)\)/);
    });

    it("lowers `this.<refColl>.contains(param)` to a join-table subquery", async () => {
      const model = await buildModel("examples/roster.ddd");
      const files = generateDotnet(model);
      const repo = files.get("Infrastructure/Repositories/TrainerRepository.cs")!;
      // The membership filter is admitted by the IR validator and
      // lowered here to an EXISTS-style subquery against the join entity.
      expect(repo).toMatch(
        /_db\.Trainers\.Where\(x => _db\.TrainerParties\.Any\(__j => __j\.TrainerId == x\.Id && __j\.PokemonId == pokemon\)\)/,
      );
    });
  });
});
