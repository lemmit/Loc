import type { AggregateIR, EnrichedBoundedContextIR } from "../../../ir/types/loom-ir.js";
import { operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { domainToRequestExpr } from "../dto-mapping.js";
import { renderCommand, renderCommandHandler } from "../emit.js";
import { renderCsType } from "../render-expr.js";
import { renderCreateValidator, renderOperationValidator } from "../validator-emit.js";

// ---------------------------------------------------------------------------
// Create command + handler
// ---------------------------------------------------------------------------

export function emitCreateCommandAndHandler(
  agg: AggregateIR,
  requiredFields: AggregateIR["fields"],
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
  /** Emit the FluentValidation create-validator (built from invariants over
   *  the field set).  Skipped for event-sourced aggregates, whose create
   *  input is the command's params (not the field set) and whose invariants
   *  are enforced on the fold.  Defaults true. */
  opts?: { emitValidator?: boolean },
): void {
  const emitValidator = opts?.emitValidator ?? true;
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
          .map((f) => `command.${upperFirst(f.name)}`)
          .join(", ")});\n` +
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
        `        var aggregate = await _repo.GetByIdAsync(command.Id, cancellationToken)\n` +
        `            ?? throw new AggregateNotFoundException($"${agg.name} {command.Id} not found");\n` +
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
            `        var aggregate = await _repo.GetByIdAsync(command.Id, cancellationToken)\n` +
            `            ?? throw new AggregateNotFoundException($"${agg.name} {command.Id} not found");\n` +
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
          `        var aggregate = await _repo.GetByIdAsync(command.Id, cancellationToken)\n` +
          `            ?? throw new AggregateNotFoundException($"${agg.name} {command.Id} not found");\n` +
          `        aggregate.${upperFirst(op.name)}(${callArgs});\n` +
          `        await _repo.SaveAsync(aggregate, cancellationToken);\n` +
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
