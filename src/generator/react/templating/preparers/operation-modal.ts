// ---------------------------------------------------------------------------
// View-model preparer for an aggregate operation's modal-form pair
// (the `function openXModal` + `function XForm` block emitted at
// module scope after a detail page's default export).  Replaces
// the legacy renderOperationModalFn in pages-builder.ts so detail-
// page modals render through the per-pack templates that page-new
// uses for its inputs.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  OperationIR,
} from "../../../../ir/loom-ir.js";
import { humanize, snake, plural } from "../../../../util/naming.js";
import {
  idTargetHookVar,
  idTargetsInFields,
  initialValuesTs,
  needsController,
} from "../../form-helpers.js";
import type { OperationModalVM } from "../view-models.js";
import { prepareFormFieldVM } from "./form-fields.js";

function pascal(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

export function prepareOperationModalVM(
  agg: AggregateIR,
  op: OperationIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): OperationModalVM {
  const slug = snake(plural(agg.name));
  const opFields = op.params.map((p) => ({ type: p.type }));
  const useCtrl = needsController(opFields, ctx);
  const destructured = useCtrl
    ? "{ register, handleSubmit, control, formState: { errors } }"
    : "{ register, handleSubmit, formState: { errors } }";
  const opIdTargets = idTargetsInFields(opFields, ctx, aggregatesByName);
  const idHookCalls = opIdTargets.map(
    (t) => `  const ${idTargetHookVar(t)} = useAll${plural(t.name)}();`,
  );
  const fieldVMs = op.params.map((p) =>
    prepareFormFieldVM(
      p.name,
      p.type,
      ctx,
      `${slug}-op-${op.name}-input-${p.name}`,
      aggregatesByName,
    ),
  );
  return {
    aggregateName: agg.name,
    slug,
    opName: op.name,
    opPascal: pascal(op.name),
    humanOp: humanize(op.name),
    hasParams: op.params.length > 0,
    idHookCalls,
    destructured,
    defaultValuesTs: initialValuesTs(
      op.params.map((p) => ({ name: p.name, type: p.type, optional: false })),
      ctx,
    ),
    fields: fieldVMs,
  };
}
