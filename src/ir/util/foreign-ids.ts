// ---------------------------------------------------------------------------
// Foreign id brands — the id types a deployable REFERENCES but whose owning
// aggregate it does not HOST, so it must emit the brand itself.
//
// Why this is shared rather than per-backend: the same collection was written
// out four times (hono, python, dotnet, java), and all four drew from the same
// two sources — foreign consumed-event fields and workflow STATE fields.  None
// covered workflow STARTER PARAMS, so `create(orderId: Order id)` on a
// deployable that doesn't host `Order` emitted a reference to an id brand that
// was never declared.  Every one of those backends produced code that failed
// its own compiler, and no vitest-tier gate saw it (the model is valid and
// every emitter "succeeds").
//
// A missing SOURCE is the bug this module exists to make unrepeatable: adding a
// new place ids can be referenced is one edit here, not four.
// ---------------------------------------------------------------------------

import type { TypeIR, WorkflowIR } from "../types/loom-ir.js";

/** Every `TypeIR` position in a workflow that can name a foreign aggregate id:
 *  persisted correlation/saga STATE, plus the STARTER PARAMS a command or
 *  event hands the workflow. */
export function workflowIdTypeSources(workflows: readonly WorkflowIR[]): TypeIR[] {
  const out: TypeIR[] = [];
  for (const w of workflows) {
    for (const f of w.stateFields ?? []) out.push(f.type);
    for (const c of w.creates) for (const p of c.params) out.push(p.type);
  }
  return out;
}

/** The distinct id-target names among `sources` that `hostedIdNames` doesn't
 *  cover — i.e. the brands this deployable has to declare locally. */
export function foreignIdBrandNames(
  hostedIdNames: ReadonlySet<string>,
  sources: readonly TypeIR[],
): string[] {
  return [
    ...new Set(
      sources
        .filter((t): t is Extract<TypeIR, { kind: "id" }> => t.kind === "id")
        .map((t) => t.targetName)
        .filter((n) => !hostedIdNames.has(n)),
    ),
  ];
}
