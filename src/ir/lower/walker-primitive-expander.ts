// System expand-context builder — the per-UI index of aggregates / workflows,
// derived once from the lowered system shape.
//
// Consumed in `lower.ts` by the scaffold post-passes (`classifyPage`'s
// name-context, the non-constructible drops, the emit-path side effects).  The
// scaffold pages — including the Home / Workflows dashboards — carry their full
// body tree directly from the macro's `_body-builders.ts` scaffolders, so there
// is no inline sentinel left to expand here.

import type { AggregateIR, BoundedContextIR, SystemIR, UiIR } from "../types/loom-ir.js";

/** The per-UI declaration index.  Carried as a struct so callers don't have to
 *  rethread the same derived maps; `lowerSystem` builds it once at top level. */
export interface WalkerExpandContext {
  ui: UiIR;
  /** Aggregate by name — every reachable bounded context across the system. */
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
  /** Owning bounded context per aggregate. */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR>;
  /** Workflow by name. */
  workflowsByName: ReadonlyMap<string, import("../types/loom-ir.js").WorkflowIR>;
}

/** Build the expand context from the system + a specific UI.  Used by
 *  `lowerSystem`'s post-processing pass and by tests. */
export function buildExpandContext(sys: SystemIR, ui: UiIR): WalkerExpandContext {
  const aggregatesByName = new Map<string, AggregateIR>();
  const bcByAggregate = new Map<string, BoundedContextIR>();
  const workflowsByName = new Map<string, import("../types/loom-ir.js").WorkflowIR>();
  for (const m of sys.subdomains) {
    for (const ctx of m.contexts) {
      for (const agg of ctx.aggregates) {
        aggregatesByName.set(agg.name, agg);
        bcByAggregate.set(agg.name, ctx);
      }
      for (const wf of ctx.workflows) {
        workflowsByName.set(wf.name, wf);
      }
    }
  }
  return {
    ui,
    aggregatesByName,
    bcByAggregate,
    workflowsByName,
  };
}
