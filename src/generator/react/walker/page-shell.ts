// Page-file shell assembly: wraps a walked body in the full page
// module (imports, hooks, useForm/mutation wiring, state, typed
// useParams) and renders user-defined component files. This is the
// page-assembly layer that sits on top of the core walker engine in
// body-walker.ts; it consumes the FormOfState records the form
// primitives push onto the walk sink.

import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  ParamIR,
  StateFieldIR,
  TypeIR,
  UiApiParamIR,
  UiHelperImportIR,
  WorkflowIR,
} from "../../../ir/loom-ir.js";
import { camel, humanize, pascal, plural, snake } from "../../../util/naming.js";
import type { LoadedPack } from "../../_packs/loader.js";
import { routerPackageForStack } from "../../_packs/stack-runtime.js";
import type {
  FormOfState,
  OperationFormState,
  WalkContext,
  WorkflowFormState,
} from "../body-walker.js";
import { emitExpr, walkBodyToTsx } from "../body-walker.js";
import { idTargetHookVar } from "../form-helpers.js";
import { renderApiHookImports, renderHelperImports, renderImportLines } from "./import-lines.js";
import { indentJsx } from "./shared/args.js";

/** Render the page-file shell around a walked body — imports +
 *  function component + return.
 *
 *  Slice 11.4 — when the page has typed route params, the walker
 *  is given their names.  If the body referenced any of them
 *  (`Heading(name)`, `Text(customerId)`), the shell adds a
 *  `useParams<{ name: string, customerId: string }>()` hook and
 *  destructures the names so the JSX expressions resolve at
 *  render time.  Unused params are NOT destructured (avoids TS
 *  "declared but never read" warnings) — but the type parameter
 *  always lists every declared param so the typed shape stays
 *  intact regardless of usage. */
export function renderCustomLayoutPage(
  pageName: string,
  body: ExprIR,
  pack: LoadedPack,
  params: ParamIR[] = [],
  state: StateFieldIR[] = [],
  /** Slice 11.12 — page-level `title:` expression.  Renders into a
   *  `useEffect` that sets `document.title` on mount and whenever
   *  any referenced param/state changes (deps array auto-derived
   *  from the title expression's refs). */
  title: ExprIR | undefined = undefined,
  /** Slice 11.18 — user-defined components in scope, so calls to
   *  them in the body emit as `<Name prop={…} />` instead of
   *  unknown-component placeholders. */
  userComponents: ReadonlyMap<string, readonly ParamIR[]> = new Map(),
  /** Slice 11.24 — UI api parameters.  Body refs of the form
   *  `<paramName>.<aggregate>.<op>` become hook calls injected at
   *  page-top by the walker. */
  apiParams: ReadonlyArray<UiApiParamIR> = [],
  /** Slice A4 — aggregates reachable from this UI's deployable.
   *  Required for `Form(of: <Agg>)` field dispatch and
   *  `IdLink(of: <Agg>)` display-field resolution. */
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
  /** Slice A4 — owning bounded context per aggregate (drives
   *  enum / value-object resolution inside the form-field
   *  preparer). */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR> = new Map(),
  /** Slice A6 — user-authored helper imports.  Body refs whose
   *  call name matches a helper emit as plain JS calls; the shell
   *  adds `import { <name> } from "<path>"` for each USED helper. */
  helperImports: ReadonlyArray<UiHelperImportIR> = [],
  /** Slice C2 — relative-path prefix from the emitted page TSX
   *  back to the `src/` root.  Defaults to `"../"` for pages at
   *  `src/pages/<name>.tsx` (1 hop).  Scaffold-expanded pages live
   *  at `src/pages/<plural>/<arch>.tsx` (2 hops) so the caller
   *  passes `"../../"`.  Used to resolve api-hook + format-helper
   *  imports the shell emits at function-top. */
  srcImportPrefix: string = "../",
  /** Slice A12 — workflows reachable from this UI's deployable.
   *  Required for `Form(runs: <wf>)` field dispatch. */
  workflowsByName: ReadonlyMap<string, WorkflowIR> = new Map(),
  /** Slice A12 — owning bounded context per workflow. */
  bcByWorkflow: ReadonlyMap<string, BoundedContextIR> = new Map(),
): string {
  const paramNames = new Set(params.map((p) => p.name));
  const stateNames = new Set(state.map((s) => s.name));
  const {
    tsx,
    imports,
    usedParams,
    usesNavigate,
    usesState,
    usesRouterLink,
    usedUserComponents,
    usedApiHooks,
    formOfs,
    usedHelpers,
  } = walkBodyToTsx(
    body,
    pack,
    paramNames,
    stateNames,
    userComponents,
    apiParams,
    aggregatesByName,
    bcByAggregate,
    helperImports,
    workflowsByName,
    bcByWorkflow,
  );
  // Slice 11.12 — render the title expression through emitExpr
  // (sharing the body's tracking state so the shell destructures
  // any param/state the title references).  Compute the deps
  // array from the title's referenced names so the effect re-runs
  // when those values change.
  let titleEffect = "";
  let usesEffect = false;
  let usesStateForTitle = false;
  if (title !== undefined) {
    const titleCtx: WalkContext = {
      imports,
      pack,
      paramNames,
      usedParams,
      usesNavigate,
      stateNames,
      usesState,
      usesRouterLink: false,
      userComponents: new Map(),
      usedUserComponents: new Set(),
      usesChildren: false,
      apiParamNames: new Map(),
      usedApiHooks: new Map(),
      lambdaParams: new Map(),
      shellLocals: new Set(),
      aggregatesByName: new Map(),
      bcByAggregate: new Map(),
      workflowsByName: new Map(),
      bcByWorkflow: new Map(),
      formOfs: [],
      collectedTestids: new Set(),
      helperImports: new Map(),
      usedHelpers: new Set(),
    };
    const titleExpr = emitExpr(title, titleCtx);
    // emitExpr may have added to usedParams; reflect title's state
    // usage separately so the shell knows whether to import useState.
    usesStateForTitle = titleCtx.usesState && !usesState;
    const refs = new Set<string>();
    collectExprRefs(title, refs);
    const deps = [...refs].filter((n) => paramNames.has(n) || stateNames.has(n)).sort();
    titleEffect = `  useEffect(() => { document.title = ${titleExpr}; }, [${deps.join(", ")}]);\n`;
    usesEffect = true;
  }
  const effectiveUsesState = usesState || usesStateForTitle;

  const mantineImport = renderImportLines(imports, srcImportPrefix);
  // Slice 11.18 — one default-import line per user component
  // referenced in the body, sorted alphabetically.
  const userComponentImports = [...usedUserComponents]
    .sort()
    .map((name) => `import ${name} from "${srcImportPrefix}components/${name}";\n`)
    .join("");
  // Slice 11.24 — api hook imports, grouped per `from` path so
  // multiple ops on the same aggregate dedupe to one import line
  // (matching the existing scaffold output's per-aggregate api file).
  const apiHookImports = renderApiHookImports(usedApiHooks, srcImportPrefix);
  // Slice A6 — `import { <name> } from "<path>"` per UI-declared
  // helper actually referenced in the body.  Lines grouped per
  // path so two helpers from the same module dedupe to one
  // import line; paths sorted for deterministic output.
  const helperImportLines = renderHelperImports(usedHelpers, helperImports);
  // Slice 11.24 — api hook declarations, emitted at page-top right
  // before the JSX return.  Each unique `<param>.<aggregate>.<op>`
  // becomes one `const <var> = use<Op><Aggregate>(args?);` line.
  const apiHookDecls = [...usedApiHooks.values()]
    .map((h) => `  const ${h.varName} = ${h.hookName}(${h.argsRendered.join(", ")});\n`)
    .join("");
  // Slice A4 — RHF wiring when the body included `Form(of:)` /
  // `Form(runs:)` / `Form(of:, op:)` primitives.  Emits the
  // mutation-hook import, per-Id<X> target `useAllX()` hooks, the
  // `useForm` declaration, and the `react-hook-form` import.  A
  // detail page can host several forms (one per operation modal)
  // plus its QueryView, so wiring is concatenated across every
  // recorded form state.
  // Form wiring across every recorded form state — all imports
  // already flowed through `ctx.imports` via `addImport` in the
  // emit functions (no textual merge needed; renderImportLines
  // dedupes by module).  Only page-scope decls + module-scope
  // helpers concatenate here.
  const form = formOfs.reduce<{
    decls: string;
    moduleScope: string;
    usesNavigate: boolean;
  }>(
    (acc, state) => {
      const w = renderFormOfWiring(state, pack, srcImportPrefix);
      return {
        decls: acc.decls + w.decls,
        moduleScope: acc.moduleScope + w.moduleScope,
        usesNavigate: acc.usesNavigate || w.usesNavigate,
      };
    },
    { decls: "", moduleScope: "", usesNavigate: false },
  );
  const hasParams = params.length > 0;
  const routerSpecifiers: string[] = [];
  if (hasParams) routerSpecifiers.push("useParams");
  if (usesNavigate || form.usesNavigate) routerSpecifiers.push("useNavigate");
  if (usesRouterLink) routerSpecifiers.push("Link as RouterLink");
  const reactRouterImport =
    routerSpecifiers.length > 0
      ? `import { ${routerSpecifiers.join(", ")} } from "${routerPackageForStack(pack.manifest.stack)}";\n`
      : "";
  // Slice 11.7 — emit the `useState` hook + per-field declaration
  // when any state ref or `:=` mutation surfaced during the walk.
  // Pages that DECLARE state but never reference it from the body
  // skip the import so unused-var warnings stay quiet (parallel to
  // how `usedParams` shapes the useParams destructure).
  // Slice 11.12 — `useEffect` joins the same React import line.
  const reactSpecifiers: string[] = [];
  if (effectiveUsesState) reactSpecifiers.push("useState");
  if (usesEffect) reactSpecifiers.push("useEffect");
  const reactImport =
    reactSpecifiers.length > 0 ? `import { ${reactSpecifiers.join(", ")} } from "react";\n` : "";
  const stateLines = effectiveUsesState
    ? state.map((f) => `  ${renderUseState(f, pack)}\n`).join("")
    : "";
  const paramsType = hasParams
    ? `<{ ${params.map((p) => `${p.name}: ${typeRefAsTsString(p)}`).join("; ")} }>`
    : "";
  const used = [...usedParams].sort();
  const paramsLine =
    used.length > 0
      ? `  const { ${used.join(", ")} } = useParams${paramsType}();\n`
      : hasParams
        ? `  useParams${paramsType}();\n`
        : "";
  const navigateLine =
    usesNavigate || form.usesNavigate ? `  const navigate = useNavigate();\n` : "";
  return `// Auto-generated.  Do not edit by hand.
${reactImport}${reactRouterImport}${mantineImport}${apiHookImports}${helperImportLines}${userComponentImports}${form.moduleScope}
export default function ${pageName}() {
${paramsLine}${navigateLine}${stateLines}${apiHookDecls}${form.decls}${titleEffect}  return (
    ${indentJsx(tsx, "    ")}
  );
}
`;
}

/** Slice A4 — assemble the RHF + create-mutation wiring around a
 *  `Form(of: <Agg>)` body emission.  Rendered through per-pack
 *  templates (`form-of-imports.hbs` + `form-of-decls.hbs`) so the
 *  pack controls exactly which packages it imports and how it
 *  destructures the RHF result (`form.handleSubmit` for shadcn,
 *  destructured `{ handleSubmit, register, … }` for mantine).
 *
 *  The form's JSX block (rendered by `emitFormOf`) embeds the
 *  `handleSubmit(...)` call directly; this helper produces only
 *  the shell-level surroundings: imports + in-function hook
 *  declarations + the `usesNavigate` signal. */
type FormWiring = {
  /** Page-scope const declarations (the `useForm` destructure, the
   *  mutation hook, idTarget `useAll<X>` calls) emitted above the
   *  `return (` JSX in the page component.  Imports are NOT
   *  carried here — every form variant routes its imports through
   *  the structured `ctx.imports` set (via `addImport` in the
   *  emit functions + `addImportsForPrimitive` for pack-specific
   *  shared) so cross-form duplicates dedupe naturally and no
   *  textual merge is needed. */
  decls: string;
  /** Module-scope helper functions emitted above `export default
   *  function` (operation forms only — their `<Op>Form` component
   *  + `open<Op>Modal` opener).  Empty for create/workflow forms. */
  moduleScope: string;
  usesNavigate: boolean;
};

function renderFormOfWiring(
  state: FormOfState,
  pack: LoadedPack,
  /** Slice C2 — see `renderImportLines` for prefix semantics. */
  srcImportPrefix: string = "../",
): FormWiring {
  if (state.kind === "workflow") {
    return renderFormRunsWiring(state, pack, srcImportPrefix);
  }
  if (state.kind === "operation") {
    return renderFormOpWiring(state, pack, srcImportPrefix);
  }
  const { agg, idTargets, useController, defaultValuesTs, onSubmitJs } = state;
  const tplCtx = {
    aggregateName: agg.name,
    aggregateNameCamel: camel(agg.name),
    pluralAggregateName: plural(agg.name),
    snakePluralAggregate: snake(plural(agg.name)),
    humanAgg: humanize(agg.name),
    humanAggLower: humanize(agg.name).toLowerCase(),
    srcImportPrefix,
    idTargets: idTargets.map((t) => ({
      name: t.name,
      nameCamel: camel(t.name),
      namePlural: plural(t.name),
      hookVar: idTargetHookVar(t),
    })),
    useController,
    defaultValuesTs,
    hasDefaultOnSubmit: onSubmitJs === null,
  };
  const decls = pack.render("form-of-decls", tplCtx);
  return {
    decls: decls.endsWith("\n") ? decls : decls + "\n",
    moduleScope: "",
    usesNavigate: onSubmitJs === null,
  };
}

/** `Form(of: <Agg>, op: <name>)` wiring.  Splits into three
 *  emission sites: page-scope `decls` (the mutation hook
 *  `const <op> = use<Op><Agg>(id ?? "")`), `imports` (op hook +
 *  request type + RHF + notifications + modals manager), and
 *  `moduleScope` (the `<Op>Form` component — own `useForm`, op-
 *  param inputs — plus the `open<Op>Modal` opener the trigger
 *  button calls).  Mirrors the deleted legacy operation-modal
 *  renderer's contract. */
function renderFormOpWiring(
  state: OperationFormState,
  pack: LoadedPack,
  srcImportPrefix: string,
): FormWiring {
  const { agg, op, idTargets, useController, defaultValuesTs, fieldHtmls } = state;
  const opPascal = pascal(op.name);
  const tplCtx = {
    aggregateName: agg.name,
    aggregateNameCamel: camel(agg.name),
    opName: op.name,
    opPascal,
    opCamel: camel(op.name),
    humanOp: humanize(op.name),
    slug: snake(plural(agg.name)),
    srcImportPrefix,
    idTargets: idTargets.map((t) => ({
      name: t.name,
      nameCamel: camel(t.name),
      namePlural: plural(t.name),
      hookVar: idTargetHookVar(t),
    })),
    useController,
    defaultValuesTs,
    hasParams: fieldHtmls.length > 0,
    fieldHtmls,
    triggerLabel: state.triggerLabel,
    triggerPrimary: state.triggerPrimary,
    destructured: useController
      ? "{ register, handleSubmit, control, formState: { errors } }"
      : "{ register, handleSubmit, formState: { errors } }",
  };
  const decls = pack.render("form-op-decls", tplCtx);
  const moduleScope = pack.render("form-op-module", tplCtx);
  return {
    decls: decls.endsWith("\n") ? decls : decls + "\n",
    moduleScope: moduleScope.endsWith("\n") ? moduleScope : moduleScope + "\n",
    usesNavigate: false,
  };
}

/** Slice A12 — workflow-form variant of renderFormOfWiring.  Same
 *  RHF wiring, but the request type / mutation hook / import
 *  source come from the workflow surface (`<Wf>Request`,
 *  `use<Wf>Workflow`, `../api/workflows`) instead of the
 *  aggregate's. */
function renderFormRunsWiring(
  state: WorkflowFormState,
  pack: LoadedPack,
  srcImportPrefix: string,
): FormWiring {
  const { workflow, idTargets, useController, defaultValuesTs, onSubmitJs } = state;
  const wfPascal = pascal(workflow.name);
  const tplCtx = {
    workflowName: workflow.name,
    workflowPascal: wfPascal,
    humanWorkflow: humanize(workflow.name),
    srcImportPrefix,
    idTargets: idTargets.map((t) => ({
      name: t.name,
      nameCamel: camel(t.name),
      namePlural: plural(t.name),
      hookVar: idTargetHookVar(t),
    })),
    useController,
    defaultValuesTs,
    hasDefaultOnSubmit: onSubmitJs === null,
  };
  const decls = pack.render("form-runs-decls", tplCtx);
  return {
    decls: decls.endsWith("\n") ? decls : decls + "\n",
    moduleScope: "",
    usesNavigate: onSubmitJs === null,
  };
}

/** Slice 11.18 — render one ComponentIR as a `.tsx` file: typed
 *  Props interface, default-export function component, useState
 *  declarations from the component's own state, body walked
 *  through the same machinery as page bodies.  Components don't
 *  have routes / titles, so the shell skips useParams /
 *  useEffect; they CAN have state and CAN invoke other user
 *  components. */
export function renderUserComponentFile(
  name: string,
  params: ParamIR[],
  state: StateFieldIR[],
  body: ExprIR,
  pack: LoadedPack,
  userComponents: ReadonlyMap<string, readonly ParamIR[]>,
): string {
  const paramNames = new Set(params.map((p) => p.name));
  const stateNames = new Set(state.map((s) => s.name));
  const {
    tsx,
    imports,
    usedParams,
    usesState,
    usesRouterLink,
    usesNavigate,
    usedUserComponents,
    usesChildren,
  } = walkBodyToTsx(body, pack, paramNames, stateNames, userComponents);
  const mantineImport = renderImportLines(imports);
  // Components don't have routes — useNavigate/Link still legal in
  // a component subtree (e.g. Button(to:) inside).
  const routerSpecifiers: string[] = [];
  if (usesNavigate) routerSpecifiers.push("useNavigate");
  if (usesRouterLink) routerSpecifiers.push("Link as RouterLink");
  const reactRouterImport =
    routerSpecifiers.length > 0
      ? `import { ${routerSpecifiers.join(", ")} } from "${routerPackageForStack(pack.manifest.stack)}";\n`
      : "";
  const reactImport = usesState ? `import { useState } from "react";\n` : "";
  // Slice 11.19 — components that reference Slot() get a
  // `children` prop on top of their declared params.  React's
  // type is imported lazily.
  const reactTypesImport = usesChildren ? `import type { ReactNode } from "react";\n` : "";
  const userComponentImports = [...usedUserComponents]
    .sort()
    .map((n) => `import ${n} from "./${n}";\n`)
    .join("");
  // Props interface — every declared param becomes a typed field;
  // Slot()-using components also get a `children` field.
  const propLines = params.map((p) => `  ${p.name}: ${typeRefAsTsString(p)};`);
  if (usesChildren) propLines.push(`  children?: ReactNode;`);
  const propsType =
    propLines.length > 0 ? `\nexport interface ${name}Props {\n${propLines.join("\n")}\n}\n` : "";
  const destructureNames = params.map((p) => p.name);
  if (usesChildren) destructureNames.push("children");
  const propDestructure =
    destructureNames.length > 0 ? `{ ${destructureNames.join(", ")} }: ${name}Props` : "";
  const navigateLine = usesNavigate ? `  const navigate = useNavigate();\n` : "";
  const stateLines = usesState ? state.map((f) => `  ${renderUseState(f, pack)}\n`).join("") : "";
  // Suppress used-prop warnings — params declared but unused at
  // walker-emit time (e.g. typed pass-through to a child component
  // not yet wired) shouldn't trigger TS lint noise.  We reference
  // them with a `void` block when none made it into `tsx`.
  void usedParams;
  return `// Auto-generated.  Do not edit by hand.
${reactImport}${reactTypesImport}${reactRouterImport}${mantineImport}${userComponentImports}${propsType}
export default function ${name}(${propDestructure}) {
${navigateLine}${stateLines}  return (
    ${indentJsx(tsx, "    ")}
  );
}
`;
}

/** Slice 11.12 — collect every name referenced in an expression
 *  (via `ref` nodes), used to derive the deps array for the
 *  title's `useEffect`.  Walks binary / unary / call subtrees. */
function collectExprRefs(expr: ExprIR, out: Set<string>): void {
  switch (expr.kind) {
    case "ref":
      out.add(expr.name);
      return;
    case "binary":
      collectExprRefs(expr.left, out);
      collectExprRefs(expr.right, out);
      return;
    case "unary":
      collectExprRefs(expr.operand, out);
      return;
    case "call":
      for (const a of expr.args) collectExprRefs(a, out);
      return;
    default:
      return;
  }
}

/** Slice 11.7 — render one `state {}` field as a React `useState`
 *  declaration: `const [name, setName] = useState<T>(init);`.  Init
 *  comes from the field's optional `=` initializer; absent
 *  initializers fall back to the type's zero value. */
function renderUseState(field: StateFieldIR, pack: LoadedPack): string {
  const setter = "set" + field.name[0]!.toUpperCase() + field.name.slice(1);
  const tsType = stateTypeAsTsString(field.type);
  const init =
    field.init !== undefined ? renderInitExpr(field.init, pack) : zeroValueForType(field.type);
  return `const [${field.name}, ${setter}] = useState<${tsType}>(${init});`;
}

/** Render a state-field initializer ExprIR as a JS expression
 *  string.  Reuses the same shape `emitExpr` produces but runs
 *  with an empty context — initializers can't reference state or
 *  params (they evaluate at component-mount time). */
function renderInitExpr(expr: ExprIR, pack: LoadedPack): string {
  // Empty walker context — init expressions don't see state /
  // params (they evaluate before the hooks run).
  const dummy: WalkContext = {
    imports: new Map(),
    pack,
    paramNames: new Set(),
    usedParams: new Set(),
    usesNavigate: false,
    stateNames: new Set(),
    usesState: false,
    usesRouterLink: false,
    userComponents: new Map(),
    usedUserComponents: new Set(),
    usesChildren: false,
    apiParamNames: new Map(),
    usedApiHooks: new Map(),
    lambdaParams: new Map(),
    shellLocals: new Set(),
    aggregatesByName: new Map(),
    bcByAggregate: new Map(),
    workflowsByName: new Map(),
    bcByWorkflow: new Map(),
    formOfs: [],
    collectedTestids: new Set(),
    helperImports: new Map(),
    usedHelpers: new Set(),
  };
  return emitExpr(expr, dummy);
}

/** Map a Loom `TypeIR` to the TS type used in `useState<T>(...)`.
 *  v0 covers the primitives that show up in click-counter-shaped
 *  toy pages; complex types fall back to `any`. */
function stateTypeAsTsString(type: TypeIR): string {
  if (type.kind === "primitive") {
    switch (type.name) {
      case "int":
      case "long":
      case "decimal":
        return "number";
      case "bool":
        return "boolean";
      case "string":
      case "datetime":
      case "guid":
        return "string";
    }
  }
  if (type.kind === "id" || type.kind === "enum") return "string";
  if (type.kind === "optional") {
    return `${stateTypeAsTsString(type.inner)} | undefined`;
  }
  return "any";
}

/** Default initial value for a state field that doesn't declare an
 *  `=` initializer.  Mirrors the spec §6 zero-value table. */
function zeroValueForType(type: TypeIR): string {
  if (type.kind === "primitive") {
    switch (type.name) {
      case "int":
      case "long":
      case "decimal":
        return "0";
      case "bool":
        return "false";
      case "string":
      case "datetime":
      case "guid":
        return '""';
    }
  }
  if (type.kind === "id" || type.kind === "enum") return '""';
  if (type.kind === "optional") return "undefined";
  return "undefined";
}

/** Render a `ParamIR` (route param) as the TS type the
 *  `useParams<{...}>()` generic should declare for it.  Slice 11.4
 *  v0 — every route param is `string` at the React-Router level;
 *  the original Loom type intent (e.g. `Id<Order>`) is preserved
 *  in the IR but doesn't affect the typed-useParams shape today.
 *  A future slice can layer `z.coerce` or similar at the page-
 *  shell to convert to the declared types. */
function typeRefAsTsString(p: ParamIR): string {
  void p;
  return "string";
}
