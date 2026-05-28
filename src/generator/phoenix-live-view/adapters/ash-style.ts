// ---------------------------------------------------------------------------
// ash — the real StyleAdapter for the phoenixLiveView platform.
//
// Ash's architectural style is unusual: an Ash.Domain module groups
// resources, and resources expose their actions as the HTTP-callable
// surface (via AshJsonApi / AshPhoenix routers, or directly via
// controller-thin shells the orchestrator emits today).  There's no
// CQRS dispatcher and no per-op handler module — actions ARE the
// operations.
//
// That makes the per-op StyleAdapter contract a particularly bad fit
// today.  The per-aggregate `emitForAggregate` is also a weak match:
// Ash emits AT THE CONTEXT level (the Ash.Domain module groups every
// resource in the context).  For F7b we cover the parts that DO fit
// — the style-level DI registration (ash_domains config) — and
// expose `emitDi` as the real method.  `emitForAggregate` returns []
// because the per-aggregate Resource emission is handled by the
// ashPostgres PersistenceAdapter (F7a), not by the style.
// ---------------------------------------------------------------------------

import type { AggregateIR, OperationIR } from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";
import {
  AdapterNotImplementedError,
  type EmitCtx,
  type EmittedArtifact,
  type Lines,
  type StyleAdapter,
} from "../../_adapters/index.js";
import { toModulePrefix, toSnakeApp } from "./ash-postgres-persistence.js";

function appNameOf(ctx: EmitCtx): string {
  return toSnakeApp(ctx.deployable.name);
}

function appModuleOf(ctx: EmitCtx): string {
  return toModulePrefix(appNameOf(ctx));
}

const realSiblings = (): readonly string[] => ["ash"];

export const ashStyleAdapter: StyleAdapter = {
  name: "ash",
  supportedStrategies: ["stateBased"],
  supportedLayouts: ["byFeature"],

  emitEndpoint(_op: OperationIR, _ctx: EmitCtx): Lines {
    // Ash actions ARE the endpoints (via AshJsonApi); there is no
    // per-op controller-route file to emit.  The orchestrator's
    // `emitApiControllers` is per-aggregate today (a thin
    // <Agg>Controller shell), but per-op decomposition would require
    // a new emit slice that doesn't exist.  Deferred to F7d.
    throw new AdapterNotImplementedError("style", "ash", "phoenixLiveView", realSiblings());
  },

  emitHandlerOrService(_op: OperationIR, _ctx: EmitCtx): readonly EmittedArtifact[] {
    // Same per-op caveat — Ash's "handler" is the action body itself,
    // declared inside the Resource module that the ashPostgres
    // PersistenceAdapter already emits.  No per-op file boundary.
    throw new AdapterNotImplementedError("style", "ash", "phoenixLiveView", realSiblings());
  },

  emitDi(ctx: EmitCtx): Lines {
    // `config :<app>, ash_domains: [...]` — the application-level
    // registration of every Ash.Domain module the deployable hosts.
    // Without this `mix compile --warnings-as-errors` rejects with
    // "Domain <Mod> is not present in :ash_domains".  Mirrors the
    // `renderConfig` template in the orchestrator.  Each context's
    // domain module is `<AppModule>.<PascalContextName>`.
    const appName = appNameOf(ctx);
    const appModule = appModuleOf(ctx);
    const domains = ctx.contexts.map((c) => `${appModule}.${upperFirst(c.name)}`).join(", ");
    return [`config :${appName},`, `  ash_domains: [${domains}]`];
  },

  emitForAggregate(_agg: AggregateIR, _ctx: EmitCtx): readonly EmittedArtifact[] {
    // Ash's per-aggregate emission lives in the ashPostgres
    // PersistenceAdapter (the Resource module fuses schema + actions
    // in one .ex file).  The style adapter contributes per-context
    // pieces, not per-aggregate; returning `[]` keeps the optional
    // contract honest without overlapping with persistence.
    return [];
  },
};
