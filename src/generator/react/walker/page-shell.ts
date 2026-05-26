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
import { humanize, lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import type { LoadedPack } from "../../_packs/loader.js";
import { routerPackageForStack } from "../../_packs/stack-runtime.js";
import type {
  ActionMutationState,
  FormOfState,
  OperationFormState,
  WalkContext,
  WorkflowFormState,
} from "../body-walker.js";
import { emitExpr, walkBodyToTsx } from "../body-walker.js";
import { idTargetHookVar } from "../form-helpers.js";
import { renderApiHookImports, renderImportLines } from "./import-lines.js";
import { indentJsx } from "./shared/args.js";
import { tsxTarget } from "./tsx-target.js";

/** Map each aggregate-typed param to its aggregate name, so the
 *  walker can resolve `Action(<param>.<op>)` (the lowering env is
 *  neutral, so the IR's receiverType is unresolved for page bodies). */
function aggregateParamTypes(
  params: readonly ParamIR[],
  aggregatesByName: ReadonlyMap<string, AggregateIR>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of params) {
    if (p.type.kind === "entity" && aggregatesByName.has(p.type.name)) {
      m.set(p.name, p.type.name);
    }
  }
  return m;
}

/** Function-top mutation-hook declarations + api imports for the
 *  `Action(<instance>.<op>)` primitives recorded during the walk. */
function renderActionMutations(
  actionMutations: readonly ActionMutationState[],
  srcImportPrefix: string,
): { imports: string; decls: string } {
  const importsByModule = new Map<string, Set<string>>();
  for (const m of actionMutations) {
    const mod = `${srcImportPrefix}api/${m.aggCamel}`;
    (importsByModule.get(mod) ?? importsByModule.set(mod, new Set()).get(mod)!).add(m.hookName);
  }
  const imports = [...importsByModule.entries()]
    .map(([mod, names]) => `import { ${[...names].sort().join(", ")} } from "${mod}";\n`)
    .join("");
  const decls = actionMutations
    .map((m) => `  const ${m.localVar} = ${m.hookName}(${m.idExpr});\n`)
    .join("");
  return { imports, decls };
}

/** Render the page-file shell around a walked body — imports +
 *  function component + return.
 *
 *  When the page has typed route params, the walker is given their
 *  names.  If the body referenced any of them
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
  /** Page-level `title:` expression.  Renders into a
   *  `useEffect` that sets `document.title` on mount and whenever
   *  any referenced param/state changes (deps array auto-derived
   *  from the title expression's refs). */
  title: ExprIR | undefined = undefined,
  /** User-defined components in scope, so calls to
   *  them in the body emit as `<Name prop={…} />` instead of
   *  unknown-component placeholders. */
  userComponents: ReadonlyMap<string, readonly ParamIR[]> = new Map(),
  /** UI api parameters.  Body refs of the form
   *  `<paramName>.<aggregate>.<op>` become hook calls injected at
   *  page-top by the walker. */
  apiParams: ReadonlyArray<UiApiParamIR> = [],
  /** Aggregates reachable from this UI's deployable.
   *  Required for `Form(of: <Agg>)` field dispatch and
   *  `IdLink(of: <Agg>)` display-field resolution. */
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
  /** Owning bounded context per aggregate (drives
   *  enum / value-object resolution inside the form-field
   *  preparer). */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR> = new Map(),
  /** User-authored helper imports.  Body refs whose
   *  call name matches a helper emit as plain JS calls; the shell
   *  adds `import { <name> } from "<path>"` for each USED helper. */
  helperImports: ReadonlyArray<UiHelperImportIR> = [],
  /** Relative-path prefix from the emitted page TSX
   *  back to the `src/` root.  Defaults to `"../"` for pages at
   *  `src/pages/<name>.tsx` (1 hop).  Scaffold-expanded pages live
   *  at `src/pages/<plural>/<arch>.tsx` (2 hops) so the caller
   *  passes `"../../"`.  Used to resolve api-hook + format-helper
   *  imports the shell emits at function-top. */
  srcImportPrefix: string = "../",
  /** Workflows reachable from this UI's deployable.
   *  Required for `Form(runs: <wf>)` field dispatch. */
  workflowsByName: ReadonlyMap<string, WorkflowIR> = new Map(),
  /** Owning bounded context per workflow. */
  bcByWorkflow: ReadonlyMap<string, BoundedContextIR> = new Map(),
  /** Page name → route path, for `Action`'s `then: navigate(<Page>)`. */
  pageRoutes: ReadonlyMap<string, string> = new Map(),
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
    actionMutations,
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
    aggregateParamTypes(params, aggregatesByName),
    pageRoutes,
  );
  // Render the title expression through emitExpr
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
      actionMutations: [],
      collectedTestids: new Set(),
      helperImports: new Map(),
      usedHelpers: new Set(),
      usesCodeBlock: false,
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
  // One default-import line per user component
  // referenced in the body, sorted alphabetically.
  const userComponentImports = [...usedUserComponents]
    .sort()
    .map((name) => `import ${name} from "${srcImportPrefix}components/${name}";\n`)
    .join("");
  // Api hook imports, grouped per `from` path so
  // multiple ops on the same aggregate dedupe to one import line
  // (matching the existing scaffold output's per-aggregate api file).
  const apiHookImports = renderApiHookImports(usedApiHooks, srcImportPrefix);
  // `import { <name> } from "<path>"` per UI-declared
  // helper actually referenced in the body.  Lines grouped per
  // path so two helpers from the same module dedupe to one
  // import line; paths sorted for deterministic output.
  // Delegated to `tsxTarget.renderHelperImports` — see
  // `src/generator/_walker/target.ts`.  The target returns one
  // line per import; this site re-attaches the trailing newline
  // matching the existing splice into the import block template.
  const helperImportLines = tsxTarget
    .renderHelperImports(usedHelpers, helperImports)
    .map((l) => `${l}\n`)
    .join("");
  // Api hook declarations, emitted at page-top right before the
  // JSX return.  Each unique `<param>.<aggregate>.<op>` becomes
  // one `const <var> = use<Op><Aggregate>(args?);` line.
  // Delegated to `tsxTarget.renderApiHoisting` — see
  // `src/generator/_walker/target.ts`.  Walker passes ApiHookUse
  // fields through as pre-resolved varName/hookName/argsRendered
  // overrides on ApiCallSite, sidestepping the formula-based
  // recomputation (View hooks like `useXxxView` don't follow the
  // aggregate+op shape).  The 2-space indent + trailing newline
  // stays at the call site for splice into the function-shell
  // template.
  const apiHookDecls = tsxTarget
    .renderApiHoisting(
      [...usedApiHooks.values()].map((h) => ({
        apiHandle: "",
        aggregateName: "",
        operation: "",
        kind: "query" as const,
        args: [],
        varName: h.varName,
        hookName: h.hookName,
        argsRendered: h.argsRendered,
      })),
    )
    .map((line) => `  ${line}\n`)
    .join("");
  // RHF wiring when the body included `Form(of:)` /
  // `Form(runs:)` / `Form(of:, op:)` primitives.  Emits the
  // mutation-hook import, per-X id target `useAllX()` hooks, the
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
  const actionWiring = renderActionMutations(actionMutations, srcImportPrefix);
  const hasParams = params.length > 0;
  const routerSpecifiers: string[] = [];
  if (hasParams) routerSpecifiers.push("useParams");
  if (usesNavigate || form.usesNavigate) routerSpecifiers.push("useNavigate");
  if (usesRouterLink) routerSpecifiers.push("Link as RouterLink");
  const reactRouterImport =
    routerSpecifiers.length > 0
      ? `import { ${routerSpecifiers.join(", ")} } from "${routerPackageForStack(pack.manifest.stack)}";\n`
      : "";
  // Emit the `useState` hook + per-field declaration
  // when any state ref or `:=` mutation surfaced during the walk.
  // Pages that DECLARE state but never reference it from the body
  // skip the import so unused-var warnings stay quiet (parallel to
  // how `usedParams` shapes the useParams destructure).
  // `useEffect` joins the same React import line.
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
${reactImport}${reactRouterImport}${mantineImport}${apiHookImports}${actionWiring.imports}${helperImportLines}${userComponentImports}${form.moduleScope}
export default function ${pageName}() {
${paramsLine}${navigateLine}${stateLines}${apiHookDecls}${actionWiring.decls}${form.decls}${titleEffect}  return (
    ${indentJsx(tsx, "    ")}
  );
}
`;
}

/** Assemble the RHF + create-mutation wiring around a
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
  /** See `renderImportLines` for prefix semantics. */
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
    aggregateNameCamel: lowerFirst(agg.name),
    pluralAggregateName: plural(agg.name),
    snakePluralAggregate: snake(plural(agg.name)),
    humanAgg: humanize(agg.name),
    humanAggLower: humanize(agg.name).toLowerCase(),
    srcImportPrefix,
    idTargets: idTargets.map((t) => ({
      name: t.name,
      nameCamel: lowerFirst(t.name),
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
 *  button calls). */
function renderFormOpWiring(
  state: OperationFormState,
  pack: LoadedPack,
  srcImportPrefix: string,
): FormWiring {
  const { agg, op, idTargets, useController, defaultValuesTs, fieldHtmls, idExpr } = state;
  const opPascal = upperFirst(op.name);
  const tplCtx = {
    aggregateName: agg.name,
    aggregateNameCamel: lowerFirst(agg.name),
    opName: op.name,
    opPascal,
    opCamel: lowerFirst(op.name),
    idExpr,
    humanOp: humanize(op.name),
    slug: snake(plural(agg.name)),
    srcImportPrefix,
    idTargets: idTargets.map((t) => ({
      name: t.name,
      nameCamel: lowerFirst(t.name),
      namePlural: plural(t.name),
      hookVar: idTargetHookVar(t),
    })),
    useController,
    defaultValuesTs,
    hasParams: fieldHtmls.length > 0,
    fieldHtmls,
    triggerLabel: state.triggerLabel,
    triggerPrimary: state.triggerPrimary,
    destructured: (() => {
      // Scan the rendered field markup to keep only the destructured
      // pieces the form actually references — when every field is wired
      // via <Controller render={({ field, fieldState }) => …}>, `register`
      // and the formState `errors` map fall out as unused locals.
      const formBody = fieldHtmls.join("\n");
      const usesRegister = /\bregister\(/.test(formBody);
      const usesErrors = /\berrors\./.test(formBody);
      const parts: string[] = [];
      if (usesRegister) parts.push("register");
      parts.push("handleSubmit");
      if (useController) parts.push("control");
      if (usesErrors) parts.push("formState: { errors }");
      return `{ ${parts.join(", ")} }`;
    })(),
  };
  const decls = pack.render("form-op-decls", tplCtx);
  const moduleScope = pack.render("form-op-module", tplCtx);
  return {
    decls: decls.endsWith("\n") ? decls : decls + "\n",
    moduleScope: moduleScope.endsWith("\n") ? moduleScope : moduleScope + "\n",
    usesNavigate: false,
  };
}

/** Workflow-form variant of renderFormOfWiring.  Same
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
  const wfPascal = upperFirst(workflow.name);
  const tplCtx = {
    workflowName: workflow.name,
    workflowPascal: wfPascal,
    humanWorkflow: humanize(workflow.name),
    srcImportPrefix,
    idTargets: idTargets.map((t) => ({
      name: t.name,
      nameCamel: lowerFirst(t.name),
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

/** Render one ComponentIR as a `.tsx` file: typed
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
  /** Aggregates / owning BCs reachable from this UI — needed for
   *  `Action(<instance>.<op>)` operation + mutation-hook resolution. */
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
  bcByAggregate: ReadonlyMap<string, BoundedContextIR> = new Map(),
  /** Page name → route path, for `Action`'s `then: navigate(<Page>)`. */
  pageRoutes: ReadonlyMap<string, string> = new Map(),
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
    actionMutations,
    formOfs,
  } = walkBodyToTsx(
    body,
    pack,
    paramNames,
    stateNames,
    userComponents,
    [],
    aggregatesByName,
    bcByAggregate,
    [],
    new Map(),
    new Map(),
    aggregateParamTypes(params, aggregatesByName),
    pageRoutes,
  );
  // Components live at `src/components/<Name>.tsx` (one hop to `src/`),
  // so api imports for Action mutation hooks resolve via `../api/<agg>`.
  const actionWiring = renderActionMutations(actionMutations, "../");
  // Form wiring (create / workflow / operation forms) — same as the
  // page shell: module-scope `<Op>Form` components + function-top hook
  // decls.  Component files sit one hop from `src/`, so the api/format
  // imports the wiring emits resolve via `../`.
  const form = formOfs.reduce<{
    decls: string;
    moduleScope: string;
    usesNavigate: boolean;
  }>(
    (acc, state) => {
      const w = renderFormOfWiring(state, pack, "../");
      return {
        decls: acc.decls + w.decls,
        moduleScope: acc.moduleScope + w.moduleScope,
        usesNavigate: acc.usesNavigate || w.usesNavigate,
      };
    },
    { decls: "", moduleScope: "", usesNavigate: false },
  );
  const mantineImport = renderImportLines(imports);
  // Components don't have routes — useNavigate/Link still legal in
  // a component subtree (e.g. Button(to:) inside).
  const routerSpecifiers: string[] = [];
  if (usesNavigate || form.usesNavigate) routerSpecifiers.push("useNavigate");
  if (usesRouterLink) routerSpecifiers.push("Link as RouterLink");
  const reactRouterImport =
    routerSpecifiers.length > 0
      ? `import { ${routerSpecifiers.join(", ")} } from "${routerPackageForStack(pack.manifest.stack)}";\n`
      : "";
  const reactImport = usesState ? `import { useState } from "react";\n` : "";
  // Components that reference Slot() get a
  // `children` prop on top of their declared params.  React's
  // type is imported lazily.
  const reactTypesImport = usesChildren ? `import type { ReactNode } from "react";\n` : "";
  const userComponentImports = [...usedUserComponents]
    .sort()
    .map((n) => `import ${n} from "./${n}";\n`)
    .join("");
  // Props interface — every declared param becomes a typed field;
  // Slot()-using components also get a `children` field.  An
  // aggregate-typed param (`order: Order`) gets the aggregate's wire
  // DTO type (`OrderResponse`, imported from its api module) so member
  // accesses like `order.id` / `order.customerId` typecheck; other
  // params fall back to the route-param `string` shape.
  const dtoImports = new Map<string, string>(); // DTO type → api module
  const propType = (p: ParamIR): string => {
    if (p.type.kind === "entity" && aggregatesByName.has(p.type.name)) {
      dtoImports.set(`${p.type.name}Response`, `../api/${lowerFirst(p.type.name)}`);
      return `${p.type.name}Response`;
    }
    return typeRefAsTsString(p);
  };
  const propLines = params.map((p) => `  ${p.name}: ${propType(p)};`);
  if (usesChildren) propLines.push(`  children?: ReactNode;`);
  const dtoImportLines = [...dtoImports.entries()]
    .map(([type, mod]) => `import type { ${type} } from "${mod}";\n`)
    .join("");
  const propsType =
    propLines.length > 0 ? `\nexport interface ${name}Props {\n${propLines.join("\n")}\n}\n` : "";
  const destructureNames = params.map((p) => p.name);
  if (usesChildren) destructureNames.push("children");
  const propDestructure =
    destructureNames.length > 0 ? `{ ${destructureNames.join(", ")} }: ${name}Props` : "";
  const navigateLine =
    usesNavigate || form.usesNavigate ? `  const navigate = useNavigate();\n` : "";
  const stateLines = usesState ? state.map((f) => `  ${renderUseState(f, pack)}\n`).join("") : "";
  // Suppress used-prop warnings — params declared but unused at
  // walker-emit time (e.g. typed pass-through to a child component
  // not yet wired) shouldn't trigger TS lint noise.  We reference
  // them with a `void` block when none made it into `tsx`.
  void usedParams;
  return `// Auto-generated.  Do not edit by hand.
${reactImport}${reactTypesImport}${reactRouterImport}${mantineImport}${dtoImportLines}${actionWiring.imports}${userComponentImports}${propsType}${form.moduleScope}
export default function ${name}(${propDestructure}) {
${navigateLine}${actionWiring.decls}${form.decls}${stateLines}  return (
    ${indentJsx(tsx, "    ")}
  );
}
`;
}

/** Collect every name referenced in an expression
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
    case "convert":
      // The wrapped value carries the original ref(s) — without
      // recursing here the useEffect deps-array would miss refs
      // wrapped by implicit string-concat (`document.title = "n: "
      // + n` lowers the `n` ref inside a convert).
      collectExprRefs(expr.value, out);
      return;
    default:
      return;
  }
}

/** Render one `state {}` field as a React `useState`
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
    actionMutations: [],
    collectedTestids: new Set(),
    helperImports: new Map(),
    usedHelpers: new Set(),
    usesCodeBlock: false,
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
      case "money":
        return "Decimal";
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
 *  `=` initializer.  Delegated to `tsxTarget.defaultInitFor` —
 *  see `src/generator/_walker/target.ts` for the contract.  The
 *  per-type zero-value table now lives next to the rest of TSX
 *  framework-specific rendering.  Spec §6 still pins the values. */
function zeroValueForType(type: TypeIR): string {
  return tsxTarget.defaultInitFor(type);
}

/** Render a `ParamIR` (route param) as the TS type the
 *  `useParams<{...}>()` generic should declare for it.  Every route
 *  param is `string` at the React-Router level; the original Loom
 *  type intent (e.g. `Order id`) is preserved in the IR but doesn't
 *  affect the typed-useParams shape today.
 *  A future change can layer `z.coerce` or similar at the page-
 *  shell to convert to the declared types. */
function typeRefAsTsString(p: ParamIR): string {
  void p;
  return "string";
}
