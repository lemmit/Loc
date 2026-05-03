import type { Model } from "../../language/generated/ast.js";
import { lowerModel } from "../../ir/lower.js";
import type {
  AggregateIR,
  BoundedContextIR,
  FieldIR,
  RepositoryIR,
} from "../../ir/loom-ir.js";
import { pascal } from "../../util/naming.js";
import { renderCsType } from "./render-expr.js";
import {
  renderCommand,
  renderCommandHandler,
  renderCommon,
  renderConfiguration,
  renderController,
  renderCsproj,
  renderDbContext,
  renderEntity,
  renderEnum,
  renderEvent,
  renderExceptionFilter,
  renderId,
  renderIDomainEvent,
  renderProgram,
  renderQuery,
  renderQueryHandler,
  renderRepositoryImpl,
  renderRepositoryInterface,
  renderValueObject,
} from "./templates.js";

export function generateDotnet(model: Model): Map<string, string> {
  const out = new Map<string, string>();
  const loom = lowerModel(model);
  for (const ctx of loom.contexts) {
    emitContext(ctx, ctx.name, out);
  }
  return out;
}

function emitContext(
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  for (const agg of ctx.aggregates) {
    out.set(`Domain/Ids/${agg.name}Id.cs`, renderId(agg.name, agg.idValueType, ns));
    for (const part of agg.parts) {
      out.set(
        `Domain/Ids/${part.name}Id.cs`,
        renderId(part.name, agg.idValueType, ns),
      );
    }
  }
  for (const e of ctx.enums) {
    out.set(`Domain/Enums/${e.name}.cs`, renderEnum(e, ns));
  }
  for (const vo of ctx.valueObjects) {
    out.set(`Domain/ValueObjects/${vo.name}.cs`, renderValueObject(vo, ns));
  }
  out.set("Domain/Events/IDomainEvent.cs", renderIDomainEvent(ns));
  for (const ev of ctx.events) {
    out.set(`Domain/Events/${ev.name}.cs`, renderEvent(ev, ns));
  }
  out.set("Domain/Common/DomainException.cs", renderCommon(ns));
  for (const agg of ctx.aggregates) {
    for (const part of agg.parts) {
      out.set(
        `Domain/${agg.name}/${part.name}.cs`,
        renderEntity(part, false, ns, agg.name),
      );
    }
    out.set(`Domain/${agg.name}/${agg.name}.cs`, renderEntity(agg, true, ns, agg.name));
    const repo = findRepoFor(ctx, agg.name);
    out.set(
      `Domain/${agg.name}/I${agg.name}Repository.cs`,
      renderRepositoryInterface(agg, repo, ns),
    );
    out.set(
      `Infrastructure/Repositories/${agg.name}Repository.cs`,
      renderRepositoryImpl(agg, repo, ns),
    );
    out.set(
      `Infrastructure/Persistence/Configurations/${agg.name}Configuration.cs`,
      renderConfiguration(agg, ns),
    );
    emitCqrs(agg, repo, ns, out);
    out.set(
      `Api/${pascal(plural(agg.name))}Controller.cs`,
      renderController(agg, repo, ns),
    );
  }
  out.set("Infrastructure/Persistence/AppDbContext.cs", renderDbContext(ctx, ns));
  out.set("Api/DomainExceptionFilter.cs", renderExceptionFilter(ns));
  out.set("Program.cs", renderProgram(ctx, ns));
  out.set(`${ns}.csproj`, renderCsproj(ns));
}

function plural(s: string): string {
  if (s.endsWith("y") && !/[aeiou]y$/.test(s)) return s.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/.test(s)) return s + "es";
  return s + "s";
}

function findRepoFor(ctx: BoundedContextIR, name: string): RepositoryIR | undefined {
  return ctx.repositories.find((r) => r.aggregateName === name);
}

// ---------------------------------------------------------------------------
// CQRS emission — Commands and Queries are typed records; their handlers
// translate the request into method calls on the aggregate root.
// ---------------------------------------------------------------------------

function emitCqrs(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
  out: Map<string, string>,
): void {
  // Create command + handler
  const requiredFields = agg.fields.filter((f) => !f.optional);
  out.set(
    `Application/${agg.name}/Commands/Create${agg.name}Command.cs`,
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
    `Application/${agg.name}/Commands/Create${agg.name}Handler.cs`,
    renderCommandHandler({
      ns,
      aggName: agg.name,
      handlerName: `Create${agg.name}Handler`,
      commandName: `Create${agg.name}Command`,
      returnType: `${agg.name}Id`,
      body: `        var aggregate = ${agg.name}.Create(${requiredFields
        .map((f) => `cmd.${pascal(f.name)}`)
        .join(", ")});\n        await _repo.SaveAsync(aggregate, ct);\n        return aggregate.Id;\n`,
    }),
  );

  // One Command + Handler per public operation
  for (const op of agg.operations) {
    if (op.visibility !== "public") continue;
    const params = [
      `${agg.name}Id Id`,
      ...op.params.map((p) => `${renderCsType(p.type)} ${pascal(p.name)}`),
    ].join(", ");
    out.set(
      `Application/${agg.name}/Commands/${pascal(op.name)}Command.cs`,
      renderCommand({
        ns,
        aggName: agg.name,
        commandName: `${pascal(op.name)}Command`,
        commandParams: params,
      }),
    );
    const callArgs = op.params.map((p) => `cmd.${pascal(p.name)}`).join(", ");
    out.set(
      `Application/${agg.name}/Commands/${pascal(op.name)}Handler.cs`,
      renderCommandHandler({
        ns,
        aggName: agg.name,
        handlerName: `${pascal(op.name)}Handler`,
        commandName: `${pascal(op.name)}Command`,
        body:
          `        var aggregate = await _repo.GetByIdAsync(cmd.Id, ct)\n` +
          `            ?? throw new ${ns}.Domain.Common.AggregateNotFoundException($"${agg.name} {cmd.Id} not found");\n` +
          `        aggregate.${pascal(op.name)}(${callArgs});\n` +
          `        await _repo.SaveAsync(aggregate, ct);\n`,
      }),
    );
  }

  // Get-by-id query
  out.set(
    `Application/${agg.name}/Queries/Get${agg.name}ByIdQuery.cs`,
    renderQuery({
      ns,
      aggName: agg.name,
      queryName: `Get${agg.name}ByIdQuery`,
      queryParams: `${agg.name}Id Id`,
      returnType: `${agg.name}Dto?`,
      dto: true,
    }),
  );
  out.set(
    `Application/${agg.name}/Queries/Get${agg.name}ByIdHandler.cs`,
    renderQueryHandler({
      ns,
      aggName: agg.name,
      handlerName: `Get${agg.name}ByIdHandler`,
      queryName: `Get${agg.name}ByIdQuery`,
      returnType: `${agg.name}Dto?`,
      body:
        `        var found = await _repo.GetByIdAsync(q.Id, ct);\n` +
        `        return found is null ? null : new ${agg.name}Dto(found.Id);\n`,
    }),
  );

  // Repository-defined finds → queries
  if (repo) {
    for (const find of repo.finds) {
      out.set(
        `Application/${agg.name}/Queries/${pascal(find.name)}Query.cs`,
        renderQuery({
          ns,
          aggName: agg.name,
          queryName: `${pascal(find.name)}Query`,
          queryParams: find.params
            .map((p) => `${renderCsType(p.type)} ${pascal(p.name)}`)
            .join(", "),
          returnType: renderCsType(find.returnType),
        }),
      );
      const args = find.params.map((p) => `q.${pascal(p.name)}`).join(", ");
      out.set(
        `Application/${agg.name}/Queries/${pascal(find.name)}Handler.cs`,
        renderQueryHandler({
          ns,
          aggName: agg.name,
          handlerName: `${pascal(find.name)}Handler`,
          queryName: `${pascal(find.name)}Query`,
          returnType: renderCsType(find.returnType),
          body: `        return await _repo.${pascal(find.name)}(${args}, ct);\n`,
        }),
      );
    }
  }
}

// Suppress unused
void (null as unknown as FieldIR);
