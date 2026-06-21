import type { ExprIR } from "../../ir/types/loom-ir.js";
import { lowerFirst, snake, upperFirst } from "../../util/naming.js";
import { namedArgValue, stringNamed } from "../_walker/shared/args.js";
import type { WalkContext } from "../_walker/walker-core.js";
import { type AngularFormControlSpec, addNg, controlInit, fieldInput } from "./form-fields.js";

// ---------------------------------------------------------------------------
// Angular `WorkflowForm(runs: <Wf>)` renderer — the workflow-command form,
// forked from the shared react-hook-form path via the `renderWorkflowForm`
// walker seam.
//
// IDIOMATIC TYPED REACTIVE FORMS — sibling of `renderAngularCreateForm`.  Emits
// a `[formGroup]` / `(ngSubmit)` `<form>` over the workflow's command params;
// the page-shell reads the recorded `AngularWorkflowFormSpec` to build the
// typed `FormGroup`, hoist the `use<Wf>Workflow` mutation, and emit the submit
// handler (`mutateAsync(getRawValue())` → navigate `/workflows`).
// ---------------------------------------------------------------------------

/** Everything the page-shell needs to wire one workflow-command form. */
export interface AngularWorkflowFormSpec {
  formVar: string;
  mutationVar: string;
  mutationFn: string;
  requestType: string;
  importFrom: string;
  submitMethod: string;
  controls: AngularFormControlSpec[];
}

export function renderAngularWorkflowForm(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string | null {
  if (call.kind !== "call") return null;
  const runsArg = namedArgValue(call, "runs");
  const wfName =
    runsArg?.kind === "ref"
      ? runsArg.name
      : runsArg?.kind === "literal" && runsArg.lit === "string"
        ? runsArg.value
        : undefined;
  if (!wfName) {
    return ctx.target.renderComment("WorkflowForm(runs: …): missing 'runs:' workflow ref");
  }
  const workflow = ctx.workflowsByName.get(wfName);
  const bc = ctx.bcByWorkflow?.get(wfName);
  if (!workflow || !bc) {
    return ctx.target.renderComment(
      `WorkflowForm(runs: ${wfName}): workflow not reachable from this UI`,
    );
  }

  const T = upperFirst(workflow.name);
  const ns = stringNamed(call, "testid") ?? `workflow-${snake(workflow.name)}`;
  const importFrom = "../../api/workflows";
  const requestType = `${T}Request`;
  const mutationFn = `use${T}Workflow`;
  const mutationVar = `${lowerFirst(workflow.name)}Run`;
  const formVar = `${lowerFirst(workflow.name)}Form`;
  const submitMethod = `onRun${T}`;

  addNg(ctx, "@angular/forms", "FormControl", "FormGroup", "ReactiveFormsModule");
  addNg(ctx, "@angular/material/button", "MatButtonModule");
  addNg(ctx, importFrom, mutationFn, requestType);
  ctx.usesNavigate = true; // hoists inject(Router) for the redirect

  const fields = workflow.params;
  const inner = "  ".repeat(depth + 1);
  const close = "  ".repeat(depth);
  const fieldMarkup = fields.map((f) => fieldInput(f.name, f.type, bc, ns, ctx));
  const submit = `<button mat-raised-button type="submit" [disabled]="${mutationVar}.isPending()" data-testid="${ns}-submit">Run</button>`;

  ctx.collectedTestids.add(ns);
  ctx.collectedTestids.add(`${ns}-submit`);
  for (const f of fields) ctx.collectedTestids.add(`${ns}-input-${f.name}`);

  const spec: AngularWorkflowFormSpec = {
    formVar,
    mutationVar,
    mutationFn,
    requestType,
    importFrom,
    submitMethod,
    controls: fields.map((f) => ({ name: f.name, init: controlInit(f.type) })),
  };
  ctx.angularWorkflowForms ??= [];
  (ctx.angularWorkflowForms as AngularWorkflowFormSpec[]).push(spec);

  return [
    `<form [formGroup]="${formVar}" (ngSubmit)="${submitMethod}()" data-testid="${ns}">`,
    ...[...fieldMarkup, submit].map((m) => `${inner}${m}`),
    `${close}</form>`,
  ].join("\n");
}
