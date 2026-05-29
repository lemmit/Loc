// ---------------------------------------------------------------------------
// cqrs — the real StyleAdapter for the dotnet platform.  Wraps the
// existing `emitCqrs` orchestrator (`../cqrs-emit.ts`) so produced
// source stays byte-identical with today's `generateDotnetForContexts`
// output.
//
// Granularity note: the StyleAdapter contract surfaces per-OPERATION
// emit methods (`emitEndpoint(op)` / `emitHandlerOrService(op)`) as
// the design target, but today's `emitCqrs` operates per-AGGREGATE —
// it packages every command / query / handler / controller for one
// aggregate as a single unit.  The optional `emitForAggregate(agg)`
// method bridges the gap: real style adapters can land their existing
// per-aggregate emit shape today, with the per-op methods staying as
// stubs the F5d orchestrator rewire will fill in when it decomposes
// the per-aggregate output into per-op artifacts.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  OperationIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import {
  AdapterNotImplementedError,
  type EmitCtx,
  type EmittedArtifact,
  type Lines,
  type StyleAdapter,
} from "../../_adapters/index.js";
import { emitCqrs } from "../cqrs-emit.js";
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

/** Lazy lookup of sibling style names for the not-yet-implemented
 *  error message — keeps the per-op stubs honest about what's
 *  available without coupling to the registry's stub-throws helper. */
const realSiblings = (): readonly string[] => ["cqrs"];

export const cqrsStyleAdapter: StyleAdapter = {
  name: "cqrs",
  supportedStrategies: ["state", "eventLog"],
  supportedLayouts: ["byLayer", "byFeature"],

  emitEndpoint(_op: OperationIR, _ctx: EmitCtx): Lines {
    // Per-op extraction is the F5d rewire's job.  The existing
    // `emitCqrs` packages all of an aggregate's controller routes in
    // one file, so a per-op extraction needs the controller emitter
    // to be split before this method has a clean implementation.
    throw new AdapterNotImplementedError("style", "cqrs", "dotnet", realSiblings());
  },

  emitHandlerOrService(_op: OperationIR, _ctx: EmitCtx): readonly EmittedArtifact[] {
    // Same per-op caveat — the per-op handler files DO emit as
    // separate `.cs` artifacts today (`emitOperationCommandsAndHandlers`
    // writes one per op), but the helper that produces them is
    // unexported.  F5d will export the per-op slice; until then the
    // orchestrator calls `emitForAggregate` below.
    throw new AdapterNotImplementedError("style", "cqrs", "dotnet", realSiblings());
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
    const hasEmbeddedSpa = !!ctx.deployable.uiName;
    const routePrefix = hasEmbeddedSpa ? "api/" : undefined;
    const collected = new Map<string, string>();
    emitCqrs(enriched, repo, owningCtx, ns, collected, {
      routePrefix,
      emitTrace: !!ctx.emitTrace,
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
