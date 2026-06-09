// ---------------------------------------------------------------------------
// vanilla — the StyleAdapter for elixir `foundation: vanilla` (plain Phoenix
// contexts + controllers + changesets, no Ash action surface).
//
// Sibling of `ashStyleAdapter`; a forward seam registered on the
// `application:` axis so the menu / validation treat the plain-Phoenix style
// as first-class.  Like the Ash style it does not decompose per-op today
// (`emitEndpoint`/`emitHandlerOrService` throw); the per-aggregate emission
// lives in the `vanilla/` subtree (selected by the `foundation` branch).
//
// The one consumed method is `emitDi`: ash injects an `ash_domains:` config
// block — plain Phoenix needs no domain registration, so vanilla emits
// nothing.  (Today this is moot for vanilla because the vanilla emit does not
// consume the threaded style adapter; returning `[]` keeps the seam correct
// for a future rewire and documents the intent.)
// ---------------------------------------------------------------------------

import type { AggregateIR, OperationIR } from "../../../ir/types/loom-ir.js";
import {
  AdapterNotImplementedError,
  type EmitCtx,
  type EmittedArtifact,
  type Lines,
  type StyleAdapter,
} from "../../_adapters/index.js";

const realSiblings = (): readonly string[] => ["ash", "vanilla"];

export const vanillaStyleAdapter: StyleAdapter = {
  name: "vanilla",
  supportedStrategies: ["state"],
  supportedLayouts: ["byFeature"],

  emitEndpoint(_op: OperationIR, _ctx: EmitCtx): Lines {
    // Per-op decomposition not implemented — the vanilla controllers are
    // per-aggregate (emitted by the `vanilla/` subtree).  Mirrors the ash
    // style's posture.
    throw new AdapterNotImplementedError("style", "vanilla", "elixir", realSiblings());
  },

  emitHandlerOrService(_op: OperationIR, _ctx: EmitCtx): readonly EmittedArtifact[] {
    throw new AdapterNotImplementedError("style", "vanilla", "elixir", realSiblings());
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
