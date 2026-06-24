// ---------------------------------------------------------------------------
// layered — the StyleAdapter for elixir's plain-Phoenix pipeline (DSL
// spelling `serviceLayer`; adapter key `layered`, matching java/dotnet/node).
//
// This style is selected for the elixir backend.  Plain Phoenix's request
// pipeline — controller → context module (the bounded-context service facade) →
// repository/schema — IS the classic layered/service-layer shape, so it takes
// the real pipeline name on the `application:` axis.
//
// It does not decompose per-op today (`emitEndpoint`/`emitHandlerOrService`
// throw); the per-aggregate emission lives in the `vanilla/` subtree.
//
// The one nominal method is `emitDi`: plain Phoenix needs no domain
// registration, so this emits nothing.  (Today this is moot because the emit
// does not consume the threaded style adapter; returning `[]` keeps the seam
// correct for a future rewire and documents the intent.)
// ---------------------------------------------------------------------------

import type { AggregateIR, OperationIR } from "../../../ir/types/loom-ir.js";
import {
  AdapterNotImplementedError,
  type EmitCtx,
  type EmittedArtifact,
  type Lines,
  type StyleAdapter,
} from "../../_adapters/index.js";

const realSiblings = (): readonly string[] => ["ash", "layered"];

export const layeredStyleAdapter: StyleAdapter = {
  name: "layered",
  supportedStrategies: ["state"],
  supportedLayouts: ["byFeature"],

  emitEndpoint(_op: OperationIR, _ctx: EmitCtx): Lines {
    // Per-op decomposition not implemented — the vanilla controllers are
    // per-aggregate (emitted by the `vanilla/` subtree).
    throw new AdapterNotImplementedError("style", "layered", "elixir", realSiblings());
  },

  emitHandlerOrService(_op: OperationIR, _ctx: EmitCtx): readonly EmittedArtifact[] {
    throw new AdapterNotImplementedError("style", "layered", "elixir", realSiblings());
  },

  emitDi(_ctx: EmitCtx): Lines {
    // Plain Phoenix: no domain registration / DI block.
    return [];
  },

  emitForAggregate(_agg: AggregateIR, _ctx: EmitCtx): readonly EmittedArtifact[] {
    // Per-aggregate emission lives in the vanilla subtree, not the style
    // adapter.  Empty keeps the optional contract honest.
    return [];
  },
};
