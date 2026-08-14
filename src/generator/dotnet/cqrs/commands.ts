import { unionInstanceName } from "../../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  OperationIR,
} from "../../../ir/types/loom-ir.js";
import {
  lifecycleGates,
  lifecycleGatesUseCurrentUser,
  operationBodyUsesCurrentUser,
  operationGates,
  operationGatesUseCurrentUser,
} from "../../../ir/util/op-gates.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { renderDotnetLogCall } from "../../_obs/render-dotnet.js";
import { maskNamer, projectEntityExpr, projectToResponse, wireType } from "../dto-mapping.js";
import { renderCommand, renderCommandHandler } from "../emit.js";
import { collectCsExprUsings, renderCsExpr, renderCsType } from "../render-expr.js";
import { renderCreateValidator, renderOperationValidator } from "../validator-emit.js";

/** The `when` canCommand gate (criterion.md use site 2): evaluate the
 *  predicate against the loaded aggregate before the body runs; false →
 *  DisallowedException, which DomainExceptionFilter maps to a 409
 *  ProblemDetails ("Disallowed").  Empty string when the op has no gate. */
/** The hoisted authorization gate — the leading run of `requires` statements,
 *  evaluated by the command HANDLER rather than the aggregate (op-gates.ts).
 *
 *  Emitted post-load (so a row-aware term reads the loaded `aggregate`) and
 *  BEFORE the `when` state gate: 403 precedes 409, so an unauthorized caller
 *  never learns the row's state.  Operation params are not locals here — they
 *  ride the command record, which is where the call reads them from too. */
function requiresGate(op: AggregateIR["operations"][number]): string {
  const gates = operationGates(op);
  if (gates.length === 0) return "";
  // Bind the principal to a local rather than rendering the accessor inline, so
  // the emitted guard text is IDENTICAL to the one the aggregate used to carry
  // — the hoist changes where the check runs, not what it reads.
  const bind = operationGatesUseCurrentUser(op)
    ? "        var currentUser = _currentUser.User;\n"
    : "";
  return (
    bind +
    gates
      .map((g) => {
        const pred = renderCsExpr(g.expr, {
          thisName: "aggregate",
          paramExpr: (name) =>
            op.params.some((q) => q.name === name) ? `command.${upperFirst(name)}` : undefined,
        });
        return `        if (!(${pred})) throw new ForbiddenException(${JSON.stringify(
          `Forbidden: ${g.source}`,
        )});\n`;
      })
      .join("")
  );
}

/**
 * The canonical `create` / `destroy` authorization gate, rendered into the
 * command HANDLER — .NET's controller is a thin Mediator dispatch, so the
 * handler is the first place holding both the principal
 * (`ICurrentUserAccessor`) and, for a destroy, the loaded aggregate.  Denial
 * throws `ForbiddenException`, which `DomainExceptionFilter` maps to the 403
 * ProblemDetails `errorStatuses(<kind>, true)` declares.
 *
 * `thisName` is undefined for a create (there is no instance yet — the guard
 * reads the principal only) and the loaded local for a destroy.
 */
function lifecycleGate(
  action: OperationIR | null | undefined,
  /** Project root namespace — the gate's `ICurrentUserAccessor` lives in
   *  `<ns>.Auth`. */
  ns: string,
  thisName?: string,
): { readonly body: string; readonly deps: DepList; readonly usings: string[] } {
  const gates = lifecycleGates(action);
  if (gates.length === 0) return { body: "", deps: [], usings: [] };
  const usesUser = lifecycleGatesUseCurrentUser(action);
  const usings = new Set<string>();
  for (const g of gates) collectCsExprUsings(g.expr, usings);
  // `ICurrentUserAccessor` lives in `<ns>.Auth`, which the base handler usings
  // do NOT carry — the operation handler adds it the same way.  Without it the
  // emitted handler is CS0246, which no tsc-level test can see.
  if (usesUser) usings.add(`${ns}.Auth`);
  const bind = usesUser ? "        var currentUser = _currentUser.User;\n" : "";
  const body =
    bind +
    gates
      .map(
        (g) =>
          `        if (!(${renderCsExpr(g.expr, thisName ? { thisName } : undefined)}))\n` +
          `        {\n` +
          `            throw new ForbiddenException(${JSON.stringify(`Forbidden: ${g.source}`)});\n` +
          `        }\n`,
      )
      .join("");
  return {
    body,
    // Only a principal-reading gate needs the accessor injected; a row-only
    // gate reads the local the handler already loaded.
    deps: usesUser ? [{ type: "ICurrentUserAccessor", field: "_currentUser" }] : [],
    usings: [...usings],
  };
}

type DepList = readonly { readonly type: string; readonly field: string }[];

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
      `            Before = null,\n` +
      `            After = System.Text.Json.JsonSerializer.SerializeToNode(${createAfterExpr}),\n` +
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
  // The canonical create's authorization gate (no receiver — the guard reads
  // the principal only, there being no instance yet).
  const createGate = lifecycleGate(agg.canonicalCreate, ns);
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
      extraDeps: [...createAuditDeps, ...createGate.deps],
      extraUsings: [...createAuditUsings, ...createGate.usings],
      body:
        // The gate runs BEFORE the factory: a denied create constructs nothing
        // and stages no audit row.
        createGate.body +
        // NAMED arguments, not positional: the factory now trails its
        // defaultable parameters (C# CS1737 requires optional params last), so
        // its signature order no longer matches the declared field order this
        // list is in.  Naming them decouples the two — and a create factory is
        // exactly the call site where positional args were least readable.
        `        var aggregate = ${agg.name}.Create(${requiredFields
          .map((f) => `${f.name}: command.${upperFirst(f.name)}`)
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
      `            Before = System.Text.Json.JsonSerializer.SerializeToNode(${destroyBeforeExpr}),\n` +
      `            After = null,\n` +
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
  // The canonical destroy's gate reads the row the handler just loaded.
  const destroyGate = lifecycleGate(agg.canonicalDestroy, ns, "aggregate");
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
      extraDeps: [...destroyAuditDeps, ...destroyGate.deps],
      extraUsings: [...destroyAuditUsings, ...destroyGate.usings],
      body:
        `        var aggregate = await _repo.${writeCmdLoad(agg)}(command.Id, cancellationToken)\n` +
        `            ?? throw new AggregateNotFoundException($"${agg.name} {command.Id} not found");\n` +
        // AFTER the load (so an unreachable id is a 404, not a 403) and BEFORE
        // the audit stage AND the delete.  The ordering is the security
        // property: #2450's gate passed a mutation that moved this line below
        // `DeleteAsync`, which denies a delete that already happened.
        destroyGate.body +
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
    // A SCALAR return (`operation describe(): string` — non-void, non-`or`-union,
    // BUG-003): the command carries the value's WIRE type as its result
    // (`ICommand<string>` etc.), the handler projects the domain value to wire
    // and returns it, and the controller returns `Ok(result)` at 200.  A union
    // scalar-success arm serializes `v.Value` the same way (`wireType`), but here
    // the RAW value is returned, not a Union wrapper.  `undefined` for void ops.
    const scalarWireType =
      op.returnType && op.returnType.kind !== "union"
        ? wireType(op.returnType, ctx, "response")
        : undefined;
    out.set(
      `Application/${aggFolder}/Commands/${upperFirst(op.name)}Command.cs`,
      renderCommand({
        ns,
        aggName: agg.name,
        commandName: `${upperFirst(op.name)}Command`,
        commandParams: params,
        returnType: returnUnion ?? scalarWireType,
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
    const usesUser = operationBodyUsesCurrentUser(op);
    // The gate is evaluated by the handler now, so it needs the accessor
    // injected even when the remaining body no longer takes a principal.
    const gateUsesUser = operationGatesUseCurrentUser(op);
    const baseCallArgs = op.params.map((p) => `command.${upperFirst(p.name)}`);
    const callArgs = (usesUser ? [...baseCallArgs, "_currentUser.User"] : baseCallArgs).join(", ");
    const userExtraDeps =
      usesUser || gateUsesUser ? [{ type: "ICurrentUserAccessor", field: "_currentUser" }] : [];
    const userExtraUsings = usesUser || gateUsesUser ? [`${ns}.Auth`] : [];
    // Extern (b) Phase 2: an `extern` op is now an ordinary aggregate method
    // (its body runs preconditions, calls the `<Op>Core` partial hook, and
    // re-asserts invariants — see `emit/entity.ts`), so it flows through the
    // SAME command-handler path below as any other op (`aggregate.<Op>(...)`).
    // No injected `I<Op><Agg>Handler`, no dev-stub, no dispatch dance.
    // Per-operation audit (audit-and-logging.md): an `audited` op records a
    // who/what/when + before/after wire snapshot.  The before/after are the
    // aggregate's wire projection either side of the mutation; the record is
    // STAGED onto the request-scoped unit of work (IAuditWriter.Stage → adds to
    // the same AppDbContext) so `_repo.SaveAsync` commits it in the SAME
    // transaction as the state change.  The actor (principal), correlation id,
    // and scope id are stamped from the ambient RequestContext (M3 consumer).
    const audited = op.audited;
    // The before/after snapshots are TWO projections rendered into ONE handler
    // body, so they must not reuse the same `is { } __maskUser…` pattern
    // variable — that is CS0128 on any aggregate carrying a `mask unless`
    // field.  One shared namer spans the whole method scope and hands each
    // wrap its own name (see `MaskNamer` in dto-mapping.ts).  This is also why
    // the two projections are rendered SEPARATELY rather than hoisted into one
    // shared string: an identical string emitted twice is exactly the duplicate
    // declaration, and the namer only helps if each wrap is rendered once.
    const maskNames = maskNamer();
    const auditBefore = audited
      ? `        var __before = System.Text.Json.JsonSerializer.SerializeToNode(${projectEntityExpr(
          "aggregate",
          agg as EnrichedAggregateIR,
          ctx,
          { maskNames },
        )});\n`
      : "";
    const auditStage = audited
      ? `        var __after = System.Text.Json.JsonSerializer.SerializeToNode(${projectEntityExpr(
          "aggregate",
          agg as EnrichedAggregateIR,
          ctx,
          { maskNames },
        )});\n` +
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
      requiresGate(op) +
      whenGate(agg, op);
    const handlerBody = returnUnion
      ? loadLine +
        auditBefore +
        `        var result = aggregate.${upperFirst(op.name)}(${callArgs});\n` +
        auditStage +
        `        await _repo.SaveAsync(aggregate, cancellationToken);\n` +
        `        return result;\n`
      : scalarWireType
        ? // Scalar return (BUG-003): capture the domain value, save, then project
          // it to wire on the way out (`projectToResponse` handles money →
          // InvariantCulture string, datetime → ISO-8601, identity for the plain
          // scalars) so the handler's `<WireType>` result is returned, not Unit.
          loadLine +
          auditBefore +
          `        var result = aggregate.${upperFirst(op.name)}(${callArgs});\n` +
          auditStage +
          `        await _repo.SaveAsync(aggregate, cancellationToken);\n` +
          `        return ${projectToResponse("result", op.returnType!, ctx)};\n`
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
        returnType: returnUnion ?? scalarWireType,
        extraDeps: [...userExtraDeps, ...auditDeps],
        extraUsings: [...userExtraUsings, ...auditUsings],
        body: handlerBody,
      }),
    );
  }
}
