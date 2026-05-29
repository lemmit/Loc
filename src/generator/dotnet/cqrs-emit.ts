import { forCreateInput } from "../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  FindIR,
  RepositoryIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { findUsesCurrentUser, operationUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { plural, upperFirst } from "../../util/naming.js";
import {
  aggregateResponseParams,
  csIdValueClrType,
  domainToRequestExpr,
  dtoParam,
  entityResponseParams,
  projectEntityExpr,
  valueObjectsUsedBy,
  wireToCommandArgument,
  wireType,
} from "./dto-mapping.js";
import {
  renderCommand,
  renderCommandHandler,
  renderController,
  renderQuery,
  renderQueryHandler,
  renderRequestDtos,
  renderResponseDtos,
} from "./emit.js";
import { renderCsType } from "./render-expr.js";
import { renderCreateValidator, renderOperationValidator } from "./validator-emit.js";

// ---------------------------------------------------------------------------
// Per-aggregate CQRS file emission.
//
// For each aggregate this produces:
//   - Request DTOs (Create<Agg>Request, <Op>Request, <VO>Request, …)
//   - Response DTOs (<Agg>Response, <Part>Response, <VO>Response,
//     Create<Agg>Response, …)
//   - Create<Agg> command + handler (factory call → repo.Save)
//   - One command + handler per public operation (repo.Get → method →
//     repo.Save)
//   - Get<Agg>ById query + handler (repo.Get → projectToResponse)
//   - One query + handler per repository `find` (repo.<find> → project list)
//   - The aggregate's Web API controller (Request → Command, Response
//     pass-through)
// ---------------------------------------------------------------------------

export function emitCqrs(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
  options?: { routePrefix?: string; emitTrace?: boolean },
): void {
  const aggFolder = plural(agg.name);
  // Create-request payload: required + access-permitted client input.
  // `forCreateInput` excludes `managed` / `token` / `internal` (server-
  // owned or domain-only), keeps `immutable` (settable at creation) and
  // `secret` (client supplies password hashes / API keys).
  const requiredFields = forCreateInput(agg.fields).filter((f) => !f.optional);

  emitResponseDtos(agg, ctx, ns, aggFolder, out);
  emitRequestDtos(agg, ctx, ns, aggFolder, out);
  emitCreateCommandAndHandler(agg, requiredFields, ns, aggFolder, out);
  // Canonical destroy → Delete command + handler (gated on the IR
  // lifecycle, so plain aggregates emit no extra CQRS files).
  if (agg.canonicalDestroy) emitDestroyCommandAndHandler(agg, ns, aggFolder, out);
  emitOperationCommandsAndHandlers(agg, ctx, ns, aggFolder, out);
  emitGetByIdQueryAndHandler(agg, ctx, ns, aggFolder, out);
  emitFindQueriesAndHandlers(agg, repo, ctx, ns, aggFolder, out);
  emitController(agg, repo, ctx, requiredFields, ns, out, options?.routePrefix, options?.emitTrace);
}

// ---------------------------------------------------------------------------
// Response DTOs — value objects first (so subsequent records can reference
// them), then parts, then the root, then the create-response.
// ---------------------------------------------------------------------------

function emitResponseDtos(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  const records: { name: string; params: string }[] = [];
  for (const vo of valueObjectsUsedBy(agg, ctx)) {
    records.push({
      name: `${vo.name}Response`,
      params: vo.fields
        .map((f) => dtoParam(wireType(f.type, ctx, "response"), upperFirst(f.name)))
        .join(", "),
    });
  }
  for (const part of agg.parts) {
    records.push({
      name: `${part.name}Response`,
      params: entityResponseParams(part, ctx),
    });
  }
  records.push({
    name: `${agg.name}Response`,
    params: aggregateResponseParams(agg, ctx),
  });
  records.push({
    name: `Create${agg.name}Response`,
    params: dtoParam(csIdValueClrType(agg.idValueType), "Id"),
  });
  out.set(
    `Application/${aggFolder}/Responses/${agg.name}Responses.cs`,
    renderResponseDtos({ ns, aggName: agg.name, records }),
  );
}

// ---------------------------------------------------------------------------
// Request DTOs — value objects first, then create + per-operation.
// ---------------------------------------------------------------------------

function emitRequestDtos(
  agg: AggregateIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  const records: { name: string; params: string }[] = [];
  for (const vo of valueObjectsUsedBy(agg, ctx)) {
    records.push({
      name: `${vo.name}Request`,
      params: vo.fields
        .map((f) => dtoParam(wireType(f.type, ctx, "request"), upperFirst(f.name), "request"))
        .join(", "),
    });
  }
  // Create-request payload: required + access-permitted client input.
  // `forCreateInput` excludes `managed` / `token` / `internal` (server-
  // owned or domain-only), keeps `immutable` (settable at creation) and
  // `secret` (client supplies password hashes / API keys).
  const requiredFields = forCreateInput(agg.fields).filter((f) => !f.optional);
  records.push({
    name: `Create${agg.name}Request`,
    params: requiredFields
      .map((f) => dtoParam(wireType(f.type, ctx, "request"), upperFirst(f.name), "request"))
      .join(", "),
  });
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    records.push({
      name: `${upperFirst(op.name)}Request`,
      params: op.params
        .map((p) => dtoParam(wireType(p.type, ctx, "request"), upperFirst(p.name), "request"))
        .join(", "),
    });
  }
  out.set(
    `Application/${aggFolder}/Requests/${agg.name}Requests.cs`,
    renderRequestDtos({ ns, aggName: agg.name, records }),
  );
}

// ---------------------------------------------------------------------------
// Create command + handler
// ---------------------------------------------------------------------------

function emitCreateCommandAndHandler(
  agg: AggregateIR,
  requiredFields: AggregateIR["fields"],
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  out.set(
    `Application/${aggFolder}/Commands/Create${agg.name}Command.cs`,
    renderCommand({
      ns,
      aggName: agg.name,
      commandName: `Create${agg.name}Command`,
      commandParams: requiredFields
        .map((f) => `${renderCsType(f.type)} ${upperFirst(f.name)}`)
        .join(", "),
      returnType: `${agg.name}Id`,
    }),
  );
  out.set(
    `Application/${aggFolder}/Commands/Create${agg.name}Handler.cs`,
    renderCommandHandler({
      ns,
      aggName: agg.name,
      handlerName: `Create${agg.name}Handler`,
      commandName: `Create${agg.name}Command`,
      returnType: `${agg.name}Id`,
      body:
        `        var aggregate = ${agg.name}.Create(${requiredFields
          .map((f) => `cmd.${upperFirst(f.name)}`)
          .join(", ")});\n` +
        `        await _repo.SaveAsync(aggregate, ct);\n` +
        `        return aggregate.Id;\n`,
    }),
  );
  // FluentValidation rules — emitted only when at least one
  // wire-translatable invariant exists for this command.  See
  // `validator-emit.ts` for the classification + chain emission.
  const validator = renderCreateValidator(agg, ns);
  if (validator.content) {
    out.set(
      `Application/${aggFolder}/Commands/Create${agg.name}CommandValidator.cs`,
      validator.content,
    );
  }
}

/** Canonical hard-delete: `Destroy<Agg>Command(<Agg>Id Id)` + handler that
 * loads (404 if absent), then hard-deletes via the repo.  Mirrors the
 * operation-handler load→act→return shape; crudish's destroy is empty-bodied
 * so there's no domain `destroy()` method to invoke. */
function emitDestroyCommandAndHandler(
  agg: AggregateIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  out.set(
    `Application/${aggFolder}/Commands/Destroy${agg.name}Command.cs`,
    renderCommand({
      ns,
      aggName: agg.name,
      commandName: `Destroy${agg.name}Command`,
      commandParams: `${agg.name}Id Id`,
    }),
  );
  out.set(
    `Application/${aggFolder}/Commands/Destroy${agg.name}Handler.cs`,
    renderCommandHandler({
      ns,
      aggName: agg.name,
      handlerName: `Destroy${agg.name}Handler`,
      commandName: `Destroy${agg.name}Command`,
      body:
        `        var aggregate = await _repo.GetByIdAsync(cmd.Id, ct)\n` +
        `            ?? throw new AggregateNotFoundException($"${agg.name} {cmd.Id} not found");\n` +
        `        await _repo.DeleteAsync(aggregate, ct);\n` +
        `        return Unit.Value;\n`,
    }),
  );
}

// ---------------------------------------------------------------------------
// One command + handler per public operation
// ---------------------------------------------------------------------------

function emitOperationCommandsAndHandlers(
  agg: AggregateIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    const params = [
      `${agg.name}Id Id`,
      ...op.params.map((p) => `${renderCsType(p.type)} ${upperFirst(p.name)}`),
    ].join(", ");
    out.set(
      `Application/${aggFolder}/Commands/${upperFirst(op.name)}Command.cs`,
      renderCommand({
        ns,
        aggName: agg.name,
        commandName: `${upperFirst(op.name)}Command`,
        commandParams: params,
      }),
    );
    // Per-op FluentValidation rules from wire-translatable
    // preconditions.  Server-side `requires`, helper-fn calls,
    // and aggregate-state references stay in the domain layer
    // (the existing `Check<Op>` / `<Op>` body still asserts them).
    const opValidator = renderOperationValidator(agg, op, ns);
    if (opValidator.content) {
      out.set(
        `Application/${aggFolder}/Commands/${upperFirst(op.name)}CommandValidator.cs`,
        opValidator.content,
      );
    }
    // When the op body references `currentUser`, the aggregate
    // method's signature picks up a trailing `User currentUser`
    // parameter; the handler injects ICurrentUserAccessor and passes
    // its `User` into the call.  Any non-auth-aware op stays
    // untouched — no DI changes, no handler-ctor surface widening.
    const usesUser = operationUsesCurrentUser(op);
    const baseCallArgs = op.params.map((p) => `cmd.${upperFirst(p.name)}`);
    const callArgs = (usesUser ? [...baseCallArgs, "_currentUser.User"] : baseCallArgs).join(", ");
    const userExtraDeps = usesUser ? [{ type: "ICurrentUserAccessor", field: "_currentUser" }] : [];
    const userExtraUsings = usesUser ? [`${ns}.Auth`] : [];
    if (op.extern) {
      // Emit the user-implementable handler interface alongside the
      // auto Mediator handler, then dispatch through it.
      const ifaceName = `I${upperFirst(op.name)}${agg.name}Handler`;
      const reqName = `${upperFirst(op.name)}Request`;
      // Request record is wire-typed (X id → Guid, enum → string,
      // datetime → string, value-object → <VO>Request) but `cmd.X`
      // is domain-typed.  Convert each param via
      // `domainToRequestExpr` so the constructor types line up.
      // Without this, a parameterized extern auto handler fails to
      // compile (Cannot convert from <Domain> to <Wire>).
      const reqArgs = op.params
        .map((p) => domainToRequestExpr(`cmd.${upperFirst(p.name)}`, p.type, ctx))
        .join(", ");
      out.set(
        `Application/${aggFolder}/Handlers/${ifaceName}.cs`,
        renderExternHandlerInterface({
          ns,
          aggName: agg.name,
          ifaceName,
          requestName: reqName,
        }),
      );
      // Dev-stub implementation — decorated with [ExternHandler] so the
      // Scrutor scan in Program.cs picks it up automatically.  Without it
      // the boot-time check throws InvalidOperationException("Missing
      // [ExternHandler] ...").  REPLACE with a real handler in
      // production by adding your own [ExternHandler] class; multiple
      // [ExternHandler] registrations for the same interface result in
      // a DI error, so delete the stub when you ship your own.
      out.set(
        `Application/${aggFolder}/Handlers/DevStub${upperFirst(op.name)}${agg.name}Handler.cs`,
        renderExternHandlerStub({
          ns,
          aggName: agg.name,
          opName: op.name,
          ifaceName,
          requestName: reqName,
        }),
      );
      out.set(
        `Application/${aggFolder}/Commands/${upperFirst(op.name)}Handler.cs`,
        renderCommandHandler({
          ns,
          aggName: agg.name,
          handlerName: `${upperFirst(op.name)}Handler`,
          commandName: `${upperFirst(op.name)}Command`,
          extraDeps: [{ type: ifaceName, field: "_user" }, ...userExtraDeps],
          extraUsings: [
            `${ns}.Application.${plural(agg.name)}.Handlers`,
            `${ns}.Application.${plural(agg.name)}.Requests`,
            ...userExtraUsings,
          ],
          // Wrap the user's HandleAsync in try/catch so any
          // non-domain exception rethrows as ExternHandlerException
          // (mapped by DomainExceptionFilter to a descriptive 500).
          // Domain exceptions raised by the user handler bubble
          // unchanged so DomainException → 400, ForbiddenException →
          // 403, AggregateNotFoundException → 404 still apply.
          body:
            `        var aggregate = await _repo.GetByIdAsync(cmd.Id, ct)\n` +
            `            ?? throw new AggregateNotFoundException($"${agg.name} {cmd.Id} not found");\n` +
            `        aggregate.Check${upperFirst(op.name)}(${callArgs});\n` +
            `        var request = new ${reqName}(${reqArgs});\n` +
            `        try\n` +
            `        {\n` +
            `            await _user.HandleAsync(aggregate, request, ct);\n` +
            `        }\n` +
            `        catch (DomainException) { throw; }\n` +
            `        catch (ForbiddenException) { throw; }\n` +
            `        catch (AggregateNotFoundException) { throw; }\n` +
            `        catch (OperationCanceledException) { throw; }\n` +
            `        catch (Exception ex)\n` +
            `        {\n` +
            `            throw new ExternHandlerException("${op.name}", "${agg.name}", ex);\n` +
            `        }\n` +
            `        aggregate.AssertInvariants();\n` +
            `        await _repo.SaveAsync(aggregate, ct);\n` +
            `        return Unit.Value;\n`,
        }),
      );
      continue;
    }
    out.set(
      `Application/${aggFolder}/Commands/${upperFirst(op.name)}Handler.cs`,
      renderCommandHandler({
        ns,
        aggName: agg.name,
        handlerName: `${upperFirst(op.name)}Handler`,
        commandName: `${upperFirst(op.name)}Command`,
        extraDeps: userExtraDeps,
        extraUsings: userExtraUsings,
        body:
          `        var aggregate = await _repo.GetByIdAsync(cmd.Id, ct)\n` +
          `            ?? throw new AggregateNotFoundException($"${agg.name} {cmd.Id} not found");\n` +
          `        aggregate.${upperFirst(op.name)}(${callArgs});\n` +
          `        await _repo.SaveAsync(aggregate, ct);\n` +
          `        return Unit.Value;\n`,
      }),
    );
  }
}

/**
 * `IXAggHandler` — the interface a user implements (decorated with
 * `[ExternHandler]`) to own the business decision for an extern
 * operation.  The auto-generated Mediator handler runs preconditions
 * and invariants around the user's call.
 */
function renderExternHandlerInterface(args: {
  ns: string;
  aggName: string;
  ifaceName: string;
  requestName: string;
}): string {
  return `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using ${args.ns}.Domain.${plural(args.aggName)};
using ${args.ns}.Application.${plural(args.aggName)}.Requests;

namespace ${args.ns}.Application.${plural(args.aggName)}.Handlers;

/// <summary>
/// User-supplied business decision for an extern operation.  Implement
/// in the same project, decorate with <c>[ExternHandler]</c>, and
/// the framework will load the aggregate, run preconditions, invoke
/// HandleAsync, run invariants, and save in one transaction.
/// </summary>
public interface ${args.ifaceName}
{
    Task HandleAsync(${args.aggName} aggregate, ${args.requestName} request, CancellationToken ct);
}
`;
}

/**
 * Permissive dev stub for an extern operation handler — emitted alongside
 * the user-facing interface so a generated app boots end-to-end before the
 * user has wired their own implementation.  Body is a no-op (yields
 * `Task.CompletedTask`); the framework still runs preconditions and
 * invariants around the call.  Replace by deleting the stub file and
 * adding your own [ExternHandler] class.
 */
function renderExternHandlerStub(args: {
  ns: string;
  aggName: string;
  opName: string;
  ifaceName: string;
  requestName: string;
}): string {
  const stubName = `DevStub${upperFirst(args.opName)}${args.aggName}Handler`;
  return `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using ${args.ns}.Application.${plural(args.aggName)}.Requests;
using ${args.ns}.Domain.Common;
using ${args.ns}.Domain.${plural(args.aggName)};

namespace ${args.ns}.Application.${plural(args.aggName)}.Handlers;

/// <summary>Permissive dev stub for the <c>${args.opName}</c> extern op.
/// Replace by deleting this file and adding your own
/// <c>[ExternHandler]</c>-decorated class implementing
/// <see cref="${args.ifaceName}"/>.</summary>
[ExternHandler]
public sealed class ${stubName} : ${args.ifaceName}
{
    public Task HandleAsync(${args.aggName} aggregate, ${args.requestName} request, CancellationToken ct)
    {
        return Task.CompletedTask;
    }
}
`;
}

// ---------------------------------------------------------------------------
// Get-by-id query (returns Response | null)
// ---------------------------------------------------------------------------

function emitGetByIdQueryAndHandler(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  out.set(
    `Application/${aggFolder}/Queries/Get${agg.name}ByIdQuery.cs`,
    renderQuery({
      ns,
      aggName: agg.name,
      queryName: `Get${agg.name}ByIdQuery`,
      queryParams: `${agg.name}Id Id`,
      returnType: `${agg.name}Response?`,
    }),
  );
  out.set(
    `Application/${aggFolder}/Queries/Get${agg.name}ByIdHandler.cs`,
    renderQueryHandler({
      ns,
      aggName: agg.name,
      handlerName: `Get${agg.name}ByIdHandler`,
      queryName: `Get${agg.name}ByIdQuery`,
      returnType: `${agg.name}Response?`,
      body:
        `        var found = await _repo.GetByIdAsync(q.Id, ct);\n` +
        `        return found is null ? null : ${projectEntityExpr("found", agg, ctx)};\n`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Repository-defined finds → queries
// ---------------------------------------------------------------------------

function emitFindQueriesAndHandlers(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  if (!repo) return;
  for (const find of repo.finds) {
    const queryReturn = renderResponseReturnType(find.returnType, agg);
    const usesUser = findUsesCurrentUser(find);
    out.set(
      `Application/${aggFolder}/Queries/${upperFirst(find.name)}Query.cs`,
      renderQuery({
        ns,
        aggName: agg.name,
        queryName: `${upperFirst(find.name)}Query`,
        queryParams: find.params
          .map((p) => `${renderCsType(p.type)} ${upperFirst(p.name)}`)
          .join(", "),
        returnType: queryReturn,
      }),
    );
    out.set(
      `Application/${aggFolder}/Queries/${upperFirst(find.name)}Handler.cs`,
      renderQueryHandler({
        ns,
        aggName: agg.name,
        handlerName: `${upperFirst(find.name)}Handler`,
        queryName: `${upperFirst(find.name)}Query`,
        returnType: queryReturn,
        body: buildFindHandlerBody(find, agg, ctx, usesUser),
        extraDeps: usesUser ? [{ type: "ICurrentUserAccessor", field: "_currentUser" }] : [],
        extraUsings: usesUser ? [`${ns}.Auth`] : [],
      }),
    );
  }
}

function buildFindHandlerBody(
  find: FindIR,
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  usesUser: boolean = false,
): string {
  const baseArgs = find.params.map((p) => `q.${upperFirst(p.name)}`);
  const allArgs = usesUser ? [...baseArgs, "_currentUser.User"] : baseArgs;
  // The repository signature ends with `CancellationToken ct`; drop the
  // separator when there are no domain params, so the auto-included
  // zero-arg `all` find compiles cleanly.
  const argList = allArgs.join(", ");
  const callArgs = argList.length > 0 ? `${argList}, ct` : `ct`;
  if (find.returnType.kind === "array") {
    return (
      `        var domain = await _repo.${upperFirst(find.name)}(${callArgs});\n` +
      `        return domain.Select(d => ${projectEntityExpr("d", agg, ctx)}).ToList();\n`
    );
  }
  if (find.returnType.kind === "optional") {
    return (
      `        var domain = await _repo.${upperFirst(find.name)}(${callArgs});\n` +
      `        return domain is null ? null : ${projectEntityExpr("domain", agg, ctx)};\n`
    );
  }
  return (
    `        var domain = await _repo.${upperFirst(find.name)}(${callArgs});\n` +
    `        return ${projectEntityExpr("domain", agg, ctx)};\n`
  );
}

function renderResponseReturnType(t: TypeIR, agg: AggregateIR): string {
  if (t.kind === "array") {
    return `IReadOnlyList<${agg.name}Response>`;
  }
  if (t.kind === "optional") {
    return `${agg.name}Response?`;
  }
  return `${agg.name}Response`;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

function emitController(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  requiredFields: AggregateIR["fields"],
  ns: string,
  out: Map<string, string>,
  routePrefix?: string,
  emitTrace?: boolean,
): void {
  // Threaded through every wireToCommandArgument call below.  When a
  // datetime field is on the wire, the helper lowers to
  // `DateTime.Parse(..., CultureInfo.InvariantCulture, …)` and adds
  // `System.Globalization` to this set; the controller file imports
  // it once, only when actually needed.
  const usings = new Set<string>();
  out.set(
    `Api/${upperFirst(plural(agg.name))}Controller.cs`,
    renderController(agg, repo, ns, {
      idClrType: csIdValueClrType(agg.idValueType),
      destroyAction: !!agg.canonicalDestroy,
      createCmdArgs: requiredFields.map((f) =>
        wireToCommandArgument(`request.${upperFirst(f.name)}`, f.type, ctx, usings),
      ),
      publicOps: agg.operations
        .filter((o) => o.visibility === "public")
        .map((op) => ({
          name: op.name,
          // URL segment from routeSlug (D-URLSTYLE); name stays the verb
          // for the C# action method + command type.
          routeSlug: op.routeSlug,
          cmdArgs: op.params.map((p) =>
            wireToCommandArgument(`request.${upperFirst(p.name)}`, p.type, ctx, usings),
          ),
          // Wire-shape key set for --trace's wire_in line.  Param names
          // are lowerCamel in the IR — same form the JSON wire uses
          // (default ASP.NET JsonNamingPolicy.CamelCase).
          paramNames: op.params.map((p) => p.name),
        })),
      finds: (repo?.finds ?? []).map((find) => ({
        name: find.name,
        isRoot: find.name === "all",
        queryRouteParams: find.params
          .map((p) => {
            // A required find param must bind required so Swashbuckle emits
            // `required: true` — a non-nullable reference type alone reads as
            // optional, diverging from Hono/Phoenix (which mark it required).
            // Optional params (`kind === "optional"`) stay optional.  Attribute
            // fully-qualified to avoid an unused `using` under /warnaserror.
            const bind =
              p.type.kind === "optional"
                ? ""
                : "[Microsoft.AspNetCore.Mvc.ModelBinding.BindRequired] ";
            return `[FromQuery] ${bind}${wireType(p.type, ctx, "request")} ${p.name}`;
          })
          .join(", "),
        queryConstructorArgs: find.params
          .map((p) => wireToCommandArgument(p.name, p.type, ctx, usings))
          .join(", "),
        returnShape: (find.returnType.kind === "array"
          ? "list"
          : find.returnType.kind === "optional"
            ? "optional"
            : "single") as "list" | "optional" | "single",
      })),
      extraUsings: [...usings].sort(),
      routePrefix,
      emitTrace,
    }),
  );
}
