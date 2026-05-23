import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../src/generator/dotnet/index.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

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
    expect(dockerfile).toMatch(/FROM mcr\.microsoft\.com\/dotnet\/sdk:8\.0 AS build/);
    expect(dockerfile).toMatch(/FROM mcr\.microsoft\.com\/dotnet\/aspnet:8\.0 AS runtime/);
    expect(dockerfile).toMatch(/ENTRYPOINT \["dotnet", "Sales\.dll"\]/);
    const dockerignore = files.get(".dockerignore")!;
    expect(dockerignore).toMatch(/\*\*\/bin/);
  });

  it("wires Swashbuckle so /swagger/v1/swagger.json is exposed", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const csproj = files.get("Sales.csproj")!;
    expect(csproj).toMatch(/<PackageReference Include="Swashbuckle\.AspNetCore"/);
    const program = files.get("Program.cs")!;
    expect(program).toMatch(/AddSwaggerGen/);
    expect(program).toMatch(/UseSwagger/);
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
      expect(program).toMatch(/db\.Database\.CanConnectAsync\(ct\)/);
      // 503 with a structured body on failure.
      expect(program).toMatch(/status = "not_ready"/);
      expect(program).toMatch(/statusCode: 503/);
    });

    it("Program.cs registers ApplicationStopping for graceful shutdown logging", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const program = files.get("Program.cs")!;
      expect(program).toMatch(/IHostApplicationLifetime/);
      expect(program).toMatch(/ApplicationStopping\.Register/);
      expect(program).toMatch(/Shutting down/);
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
    });

    it("DomainExceptionFilter threads Activity.TraceId into every error envelope", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const filter = files.get("Api/DomainExceptionFilter.cs")!;
      // trace_id pulled off the ambient Activity (set by ASP.NET on
      // every request).  Empty string when no Activity is active.
      expect(filter).toMatch(
        /var trace_id = System\.Diagnostics\.Activity\.Current\?\.TraceId\.ToString\(\) \?\? "";/,
      );
      // Every arm of the filter includes trace_id in its envelope.
      expect(filter).toMatch(/error = fe\.Message, trace_id/);
      expect(filter).toMatch(/error = de\.Message, trace_id/);
      expect(filter).toMatch(/error = nf\.Message, trace_id/);
      expect(filter).toMatch(/error = xh\.Message, trace_id/);
      expect(filter).toMatch(/error = "internal", trace_id/);
    });
  });

  it("auto-includes a GET /<plural> find via the `all` repository method", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const controller = files.get("Api/OrdersController.cs")!;
    // [HttpGet] (root) — followed by an All(...) action.
    expect(controller).toMatch(/\[HttpGet\][\s\S]*?All\(/);
    const repoIface = files.get("Domain/Orders/IOrderRepository.cs")!;
    expect(repoIface).toMatch(/List<Order>[\s\S]*?All\(/);
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
    expect(cfg).toMatch(/b\.HasIndex\(x => x\.CustomerId\)/);
    expect(cfg).toMatch(/b\.HasIndex\(x => x\.Status\)/);
  });

  it("emits an IXAggHandler interface + Scrutor scan for extern operations", async () => {
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

    // 1. The user-implementable handler interface lives under
    //    Application/<Aggregate>/Handlers/.
    const iface = files.get("Application/Orders/Handlers/IConfirmOrderHandler.cs")!;
    expect(iface).toMatch(
      /Task HandleAsync\(Order aggregate, ConfirmRequest request, CancellationToken ct\)/,
    );

    // 2. The auto Mediator handler injects the user interface and
    //    delegates: load → CheckX → user.HandleAsync → invariants → save.
    const handler = files.get("Application/Orders/Commands/ConfirmHandler.cs")!;
    expect(handler).toMatch(/private readonly IConfirmOrderHandler _user;/);
    expect(handler).toMatch(/aggregate\.CheckConfirm\(\);/);
    expect(handler).toMatch(/await _user\.HandleAsync\(aggregate, request, ct\);/);
    expect(handler).toMatch(/aggregate\.AssertInvariants\(\);/);
    // No direct call to a non-existent `aggregate.Confirm()` method.
    expect(handler).not.toMatch(/aggregate\.Confirm\(/);

    // 3. The aggregate exposes RaiseEvent + AssertInvariants as internal
    //    and widens setters to `internal set` so [ExternHandler] classes
    //    in the same assembly can mutate state.
    const order = files.get("Domain/Orders/Order.cs")!;
    expect(order).toMatch(/internal void RaiseEvent\(IDomainEvent ev\) =>/);
    expect(order).toMatch(/internal void AssertInvariants\(\)/);
    expect(order).toMatch(/public OrderStatus Status \{ get; internal set; \}/);
    expect(order).toMatch(/public void CheckConfirm\(\)/);
    expect(order).not.toMatch(/public void Confirm\(\)/);

    // 4. Common code declares the [ExternHandler] attribute (no Loom
    //    name leaks into the user-facing surface).
    const common = files.get("Domain/Common/DomainException.cs")!;
    expect(common).toMatch(/public sealed class ExternHandlerAttribute : Attribute/);
    expect(common).not.toMatch(/Loom/);

    // 5. Program.cs registers Scrutor + verifies the handler is wired.
    const program = files.get("Program.cs")!;
    expect(program).toMatch(/builder\.Services\.Scan\(s => s/);
    expect(program).toMatch(/WithAttribute<ExternHandlerAttribute>/);
    expect(program).toMatch(/IConfirmOrderHandler.*is null/s);
    expect(program).toMatch(/Missing \[ExternHandler\] for/);

    // 6. csproj brings in Scrutor.
    const csproj = files.get("Sales.csproj")!;
    expect(csproj).toMatch(/<PackageReference Include="Scrutor"/);
  });

  describe("extern handler exception envelope", () => {
    it("Domain.Common declares ExternHandlerException with op + agg fields", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model);
      const common = files.get("Domain/Common/DomainException.cs")!;
      expect(common).toMatch(/public sealed class ExternHandlerException : System\.Exception/);
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
      // ExternHandlerException arm exists and lands on 500.
      expect(filter).toMatch(/context\.Exception is ExternHandlerException xh/);
      expect(filter).toMatch(/error = xh\.Message/);
      expect(filter).toMatch(/StatusCode = 500/);
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

    it("--trace on: emits DomainLog accessor + DomainLogBehavior + domain trace injections", async () => {
      // Phase 8 .NET domain-trace v1 — mirrors Hono Phase 6.  Aggregate
      // methods can't take ILogger via constructor (they're POCO
      // entities, not DI-managed), so the compile-time --trace
      // switch emits a Domain/Common/DomainLog.cs static accessor
      // backed by AsyncLocal<ILogger?>, a Mediator pipeline behavior
      // that sets it per command/query from the request-scoped
      // logger, and renders trace lines through DomainLog.LogTrace
      // at the catalog's domain seams (value_computed after every
      // scalar assign; precondition_evaluated as a bound-temp wrap).
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model, { emitTrace: true });

      // 1. Accessor + behavior emitted.
      const log = files.get("Domain/Common/DomainLog.cs")!;
      expect(log).toMatch(/public static class DomainLog/);
      expect(log).toMatch(/AsyncLocal<ILogger\?>/);
      expect(log).toMatch(/public static void LogTrace\(string template, params object\[\] args\)/);

      const behavior = files.get("Application/Common/DomainLogBehavior.cs")!;
      expect(behavior).toMatch(/IPipelineBehavior<TMessage, TResponse>/);
      expect(behavior).toMatch(/DomainLog\.Current = _log;/);
      // Restores the previous value on exit so reentrant Send calls
      // stack cleanly.
      expect(behavior).toMatch(/var prev = DomainLog\.Current;/);
      expect(behavior).toMatch(/DomainLog\.Current = prev;/);

      // 2. Program.cs registers the pipeline behavior.
      const program = files.get("Program.cs")!;
      expect(program).toMatch(/typeof\(.+\.Application\.Common\.DomainLogBehavior<,>\)/);

      // 3. Aggregate ops get value_computed + precondition_evaluated.
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

    it("--trace off: domain layer stays free of DomainLog accessor + behavior + injections", async () => {
      // The whole point of the compile-time switch — off path emits
      // NOTHING domain-trace-related.  No DomainLog.cs, no behavior,
      // no Program.cs registration, no LogTrace calls in entities.
      const model = await buildModel("examples/sales.ddd");
      const files = generateDotnet(model); // no emitTrace
      expect(files.has("Domain/Common/DomainLog.cs")).toBe(false);
      expect(files.has("Application/Common/DomainLogBehavior.cs")).toBe(false);
      const program = files.get("Program.cs")!;
      expect(program).not.toMatch(/DomainLogBehavior/);
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
      // error: no element type to infer).
      expect(controller).toMatch(
        /_log\.LogTrace\("\{Event\} keys=\{Keys\}", "wire_in", System\.Array\.Empty<string>\(\)\);/,
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

      // Signature carries the __op param with the "<init>" default so
      // any external caller (extern handlers) can still invoke
      // AssertInvariants() without args.
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
      expect(repo).toMatch(/try\s*\n\s*\{[\s\S]+?catch \(System\.Exception __txErr\)/);
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
        /await _db\.SaveChangesAsync\(ct\);\n\s+_log\.LogDebug\("\{Event\} aggregate=\{Aggregate\} id=\{Id\}", "repository_save", "Order", aggregate\.Id\.Value\);/,
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

    it("extern command handler wraps user.HandleAsync in try/catch that rethrows ExternHandlerException", async () => {
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
      const handler = files.get("Application/Orders/Commands/ConfirmHandler.cs")!;
      // Try/catch wraps the user call.
      expect(handler).toMatch(/try\s*\{\s*await _user\.HandleAsync/);
      // Domain-layer exceptions re-throw unchanged so 400 / 403 /
      // 404 still apply when the user handler raises one
      // deliberately.
      expect(handler).toMatch(/catch \(DomainException\) \{ throw; \}/);
      expect(handler).toMatch(/catch \(ForbiddenException\) \{ throw; \}/);
      expect(handler).toMatch(/catch \(AggregateNotFoundException\) \{ throw; \}/);
      // Cancellation also re-throws so request cancellation isn't
      // misattributed as a handler failure.
      expect(handler).toMatch(/catch \(System\.OperationCanceledException\) \{ throw; \}/);
      // Any other exception wraps as ExternHandlerException with
      // the op + agg names baked in.
      expect(handler).toMatch(/throw new ExternHandlerException\("confirm", "Order", ex\);/);
    });
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
          name: string display
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
        workflow placeOrder(customerId: Customer id, amount: decimal, placedAt: datetime) {
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
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);

    // Request DTO uses wire types (Guid for X id, string for datetime).
    const req = files.get("Application/Workflows/PlaceOrderRequest.cs")!;
    expect(req).toMatch(
      /public sealed record PlaceOrderRequest\(Guid CustomerId, decimal Amount, string PlacedAt\)/,
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
    expect(handler).toMatch(/if \(!\(cmd\.Amount > 0\)\) throw new DomainException/);
    expect(handler).toMatch(
      /var customer = await _customers\.GetByIdAsync\(cmd\.CustomerId, ct\);/,
    );
    expect(handler).toMatch(/customer\.DeductCredit\(cmd\.Amount\);/);
    expect(handler).toMatch(
      /var order = Order\.Create\(CustomerId: cmd\.CustomerId, Status: OrderStatus\.Draft/,
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
    expect(ctrl).toMatch(
      /public async Task<IActionResult> PlaceOrder\(\[FromBody\] PlaceOrderRequest request\)/,
    );
    expect(ctrl).toMatch(/new PlaceOrderCommand\(\s*new CustomerId\(request\.CustomerId\)/);
  });

  it("emits a transactional workflow with BeginTransactionAsync + Commit + Rollback", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context T {
        aggregate Customer {
          name: string display
          creditLimit: decimal
          operation addCredit(amount: decimal) {
            precondition amount > 0
            creditLimit := creditLimit + amount
          }
        }
        repository Customers for Customer { }
        workflow topUp(customerId: Customer id, amount: decimal) transactional {
          precondition amount > 0
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);
    const handler = files.get("Application/Workflows/TopUpHandler.cs")!;
    expect(handler).toMatch(/private readonly T\.Infrastructure\.Persistence\.AppDbContext _db;/);
    expect(handler).toMatch(
      /await using var tx = await _db\.Database\.BeginTransactionAsync\(ct\);/,
    );
    expect(handler).toMatch(/await tx\.CommitAsync\(ct\);/);
    expect(handler).toMatch(/await tx\.RollbackAsync\(ct\);/);
    // Save inside the try block, before commit.
    const trySaveIdx = handler.indexOf("await _customers.SaveAsync(c, ct);");
    const commitIdx = handler.indexOf("await tx.CommitAsync(ct);");
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
      /public sealed record ActiveOrdersQuery\(\) : IQuery<System\.Collections\.Generic\.IReadOnlyList<OrderResponse>>/,
    );

    // 2. Handler injects IOrderRepository, calls _repo.ActiveOrders(ct),
    //    projects each domain row to OrderResponse via the canonical
    //    projection helper.
    const handler = files.get("Application/Views/ActiveOrdersHandler.cs")!;
    expect(handler).toMatch(/private readonly IOrderRepository _repo;/);
    expect(handler).toMatch(/await _repo\.ActiveOrders\(ct\);/);
    expect(handler).toMatch(/domain\.Select\(d => new OrderResponse\(/);

    // 3. The .NET repository interface + impl gained the view method
    //    (via the mergeViewsAsFinds synthesis).
    const iface = files.get("Domain/Orders/IOrderRepository.cs")!;
    expect(iface).toMatch(/Task<List<Order>> ActiveOrders\(/);
    const impl = files.get("Infrastructure/Repositories/OrderRepository.cs")!;
    expect(impl).toMatch(/public async Task<List<Order>> ActiveOrders\(/);
    expect(impl).toMatch(
      /_db\.Orders\.Where\(x => x\.Status == OrderStatus\.Confirmed\)\.ToListAsync\(ct\)/,
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

    // Wire-typed Row record (Order id → Guid, enum → string, int → int).
    const row = files.get("Application/Views/OrderSummaryRow.cs")!;
    expect(row).toMatch(
      /public sealed record OrderSummaryRow\(Guid OrderId, string Status, int LineCount\);/,
    );

    // Query returns IReadOnlyList<OrderSummaryRow>, not <Agg>Response.
    const query = files.get("Application/Views/OrderSummaryQuery.cs")!;
    expect(query).toMatch(/IQuery<System\.Collections\.Generic\.IReadOnlyList<OrderSummaryRow>>/);

    // Handler projects through projectToResponse (Id.Value, enum.ToString,
    // collection .Count via the bind renderer).
    const handler = files.get("Application/Views/OrderSummaryHandler.cs")!;
    expect(handler).toMatch(
      /domain\.Select\(d => new OrderSummaryRow\(d\.Id\.Value, d\.Status\.ToString\(\), d\.Lines\.Count\)\)\.ToList\(\)/,
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
        aggregate Customer { name: string display, email: string }
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
      /var customerById = \(await _customerRepo\.FindManyByIdsAsync\(domain\.Select\(d => d\.CustomerId\)\.ToList\(\), ct\)\)\.ToDictionary\(__a => __a\.Id\)/,
    );
    // Projection rewrites the Id-follow refs to dictionary lookups.
    expect(handler).toMatch(
      /new CustomerOrdersRow\(d\.Id\.Value, customerById\[d\.CustomerId\]\.Name, customerById\[d\.CustomerId\]\.Email, d\.Status\.ToString\(\)\)/,
    );

    // Repo interface + impl gained FindManyByIdsAsync.
    const iface = files.get("Domain/Customers/ICustomerRepository.cs")!;
    expect(iface).toMatch(
      /Task<System\.Collections\.Generic\.IReadOnlyList<Customer>> FindManyByIdsAsync/,
    );
    const impl = files.get("Infrastructure/Repositories/CustomerRepository.cs")!;
    expect(impl).toMatch(/_db\.Customers\.Where\(x => ids\.Contains\(x\.Id\)\)\.ToListAsync\(ct\)/);
  });

  it("workflow op-call to a parameterless extern emits the dispatch dance", async () => {
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
        workflow placeAndConfirm(orderId: Order id) {
          let order = Orders.getById(orderId)
          order.confirm()
        }
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);
    const handler = files.get("Application/Workflows/PlaceAndConfirmHandler.cs")!;

    // IConfirmOrderHandler is injected.
    expect(handler).toMatch(/private readonly IConfirmOrderHandler _confirmOrderHandler;/);
    // Usings cover the handler interface + request namespaces.
    expect(handler).toMatch(/using Sales\.Application\.Orders\.Handlers;/);
    expect(handler).toMatch(/using Sales\.Application\.Orders\.Requests;/);
    // Body: CheckConfirm → new ConfirmRequest → user.HandleAsync → AssertInvariants.
    expect(handler).toMatch(/order\.CheckConfirm\(\);/);
    expect(handler).toMatch(/var __confirmRequest = new ConfirmRequest\(\);/);
    expect(handler).toMatch(
      /await _confirmOrderHandler\.HandleAsync\(order, __confirmRequest, ct\);/,
    );
    expect(handler).toMatch(/order\.AssertInvariants\(\);/);
    // Save still happens at workflow exit.
    expect(handler).toMatch(/await _orders\.SaveAsync\(order, ct\);/);
  });

  it("auto Mediator handler for parameterized extern wraps domain args via domainToRequestExpr", async () => {
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
      /var request = new AddLineRequest\(cmd\.ProductId\.Value, cmd\.Qty, new MoneyRequest\(cmd\.Price\.Amount, cmd\.Price\.Currency\)\);/,
    );
  });

  it("workflow op-call to parameterized extern emits the dispatch dance with domain→wire conversion", async () => {
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
        workflow chargeOrder(orderId: Order id, amount: decimal) {
          let order = Orders.getById(orderId)
          order.deduct(amount)
        }
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);
    const handler = files.get("Application/Workflows/ChargeOrderHandler.cs")!;
    expect(handler).toMatch(/order\.CheckDeduct\(cmd\.Amount\);/);
    expect(handler).toMatch(/var __deductRequest = new DeductRequest\(cmd\.Amount\);/);
    expect(handler).toMatch(
      /await _deductOrderHandler\.HandleAsync\(order, __deductRequest, ct\);/,
    );
  });

  it("multi-hop X id.Y id.field follow loads aggregates in dependency order", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Region { name: string display, countryCode: string }
        aggregate Customer { name: string display, regionId: Region id }
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
      /var customerById = \(await _customerRepo\.FindManyByIdsAsync\(domain\.Select\(d => d\.CustomerId\)\.ToList\(\), ct\)\)\.ToDictionary\(__a => __a\.Id\);/,
    );
    expect(handler).toMatch(
      /var regionByCustomerId = \(await _regionRepo\.FindManyByIdsAsync\(customerById\.Values\.Select\(__a => __a\.RegionId\)\.ToList\(\), ct\)\)\.ToDictionary\(__a => __a\.Id\);/,
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
          name: string display
          creditLimit: decimal
          operation addCredit(amount: decimal) {
            precondition amount > 0
            creditLimit := creditLimit + amount
          }
        }
        repository Customers for Customer { }
        workflow ser(customerId: Customer id, amount: decimal) transactional(serializable) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
        workflow rr(customerId: Customer id, amount: decimal) transactional(repeatableRead) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
        workflow ru(customerId: Customer id, amount: decimal) transactional(readUncommitted) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
        workflow rc(customerId: Customer id, amount: decimal) transactional(readCommitted) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
        workflow plain(customerId: Customer id, amount: decimal) transactional {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
      }
    `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);
    expect(files.get("Application/Workflows/SerHandler.cs")!).toMatch(
      /BeginTransactionAsync\(System\.Data\.IsolationLevel\.Serializable, ct\)/,
    );
    expect(files.get("Application/Workflows/RrHandler.cs")!).toMatch(
      /BeginTransactionAsync\(System\.Data\.IsolationLevel\.RepeatableRead, ct\)/,
    );
    expect(files.get("Application/Workflows/RuHandler.cs")!).toMatch(
      /BeginTransactionAsync\(System\.Data\.IsolationLevel\.ReadUncommitted, ct\)/,
    );
    expect(files.get("Application/Workflows/RcHandler.cs")!).toMatch(
      /BeginTransactionAsync\(System\.Data\.IsolationLevel\.ReadCommitted, ct\)/,
    );
    // Bare `transactional` doesn't pass an explicit level.
    const plain = files.get("Application/Workflows/PlainHandler.cs")!;
    expect(plain).toMatch(/BeginTransactionAsync\(ct\)/);
    expect(plain).not.toMatch(/IsolationLevel/);
  });

  it("DomainExceptionFilter catches unhandled exceptions as sanitized 500", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const filter = files.get("Api/DomainExceptionFilter.cs")!;
    expect(filter).toMatch(/ILogger<DomainExceptionFilter>/);
    expect(filter).toMatch(/StatusCode = 500/);
    expect(filter).toMatch(/error = "internal"/);
    // Domain-specific paths still mapped.
    expect(filter).toMatch(/BadRequestObjectResult/);
    expect(filter).toMatch(/NotFoundObjectResult/);
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
      const { lowerModel } = await import("../../src/ir/lower.js");
      const { enrichLoomModel } = await import("../../src/ir/enrichments.js");
      const { generateDotnetForContexts } = await import("../../src/generator/dotnet/index.js");
      const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
      const sys = loom.systems[0]!;
      const dep = sys.deployables.find((d) => d.platform === "dotnet")!;
      const contexts = sys.modules.flatMap((m) => m.contexts);
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
        module Sales {
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
          modules: Sales
          port: 8080
          auth: required
        }
      }
    `;

    const SRC_NO_AUTH = `
      system Acme {
        user { id: string }
        module Sales {
          context Orders {
            aggregate Order { customerId: string }
            repository Orders for Order { }
          }
        }
        deployable api {
          platform: dotnet
          modules: Sales
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
      const sw = program.indexOf("UseSwagger()");
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

    // -----------------------------------------------------------------------
    // currentUser inside find / view filters
    // -----------------------------------------------------------------------

    const SRC_FILTER_AUTH = `
      system Acme {
        user {
          id: string
          customerId: string
        }
        module Sales {
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
          modules: Sales
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
      expect(handler).toMatch(/_repo\.Mine\(_currentUser\.User, ct\)/);
    });

    it("view handler injects ICurrentUserAccessor when the view filter uses currentUser", async () => {
      const files = await emitForAuthSystem(SRC_FILTER_AUTH);
      const handler = files.get("Application/Views/MyOrdersHandler.cs")!;
      expect(handler).toMatch(/ICurrentUserAccessor _currentUser/);
      expect(handler).toMatch(/_repo\.MyOrders\(_currentUser\.User, ct\)/);
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
        module Sales {
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
          modules: Sales
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
      expect(filter).toMatch(/StatusCode = 403/);
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
      // Envelope: extends the existing { error, trace_id } shape with a
      // structured `failures` array.
      expect(filter).toMatch(/error = "Validation failed"/);
      expect(filter).toMatch(/failures = fv\.Errors/);
      expect(filter).toMatch(/new \{ field = e\.PropertyName, message = e\.ErrorMessage \}/);
    });

    it("skips the FluentValidation gate entirely when no aggregate has wire-translatable invariants", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
          context Plain {
            aggregate Note {
              title: string display
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
              email: string display
              invariant email.matches("^[^@]+@.+$")
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
              email: string display
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
      expect(userClass).toMatch(
        /System\.Text\.RegularExpressions\.Regex\.IsMatch\(this\.Email, "\^\[\^@\]\+@\.\+\$"\)/,
      );
    });

    it("`private invariant` is skipped from FluentValidation but stays in domain", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
          context Acct {
            aggregate User {
              username: string display
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
});
