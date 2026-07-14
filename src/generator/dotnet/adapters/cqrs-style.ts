// ---------------------------------------------------------------------------
// cqrs — the real StyleAdapter for the dotnet platform.  Wraps the
// existing `emitCqrs` orchestrator (`../cqrs-emit.ts`) so produced
// source stays byte-identical with today's `generateDotnetForContexts`
// output.
//
// Granularity note (F5d, done for this style): the per-OPERATION emit
// methods are REAL here — `emitHandlerOrService(op)` produces one
// operation's command / validator / handler (+ extern interface & stub)
// through the exported `emitOperationCommandAndHandler` slice, and
// `emitEndpoint(op)` produces that operation's controller action block
// through `buildOperationSpec` + `renderOperationActionBlock`.  Both
// return the byte-identical content the per-aggregate path packages
// (gated by `cqrs-style-per-op.test.ts`).  The orchestrator still
// routes through `emitForAggregate` (the create/destroy/query/DTO
// surfaces remain aggregate-scoped); per-op dispatch is available for
// styles and orchestrators that want operation-grained placement.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  OperationIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import { tableOwnerName } from "../../../ir/util/inheritance.js";
import { apiRoutePrefix } from "../../../util/api-base.js";
import { plural } from "../../../util/naming.js";
import type { EmitCtx, EmittedArtifact, Lines, StyleAdapter } from "../../_adapters/index.js";
import { emitOperationCommandAndHandler } from "../cqrs/commands.js";
import { buildOperationSpec } from "../cqrs/controller.js";
import { emitCqrs } from "../cqrs-emit.js";
import { csIdValueClrType } from "../dto-mapping.js";
import { renderOperationActionBlock } from "../emit/api.js";
import type { DotnetArtifactCategory } from "./by-layer-layout.js";

/** Namespace string the dotnet emitter threads everywhere as `ns`.
 *  The orchestrator computes it as `deployable.name` with the first
 *  letter capitalised (see `src/platform/dotnet.ts:emitProject`); the
 *  adapter mirrors that so adapter-dispatched emit produces the same
 *  `using <Ns>.…;` + `namespace <Ns>.…;` lines as the direct path. */
function nsOf(ctx: EmitCtx): string {
  const name = ctx.deployable.name;
  return name[0]!.toUpperCase() + name.slice(1);
}

function contextOf(ctx: EmitCtx, aggName: string): EnrichedBoundedContextIR | undefined {
  return ctx.contexts.find((c) => c.aggregates.some((a) => a.name === aggName));
}

function findRepoFor(ctx: EnrichedBoundedContextIR, aggName: string): RepositoryIR | undefined {
  return ctx.repositories.find((r) => r.aggregateName === aggName);
}

/** Classify a generated CQRS file's path into the byLayer category
 *  the dotnet layout adapter knows about.  Lets `emitForAggregate`
 *  return artifacts the layout adapter can route without the caller
 *  re-deriving categories from path shape. */
function categoriseCqrsPath(path: string): DotnetArtifactCategory {
  // `path` is the relative output path the existing `emitCqrs` writes
  // into the Map — e.g. `Application/Orders/Commands/CreateOrder.cs`,
  // `Api/OrdersController.cs`.  The byLayer adapter mirrors these
  // exact prefixes, so the classification is a path-prefix match.
  if (path.startsWith("Application/") && path.includes("/Commands/")) {
    if (path.endsWith("Validator.cs")) return "command-validator";
    if (path.endsWith("Handler.cs")) return "command-handler";
    return "command";
  }
  if (path.startsWith("Application/") && path.includes("/Queries/")) {
    if (path.endsWith("Handler.cs")) return "query-handler";
    return "query";
  }
  if (path.startsWith("Application/") && path.includes("/Requests/")) return "request-dto";
  if (path.startsWith("Application/") && path.includes("/Responses/")) return "response-dto";
  if (path.startsWith("Application/") && path.includes("/Handlers/")) {
    // Extern operations emit a per-op interface plus a dev-stub
    // implementation: `IXAggHandler.cs` (interface, named `I…`) and
    // `DevStub…Handler.cs` (concrete stub).  Both live under the
    // per-aggregate `Handlers/` folder.
    const bare = path.split("/").pop()!;
    if (bare.startsWith("I") && bare.endsWith("Handler.cs")) return "extern-handler-interface";
    return "extern-handler-stub";
  }
  if (path.startsWith("Api/")) return "controller";
  // Anything else (Domain entities, infra repository, etc.) shouldn't
  // be coming out of `emitCqrs` — but if a future change emits a
  // domain helper we want a clear signal rather than a wrong category.
  throw new Error(`cqrsStyleAdapter: unclassifiable CQRS path '${path}'.`);
}

/** Resolve the aggregate (and owning context) that declares `op`.
 *  `OperationIR` carries no back-pointer, so the per-op adapter methods
 *  locate the host by reference identity (the IR holds one object per
 *  operation), falling back to a name match for programmatically
 *  rebuilt IR. */
function hostOf(
  op: OperationIR,
  ctx: EmitCtx,
): { agg: EnrichedAggregateIR; owningCtx: EnrichedBoundedContextIR } {
  for (const c of ctx.contexts) {
    for (const a of c.aggregates) {
      if (a.operations.includes(op)) return { agg: a, owningCtx: c };
    }
  }
  for (const c of ctx.contexts) {
    for (const a of c.aggregates) {
      if (a.operations.some((o) => o.name === op.name)) return { agg: a, owningCtx: c };
    }
  }
  throw new Error(
    `cqrsStyleAdapter: operation '${op.name}' is not declared by any aggregate in scope.`,
  );
}

export const cqrsStyleAdapter: StyleAdapter = {
  name: "cqrs",
  supportedStrategies: ["state", "eventLog"],
  supportedLayouts: ["byLayer", "byFeature"],

  emitEndpoint(op: OperationIR, ctx: EmitCtx): Lines {
    // The per-OPERATION controller action block (F5d): the
    // `[HttpPost("{id}/<slug>")]` action + response declarations +
    // dispatch (and the `can_<op>` companion when `when`-gated) for one
    // public operation — the exact lines `renderController` flatMaps
    // into the per-aggregate controller file.
    const { agg, owningCtx } = hostOf(op, ctx);
    const ns = nsOf(ctx);
    const idClass = `${tableOwnerName(agg, owningCtx.aggregates)}Id`;
    return renderOperationActionBlock(agg, buildOperationSpec(agg, op, owningCtx, ns), {
      idClass,
      idClrType: csIdValueClrType(agg.idValueType),
      emitTrace: !!ctx.emitTrace,
      // Structural-conflict `httpStatus` overrides (M-T3.4a) — the per-op
      // when/versioned 409 declarations resolve through this map.
      structuralStatuses: owningCtx.structuralErrorStatuses,
    });
  },

  emitHandlerOrService(op: OperationIR, ctx: EmitCtx): readonly EmittedArtifact[] {
    // Every artifact ONE public operation produces (F5d): the command,
    // its optional FluentValidation validator, the Mediator handler,
    // and — extern ops — the user-implementable interface + dev stub.
    // Same content the per-aggregate path writes; collected through the
    // exported per-op slice and categorised for the layout adapter.
    const { agg, owningCtx } = hostOf(op, ctx);
    const ns = nsOf(ctx);
    const aggFolder = plural(agg.name);
    const idClass = `${tableOwnerName(agg, owningCtx.aggregates)}Id`;
    const collected = new Map<string, string>();
    emitOperationCommandAndHandler(agg, op, owningCtx, ns, aggFolder, collected, idClass);
    const out: EmittedArtifact[] = [];
    for (const [path, content] of [...collected.entries()].sort()) {
      out.push({
        name: path.split("/").pop()!,
        content,
        category: categoriseCqrsPath(path),
        aggregateName: agg.name,
      } as EmittedArtifact);
    }
    return out;
  },

  emitDi(ctx: EmitCtx): Lines {
    // MediatR + (when validators are present) FluentValidation pipeline
    // registration lines.  Mirrors the inline template in
    // `renderProgram`.  The Mediator package wires AddMediator(...)
    // via its source generator, so the visible Program.cs blocks here
    // are the pipeline behaviors that compose around the dispatcher.
    const ns = nsOf(ctx);
    const usesValidators = ctx.contexts.some((c) =>
      // Cheap re-derivation of the validator gate; the existing
      // emitter computes the same predicate via `hasAnyWireValidator`.
      // `scope === "server-only"` opts an invariant out; preconditions
      // attached to operations also flow to the FluentValidation pipeline.
      c.aggregates.some(
        (a) =>
          a.invariants.some((i) => i.scope !== "server-only") ||
          a.operations.some((op) => op.statements.some((s) => s.kind === "precondition")),
      ),
    );
    const lines: string[] = [
      `// MediatR / Mediator dispatcher — registered by Mediator.SourceGenerator.`,
      `// Pipeline behaviors compose around it for cross-cutting concerns.`,
    ];
    if (usesValidators) {
      lines.push(
        `// FluentValidation pipeline — runs wire-boundary validators ahead of handlers.`,
        `builder.Services.AddValidatorsFromAssembly(typeof(Program).Assembly);`,
        `builder.Services.AddTransient(typeof(Mediator.IPipelineBehavior<,>),`,
        `    typeof(${ns}.Application.Common.ValidationBehavior<,>));`,
      );
    }
    return lines;
  },

  emitForAggregate(agg: AggregateIR, ctx: EmitCtx): readonly EmittedArtifact[] {
    // Wraps the existing aggregate-scoped `emitCqrs` end-to-end.
    // Collects into a temporary Map<path, content>, then converts
    // each entry to an EmittedArtifact whose `category` the byLayer
    // adapter can route — `aggregateName` carries through so per-
    // aggregate folders pluralise correctly.
    const owningCtx = contextOf(ctx, agg.name);
    if (!owningCtx) return [];
    const enriched = agg as EnrichedAggregateIR;
    const repo = findRepoFor(owningCtx, agg.name);
    const ns = nsOf(ctx);
    // Domain controllers always live under `/api/*` (the shared API base
    // path), matching every other backend + the by-layer dotnet adapter.
    const routePrefix = apiRoutePrefix();
    const collected = new Map<string, string>();
    emitCqrs(enriched, repo, owningCtx, ns, collected, {
      routePrefix,
      emitTrace: !!ctx.emitTrace,
      usingDapper: ctx.deployable.persistence === "dapper",
    });
    const out: EmittedArtifact[] = [];
    for (const [path, content] of [...collected.entries()].sort()) {
      const category = categoriseCqrsPath(path);
      // Path's last segment is the bare file name the byLayer adapter
      // wants — the layout will reapply the `Application/.../` prefix.
      const bareName = path.split("/").pop()!;
      out.push({
        name: bareName,
        content,
        category,
        aggregateName: agg.name,
      } as EmittedArtifact);
    }
    return out;
  },
};
