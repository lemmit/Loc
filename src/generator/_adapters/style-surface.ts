// ---------------------------------------------------------------------------
// StyleAdapter — the per-(platform × architectural style) emitter slot.
//
// "Style" is the request-pipeline shape — `cqrs` (one handler per
// command via MediatR / a tiny dispatch table), `layered` (a service
// class per aggregate calling repositories directly), `ash` (Phoenix's
// Ash framework's action surface), …  One adapter per style each
// platform supports.  Decoupled from `PersistenceAdapter` because the
// same persistence library composes with multiple styles.
// ---------------------------------------------------------------------------

import type { AggregateIR, OperationIR, PersistenceStrategy } from "../../ir/types/loom-ir.js";
import type { EmitCtx, EmittedArtifact, Lines } from "./types.js";

/** Coarse layout-shape constraints a style requires.  Validator pairs
 *  this with the resolved `LayoutAdapter.name` to reject combinations
 *  the style can't fit (e.g. `cqrs` without a per-feature folder). */
export type LayoutShape = "byLayer" | "byFeature";

export interface StyleAdapter {
  /** Registry key — `style: <name>` resolves to this entry. */
  readonly name: string;
  /** Aggregate persistence strategies this style can drive. */
  readonly supportedStrategies: readonly PersistenceStrategy[];
  /** Layouts this style supports.  The validator intersects with the
   *  resolved `LayoutAdapter.name` to gate combinations. */
  readonly supportedLayouts: readonly LayoutShape[];
  /** HTTP / message-bus endpoint for an aggregate operation —
   *  controller / route entry that hands off to a handler or service.
   *
   *  Today every backend's existing emit code packages an aggregate's
   *  endpoints together (per-aggregate controller, per-aggregate
   *  routes file).  Per-op extraction is a refactor deferred to the
   *  orchestrator-rewire slices (F5d / F6d / F7d).  Real style
   *  adapters that haven't been decomposed yet may throw an
   *  `AdapterNotImplementedError` from this method while still
   *  implementing `emitForAggregate` below. */
  emitEndpoint(op: OperationIR, ctx: EmitCtx): Lines;
  /** Handler (cqrs) or service method (layered) for one operation.
   *  Returns one or more artifacts so the layout adapter can route
   *  each to its own file.  Same per-aggregate-vs-per-op caveat as
   *  `emitEndpoint`. */
  emitHandlerOrService(op: OperationIR, ctx: EmitCtx): readonly EmittedArtifact[];
  /** Style-level DI / pipeline registration spliced into the
   *  deployable's startup — e.g. `services.AddMediatR(...)` for cqrs,
   *  `services.AddScoped<IOrderService, OrderService>()` for layered. */
  emitDi(ctx: EmitCtx): Lines;
  /** Aggregate-scoped emission — the natural unit every existing
   *  backend's style implementation operates on today.  Returns every
   *  artifact (DTOs + commands + queries + handlers + controllers /
   *  routes) the style produces for ONE aggregate, in the same shape
   *  the existing emit fns do.  The orchestrator rewire calls this
   *  per-aggregate; per-op methods above are the refined target
   *  shape future style implementations can decompose to.
   *
   *  Optional today: style implementations that DO have per-op
   *  decomposition can omit this and the orchestrator will route
   *  through `emitEndpoint` / `emitHandlerOrService` instead. */
  emitForAggregate?(agg: AggregateIR, ctx: EmitCtx): readonly EmittedArtifact[];
}

/** Capability subset a stub still answers at registration time. */
export type StyleCapabilities = Pick<
  StyleAdapter,
  "name" | "supportedStrategies" | "supportedLayouts"
>;
