// ---------------------------------------------------------------------------
// View-model preparer for per-workflow form pages.
// (`pages/workflows/<slug>.tsx`).  Reuses the field-input-* templates
// shared with page-new + operation-modal.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  WorkflowIR,
} from "../../../../ir/loom-ir.js";
import { camel, humanize, plural, snake } from "../../../../util/naming.js";
import {
  componentsForFields,
  idTargetHookVar,
  idTargetsInFields,
  initialValuesTs,
  needsController,
} from "../../form-helpers.js";
import type { WorkflowFormVM } from "../view-models.js";
import { prepareFormFieldVM } from "./form-fields.js";

function pascal(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

export function prepareWorkflowFormVM(
  wf: WorkflowIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): WorkflowFormVM {
  const slug = snake(wf.name);
  const fields = wf.params.map((p) => ({
    name: p.name,
    type: p.type,
    optional: false,
  }));
  const idTargets = idTargetsInFields(fields, ctx, aggregatesByName);
  const idHookImportLines = idTargets.map(
    (t) =>
      `import { useAll${pascal(plural(t.name))} } from "../../api/${camel(t.name)}";`,
  );
  const idHookCalls = idTargets.map(
    (t) =>
      `  const ${idTargetHookVar(t)} = useAll${pascal(plural(t.name))}();`,
  );
  const useCtrl = needsController(fields, ctx);
  const useFormImports = useCtrl ? "useForm, Controller" : "useForm";
  const destructured = useCtrl
    ? "{ register, handleSubmit, control, formState: { errors } }"
    : "{ register, handleSubmit, formState: { errors } }";
  const mantineImports = [
    "Stack",
    "Title",
    "Button",
    "Group",
    "Anchor",
    "Text",
    "Card",
    "Breadcrumbs",
    ...componentsForFields(fields, ctx),
  ]
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
  const fieldVMs = wf.params.map((p) =>
    prepareFormFieldVM(
      p.name,
      p.type,
      ctx,
      `workflow-${slug}-input-${p.name}`,
      aggregatesByName,
    ),
  );
  return {
    workflowPascal: pascal(wf.name),
    componentName: `${pascal(wf.name)}WorkflowPage`,
    slug,
    humanWorkflow: humanize(wf.name),
    mantineImports,
    idHookImportLines,
    idHookCalls,
    useFormImports,
    destructured,
    defaultValuesTs: initialValuesTs(fields, ctx),
    hasParams: wf.params.length > 0,
    fields: fieldVMs,
  };
}
