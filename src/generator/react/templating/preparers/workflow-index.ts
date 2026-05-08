// ---------------------------------------------------------------------------
// View-model preparer for the workflows index page.  Mirrors the
// legacy buildWorkflowsIndexPage in workflow-builder.ts: a card per
// workflow with humanised name + parameter signature + Run button.
// ---------------------------------------------------------------------------

import type {
  BoundedContextIR,
  TypeIR,
  WorkflowIR,
} from "../../../../ir/loom-ir.js";
import { humanize, snake } from "../../../../util/naming.js";
import type { WorkflowsIndexVM } from "../view-models.js";

export function prepareWorkflowsIndexVM(
  contexts: BoundedContextIR[],
): WorkflowsIndexVM {
  const all: WorkflowIR[] = [];
  for (const ctx of contexts) {
    for (const wf of ctx.workflows) all.push(wf);
  }
  all.sort((a, b) => a.name.localeCompare(b.name));
  return {
    cards: all.map((wf) => {
      const slug = snake(wf.name);
      return {
        slug,
        humanWorkflow: humanize(wf.name),
        params: wf.params.map((p) => ({
          name: p.name,
          humanName: humanize(p.name),
          typeLabelJson: JSON.stringify(typeLabel(p.type)),
        })),
        hasParams: wf.params.length > 0,
      };
    }),
  };
}

/** Human-readable type label for a workflow parameter, embedded as
 *  a JS string literal so JSX doesn't try to parse `Id<Product>` as
 *  an opening tag. */
function typeLabel(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      return t.name;
    case "id":
      return `Id<${t.targetName}>`;
    case "enum":
      return t.name;
    case "valueobject":
      return t.name;
    case "entity":
      return t.name;
    case "array":
      return `${typeLabel(t.element)}[]`;
    case "optional":
      return `${typeLabel(t.inner)}?`;
  }
}
