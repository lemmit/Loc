// ---------------------------------------------------------------------------
// layered — the StyleAdapter for elixir's plain-Phoenix pipeline (DSL
// spelling `serviceLayer`; adapter key `layered`, matching java/dotnet/node).
//
// `foundation: vanilla` selects this style.  Plain Phoenix's request pipeline
// — controller → context module (the bounded-context service facade) →
// repository/schema — IS the classic layered/service-layer shape, so it takes
// the real pipeline name on the `application:` axis instead of echoing the
// foundation's name.  (The earlier `vanilla` style was a foundation value
// masquerading as a pipeline shape — it conflated the foundation and
// application axes; `application: vanilla` is no longer a thing.)
//
// Sibling of `ashStyleAdapter`.  Like the Ash style it does not decompose
// per-op today (`emitEndpoint`/`emitHandlerOrService` throw); the per-aggregate
// emission lives in the `vanilla/` subtree (selected by the `foundation`
// branch).
//
// The one nominal method is `emitDi`: ash injects an `ash_domains:` config
// block — plain Phoenix needs no domain registration, so this emits nothing.
// (Today this is moot because the vanilla emit does not consume the threaded
// style adapter; returning `[]` keeps the seam correct for a future rewire and
// documents the intent.)
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
    // per-aggregate (emitted by the `vanilla/` subtree).  Mirrors the ash
    // style's posture.
    throw new AdapterNotImplementedError("style", "layered", "elixir", realSiblings());
  },

  emitHandlerOrService(_op: OperationIR, _ctx: EmitCtx): readonly EmittedArtifact[] {
    throw new AdapterNotImplementedError("style", "layered", "elixir", realSiblings());
  },

  emitDi(_ctx: EmitCtx): Lines {
    // Plain Phoenix: no Ash domain registration / DI block.
    return [];
  },

  emitForAggregate(_agg: AggregateIR, _ctx: EmitCtx): readonly EmittedArtifact[] {
    // Per-aggregate emission lives in the vanilla subtree, not the style
    // adapter (parallels ash → ashPostgres).  Empty keeps the optional
    // contract honest.
    return [];
  },
};
