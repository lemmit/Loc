// ---------------------------------------------------------------------------
// View-model preparer for the aggregate `new` (create) page.
// Mirrors the legacy buildNewPage in pages-builder.ts: form layout
// with breadcrumbs + eyebrow + cards + the Create<Aggregate>Request
// hooked up to React Hook Form + zodResolver.
//
// Form fields delegate to prepareFormFieldVM; the renderer pre-
// renders each into HTML so the page template stays flat.
// ---------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR } from "../../../../ir/loom-ir.js";
import { camel, humanize, plural, snake } from "../../../../util/naming.js";
import {
  componentsForFields,
  idTargetHookVar,
  idTargetsInFields,
  initialValuesTs,
  needsController,
} from "../../form-helpers.js";
import type { NewPageVM } from "../view-models.js";
import { prepareFormFieldVM } from "./form-fields.js";

export function prepareNewPageVM(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): NewPageVM {
  const slug = snake(plural(agg.name));
  // Optional fields are excluded from the create form, matching the
  // legacy builder.  Users add them later via update-flow operations.
  const fields = agg.fields.filter((f) => !f.optional);
  const idTargets = idTargetsInFields(fields, ctx, aggregatesByName);
  const idHookImportLines = idTargets.map(
    (t) =>
      `import { useAll${plural(t.name)} } from "../../api/${camel(t.name)}";`,
  );
  const idHookCalls = idTargets.map(
    (t) => `  const ${idTargetHookVar(t)} = useAll${plural(t.name)}();`,
  );
  const useCtrl = needsController(fields, ctx);
  const useFormImports = useCtrl ? "useForm, Controller" : "useForm";
  const destructuredHookFields = useCtrl
    ? "{ register, handleSubmit, control, formState: { errors } }"
    : "{ register, handleSubmit, formState: { errors } }";
  const mantineImports = [
    "Stack",
    "Title",
    "Button",
    "Group",
    "Card",
    "Text",
    "Anchor",
    "Breadcrumbs",
    ...componentsForFields(fields, ctx),
  ]
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
  const fieldVMs = fields.map((f) =>
    prepareFormFieldVM(
      f.name,
      f.type,
      ctx,
      `${slug}-new-input-${f.name}`,
      aggregatesByName,
    ),
  );
  const humanAgg = humanize(agg.name);
  return {
    aggregateName: agg.name,
    aggregateNameCamel: camel(agg.name),
    slug,
    humanAgg,
    humanAggLower: humanAgg.toLowerCase(),
    humanPlural: humanize(plural(agg.name)),
    mantineImports,
    idHookImportLines,
    idHookCalls,
    useFormImports,
    destructuredHookFields,
    defaultValuesTs: initialValuesTs(fields, ctx),
    fields: fieldVMs,
  };
}
