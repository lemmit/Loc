import type { IdValueType, WireField, WorkflowIR } from "../types/loom-ir.js";

/** The correlation field's wire row (`source: "id"`) on an observable
 *  workflow's `instanceWireShape` — its id targetName + value type drive the
 *  `/instances/{id}` path-param type on every backend. */
export function workflowCorrWireField(wf: WorkflowIR): WireField {
  const corr = (wf.instanceWireShape ?? []).find((f) => f.source === "id");
  if (!corr) {
    throw new Error(`workflow-instances: '${wf.name}' has no id-shaped instance field`);
  }
  return corr;
}

/** The correlation id's value type (guid/int/long/string).  The
 *  `/instances/{id}` param schema derives from this on every backend —
 *  guid → uuid-format string, int/long → integer, string → plain string —
 *  so the parity gate's path-param dimension agrees by construction
 *  (docs/old/plans/non-guid-id-http-params.md). */
export function workflowCorrIdValueType(wf: WorkflowIR): IdValueType {
  const t = workflowCorrWireField(wf).type;
  const inner = t.kind === "optional" ? t.inner : t;
  return inner.kind === "id" ? inner.valueType : "guid";
}
