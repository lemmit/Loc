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

import type { OperationIR, PersistenceStrategy } from "../../ir/types/loom-ir.js";
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
   *  controller / route entry that hands off to a handler or service. */
  emitEndpoint(op: OperationIR, ctx: EmitCtx): Lines;
  /** Handler (cqrs) or service method (layered) for one operation.
   *  Returns one or more artifacts so the layout adapter can route
   *  each to its own file. */
  emitHandlerOrService(op: OperationIR, ctx: EmitCtx): readonly EmittedArtifact[];
  /** Style-level DI / pipeline registration spliced into the
   *  deployable's startup — e.g. `services.AddMediatR(...)` for cqrs,
   *  `services.AddScoped<IOrderService, OrderService>()` for layered. */
  emitDi(ctx: EmitCtx): Lines;
}

/** Capability subset a stub still answers at registration time. */
export type StyleCapabilities = Pick<
  StyleAdapter,
  "name" | "supportedStrategies" | "supportedLayouts"
>;
