// Form family: Form(of:)/Form(runs:)/Form(of:,op:) and the Modal that
// hosts an operation form. The emitters record a FormOfState on the
// shared sink (ctx.formOfs) which the page shell reads afterwards to
// emit the useForm/mutation-hook wiring. emitModal back-patches the
// trigger surface onto the operation state its Form child just pushed,
// so it must share the same sink and live alongside the form emitters.

import type { AggregateIR, BoundedContextIR, ExprIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { humanize, lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import {
  idTargetHookVar,
  idTargetsInFields,
  initialValuesTs,
  needsController,
} from "../../react/form-helpers.js";
import { prepareFormFieldVM } from "../../react/templating/preparers/form-fields.js";
import { renderFormField } from "../../react/templating/render.js";
import {
  addImport,
  addImportsForPrimitive,
  registerFormFieldImports,
  renderPrimitive,
} from "../render-primitive.js";
import {
  lambdaArg,
  namedArgValue,
  positionalArgs,
  stringNamed,
  unwrapTextLiteral,
} from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import {
  emitExpr,
  emitStmt,
  extendLambdaParams,
  firstPositionalContent,
  propagateChildFlags,
  testidAttr,
  walk,
} from "../walker-core.js";
import { emitActionThen } from "./controls.js";

/** `CreateForm(of: <Agg>)` — named-leaf entry for the create-form
 *  variant.  Same shared codegen as `Form(of:)` / `Form(creates:)`:
 *  delegates to `emitFormOfAggregate`, which builds the per-field
 *  view models and pushes a `FormOfState` on the shell sink. */
export function emitCreateForm(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  return emitFormOfAggregate(call, ctx, depth);
}

/** `OperationForm(of: <Agg>, op: <opName>)` or
 *  `OperationForm(<instance>.<op>)` — named-leaf entry for the
 *  operation-modal form.  Accepts both shapes the legacy
 *  `Form(<inst>.<op>)` / `Form(of:, op:)` dispatch covered: the
 *  instance-member form binds to a record in scope (lambda or
 *  param), the flat-named form resolves the id from the route. */
export function emitOperationForm(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  _depth: number,
): string {
  const ofArg = namedArgValue(call, "of");
  const opArg = namedArgValue(call, "op");
  if (ofArg && opArg && ofArg.kind === "ref" && opArg.kind === "ref") {
    return emitFormOfOperationByName(call, ctx, ofArg.name, opArg.name);
  }
  const opRef = positionalArgs(call)[0];
  if (opRef && opRef.kind === "member" && opRef.receiver.kind === "ref") {
    return emitFormOfOperation(call, ctx, opRef);
  }
  return ctx.target.renderComment(
    `OperationForm: expected (of: <Agg>, op: <opName>) or (<instance>.<op>)`,
  );
}

/** `DestroyForm(of: <Agg>, then?: navigate(...))` — the named-leaf
 *  confirmation form for the aggregate's CANONICAL destroy
 *  (loom-forms.md).  Confirmation-only v1 (the canonical destroy takes
 *  no params): a destructive button that `window.confirm()`s, then
 *  dispatches `useDelete<Agg>` with the route id and navigates —
 *  default: the aggregate's list route; override via `then:
 *  navigate(<Page>)`.  Named destroys (`for: <inst>.<name>`) are a
 *  follow-up. */
export function emitDestroyForm(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const ofArg = namedArgValue(call, "of");
  if (!ofArg || ofArg.kind !== "ref") {
    return ctx.target.renderComment(`DestroyForm: expected (of: <Agg>)`);
  }
  const agg = ctx.aggregatesByName.get(ofArg.name);
  if (!agg) {
    return ctx.target.renderComment(`DestroyForm(of: ${ofArg.name}): aggregate not found`);
  }
  if (!agg.canonicalDestroy) {
    return ctx.target.renderComment(
      `DestroyForm(of: ${agg.name}): no canonical destroy — declare 'destroy { }' (or use 'with crudish')`,
    );
  }
  // Hoist the delete-mutation hook to function top.  `useDelete<Agg>()`
  // takes no hook-time args (the id goes to `mutateAsync`).
  const localVar = `delete${agg.name}`;
  const hookName = `useDelete${agg.name}`;
  if (!ctx.actionMutations.some((m) => m.localVar === localVar)) {
    ctx.actionMutations.push({ localVar, hookName, aggCamel: lowerFirst(agg.name), idExpr: "" });
  }
  // The confirm handler reads the route `id` — mark it used so the shell
  // emits the `useParams` destructure (same param the detail pages bind).
  ctx.usedParams.add("id");
  // After a successful delete the record is gone, so the default `then:`
  // navigates to the aggregate's list route (loom-forms.md §submission).
  const thenArg = namedArgValue(call, "then");
  let thenJs: string;
  if (thenArg) {
    thenJs = emitActionThen(thenArg, ctx);
  } else {
    ctx.usesNavigate = true;
    thenJs = `navigate(${JSON.stringify(`/${snake(plural(agg.name))}`)})`;
  }
  const confirmMsg = JSON.stringify(`Delete this ${humanize(agg.name).toLowerCase()}?`);
  const onClick = `() => { if (window.confirm(${confirmMsg})) void ${localVar}.mutateAsync(id ?? "").then(() => { ${thenJs}; }); }`;
  const testidNamespace = stringNamed(call, "testid") ?? `${snake(plural(agg.name))}-destroy`;
  ctx.collectedTestids.add(testidNamespace);
  return renderPrimitive(ctx, "primitive-button", {
    label: `Delete ${humanize(agg.name)}`,
    onClick,
    hasOnClick: true,
    disabled: undefined,
    hasDisabled: false,
    loading: `${localVar}.isPending`,
    hasLoading: true,
    testidAttr: ` data-testid="${testidNamespace}"`,
    styleAttr: "",
  });
}

/** `WorkflowForm(runs: <Wf>)` — named-leaf entry for the
 *  workflow-run form.  Delegates to the same `emitFormRuns` the
 *  legacy `Form(runs:)` dispatch used. */
export function emitWorkflowForm(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const runsArg = namedArgValue(call, "runs");
  if (!runsArg) {
    return ctx.target.renderComment(`WorkflowForm: missing 'runs: <Workflow>'`);
  }
  return emitFormRuns(call, ctx, depth, runsArg);
}

/** Like `emitFormOfOperation` but addressed by aggregate name +
 *  op name (`Form(of: <Agg>, op: <opName>)`) instead of an
 *  instance-qualified member.  No in-scope record needed — the
 *  mutation hook resolves the id from the route `id`.  Used by
 *  the auto-fanning `scaffoldOperations(of: <Agg>)` primitive. */
function emitFormOfOperationByName(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  aggName: string,
  opName: string,
): string {
  const agg = ctx.aggregatesByName.get(aggName);
  const bc = ctx.bcByAggregate.get(aggName);
  if (!agg || !bc) {
    return ctx.target.renderComment(`Form(of: ${aggName}, op: ${opName}): aggregate not found`);
  }
  const op = agg.operations.find((o) => o.name === opName && o.visibility === "public");
  if (!op) {
    return ctx.target.renderComment(
      `Form(of: ${aggName}, op: ${opName}): no public operation '${opName}' on ${aggName}`,
    );
  }
  const fields = op.params;
  const fieldsForHelpers = fields.map((f) => ({ ...f, optional: false }));
  const testidNamespace = stringNamed(call, "testid") ?? `${snake(plural(agg.name))}-op-${op.name}`;
  const prepared = prepareFormFields(ctx, fields, fieldsForHelpers, bc, testidNamespace);
  addImport(
    ctx,
    `../api/${lowerFirst(agg.name)}`,
    `${upperFirst(op.name)}${agg.name}Request`,
    `use${upperFirst(op.name)}${agg.name}`,
  );
  ctx.collectedTestids.add(testidNamespace);
  ctx.collectedTestids.add(`${testidNamespace}-form`);
  ctx.collectedTestids.add(`${testidNamespace}-submit`);
  ctx.formOfs.push({
    kind: "operation",
    agg,
    op,
    bc,
    fields,
    idExpr: `id ?? ""`,
    idTargets: prepared.idTargets,
    useController: prepared.useController,
    defaultValuesTs: prepared.defaultValuesTs,
    testidNamespace,
    fieldHtmls: prepared.fieldHtmls,
    onSubmitJs: null,
    triggerLabel: humanize(op.name),
    triggerPrimary: true,
  });
  return "";
}

interface PreparedForm {
  idTargets: AggregateIR[];
  useController: boolean;
  defaultValuesTs: string;
  fieldHtmls: string[];
}

/** Shared field preparation for all three Form variants.  Resolves the
 *  `X id` targets / `Controller` need / RHF default-values literal,
 *  prepares each field's view-model (driving its `field-input-*`
 *  template), and registers the universal RHF imports, the per-idTarget
 *  `useAll<X>` imports, the per-field template imports, and the per-field
 *  testids.  Import insertion order is irrelevant (the import block is
 *  sorted on render), so callers register their variant-specific
 *  request/hook import separately; the per-field testids are added here
 *  because that ordering is identical across variants. */
function prepareFormFields(
  ctx: WalkContext,
  fields: { name: string; type: TypeIR }[],
  fieldsForHelpers: { name: string; type: TypeIR; optional: boolean }[],
  bc: BoundedContextIR,
  testidNamespace: string,
): PreparedForm {
  const aggregatesByNameMut = new Map(ctx.aggregatesByName);
  const idTargets = idTargetsInFields(fieldsForHelpers, bc, aggregatesByNameMut);
  const useController = needsController(fieldsForHelpers, bc, aggregatesByNameMut);
  const defaultValuesTs = initialValuesTs(fieldsForHelpers, bc);
  const fieldVMs = fields.map((f) =>
    prepareFormFieldVM(
      f.name,
      f.type,
      bc,
      `${testidNamespace}-input-${f.name}`,
      aggregatesByNameMut,
    ),
  );
  // RHF + zodResolver are universal across all React packs; the
  // per-idTarget hook paths are dynamic per-aggregate.  Per-field input
  // components come from each `field-input-*` template's import
  // declaration in pack.json (recursing into value-object children).
  addImport(ctx, "react-hook-form", "useForm");
  if (useController) addImport(ctx, "react-hook-form", "Controller");
  addImport(ctx, "@hookform/resolvers/zod", "zodResolver");
  for (const t of idTargets) {
    addImport(ctx, `../api/${lowerFirst(t.name)}`, `useAll${plural(t.name)}`);
  }
  for (const vm of fieldVMs) registerFormFieldImports(ctx, vm);
  const fieldHtmls = fieldVMs.map((vm) => renderFormField(vm, ctx.pack));
  for (const vm of fieldVMs) ctx.collectedTestids.add(vm.testId);
  return { idTargets, useController, defaultValuesTs, fieldHtmls };
}

/** Walk an optional `onSubmit:` lambda into the handler-body string,
 *  rebinding its source param to `vals` and exposing the form's
 *  shell-locals (the mutation hook + RHF handles + per-idTarget query
 *  hooks) so refs resolve.  Returns null when there's no `onSubmit:`
 *  (callers then emit the pack's default submit body). */
function emitFormOnSubmit(
  ctx: WalkContext,
  call: ExprIR & { kind: "call" },
  idTargets: AggregateIR[],
  mutationLocal: string,
): string | null {
  const onSubmit = lambdaArg(call, "onSubmit");
  if (!onSubmit) return null;
  const shellLocals = new Set<string>([
    mutationLocal,
    "register",
    "handleSubmit",
    "control",
    "errors",
    ...idTargets.map((t) => idTargetHookVar(t)),
  ]);
  const childCtx: WalkContext = {
    ...ctx,
    lambdaParams: extendLambdaParams(ctx, onSubmit.param, "vals"),
    shellLocals,
  };
  let onSubmitJs: string | null = null;
  if (onSubmit.body) {
    onSubmitJs = emitExpr(onSubmit.body, childCtx);
  } else if (onSubmit.block && onSubmit.block.length > 0) {
    const stmts = onSubmit.block.map((s) => emitStmt(s, childCtx)).join(" ");
    onSubmitJs = `{ ${stmts} }`;
  }
  propagateChildFlags(ctx, childCtx);
  return onSubmitJs;
}

interface FormSubmitConfig {
  mutationCall: string;
  successMessage: string;
  redirectStmt: string;
  submitPendingExpr: string;
  submitLabel: string;
}

/** Shared render for the inline create/run forms (`Form(of:)` and
 *  `Form(runs:)`): emits the pack's default submit body when no explicit
 *  `onSubmit:` was given, then renders the `primitive-form-of` shell.
 *  The op-form variant (`Form(<instance>.<operation>)`) does NOT use this — it emits
 *  no inline JSX; its shell component is rendered from the recorded
 *  OperationFormState by the page shell. */
function renderFormOfPrimitive(
  ctx: WalkContext,
  call: ExprIR & { kind: "call" },
  depth: number,
  testidNamespace: string,
  fieldHtmls: string[],
  onSubmitJs: string | null,
  cfg: FormSubmitConfig,
): string {
  // The default submit body references the pack's toast lib
  // (`notifications.show` on mantine, `toast.success` on shadcn, …);
  // each pack declares the matching import under
  // `imports["form-default-onsubmit"]`, registered only when this
  // branch actually fires.
  if (onSubmitJs === null) {
    addImportsForPrimitive(ctx, "form-default-onsubmit");
  }
  const submitBody =
    onSubmitJs !== null
      ? onSubmitJs
      : ctx.pack.render("form-default-onsubmit", {
          mutationCall: cfg.mutationCall,
          successMessage: cfg.successMessage,
          redirectStmt: cfg.redirectStmt,
        });
  return renderPrimitive(ctx, "primitive-form-of", {
    fieldHtmls,
    submitBody,
    submitTestid: `${testidNamespace}-submit`,
    submitPendingExpr: cfg.submitPendingExpr,
    submitLabel: cfg.submitLabel,
    testidAttr: testidAttr(call, ctx),
    indent: "  ".repeat(depth + 1),
    innerIndent: "  ".repeat(depth + 2),
    deepIndent: "  ".repeat(depth + 3),
    deeperIndent: "  ".repeat(depth + 4),
    closeIndent: "  ".repeat(depth),
  });
}

function emitFormOfAggregate(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const ofArg = namedArgValue(call, "of");
  const aggName =
    ofArg && ofArg.kind === "ref"
      ? ofArg.name
      : ofArg && ofArg.kind === "literal" && ofArg.lit === "string"
        ? ofArg.value
        : undefined;
  if (!aggName) {
    return ctx.target.renderComment(`Form(of: …): missing 'of:' aggregate ref`);
  }
  const agg = ctx.aggregatesByName.get(aggName);
  const bc = ctx.bcByAggregate.get(aggName);
  if (!agg || !bc) {
    return ctx.target.renderComment(
      `Form(of: ${aggName}): aggregate not found in this UI's reachable contexts`,
    );
  }
  // Optional fields are excluded from create forms — same rule as
  // the scaffold New-page builder (`!f.optional`).  This keeps the
  // first iteration of a form schema focused on what the wire
  // contract REQUIRES; optional fields surface via update-flow
  // operations on the detail page.
  const fields = agg.fields.filter((f) => !f.optional);
  const testidNamespace = stringNamed(call, "testid") ?? `${snake(plural(agg.name))}-new`;
  // The pack's `primitive-form-of` imports cover the form-shell
  // components (Stack/Button/Group on Mantine, equivalents elsewhere).
  addImportsForPrimitive(ctx, "primitive-form-of");
  const prepared = prepareFormFields(ctx, fields, fields, bc, testidNamespace);
  addImport(
    ctx,
    `../api/${lowerFirst(agg.name)}`,
    `Create${agg.name}Request`,
    `useCreate${agg.name}`,
  );
  ctx.collectedTestids.add(`${testidNamespace}-submit`);
  const onSubmitJs = emitFormOnSubmit(ctx, call, prepared.idTargets, "create");
  ctx.formOfs.push({
    kind: "aggregate",
    agg,
    bc,
    fields,
    idTargets: prepared.idTargets,
    useController: prepared.useController,
    defaultValuesTs: prepared.defaultValuesTs,
    testidNamespace,
    fieldHtmls: prepared.fieldHtmls,
    onSubmitJs,
  });
  const slug = snake(plural(agg.name));
  return renderFormOfPrimitive(ctx, call, depth, testidNamespace, prepared.fieldHtmls, onSubmitJs, {
    mutationCall: "const out = await create.mutateAsync(vals);",
    successMessage: `${humanize(agg.name)} created`,
    redirectStmt: `navigate(\`/${slug}/\${out.id}\`)`,
    submitPendingExpr: "create.isPending",
    submitLabel: "Create",
  });
}

/** `Form(runs: <wf>)` walker variant.  Same per-field
 *  preparer + same outer <form> JSX as the aggregate form, but
 *  the shell wires a workflow request type + mutation hook + a
 *  default redirect to `/workflows`. */
function emitFormRuns(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
  runsArg: ExprIR,
): string {
  const wfName =
    runsArg.kind === "ref"
      ? runsArg.name
      : runsArg.kind === "literal" && runsArg.lit === "string"
        ? runsArg.value
        : undefined;
  if (!wfName) {
    return ctx.target.renderComment(`Form(runs: …): missing 'runs:' workflow ref`);
  }
  const workflow = ctx.workflowsByName.get(wfName);
  const bc = ctx.bcByWorkflow.get(wfName);
  if (!workflow || !bc) {
    return ctx.target.renderComment(
      `Form(runs: ${wfName}): workflow not found in this UI's reachable contexts`,
    );
  }
  const fields = workflow.params;
  // form-helpers expect `{ name, type, optional }` rows; workflow
  // params don't carry an `optional` flag so we adapt here.  All
  // workflow params are treated as required (matches the scaffold
  // workflow-form builder, which doesn't filter them either).
  const fieldsForHelpers = fields.map((f) => ({ ...f, optional: false }));
  const testidNamespace = stringNamed(call, "testid") ?? `workflow-${snake(workflow.name)}`;
  addImportsForPrimitive(ctx, "primitive-form-of");
  const prepared = prepareFormFields(ctx, fields, fieldsForHelpers, bc, testidNamespace);
  const wfPascalForImport = upperFirst(workflow.name);
  addImport(
    ctx,
    "../api/workflows",
    `${wfPascalForImport}Request`,
    `use${wfPascalForImport}Workflow`,
  );
  ctx.collectedTestids.add(`${testidNamespace}-submit`);
  const onSubmitJs = emitFormOnSubmit(ctx, call, prepared.idTargets, "run");
  ctx.formOfs.push({
    kind: "workflow",
    workflow,
    bc,
    fields,
    idTargets: prepared.idTargets,
    useController: prepared.useController,
    defaultValuesTs: prepared.defaultValuesTs,
    testidNamespace,
    fieldHtmls: prepared.fieldHtmls,
    onSubmitJs,
  });
  return renderFormOfPrimitive(ctx, call, depth, testidNamespace, prepared.fieldHtmls, onSubmitJs, {
    mutationCall: "await run.mutateAsync(vals);",
    successMessage: `${humanize(workflow.name)} completed`,
    redirectStmt: `navigate("/workflows")`,
    submitPendingExpr: "run.isPending",
    submitLabel: "Run",
  });
}

/** `Form(<instance>.<operation>)` — records an OperationFormState
 *  and emits no inline JSX.  The enclosing `Modal` primitive
 *  renders the trigger button; the shell emits the module-scope
 *  `<Op>Form` component + `open<Op>Modal` opener + the page-scope
 *  `const <op> = use<Op><Agg>(<idExpr>)` mutation hook from the
 *  recorded state.  Field rendering is byte-identical to
 *  `Form(of:)` (same preparer + `field-input-*` templates). */
function emitFormOfOperation(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  opRef: ExprIR & { kind: "member" },
): string {
  const instanceName = opRef.receiver.kind === "ref" ? opRef.receiver.name : undefined;
  const opName = opRef.member;
  const aggName = instanceName ? ctx.paramTypes?.get(instanceName) : undefined;
  if (!instanceName || !aggName) {
    return ctx.target.renderComment(
      `Form(${instanceName ?? "?"}.${opName}): '${instanceName ?? "?"}' is not an in-scope aggregate instance`,
    );
  }
  const agg = ctx.aggregatesByName.get(aggName);
  const bc = ctx.bcByAggregate.get(aggName);
  if (!agg || !bc) {
    return ctx.target.renderComment(
      `Form(${instanceName}.${opName}): aggregate ${aggName} not found`,
    );
  }
  const op = agg.operations.find((o) => o.name === opName && o.visibility === "public");
  if (!op) {
    return ctx.target.renderComment(
      `Form(${instanceName}.${opName}): no public operation '${opName}' on ${agg.name}`,
    );
  }
  // The mutation hook is declared at function-top.  When the instance
  // is a function-top param (a component prop), target `<instance>.id`;
  // when it's a render-lambda binding (a Detail page's `data`, not in
  // scope at function-top), fall back to the route `id`.
  const idExpr = ctx.paramNames.has(instanceName)
    ? `${emitExpr(opRef.receiver, ctx)}.id`
    : `id ?? ""`;
  // Op params carry no `optional` flag — adapt for form-helpers
  // exactly as the workflow-form variant does.
  const fields = op.params;
  const fieldsForHelpers = fields.map((f) => ({ ...f, optional: false }));
  const testidNamespace = stringNamed(call, "testid") ?? `${snake(plural(agg.name))}-op-${op.name}`;
  // Note: unlike the inline forms, the op-form does NOT register
  // `primitive-form-of` here — the pack-specific shell (toast lib,
  // useState/useDisclosure, modals manager) rides on
  // `imports["primitive-modal"]`, which the enclosing `emitModal`
  // auto-registers.
  const prepared = prepareFormFields(ctx, fields, fieldsForHelpers, bc, testidNamespace);
  addImport(
    ctx,
    `../api/${lowerFirst(agg.name)}`,
    `${upperFirst(op.name)}${agg.name}Request`,
    `use${upperFirst(op.name)}${agg.name}`,
  );
  ctx.collectedTestids.add(testidNamespace);
  ctx.collectedTestids.add(`${testidNamespace}-form`);
  ctx.collectedTestids.add(`${testidNamespace}-submit`);
  ctx.formOfs.push({
    kind: "operation",
    agg,
    op,
    bc,
    fields,
    idExpr,
    idTargets: prepared.idTargets,
    useController: prepared.useController,
    defaultValuesTs: prepared.defaultValuesTs,
    testidNamespace,
    fieldHtmls: prepared.fieldHtmls,
    onSubmitJs: null,
    // Defaults — the enclosing Modal overrides from its trigger.
    triggerLabel: humanize(op.name),
    triggerPrimary: true,
  });
  // No inline JSX — the Modal primitive renders the trigger and
  // the shell emits the module-scope form component.
  return "";
}

export function emitModal(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const positionals = positionalArgs(call);
  const formChild = positionals.find(
    (a): a is ExprIR & { kind: "call" } => a.kind === "call" && a.name === "OperationForm",
  );
  const triggerArg = namedArgValue(call, "trigger");
  if (!formChild || !triggerArg || triggerArg.kind !== "call") {
    return ctx.target.renderComment(
      `Modal: expects trigger: Button(...) and a Form(<instance>.<operation>) child`,
    );
  }
  // Walk the form child first — records the OperationFormState
  // (and returns "" — the form has no inline JSX).
  walk(formChild, ctx, depth);
  // The op-form names its operation either through an instance-
  // member shape (`Form(data.confirm)`) or through the new
  // `Form(of: <Agg>, op: <opName>)` flat shape (used by
  // `scaffoldOperations(of:)` so modals can live outside a
  // QueryView data lambda).  Recover the op name from whichever
  // shape the child carries.
  const opRef = positionalArgs(formChild)[0];
  const opNameNamed = (() => {
    const opArg = namedArgValue(formChild, "op");
    return opArg && opArg.kind === "ref" ? opArg.name : undefined;
  })();
  const opName = opRef && opRef.kind === "member" ? opRef.member : opNameNamed;
  if (!opName) {
    return ctx.target.renderComment(
      `Modal: child Form must be Form(<instance>.<op>) or Form(of:, op:)`,
    );
  }
  const label = unwrapTextLiteral(
    firstPositionalContent(triggerArg, ctx) ?? '"Action"',
    ctx.target.escapeText,
  );
  // Platform-neutral emphasis token from the scaffold-expander
  // (`primary` for the aggregate's first public op, `secondary`
  // for the rest).  Each pack's template maps it to its own button
  // vocabulary — the walker never emits a pack-specific variant.
  const emphasis = stringNamed(triggerArg, "emphasis") ?? "primary";
  const triggerPrimary = emphasis === "primary";
  // Backfill the trigger surface onto the OperationFormState the
  // form child just pushed so packs that own the trigger inside
  // their module component (shadcn/mui/chakra) can render it.
  for (let i = ctx.formOfs.length - 1; i >= 0; i--) {
    const st = ctx.formOfs[i]!;
    if (st.kind === "operation" && st.op.name === opName) {
      st.triggerLabel = label;
      st.triggerPrimary = triggerPrimary;
      break;
    }
  }
  return renderPrimitive(ctx, "primitive-modal", {
    label,
    emphasisPrimary: triggerPrimary,
    opPascal: upperFirst(opName),
    opCamel: lowerFirst(opName),
    testidAttr: testidAttr(triggerArg, ctx),
  });
}
