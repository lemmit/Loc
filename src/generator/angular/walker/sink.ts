import type { AngularActionSpec } from "../action.js";
import type { AngularCreateFormSpec } from "../create-form.js";
import type { AngularDestroyFormSpec } from "../destroy-form.js";
import type { AngularModalSpec } from "../modal.js";
import type { AngularOperationFormSpec } from "../operation-form.js";
import type { AngularWorkflowFormSpec } from "../workflow-form.js";

/** The Angular target's opaque per-walk sink — the six per-primitive spec
 *  lists the Angular render seams (`renderCreateForm` / `renderAction` /
 *  `renderModal` / `renderWorkflowForm` / `renderOperationForm` /
 *  `renderDestroyForm`) accumulate and the Angular page-shell drains to hoist
 *  the matching `FormGroup`s, mutations, and submit methods.
 *
 *  It rides the framework-neutral walker core through the single opaque
 *  `WalkResult.sink` / `Sink.sink` slot (typed `unknown` there so the shared
 *  core never depends on Angular).  Only the Angular target knows this shape —
 *  the other frontends leave the slot untouched. */
export interface AngularWalkerSink {
  forms: AngularCreateFormSpec[];
  actions: AngularActionSpec[];
  modals: AngularModalSpec[];
  workflowForms: AngularWorkflowFormSpec[];
  opForms: AngularOperationFormSpec[];
  destroyForms: AngularDestroyFormSpec[];
}

/** View the Angular sink on a walk context (write side, seams) or a walk
 *  result (read side, page-shell).  The walker seeds `sink` with a shared
 *  empty container on the root context (so child-context spreads share one
 *  object reference); this fills in any missing per-primitive list on first
 *  touch and returns the typed view.  A body with no Angular forms therefore
 *  reads empty lists — byte-identical to the old per-field `?? []` reads. */
export function angularSink(holder: { sink?: unknown }): AngularWalkerSink {
  const h = holder as { sink?: Partial<AngularWalkerSink> };
  h.sink ??= {};
  const s = h.sink;
  s.forms ??= [];
  s.actions ??= [];
  s.modals ??= [];
  s.workflowForms ??= [];
  s.opForms ??= [];
  s.destroyForms ??= [];
  return s as AngularWalkerSink;
}
