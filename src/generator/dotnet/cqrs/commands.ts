import { unionInstanceName } from "../../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
} from "../../../ir/types/loom-ir.js";
import { operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { renderDotnetLogCall } from "../../_obs/render-dotnet.js";
import { domainToRequestExpr, projectEntityExpr } from "../dto-mapping.js";
import { renderCommand, renderCommandHandler } from "../emit.js";
import { renderCsExpr, renderCsType } from "../render-expr.js";
import { renderCreateValidator, renderOperationValidator } from "../validator-emit.js";

/** The `when` canCommand gate (criterion.md use site 2): evaluate the
 *  predicate against the loaded aggregate before the body runs; false →
 *  DisallowedException, which DomainExceptionFilter maps to a 409
 *  ProblemDetails ("Disallowed").  Empty string when the op has no gate. */
function whenGate(agg: AggregateIR, op: AggregateIR["operations"][number]): string {
  if (!op.when) return "";
  const pred = renderCsExpr(op.when, { thisName: "aggregate" });
  return `        if (!(${pred})) throw new DisallowedException("operation '${op.name}' is not allowed in the current state of ${agg.name}.");\n`;
}

// ---------------------------------------------------------------------------
// Create command + handler
// ---------------------------------------------------------------------------

/** The repo method a MUTATION command handler loads through: `GetByIdForWriteAsync`
 *  when the aggregate's write scope is narrower than its read scope
 *  (authorization Phase 3 P3.1), else the ordinary `GetByIdAsync` (byte-
 *  identical).  Query (read) handlers always use `GetByIdAsync`. */
function writeCmdLoad(agg: AggregateIR): string {
  return agg.writeScopeFilter ? "GetByIdForWriteAsync" : "GetByIdAsync";
}

export function emitCreateCommandAndHandler(
  agg: AggregateIR,
  requiredFields: AggregateIR["fields"],
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
  /** Emit the FluentValidation create-validator (built from invariants over
   *  the field set).  Skipped for event-sourced aggregates, whose create
   *  input is the command's params (not the field set) and whose invariants
   *  are enforced on the fold.  Defaults true.  `auditCtx` is supplied when the
   *  create action is `audited` — it carries the enclosing context for the wire
   *  projection. */
  opts?: {
    emitValidator?: boolean;
    idClass?: string;
    auditCtx?: EnrichedBoundedContextIR;
  },
): void {
  const emitValidator = opts?.emitValidator ?? true;
  const idClass = opts?.idClass ?? `${agg.name}Id`;
  out.set(
    `Application/${aggFolder}/Commands/Create${agg.name}Command.cs`,
    renderCommand({
      ns,
      aggName: agg.name,
      commandName: `Create${agg.name}Command`,
      commandParams: requiredFields
        .map((f) => `${renderCsType(f.type)} ${upperFirst(f.name)}`)
        .join(", "),
      returnType: idClass,
    }),
  );
  // Audited create (lifecycle parity with the per-op path): the row is STAGED
  // onto the request-scoped unit of work (IAuditWriter.Stage → AppDbContext.Add)
  // BEFORE the aggregate save, so the single `_repo.SaveAsync` flushes the audit
  // row in the SAME transaction.  Asymmetry: `Before` is the JSON null literal
  // ("null"), `After` is the freshly-created wire snapshot, keyed by the
  // generated id; actor + correlation/scope/parent ids come from RequestContext.
  const auditCreate = !!opts?.auditCtx;
  const createAfterExpr = auditCreate
    ? projectEntityExpr("aggregate", agg as EnrichedAggregateIR, opts!.auditCtx!)
    : "";
  const createAuditStage = auditCreate
    ? `        _audit.Stage(new AuditRecord\n` +
      `        {\n` +
      `            AuditId = Guid.NewGuid().ToString(),\n` +
      `            OperationId = ${JSON.stringify(`create${agg.name}`)},\n` +
      `            Action = "create",\n` +
      `            TargetType = ${JSON.stringify(agg.name)},\n` +
      `            TargetId = aggregate.Id.Value.ToString(),\n` +
      `            Actor = RequestContext.Current?.PrincipalJson(),\n` +
      `            Before = "null",\n` +
      `            After = System.Text.Json.JsonSerializer.Serialize(${createAfterExpr}),\n` +
      `            At = DateTime.UtcNow,\n` +
      `            Status = "ok",\n` +
      `            CorrelationId = RequestContext.Current?.CorrelationId,\n` +
      `            ScopeId = RequestContext.Current?.ScopeId,\n` +
      `            ParentId = RequestContext.Current?.ParentId,\n` +
      `        });\n` +
      `        ${renderDotnetLogCall("auditRecorded", [
        { name: "action", valueExpr: `"create"` },
        { name: "target", valueExpr: JSON.stringify(agg.name) },
        { name: "actor", valueExpr: "RequestContext.Current?.PrincipalJson()" },
      ])}\n`
    : "";
  const createAuditDeps = auditCreate
    ? [
        { type: "IAuditWriter", field: "_audit" },
        { type: `ILogger<Create${agg.name}Handler>`, field: "_log" },
      ]
    : [];
  // `Domain.Common` is already in the base handler usings — don't repeat it
  // here (CS0105 duplicate-using is an error under /warnaserror).
  const createAuditUsings = auditCreate
    ? [
        `${ns}.Application.Common`,
        `${ns}.Application.${plural(agg.name)}.Responses`,
        `${ns}.Infrastructure.Persistence`,
        `Microsoft.Extensions.Logging`,
      ]
    : [];
  out.set(
    `Application/${aggFolder}/Commands/Create${agg.name}Handler.cs`,
    renderCommandHandler({
      ns,
      aggName: agg.name,
      handlerName: `Create${agg.name}Handler`,
      commandName: `Create${agg.name}Command`,
      returnType: idClass,
      extraDeps: createAuditDeps,
      extraUsings: createAuditUsings,
      body:
        `        var aggregate = ${agg.name}.Create(${requiredFields
          .map((f) => `command.${upperFirst(f.name)}`)
          .join(", ")});\n` +
        createAuditStage +
        `        await _repo.SaveAsync(aggregate, cancellationToken);\n` +
        `        return aggregate.Id;\n`,
    }),
  );
  // FluentValidation rules — emitted only when at least one
  // wire-translatable invariant exists for this command.  See
  // `validator-emit.ts` for the classification + chain emission.
  if (emitValidator) {
    const validator = renderCreateValidator(agg, ns);
    if (validator.content) {
      out.set(
        `Application/${aggFolder}/Commands/Create${agg.name}CommandValidator.cs`,
        validator.content,
      );
    }
  }
}

/** Canonical hard-delete: `Destroy<Agg>Command(<Agg>Id Id)` + handler that
 * loads (404 if absent), then hard-deletes via the repo.  Mirrors the
 * operation-handler load→act→return shape; crudish's destroy is empty-bodied
 * so there's no domain `destroy()` method to invoke. */
export function emitDestroyCommandAndHandler(
  agg: AggregateIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
  idClass: string = `${agg.name}Id`,
  /** Supplied when the destroy action is `audited` — carries the enclosing
   *  context for the before-snapshot wire projection. */
  auditCtx?: EnrichedBoundedContextIR,
): void {
  out.set(
    `Application/${aggFolder}/Commands/Destroy${agg.name}Command.cs`,
    renderCommand({
      ns,
      aggName: agg.name,
      commandName: `Destroy${agg.name}Command`,
      commandParams: `${idClass} Id`,
    }),
  );
  // Audited destroy (lifecycle parity with the per-op path): snapshot the
  // loaded wire shape, STAGE the audit row, THEN hard-delete — the single
  // `_repo.DeleteAsync` SaveChangesAsync flushes the audit insert + the delete
  // in ONE transaction (a failed delete rolls back the spurious record).
  // Asymmetry: `Before` is the last wire snapshot, `After` is the JSON null
  // literal ("null"); actor + correlation/scope/parent ids from RequestContext.
  const auditDestroy = !!auditCtx;
  const destroyBeforeExpr = auditDestroy
    ? projectEntityExpr("aggregate", agg as EnrichedAggregateIR, auditCtx)
    : "";
  const destroyAuditStage = auditDestroy
    ? `        _audit.Stage(new AuditRecord\n` +
      `        {\n` +
      `            AuditId = Guid.NewGuid().ToString(),\n` +
      `            OperationId = ${JSON.stringify(`destroy${agg.name}`)},\n` +
      `            Action = "destroy",\n` +
      `            TargetType = ${JSON.stringify(agg.name)},\n` +
      `            TargetId = command.Id.Value.ToString(),\n` +
      `            Actor = RequestContext.Current?.PrincipalJson(),\n` +
      `            Before = System.Text.Json.JsonSerializer.Serialize(${destroyBeforeExpr}),\n` +
      `            After = "null",\n` +
      `            At = DateTime.UtcNow,\n` +
      `            Status = "ok",\n` +
      `            CorrelationId = RequestContext.Current?.CorrelationId,\n` +
      `            ScopeId = RequestContext.Current?.ScopeId,\n` +
      `            ParentId = RequestContext.Current?.ParentId,\n` +
      `        });\n` +
      `        ${renderDotnetLogCall("auditRecorded", [
        { name: "action", valueExpr: `"destroy"` },
        { name: "target", valueExpr: JSON.stringify(agg.name) },
        { name: "actor", valueExpr: "RequestContext.Current?.PrincipalJson()" },
      ])}\n`
    : "";
  const destroyAuditDeps = auditDestroy
    ? [
        { type: "IAuditWriter", field: "_audit" },
        { type: `ILogger<Destroy${agg.name}Handler>`, field: "_log" },
      ]
    : [];
  // `Domain.Common` is already in the base handler usings — don't repeat it
  // here (CS0105 duplicate-using is an error under /warnaserror).
  const destroyAuditUsings = auditDestroy
    ? [
        `${ns}.Application.Common`,
        `${ns}.Application.${plural(agg.name)}.Responses`,
        `${ns}.Infrastructure.Persistence`,
        `Microsoft.Extensions.Logging`,
      ]
    : [];
  out.set(
    `Application/${aggFolder}/Commands/Destroy${agg.name}Handler.cs`,
    renderCommandHandler({
      ns,
      aggName: agg.name,
      handlerName: `Destroy${agg.name}Handler`,
      commandName: `Destroy${agg.name}Command`,
      extraDeps: destroyAuditDeps,
      extraUsings: destroyAuditUsings,
      body:
        `        var aggregate = await _repo.${writeCmdLoad(agg)}(command.Id, cancellationToken)\n` +
        `            ?? throw new AggregateNotFoundException($"${agg.name} {command.Id} not found");\n` +
        destroyAuditStage +
        `        await _repo.DeleteAsync(aggregate, cancellationToken);\n` +
        `        return Unit.Value;\n`,
    }),
  );
}

// ---------------------------------------------------------------------------
// One command + handler per public operation
// ---------------------------------------------------------------------------

export function emitOperationCommandsAndHandlers(
  agg: AggregateIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
  idClass: string = `${agg.name}Id`,
): void {
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    emitOperationCommandAndHandler(agg, op, ctx, ns, aggFolder, out, idClass);
  }
}

/** The per-OPERATION slice of the loop above (F5d decomposition): every
 *  artifact one public mutation operation produces — command, optional
 *  FluentValidation validator, Mediator handler, and (extern ops) the
 *  user-implementable interface + dev stub.  `emitOperationCommandsAndHandlers`
 *  delegates here per op; the cqrs StyleAdapter's `emitHandlerOrService(op)`
 *  calls it directly for one op. */
export function emitOperationCommandAndHandler(
  agg: AggregateIR,
  op: AggregateIR["operations"][number],
  ctx: EnrichedBoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
  idClass: string = `${agg.name}Id`,
): void {
  {
    const params = [
      `${idClass} Id`,
      ...op.params.map((p) => `${renderCsType(p.type)} ${upperFirst(p.name)}`),
    ].join(", ");
    // Exception-less return-typed op (exception-less.md): the command carries
    // the Domain union as its result (`ICommand<Union>`), the handler returns it
    // (the aggregate method produces the tagged value), and the controller maps
    // it to HTTP.  `null` ⇒ a plain void mutation command.
    const returnUnion =
      op.returnType?.kind === "union" ? unionInstanceName(op.returnType.variants) : undefined;
    out.set(
      `Application/${aggFolder}/Commands/${upperFirst(op.name)}Command.cs`,
      renderCommand({
        ns,
        aggName: agg.name,
        commandName: `${upperFirst(op.name)}Command`,
        commandParams: params,
        returnType: returnUnion,
        extraUsings: returnUnion ? [`${ns}.Domain.${plural(agg.name)}`] : undefined,
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
    const baseCallArgs = op.params.map((p) => `command.${upperFirst(p.name)}`);
    const callArgs = (usesUser ? [...baseCallArgs, "_currentUser.User"] : baseCallArgs).join(", ");
    const userExtraDeps = usesUser ? [{ type: "ICurrentUserAccessor", field: "_currentUser" }] : [];
    const userExtraUsings = usesUser ? [`${ns}.Auth`] : [];
    if (op.extern) {
      // Emit the user-implementable handler interface alongside the
      // auto Mediator handler, then dispatch through it.
      const ifaceName = `I${upperFirst(op.name)}${agg.name}Handler`;
      const reqName = `${upperFirst(op.name)}${agg.name}Request`;
      // Request record is wire-typed (X id → Guid, enum → string,
      // datetime → string, value-object → <VO>Request) but `command.X`
      // is domain-typed.  Convert each param via
      // `domainToRequestExpr` so the constructor types line up.
      // Without this, a parameterized extern auto handler fails to
      // compile (Cannot convert from <Domain> to <Wire>).
      const reqArgs = op.params
        .map((p) => domainToRequestExpr(`command.${upperFirst(p.name)}`, p.type, ctx))
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
            `        var aggregate = await _repo.${writeCmdLoad(agg)}(command.Id, cancellationToken)\n` +
            `            ?? throw new AggregateNotFoundException($"${agg.name} {command.Id} not found");\n` +
            whenGate(agg, op) +
            `        aggregate.Check${upperFirst(op.name)}(${callArgs});\n` +
            `        var request = new ${reqName}(${reqArgs});\n` +
            `        try\n` +
            `        {\n` +
            `            await _user.HandleAsync(aggregate, request, cancellationToken);\n` +
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
            `        await _repo.SaveAsync(aggregate, cancellationToken);\n` +
            `        return Unit.Value;\n`,
        }),
      );
      return;
    }
    // Per-operation audit (audit-and-logging.md): an `audited` op records a
    // who/what/when + before/after wire snapshot.  The before/after are the
    // aggregate's wire projection either side of the mutation; the record is
    // STAGED onto the request-scoped unit of work (IAuditWriter.Stage → adds to
    // the same AppDbContext) so `_repo.SaveAsync` commits it in the SAME
    // transaction as the state change.  The actor (principal), correlation id,
    // and scope id are stamped from the ambient RequestContext (M3 consumer).
    const audited = op.audited;
    const projectExpr = audited
      ? projectEntityExpr("aggregate", agg as EnrichedAggregateIR, ctx)
      : "";
    const auditBefore = audited
      ? `        var __before = System.Text.Json.JsonSerializer.Serialize(${projectExpr});\n`
      : "";
    const auditStage = audited
      ? `        var __after = System.Text.Json.JsonSerializer.Serialize(${projectExpr});\n` +
        `        _audit.Stage(new AuditRecord\n` +
        `        {\n` +
        `            AuditId = Guid.NewGuid().ToString(),\n` +
        `            OperationId = ${JSON.stringify(`${op.name}${agg.name}`)},\n` +
        `            Action = ${JSON.stringify(op.name)},\n` +
        `            TargetType = ${JSON.stringify(agg.name)},\n` +
        `            TargetId = command.Id.Value.ToString(),\n` +
        `            Actor = RequestContext.Current?.PrincipalJson(),\n` +
        `            Before = __before,\n` +
        `            After = __after,\n` +
        `            At = DateTime.UtcNow,\n` +
        `            Status = "ok",\n` +
        `            CorrelationId = RequestContext.Current?.CorrelationId,\n` +
        `            ScopeId = RequestContext.Current?.ScopeId,\n` +
        `            ParentId = RequestContext.Current?.ParentId,\n` +
        `        });\n` +
        `        ${renderDotnetLogCall("auditRecorded", [
          { name: "action", valueExpr: JSON.stringify(op.name) },
          { name: "target", valueExpr: JSON.stringify(agg.name) },
          { name: "actor", valueExpr: "RequestContext.Current?.PrincipalJson()" },
        ])}\n`
      : "";
    const auditDeps = audited
      ? [
          { type: "IAuditWriter", field: "_audit" },
          { type: `ILogger<${upperFirst(op.name)}Handler>`, field: "_log" },
        ]
      : [];
    // `Domain.Common` is already in the base handler usings — don't repeat it
    // here (CS0105 duplicate-using is an error under /warnaserror).
    const auditUsings = audited
      ? [
          `${ns}.Application.Common`,
          `${ns}.Application.${plural(agg.name)}.Responses`,
          `${ns}.Infrastructure.Persistence`,
          `Microsoft.Extensions.Logging`,
        ]
      : [];
    // A return-typed op threads the union value: capture the method result,
    // save, then return it (the aggregate produces the tagged Domain union).
    const loadLine =
      `        var aggregate = await _repo.${writeCmdLoad(agg)}(command.Id, cancellationToken)\n` +
      `            ?? throw new AggregateNotFoundException($"${agg.name} {command.Id} not found");\n` +
      whenGate(agg, op);
    const handlerBody = returnUnion
      ? loadLine +
        auditBefore +
        `        var result = aggregate.${upperFirst(op.name)}(${callArgs});\n` +
        auditStage +
        `        await _repo.SaveAsync(aggregate, cancellationToken);\n` +
        `        return result;\n`
      : loadLine +
        auditBefore +
        `        aggregate.${upperFirst(op.name)}(${callArgs});\n` +
        auditStage +
        `        await _repo.SaveAsync(aggregate, cancellationToken);\n` +
        `        return Unit.Value;\n`;
    out.set(
      `Application/${aggFolder}/Commands/${upperFirst(op.name)}Handler.cs`,
      renderCommandHandler({
        ns,
        aggName: agg.name,
        handlerName: `${upperFirst(op.name)}Handler`,
        commandName: `${upperFirst(op.name)}Command`,
        returnType: returnUnion,
        extraDeps: [...userExtraDeps, ...auditDeps],
        extraUsings: [...userExtraUsings, ...auditUsings],
        body: handlerBody,
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
    Task HandleAsync(${args.aggName} aggregate, ${args.requestName} request, CancellationToken cancellationToken);
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
    public Task HandleAsync(${args.aggName} aggregate, ${args.requestName} request, CancellationToken cancellationToken)
    {
        return Task.CompletedTask;
    }
}
`;
}
