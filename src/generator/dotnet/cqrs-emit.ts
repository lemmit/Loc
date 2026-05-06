import type {
  AggregateIR,
  BoundedContextIR,
  FindIR,
  RepositoryIR,
  TypeIR,
} from "../../ir/loom-ir.js";
import { pascal, plural } from "../../util/naming.js";
import {
  aggregateResponseParams,
  csIdValueClrType,
  domainToRequestExpr,
  entityResponseParams,
  projectEntityExpr,
  valueObjectsUsedBy,
  wireToCommandArgument,
  wireType,
} from "./dto-mapping.js";
import { renderCsType } from "./render-expr.js";
import {
  renderCommand,
  renderCommandHandler,
  renderController,
  renderQuery,
  renderQueryHandler,
  renderRequestDtos,
  renderResponseDtos,
} from "./templates.js";

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
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  const aggFolder = plural(agg.name);
  const requiredFields = agg.fields.filter((f) => !f.optional);

  emitResponseDtos(agg, ctx, ns, aggFolder, out);
  emitRequestDtos(agg, ctx, ns, aggFolder, out);
  emitCreateCommandAndHandler(agg, requiredFields, ns, aggFolder, out);
  emitOperationCommandsAndHandlers(agg, ctx, ns, aggFolder, out);
  emitGetByIdQueryAndHandler(agg, ctx, ns, aggFolder, out);
  emitFindQueriesAndHandlers(agg, repo, ctx, ns, aggFolder, out);
  emitController(agg, repo, ctx, requiredFields, ns, out);
}

// ---------------------------------------------------------------------------
// Response DTOs — value objects first (so subsequent records can reference
// them), then parts, then the root, then the create-response.
// ---------------------------------------------------------------------------

function emitResponseDtos(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  const records: { name: string; params: string }[] = [];
  for (const vo of valueObjectsUsedBy(agg, ctx)) {
    records.push({
      name: `${vo.name}Response`,
      params: vo.fields
        .map((f) => `${wireType(f.type, ctx, "response")} ${pascal(f.name)}`)
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
    params: `${csIdValueClrType(agg.idValueType)} Id`,
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
  ctx: BoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  const records: { name: string; params: string }[] = [];
  for (const vo of valueObjectsUsedBy(agg, ctx)) {
    records.push({
      name: `${vo.name}Request`,
      params: vo.fields
        .map((f) => `${wireType(f.type, ctx, "request")} ${pascal(f.name)}`)
        .join(", "),
    });
  }
  const requiredFields = agg.fields.filter((f) => !f.optional);
  records.push({
    name: `Create${agg.name}Request`,
    params: requiredFields
      .map((f) => `${wireType(f.type, ctx, "request")} ${pascal(f.name)}`)
      .join(", "),
  });
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    records.push({
      name: `${pascal(op.name)}Request`,
      params: op.params
        .map((p) => `${wireType(p.type, ctx, "request")} ${pascal(p.name)}`)
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
        .map((f) => `${renderCsType(f.type)} ${pascal(f.name)}`)
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
          .map((f) => `cmd.${pascal(f.name)}`)
          .join(", ")});\n` +
        `        await _repo.SaveAsync(aggregate, ct);\n` +
        `        return aggregate.Id;\n`,
    }),
  );
}

// ---------------------------------------------------------------------------
// One command + handler per public operation
// ---------------------------------------------------------------------------

function emitOperationCommandsAndHandlers(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    const params = [
      `${agg.name}Id Id`,
      ...op.params.map((p) => `${renderCsType(p.type)} ${pascal(p.name)}`),
    ].join(", ");
    out.set(
      `Application/${aggFolder}/Commands/${pascal(op.name)}Command.cs`,
      renderCommand({
        ns,
        aggName: agg.name,
        commandName: `${pascal(op.name)}Command`,
        commandParams: params,
      }),
    );
    const callArgs = op.params.map((p) => `cmd.${pascal(p.name)}`).join(", ");
    if (op.extern) {
      // Emit the user-implementable handler interface alongside the
      // auto Mediator handler, then dispatch through it.
      const ifaceName = `I${pascal(op.name)}${agg.name}Handler`;
      const reqName = `${pascal(op.name)}Request`;
      // Request record is wire-typed (Id<X> → Guid, enum → string,
      // datetime → string, value-object → <VO>Request) but `cmd.X`
      // is domain-typed.  Convert each param via
      // `domainToRequestExpr` so the constructor types line up.
      // Without this, a parameterized extern auto handler fails to
      // compile (Cannot convert from <Domain> to <Wire>).
      const reqArgs = op.params
        .map((p) =>
          domainToRequestExpr(`cmd.${pascal(p.name)}`, p.type, ctx),
        )
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
      out.set(
        `Application/${aggFolder}/Commands/${pascal(op.name)}Handler.cs`,
        renderCommandHandler({
          ns,
          aggName: agg.name,
          handlerName: `${pascal(op.name)}Handler`,
          commandName: `${pascal(op.name)}Command`,
          extraDeps: [{ type: ifaceName, field: "_user" }],
          extraUsings: [`${ns}.Application.${plural(agg.name)}.Handlers`],
          body:
            `        var aggregate = await _repo.GetByIdAsync(cmd.Id, ct)\n` +
            `            ?? throw new AggregateNotFoundException($"${agg.name} {cmd.Id} not found");\n` +
            `        aggregate.Check${pascal(op.name)}(${callArgs});\n` +
            `        var request = new ${reqName}(${reqArgs});\n` +
            `        await _user.HandleAsync(aggregate, request, ct);\n` +
            `        aggregate.AssertInvariants();\n` +
            `        await _repo.SaveAsync(aggregate, ct);\n` +
            `        return Unit.Value;\n`,
        }),
      );
      continue;
    }
    out.set(
      `Application/${aggFolder}/Commands/${pascal(op.name)}Handler.cs`,
      renderCommandHandler({
        ns,
        aggName: agg.name,
        handlerName: `${pascal(op.name)}Handler`,
        commandName: `${pascal(op.name)}Command`,
        body:
          `        var aggregate = await _repo.GetByIdAsync(cmd.Id, ct)\n` +
          `            ?? throw new AggregateNotFoundException($"${agg.name} {cmd.Id} not found");\n` +
          `        aggregate.${pascal(op.name)}(${callArgs});\n` +
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

// ---------------------------------------------------------------------------
// Get-by-id query (returns Response | null)
// ---------------------------------------------------------------------------

function emitGetByIdQueryAndHandler(
  agg: AggregateIR,
  ctx: BoundedContextIR,
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
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  if (!repo) return;
  for (const find of repo.finds) {
    const queryReturn = renderResponseReturnType(find.returnType, agg);
    out.set(
      `Application/${aggFolder}/Queries/${pascal(find.name)}Query.cs`,
      renderQuery({
        ns,
        aggName: agg.name,
        queryName: `${pascal(find.name)}Query`,
        queryParams: find.params
          .map((p) => `${renderCsType(p.type)} ${pascal(p.name)}`)
          .join(", "),
        returnType: queryReturn,
      }),
    );
    out.set(
      `Application/${aggFolder}/Queries/${pascal(find.name)}Handler.cs`,
      renderQueryHandler({
        ns,
        aggName: agg.name,
        handlerName: `${pascal(find.name)}Handler`,
        queryName: `${pascal(find.name)}Query`,
        returnType: queryReturn,
        body: buildFindHandlerBody(find, agg, ctx),
      }),
    );
  }
}

function buildFindHandlerBody(
  find: FindIR,
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string {
  const argList = find.params.map((p) => `q.${pascal(p.name)}`).join(", ");
  // The repository signature ends with `CancellationToken ct`; drop the
  // separator when there are no domain params, so the auto-included
  // zero-arg `all` find compiles cleanly.
  const callArgs = argList.length > 0 ? `${argList}, ct` : `ct`;
  if (find.returnType.kind === "array") {
    return (
      `        var domain = await _repo.${pascal(find.name)}(${callArgs});\n` +
      `        return domain.Select(d => ${projectEntityExpr("d", agg, ctx)}).ToList();\n`
    );
  }
  if (find.returnType.kind === "optional") {
    return (
      `        var domain = await _repo.${pascal(find.name)}(${callArgs});\n` +
      `        return domain is null ? null : ${projectEntityExpr("domain", agg, ctx)};\n`
    );
  }
  return (
    `        var domain = await _repo.${pascal(find.name)}(${callArgs});\n` +
    `        return ${projectEntityExpr("domain", agg, ctx)};\n`
  );
}

function renderResponseReturnType(t: TypeIR, agg: AggregateIR): string {
  if (t.kind === "array") {
    return `System.Collections.Generic.IReadOnlyList<${agg.name}Response>`;
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
  ctx: BoundedContextIR,
  requiredFields: AggregateIR["fields"],
  ns: string,
  out: Map<string, string>,
): void {
  out.set(
    `Api/${pascal(plural(agg.name))}Controller.cs`,
    renderController(agg, repo, ns, {
      idClrType: csIdValueClrType(agg.idValueType),
      createCmdArgs: requiredFields.map((f) =>
        wireToCommandArgument(`request.${pascal(f.name)}`, f.type, ctx),
      ),
      publicOps: agg.operations
        .filter((o) => o.visibility === "public")
        .map((op) => ({
          name: op.name,
          cmdArgs: op.params.map((p) =>
            wireToCommandArgument(`request.${pascal(p.name)}`, p.type, ctx),
          ),
        })),
      finds: (repo?.finds ?? []).map((find) => ({
        name: find.name,
        isRoot: find.name === "all",
        queryRouteParams: find.params
          .map((p) => `[FromQuery] ${wireType(p.type, ctx, "request")} ${p.name}`)
          .join(", "),
        queryConstructorArgs: find.params
          .map((p) => wireToCommandArgument(p.name, p.type, ctx))
          .join(", "),
        returnShape: (find.returnType.kind === "array"
          ? "list"
          : find.returnType.kind === "optional"
            ? "optional"
            : "single") as "list" | "optional" | "single",
      })),
    }),
  );
}
