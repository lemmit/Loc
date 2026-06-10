// .svelte page/component assembly: wraps a walked body in the full
// single-file-component module (`<script lang="ts">` imports, runes
// state, svelte-query handles, form wiring, `$effect` title) — the
// Svelte sibling of src/generator/react/walker/page-shell.ts on top
// of the shared markup walker (`src/generator/_walker/walker-core.ts`
// + `svelteTarget`).
//
// Structural deltas vs the react shell:
//   - file-based routing — no useParams; used route params derive
//     from `$app/state`'s `page.params`
//   - state is `let x = $state<T>(init)`; the title effect is a
//     plain `$effect` (runes auto-track, no deps array)
//   - operation forms can't be module-scope components (one
//     component per .svelte file) — the pack's `form-op-module`
//     template emits a top-level `{#snippet <op>OpModal()}` placed
//     after the main markup; `primitive-modal` renders
//     `{@render <op>OpModal()}` at the modal site
//   - navigation imports `{ goto as navigate }` so walker-emitted
//     `navigate(...)` calls (incl. pack default-submit redirects)
//     resolve unchanged

import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  ParamIR,
  StateFieldIR,
  TypeIR,
  UiApiParamIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { humanize, lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import type { LoadedPack } from "../../_packs/loader.js";
import { indentJsx } from "../../_walker/shared/args.js";
import type {
  ActionMutationState,
  FormOfState,
  OperationFormState,
  WalkContext,
  WorkflowFormState,
} from "../../_walker/walker-core.js";
import { emitExpr, walkBody } from "../../_walker/walker-core.js";
import { idTargetHookVar } from "../../react/form-helpers.js";
import { renderSvelteApiHookImports, renderSvelteImportLines } from "./import-lines.js";
import { svelteTarget } from "./svelte-target.js";

/** Map each aggregate-typed param to its aggregate name (mirrors the
 *  react shell — powers `Action(<param>.<op>)` resolution). */
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

/** Function-top mutation-handle declarations + api imports for
 *  `Action(<instance>.<op>)`.  The svelte api factories take the id
 *  as an accessor, so the rendered idExpr wraps in a thunk. */
function renderActionMutations(actionMutations: readonly ActionMutationState[]): {
  imports: string;
  decls: string;
} {
  const importsByModule = new Map<string, Set<string>>();
  for (const m of actionMutations) {
    const mod = `$lib/api/${m.aggCamel}`;
    (importsByModule.get(mod) ?? importsByModule.set(mod, new Set()).get(mod)!).add(m.hookName);
  }
  const imports = [...importsByModule.entries()]
    .map(([mod, names]) => `  import { ${[...names].sort().join(", ")} } from "${mod}";\n`)
    .join("");
  const decls = actionMutations
    .map((m) => `  const ${m.localVar} = ${m.hookName}(() => ${m.idExpr});\n`)
    .join("");
  return { imports, decls };
}

type FormWiring = {
  decls: string;
  /** Top-level `{#snippet …}` blocks (operation-form modals) placed
   *  after the main markup — Svelte's one-component-per-file rule
   *  means "module scope" lands in the template as snippets. */
  templateScope: string;
  usesNavigate: boolean;
};

function renderFormOfWiring(state: FormOfState, pack: LoadedPack): FormWiring {
  if (state.kind === "workflow") return renderFormRunsWiring(state, pack);
  if (state.kind === "operation") return renderFormOpWiring(state, pack);
  const { agg, idTargets, useController, defaultValuesTs, onSubmitJs } = state;
  const tplCtx = {
    aggregateName: agg.name,
    aggregateNameCamel: lowerFirst(agg.name),
    pluralAggregateName: plural(agg.name),
    snakePluralAggregate: snake(plural(agg.name)),
    humanAgg: humanize(agg.name),
    humanAggLower: humanize(agg.name).toLowerCase(),
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
    decls: decls.endsWith("\n") ? decls : `${decls}\n`,
    templateScope: "",
    usesNavigate: onSubmitJs === null,
  };
}

function renderFormRunsWiring(state: WorkflowFormState, pack: LoadedPack): FormWiring {
  const { workflow, idTargets, useController, defaultValuesTs, onSubmitJs } = state;
  const wfPascal = upperFirst(workflow.name);
  const tplCtx = {
    workflowName: workflow.name,
    workflowPascal: wfPascal,
    humanWorkflow: humanize(workflow.name),
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
    decls: decls.endsWith("\n") ? decls : `${decls}\n`,
    templateScope: "",
    usesNavigate: onSubmitJs === null,
  };
}

function renderFormOpWiring(state: OperationFormState, pack: LoadedPack): FormWiring {
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
  };
  const decls = pack.render("form-op-decls", tplCtx);
  const snippet = pack.render("form-op-module", tplCtx);
  return {
    decls: decls.endsWith("\n") ? decls : `${decls}\n`,
    templateScope: snippet.endsWith("\n") ? snippet : `${snippet}\n`,
    usesNavigate: false,
  };
}

/** Render a page's full `+page.svelte` module around a walked body. */
export function renderSveltePage(
  pageName: string,
  body: ExprIR,
  pack: LoadedPack,
  params: ParamIR[] = [],
  state: StateFieldIR[] = [],
  title: ExprIR | undefined = undefined,
  userComponents: ReadonlyMap<string, readonly ParamIR[]> = new Map(),
  apiParams: ReadonlyArray<UiApiParamIR> = [],
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
  bcByAggregate: ReadonlyMap<string, BoundedContextIR> = new Map(),
  workflowsByName: ReadonlyMap<string, WorkflowIR> = new Map(),
  bcByWorkflow: ReadonlyMap<string, BoundedContextIR> = new Map(),
  pageRoutes: ReadonlyMap<string, string> = new Map(),
): string {
  void pageName;
  const paramNames = new Set(params.map((p) => p.name));
  const stateNames = new Set(state.map((s) => s.name));
  const {
    tsx,
    imports,
    usedParams,
    usesNavigate,
    usesState,
    usedUserComponents,
    usedApiHooks,
    formOfs,
    actionMutations,
  } = walkBody(
    body,
    svelteTarget,
    pack,
    paramNames,
    stateNames,
    userComponents,
    apiParams,
    aggregatesByName,
    bcByAggregate,
    workflowsByName,
    bcByWorkflow,
    aggregateParamTypes(params, aggregatesByName),
    pageRoutes,
  );

  // Title — a plain `$effect`; runes auto-track any param/state the
  // expression reads, so no deps array is derived.
  let titleEffect = "";
  let usesStateForTitle = false;
  if (title !== undefined) {
    const titleCtx = dummyCtx(pack, paramNames, stateNames, usedParams);
    const titleExpr = emitExpr(title, titleCtx);
    usesStateForTitle = titleCtx.usesState && !usesState;
    titleEffect = `  $effect(() => {\n    document.title = ${titleExpr};\n  });\n`;
  }
  const effectiveUsesState = usesState || usesStateForTitle;

  const packImports = renderSvelteImportLines(imports);
  const userComponentImports = [...usedUserComponents]
    .sort()
    .map((name) => `  import ${name} from "$lib/components/${name}.svelte";\n`)
    .join("");
  const apiHookImports = renderSvelteApiHookImports(usedApiHooks);
  const apiHookDecls = svelteTarget
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
  const form = formOfs.reduce<FormWiring>(
    (acc, st) => {
      const w = renderFormOfWiring(st, pack);
      return {
        decls: acc.decls + w.decls,
        templateScope: acc.templateScope + w.templateScope,
        usesNavigate: acc.usesNavigate || w.usesNavigate,
      };
    },
    { decls: "", templateScope: "", usesNavigate: false },
  );
  const actionWiring = renderActionMutations(actionMutations);

  const navigateImport =
    usesNavigate || form.usesNavigate
      ? `  import { goto as navigate } from "$app/navigation";\n`
      : "";
  const pageStateImport = usedParams.size > 0 ? `  import { page } from "$app/state";\n` : "";
  // Used route params derive from the reactive `page.params` — bare
  // refs in the walked body (`{id}`) resolve against these locals.
  const paramLines = [...usedParams]
    .sort()
    .map((n) => `  const ${n} = $derived(page.params.${n} ?? "");\n`)
    .join("");
  const stateLines = effectiveUsesState
    ? state.map((f) => `  ${renderRunesState(f, pack)}\n`).join("")
    : "";

  const templateScope = form.templateScope === "" ? "" : `\n${form.templateScope}`;
  return `<!-- Auto-generated.  Do not edit by hand. -->
<script lang="ts">
${navigateImport}${pageStateImport}${packImports}${apiHookImports}${actionWiring.imports}${userComponentImports}${paramLines}${stateLines}${apiHookDecls}${actionWiring.decls}${form.decls}${titleEffect}</script>

${indentJsx(tsx, "")}
${templateScope}`;
}

/** Render one ComponentIR as `src/lib/components/<Name>.svelte`:
 *  typed `$props()` destructure, runes state, body walked through
 *  the shared machinery. */
export function renderSvelteComponentFile(
  name: string,
  params: ParamIR[],
  state: StateFieldIR[],
  body: ExprIR,
  pack: LoadedPack,
  userComponents: ReadonlyMap<string, readonly ParamIR[]>,
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
  bcByAggregate: ReadonlyMap<string, BoundedContextIR> = new Map(),
  pageRoutes: ReadonlyMap<string, string> = new Map(),
): string {
  void name;
  const paramNames = new Set(params.map((p) => p.name));
  const stateNames = new Set(state.map((s) => s.name));
  const {
    tsx,
    imports,
    usesState,
    usesNavigate,
    usedUserComponents,
    usesChildren,
    usedApiHooks,
    actionMutations,
    formOfs,
  } = walkBody(
    body,
    svelteTarget,
    pack,
    paramNames,
    stateNames,
    userComponents,
    [],
    aggregatesByName,
    bcByAggregate,
    new Map(),
    new Map(),
    aggregateParamTypes(params, aggregatesByName),
    pageRoutes,
  );
  const actionWiring = renderActionMutations(actionMutations);
  const form = formOfs.reduce<FormWiring>(
    (acc, st) => {
      const w = renderFormOfWiring(st, pack);
      return {
        decls: acc.decls + w.decls,
        templateScope: acc.templateScope + w.templateScope,
        usesNavigate: acc.usesNavigate || w.usesNavigate,
      };
    },
    { decls: "", templateScope: "", usesNavigate: false },
  );
  const packImports = renderSvelteImportLines(imports);
  const apiHookImports = renderSvelteApiHookImports(usedApiHooks);
  const apiHookDecls = svelteTarget
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
  const navigateImport =
    usesNavigate || form.usesNavigate
      ? `  import { goto as navigate } from "$app/navigation";\n`
      : "";
  const userComponentImports = [...usedUserComponents]
    .sort()
    .map((n) => `  import ${n} from "./${n}.svelte";\n`)
    .join("");
  // Snippet type for slot params + children — Svelte 5's analog of
  // ReactNode props.
  const dtoImports = new Map<string, string>();
  const propType = (p: ParamIR): string => {
    if (p.type.kind === "entity" && aggregatesByName.has(p.type.name)) {
      dtoImports.set(`${p.type.name}Response`, `$lib/api/${lowerFirst(p.type.name)}`);
      return `${p.type.name}Response`;
    }
    if (isSlotShape(p.type)) return "Snippet";
    return typeRefAsTsString(p);
  };
  const propEntries = params.map((p) => {
    const optional = p.type.kind === "optional" && p.type.inner.kind === "slot";
    return { name: p.name, optional, type: propType(p) };
  });
  if (usesChildren) propEntries.push({ name: "children", optional: true, type: "Snippet" });
  const needsSnippet = propEntries.some((e) => e.type === "Snippet");
  const snippetImport = needsSnippet ? `  import type { Snippet } from "svelte";\n` : "";
  const dtoImportLines = [...dtoImports.entries()]
    .map(([type, mod]) => `  import type { ${type} } from "${mod}";\n`)
    .join("");
  const propsDestructure =
    propEntries.length > 0
      ? `  let { ${propEntries.map((e) => e.name).join(", ")} }: { ${propEntries
          .map((e) => `${e.name}${e.optional ? "?" : ""}: ${e.type}`)
          .join("; ")} } = $props();\n`
      : "";
  // Slot-typed params render through `{@render}` — bare `{name}`
  // refs to a Snippet would print the function.  The walker emits
  // bare `{name}` for param refs; rewrite the slot-param ones.
  let markup = tsx;
  for (const p of params) {
    if (!isSlotShape(p.type)) continue;
    markup = markup.split(`{${p.name}}`).join(`{@render ${p.name}?.()}`);
  }
  const stateLines = usesState ? state.map((f) => `  ${renderRunesState(f, pack)}\n`).join("") : "";
  const templateScope = form.templateScope === "" ? "" : `\n${form.templateScope}`;
  return `<!-- Auto-generated.  Do not edit by hand. -->
<script lang="ts">
${snippetImport}${navigateImport}${packImports}${apiHookImports}${dtoImportLines}${actionWiring.imports}${userComponentImports}${propsDestructure}${stateLines}${apiHookDecls}${actionWiring.decls}${form.decls}</script>

${indentJsx(markup, "")}
${templateScope}`;
}

function isSlotShape(t: ParamIR["type"]): boolean {
  return t.kind === "slot" || (t.kind === "optional" && t.inner.kind === "slot");
}

/** `let name = $state<T>(init);` — one per state field. */
function renderRunesState(field: StateFieldIR, pack: LoadedPack): string {
  const tsType = stateTypeAsTsString(field.type);
  const init =
    field.init !== undefined
      ? renderInitExpr(field.init, pack)
      : svelteTarget.defaultInitFor(field.type);
  return `let ${field.name} = $state<${tsType}>(${init});`;
}

/** Render a state-field initializer with an empty walker context —
 *  initializers can't reference state or params. */
function renderInitExpr(expr: ExprIR, pack: LoadedPack): string {
  return emitExpr(expr, dummyCtx(pack, new Set(), new Set(), new Set()));
}

function dummyCtx(
  pack: LoadedPack,
  paramNames: ReadonlySet<string>,
  stateNames: ReadonlySet<string>,
  usedParams: Set<string>,
): WalkContext {
  return {
    target: svelteTarget,
    imports: new Map(),
    pack,
    paramNames,
    usedParams,
    usesNavigate: false,
    stateNames,
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
    usesCodeBlock: false,
  };
}

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

function typeRefAsTsString(p: ParamIR): string {
  const t = p.type;
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
      case "decimal":
        return "number";
      case "bool":
        return "boolean";
      default:
        return "string";
    }
  }
  return "string";
}
