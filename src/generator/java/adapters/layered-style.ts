// ---------------------------------------------------------------------------
// layered — the real StyleAdapter for the java platform: the idiomatic
// Spring Controller → Service → Repository shape.  One application
// service per aggregate, one @RestController per aggregate, services
// call the repository directly (no command/handler indirection).
//
// Granularity note (same as dotnet's cqrs adapter): the StyleAdapter
// contract surfaces per-OPERATION emit methods as the design target, but
// the java emitter packages an aggregate's controller + service as
// per-aggregate units.  `emitForAggregate` is the bridge; it is wired by
// the API-layer slice of the java backend plan (the orchestrator emits
// directly until then).
// ---------------------------------------------------------------------------

import type { OperationIR } from "../../../ir/types/loom-ir.js";
import {
  AdapterNotImplementedError,
  type EmitCtx,
  type EmittedArtifact,
  type Lines,
  type StyleAdapter,
} from "../../_adapters/index.js";

const realSiblings = (): readonly string[] => ["layered"];

export const layeredStyleAdapter: StyleAdapter = {
  name: "layered",
  supportedStrategies: ["state", "eventLog"],
  supportedLayouts: ["byLayer", "byFeature"],

  emitEndpoint(_op: OperationIR, _ctx: EmitCtx): Lines {
    // Per-op extraction is deferred exactly as on dotnet — the
    // controller emitter packages all of an aggregate's routes in one
    // file (see the cqrs adapter's granularity note).
    throw new AdapterNotImplementedError("style", "layered", "java", realSiblings());
  },

  emitHandlerOrService(_op: OperationIR, _ctx: EmitCtx): readonly EmittedArtifact[] {
    throw new AdapterNotImplementedError("style", "layered", "java", realSiblings());
  },

  emitDi(_ctx: EmitCtx): Lines {
    // Spring's component scan wires @Service / @RestController /
    // @Repository beans — layered needs no explicit DI registration.
    return [];
  },
};
