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
import { contextHasAuditedTarget } from "../../../../ir/util/audit-capability.js";
import { contextsHaveProvenancedField } from "../../../../ir/util/prov-id.js";
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
  supportedStrategies: ["state"],
  // Both layouts: the layout adapter only remaps file paths (it's decoupled
  // from the style — layout-surface.ts), so `layered` emits identically into
  // `byLayer` or `byFeature`.  Exercised end-to-end by hono-by-feature.test.ts.
  supportedLayouts: ["byLayer", "byFeature"],

  emitEndpoint(_op: OperationIR, _ctx: EmitCtx): Lines {
    // Per-op extraction requires splitting `buildRoutesFile` into a
    // per-op `OpenAPIHono.openapi(...)` registration.  Deferred to
    // F6d (orchestrator rewire) where the per-aggregate routes file
    // gets decomposed.
    throw new AdapterNotImplementedError("style", "layered", "node", realSiblings());
  },

  emitHandlerOrService(_op: OperationIR, _ctx: EmitCtx): readonly EmittedArtifact[] {
    // Hono's "layered" style has no per-op handler files — the routes
    // file holds every op's handler body inline.  Per-op extraction
    // would require synthesising file boundaries that don't exist
    // today; deferred to F6d.
    throw new AdapterNotImplementedError("style", "layered", "node", realSiblings());
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
    //
    // Audit + provenance gates are re-derived from the context
    // surface — same predicates the orchestrator computes inline
    // (`emit.ts:contextsHaveProvenancedField` / per-op `audited`
    // flag).  Threaded as flags so the orchestrator rewire can drop
    // the inline call and dispatch through this adapter without
    // losing the gate behavior.
    const owningCtx = contextOf(ctx, agg.name);
    if (!owningCtx) return [];
    const enriched = agg as EnrichedAggregateIR;
    const repo = findRepoFor(owningCtx, agg.name);
    const emitProvenance = contextsHaveProvenancedField(ctx.contexts);
    // Shared predicate: audited operations ∪ creates ∪ destroys (mirrors
    // emit.ts's `contextHasAuditedTarget` gate so lifecycle-only-audited
    // systems still get the audit instrumentation in system mode).
    const emitAudit = ctx.contexts.some(contextHasAuditedTarget);
    const content = buildRoutesFile(
      enriched,
      repo,
      owningCtx,
      emitAudit,
      emitProvenance,
      !!ctx.emitTrace,
      // `persistence: mikroorm` → the history flush runs on the EntityManager
      // (`db.transactional` + `em.insert(<Row>, …)`).  drizzle keeps the false
      // default, so its routes stay byte-identical.
      ctx.deployable.persistence === "mikroorm",
    );
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
