import type { Model } from "../../language/generated/ast.js";
import { lowerModel } from "../../ir/lower.js";
import type {
  AggregateIR,
  BoundedContextIR,
  EntityPartIR,
  EnumIR,
  FieldIR,
  FindIR,
  IdValueType,
  OperationIR,
  ParamIR,
  RepositoryIR,
  TypeIR,
  ValueObjectIR,
} from "../../ir/loom-ir.js";
import { pascal } from "../../util/naming.js";
import { renderCsExpr, renderCsType } from "./render-expr.js";
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
  renderNoopDispatcher,
  renderProgram,
  renderQuery,
  renderQueryHandler,
  renderRepositoryImpl,
  renderRepositoryInterface,
  renderRequestDtos,
  renderResponseDtos,
  renderTestsFile,
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
  out.set("Infrastructure/Events/NoopDomainEventDispatcher.cs", renderNoopDispatcher(ns));
  for (const agg of ctx.aggregates) {
    const aggFolder = plural(agg.name);
    for (const part of agg.parts) {
      out.set(
        `Domain/${aggFolder}/${part.name}.cs`,
        renderEntity(part, false, ns, agg.name),
      );
    }
    out.set(`Domain/${aggFolder}/${agg.name}.cs`, renderEntity(agg, true, ns, agg.name));
    const repo = findRepoFor(ctx, agg.name);
    out.set(
      `Domain/${aggFolder}/I${agg.name}Repository.cs`,
      renderRepositoryInterface(agg, repo, ns),
    );
    out.set(
      `Infrastructure/Repositories/${agg.name}Repository.cs`,
      renderRepositoryImpl(agg, repo, ns, buildFindBodies(agg, repo)),
    );
    out.set(
      `Infrastructure/Persistence/Configurations/${agg.name}Configuration.cs`,
      renderConfiguration(agg, ns),
    );
    emitCqrs(agg, repo, ctx, ns, out);
    const testsFile = renderTestsFile(agg, ctx, ns);
    if (testsFile) {
      out.set(`Tests/${aggFolder}/${agg.name}Tests.cs`, testsFile);
    }
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
// CQRS + DTOs
// ---------------------------------------------------------------------------

function emitCqrs(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  const aggFolder = plural(agg.name);
  const requiredFields = agg.fields.filter((f) => !f.optional);

  // ---------- Response DTOs (wire-shaped projections) ----------
  const responseRecords: { name: string; params: string }[] = [];
  // Value objects come first so subsequent records can reference them.
  for (const vo of valueObjectsUsedBy(agg, ctx)) {
    responseRecords.push({
      name: `${vo.name}Response`,
      params: vo.fields
        .map((f) => `${wireType(f.type, ctx, "response")} ${pascal(f.name)}`)
        .join(", "),
    });
  }
  for (const part of agg.parts) {
    responseRecords.push({
      name: `${part.name}Response`,
      params: responseRecordParams(part, ctx),
    });
  }
  responseRecords.push({
    name: `${agg.name}Response`,
    params: aggregateResponseParams(agg, ctx),
  });
  responseRecords.push({
    name: `Create${agg.name}Response`,
    params: `${csIdValueClrType(agg.idValueType)} Id`,
  });
  out.set(
    `Application/${aggFolder}/Responses/${agg.name}Responses.cs`,
    renderResponseDtos({ ns, aggName: agg.name, records: responseRecords }),
  );

  // ---------- Request DTOs (wire-shaped inputs) ----------
  const requestRecords: { name: string; params: string }[] = [];
  for (const vo of valueObjectsUsedBy(agg, ctx)) {
    requestRecords.push({
      name: `${vo.name}Request`,
      params: vo.fields
        .map((f) => `${wireType(f.type, ctx, "request")} ${pascal(f.name)}`)
        .join(", "),
    });
  }
  requestRecords.push({
    name: `Create${agg.name}Request`,
    params: requiredFields
      .map((f) => `${wireType(f.type, ctx, "request")} ${pascal(f.name)}`)
      .join(", "),
  });
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    requestRecords.push({
      name: `${pascal(op.name)}Request`,
      params: op.params
        .map((p) => `${wireType(p.type, ctx, "request")} ${pascal(p.name)}`)
        .join(", "),
    });
  }
  out.set(
    `Application/${aggFolder}/Requests/${agg.name}Requests.cs`,
    renderRequestDtos({ ns, aggName: agg.name, records: requestRecords }),
  );

  // ---------- Create command + handler ----------
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

  // ---------- Operation commands + handlers ----------
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

  // ---------- Get-by-id query (returns Response | null) ----------
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
        `        return found is null ? null : ${projectAggregateExpr("found", agg, ctx)};\n`,
    }),
  );

  // ---------- Repository-backed find queries ----------
  if (repo) {
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

  // ---------- Controller ----------
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

// ---------------------------------------------------------------------------
// Wire / domain mapping helpers
// ---------------------------------------------------------------------------

/**
 * What a type looks like in JSON / on the wire (primitives only).
 * Direction picks the suffix for nested DTOs: `Request` for inputs, `Response`
 * for outputs.
 */
function wireType(
  t: TypeIR,
  ctx: BoundedContextIR,
  dir: "request" | "response" = "request",
): string {
  switch (t.kind) {
    case "primitive":
      return renderCsType(t);
    case "id":
      return csIdValueClrType("guid");
    case "enum":
      return "string";
    case "valueobject":
      return `${t.name}${dir === "request" ? "Request" : "Response"}`;
    case "entity":
      return `${t.name}Response`;
    case "array":
      return `System.Collections.Generic.IReadOnlyList<${wireType(t.element, ctx, dir)}>`;
    case "optional":
      return `${wireType(t.inner, ctx, dir)}?`;
  }
}

/** Map a wire-shaped expression to a domain-typed argument for a command. */
function wireToCommandArgument(
  expr: string,
  t: TypeIR,
  ctx: BoundedContextIR,
): string {
  switch (t.kind) {
    case "primitive":
      return expr;
    case "id":
      return `new ${t.targetName}Id(${expr})`;
    case "enum":
      return `System.Enum.Parse<${t.name}>(${expr})`;
    case "valueobject": {
      const vo = ctx.valueObjects.find((v) => v.name === t.name);
      if (!vo) return expr;
      const args = vo.fields
        .map((f) => wireToCommandArgument(`${expr}.${pascal(f.name)}`, f.type, ctx))
        .join(", ");
      return `new ${t.name}(${args})`;
    }
    case "entity":
      return expr;
    case "array":
      return `${expr}.Select(__e => ${wireToCommandArgument("__e", t.element, ctx)}).ToList()`;
    case "optional":
      return `(${expr} is null ? null : ${wireToCommandArgument(`${expr}!`, t.inner, ctx)})`;
  }
}

/** Project a domain expression to its wire-shape Response. */
function projectToResponse(
  domainExpr: string,
  t: TypeIR,
  ctx: BoundedContextIR,
): string {
  switch (t.kind) {
    case "primitive":
      return domainExpr;
    case "id":
      return `${domainExpr}.Value`;
    case "enum":
      return `${domainExpr}.ToString()`;
    case "valueobject": {
      const vo = ctx.valueObjects.find((v) => v.name === t.name);
      if (!vo) return domainExpr;
      const args = vo.fields
        .map((f) => projectToResponse(`${domainExpr}.${pascal(f.name)}`, f.type, ctx))
        .join(", ");
      return `new ${t.name}Response(${args})`;
    }
    case "entity": {
      // Project an entity to its full response (recursively).
      const part =
        ctx.aggregates
          .flatMap((a) => a.parts.map((p) => ({ part: p, agg: a })))
          .find((x) => x.part.name === t.name) ??
        ctx.aggregates
          .map((a) => ({ part: a, agg: a }))
          .find((x) => x.part.name === t.name);
      if (!part) return domainExpr;
      return projectEntityExpr(domainExpr, part.part, ctx);
    }
    case "array":
      return `${domainExpr}.Select(__e => ${projectToResponse("__e", t.element, ctx)}).ToList()`;
    case "optional":
      return `(${domainExpr} is null ? null : ${projectToResponse(domainExpr, t.inner, ctx)})`;
  }
}

function projectEntityExpr(
  domainExpr: string,
  entity: AggregateIR | EntityPartIR,
  ctx: BoundedContextIR,
): string {
  const parts = [`${domainExpr}.Id.Value`];
  for (const f of entity.fields) {
    parts.push(projectToResponse(`${domainExpr}.${pascal(f.name)}`, f.type, ctx));
  }
  for (const c of entity.contains) {
    const part = ctx.aggregates.flatMap((a) => a.parts).find((p) => p.name === c.partName);
    if (!part) continue;
    if (c.collection) {
      parts.push(
        `${domainExpr}.${pascal(c.name)}.Select(__e => ${projectEntityExpr("__e", part, ctx)}).ToList()`,
      );
    } else {
      parts.push(projectEntityExpr(`${domainExpr}.${pascal(c.name)}`, part, ctx));
    }
  }
  for (const d of entity.derived) {
    parts.push(projectToResponse(`${domainExpr}.${pascal(d.name)}`, d.type, ctx));
  }
  return `new ${entity.name}Response(${parts.join(", ")})`;
}

function projectAggregateExpr(
  domainExpr: string,
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string {
  return projectEntityExpr(domainExpr, agg, ctx);
}

function aggregateResponseParams(agg: AggregateIR, ctx: BoundedContextIR): string {
  const parts: string[] = [];
  parts.push(`${csIdValueClrType(agg.idValueType)} Id`);
  for (const f of agg.fields) {
    parts.push(`${wireType(f.type, ctx, "response")} ${pascal(f.name)}`);
  }
  for (const c of agg.contains) {
    parts.push(
      `${c.collection
        ? `System.Collections.Generic.IReadOnlyList<${c.partName}Response>`
        : `${c.partName}Response`} ${pascal(c.name)}`,
    );
  }
  for (const d of agg.derived) {
    parts.push(`${wireType(d.type, ctx, "response")} ${pascal(d.name)}`);
  }
  return parts.join(", ");
}

function responseRecordParams(part: EntityPartIR, ctx: BoundedContextIR): string {
  const parts: string[] = [];
  parts.push(`${csIdValueClrType(part.parentIdValueType)} Id`);
  for (const f of part.fields) {
    parts.push(`${wireType(f.type, ctx, "response")} ${pascal(f.name)}`);
  }
  for (const c of part.contains) {
    parts.push(
      `${c.collection
        ? `System.Collections.Generic.IReadOnlyList<${c.partName}Response>`
        : `${c.partName}Response`} ${pascal(c.name)}`,
    );
  }
  for (const d of part.derived) {
    parts.push(`${wireType(d.type, ctx, "response")} ${pascal(d.name)}`);
  }
  return parts.join(", ");
}

function valueObjectsUsedBy(
  agg: AggregateIR,
  ctx: BoundedContextIR,
): ValueObjectIR[] {
  const used = new Set<string>();
  const visit = (t: TypeIR) => {
    if (t.kind === "valueobject") used.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const f of agg.fields) visit(f.type);
  for (const d of agg.derived) visit(d.type);
  for (const op of agg.operations) for (const p of op.params) visit(p.type);
  for (const part of agg.parts) {
    for (const f of part.fields) visit(f.type);
    for (const d of part.derived) visit(d.type);
  }
  return ctx.valueObjects.filter((v) => used.has(v.name));
}

function csIdValueClrType(idValueType: IdValueType): string {
  switch (idValueType) {
    case "int":
      return "int";
    case "long":
      return "long";
    case "string":
      return "string";
    default:
      return "Guid";
  }
}

// ---------------------------------------------------------------------------
// Find query bodies — convention-based equality predicates
// ---------------------------------------------------------------------------

function buildFindBodies(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
): Array<{ name: string; filterClause: string; projectionClause: string }> {
  if (!repo) return [];
  return repo.finds.map((find) => ({
    name: find.name,
    filterClause: filterClauseFor(find, agg),
    projectionClause: projectionClauseFor(find.returnType),
  }));
}

function filterClauseFor(find: FindIR, agg: AggregateIR): string {
  // Explicit `where ...` clause — render the IR expression as a LINQ
  // predicate.  Field references resolve via the standard Cs renderer,
  // which prints `this.Field` for `this-prop`; we substitute `this.` →
  // `x.` so it works inside `.Where(x => ...)`.
  if (find.filter) {
    const printed = renderCsExprForFilter(find.filter);
    return `.Where(x => ${printed})`;
  }
  // Convention fallback: equality on each parameter that matches a field.
  if (find.params.length === 0) return "";
  const conditions: string[] = [];
  for (const p of find.params) {
    const matchedField = agg.fields.find(
      (f) => f.name === p.name || `${f.name.replace(/Id$/, "")}Id` === p.name,
    );
    if (matchedField) {
      conditions.push(`x.${pascal(matchedField.name)} == ${p.name}`);
    }
  }
  if (conditions.length === 0) return "";
  return `.Where(x => ${conditions.join(" && ")})`;
}

function renderCsExprForFilter(e: import("../../ir/loom-ir.js").ExprIR): string {
  // `this`-rooted property refs need to become `x.`-rooted in the LINQ
  // lambda body.  The standard renderer already uses `this.PascalCase`
  // for `this-prop` refs, so a textual rewrite is exact.
  return renderCsExpr(e).replace(/\bthis\./g, "x.");
}

function projectionClauseFor(t: TypeIR): string {
  if (t.kind === "array") return `.ToListAsync(ct)`;
  if (t.kind === "optional") return `.FirstOrDefaultAsync(ct)`;
  return `.FirstAsync(ct)`;
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
      `        return domain.Select(d => ${projectAggregateExpr("d", agg, ctx)}).ToList();\n`
    );
  }
  if (find.returnType.kind === "optional") {
    return (
      `        var domain = await _repo.${pascal(find.name)}(${callArgs}, ct);\n` +
      `        return domain is null ? null : ${projectAggregateExpr("domain", agg, ctx)};\n`
    );
  }
  return (
    `        var domain = await _repo.${pascal(find.name)}(${callArgs}, ct);\n` +
    `        return ${projectAggregateExpr("domain", agg, ctx)};\n`
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

// Suppress unused
void (null as unknown as FieldIR | EnumIR | OperationIR | ParamIR);
