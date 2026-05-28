// ---------------------------------------------------------------------------
// layered — the real StyleAdapter for the hono platform.  Wraps the
// existing per-aggregate routes builder (`buildRoutesFile`) so
// produced source stays byte-identical with today's
// `generateTypeScript` output.
//
// Hono ships with a "layered" architectural style: each aggregate's
// HTTP surface lives in `http/<lowerFirst>.routes.ts`, calling
// directly into its `<lowerFirst>-repository.ts` module — no CQRS
// dispatcher, no per-op handler files.  This makes the
// per-aggregate-vs-per-op contract mismatch even more acute than
// .NET's CQRS: the OPERATION-level structure simply doesn't exist as
// a per-file boundary.
//
// As with the dotnet `cqrs` adapter, the per-op contract methods
// (`emitEndpoint` / `emitHandlerOrService`) throw
// `AdapterNotImplementedError` until the orchestrator rewire (F6d)
// decomposes the per-aggregate routes file into per-op pieces.
// `emitForAggregate` is the contract surface today.
// ---------------------------------------------------------------------------

import {
  AdapterNotImplementedError,
  type EmitCtx,
  type EmittedArtifact,
  type Lines,
  type StyleAdapter,
} from "../../../../generator/_adapters/index.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  OperationIR,
  RepositoryIR,
} from "../../../../ir/types/loom-ir.js";
import { lowerFirst } from "../../../../util/naming.js";
import { buildRoutesFile } from "../routes-builder.js";
import type { HonoArtifactCategory } from "./by-layer-layout.js";

function contextOf(ctx: EmitCtx, aggName: string): EnrichedBoundedContextIR | undefined {
  return ctx.contexts.find((c) => c.aggregates.some((a) => a.name === aggName));
}

function findRepoFor(ctx: EnrichedBoundedContextIR, aggName: string): RepositoryIR | undefined {
  return ctx.repositories.find((r) => r.aggregateName === aggName);
}

/** All routes for the deployable live in `http/<lowerFirst>.routes.ts`. */
const routesFileName = (aggName: string): string => `${lowerFirst(aggName)}.routes.ts`;

const realSiblings = (): readonly string[] => ["layered"];

export const layeredStyleAdapter: StyleAdapter = {
  name: "layered",
  supportedStrategies: ["stateBased"],
  supportedLayouts: ["byLayer"],

  emitEndpoint(_op: OperationIR, _ctx: EmitCtx): Lines {
    // Per-op extraction requires splitting `buildRoutesFile` into a
    // per-op `OpenAPIHono.openapi(...)` registration.  Deferred to
    // F6d (orchestrator rewire) where the per-aggregate routes file
    // gets decomposed.
    throw new AdapterNotImplementedError("style", "layered", "hono", realSiblings());
  },

  emitHandlerOrService(_op: OperationIR, _ctx: EmitCtx): readonly EmittedArtifact[] {
    // Hono's "layered" style has no per-op handler files — the routes
    // file holds every op's handler body inline.  Per-op extraction
    // would require synthesising file boundaries that don't exist
    // today; deferred to F6d.
    throw new AdapterNotImplementedError("style", "layered", "hono", realSiblings());
  },

  emitDi(_ctx: EmitCtx): Lines {
    // Hono's wiring is mostly inline in `http/index.ts` — `createApp`
    // mounts each aggregate's routes file directly without a separate
    // DI container.  No style-level startup block to splice today.
    return [];
  },

  emitForAggregate(agg: AggregateIR, ctx: EmitCtx): readonly EmittedArtifact[] {
    // Wraps the existing aggregate-scoped `buildRoutesFile`.  Emits
    // ONE artifact (the routes file) per aggregate with the
    // `http-routes` byLayer category so the layout adapter routes
    // it to `http/<lowerFirst>.routes.ts`.
    const owningCtx = contextOf(ctx, agg.name);
    if (!owningCtx) return [];
    const enriched = agg as EnrichedAggregateIR;
    const repo = findRepoFor(owningCtx, agg.name);
    // Audit + provenance + trace flags mirror the orchestrator's call
    // site (`emit.ts`); today the orchestrator computes them from the
    // deployable's settings + the system-wide audit gate.  We pass
    // `false` for audit/provenance today (the orchestrator's gate
    // doesn't currently flow into the adapter signature); `emitTrace`
    // threads through normally.
    const content = buildRoutesFile(enriched, repo, owningCtx, false, false, !!ctx.emitTrace);
    const category: HonoArtifactCategory = "http-routes";
    return [
      {
        name: routesFileName(agg.name),
        content,
        category,
        aggregateName: agg.name,
      } as EmittedArtifact,
    ];
  },
};
