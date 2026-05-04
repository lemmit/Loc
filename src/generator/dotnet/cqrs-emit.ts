import type {
  AggregateIR,
  BoundedContextIR,
  FindIR,
  RepositoryIR,
  TypeIR,
} from "../../ir/loom-ir.js";
import { pascal } from "../../util/naming.js";
import {
  aggregateResponseParams,
  csIdValueClrType,
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

const plural = (s: string): string => {
  if (s.endsWith("y") && !/[aeiou]y$/.test(s)) return s.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/.test(s)) return s + "es";
  return s + "s";
};

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
  emitOperationCommandsAndHandlers(agg, ns, aggFolder, out);
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
    out.set(
      `Application/${aggFolder}/Commands/${pascal(op.name)}Handler.cs`,
      renderCommandHandler({
        ns,
        aggName: agg.name,
        handlerName: `${pascal(op.name)}Handler`,
        commandName: `${pascal(op.name)}Command`,
        body:
          `        var aggregate = await _repo.GetByIdAsync(cmd.Id, ct)\n` +
          `            ?? throw new ${ns}.Domain.Common.AggregateNotFoundException($"${agg.name} {cmd.Id} not found");\n` +
          `        aggregate.${pascal(op.name)}(${callArgs});\n` +
          `        await _repo.SaveAsync(aggregate, ct);\n` +
          `        return Unit.Value;\n`,
      }),
    );
  }
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
  const callArgs = find.params.map((p) => `q.${pascal(p.name)}`).join(", ");
  if (find.returnType.kind === "array") {
    return (
      `        var domain = await _repo.${pascal(find.name)}(${callArgs}, ct);\n` +
      `        return domain.Select(d => ${projectEntityExpr("d", agg, ctx)}).ToList();\n`
    );
  }
  if (find.returnType.kind === "optional") {
    return (
      `        var domain = await _repo.${pascal(find.name)}(${callArgs}, ct);\n` +
      `        return domain is null ? null : ${projectEntityExpr("domain", agg, ctx)};\n`
    );
  }
  return (
    `        var domain = await _repo.${pascal(find.name)}(${callArgs}, ct);\n` +
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
        queryRouteParams: find.params
          .map((p) => `[FromQuery] ${csIdValueClrType("guid")} ${p.name}`)
          .join(", "),
        queryConstructorArgs: find.params
          .map((p) => wireToCommandArgument(p.name, p.type, ctx))
          .join(", "),
      })),
    }),
  );
}
