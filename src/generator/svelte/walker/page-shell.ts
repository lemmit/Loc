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
  ActionIR,
  AggregateIR,
  BoundedContextIR,
  DerivedIR,
  ExprIR,
  ParamIR,
  StateFieldIR,
  StoreIR,
  TypeIR,
  UiApiParamIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { typeUsesMoney } from "../../../ir/types/loom-ir.js";
import { humanize, lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { idTargetHookVar } from "../../_frontend/form-helpers.js";
import { renderGateExpr } from "../../_frontend/gate-expr.js";
import type { LoadedPack } from "../../_packs/loader.js";
import { storeMemberLocal } from "../../_walker/js-target-helpers.js";
import { indentJsx } from "../../_walker/shared/args.js";
import type {
  ActionMutationState,
  ApiHookUse,
  FormOfState,
  ImportMap,
  OperationFormState,
  WalkContext,
  WorkflowFormState,
} from "../../_walker/walker-core.js";
import { emitExpr, renderActionHandlers, walkBody } from "../../_walker/walker-core.js";
import { storeImportSpecifier, storeVarName } from "../store-builder.js";
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
  /** Extern frontend function names declared on this ui. */
  externFunctions: ReadonlySet<string> = new Set(),
  /** Page-level `derived name: T = expr` bindings — hoisted as `$derived`
   *  consts before the body. */
  derived: DerivedIR[] = [],
  /** Page-level `requires <expr>` UI authorization gate (D-AUTH-OIDC).  When
   *  set (the frontend has `auth: ui`), the `<script>` binds the verified
   *  session user and the body is wrapped in an `{#if}` that renders a
   *  `<Forbidden/>` fallback when the currentUser-only predicate fails — the
   *  client mirror of the backend 403.  Undefined ⇒ ungated (byte-identical). */
  requires: ExprIR | undefined = undefined,
  /** True when the hosting deployable has `auth: ui` — enables currentUser-only
   *  operation-`requires` gating on `Action(...)` buttons in the body. */
  authUi = false,
  /** Named, typed page event handlers — hoisted as `const <name> = … =>`
   *  arrow consts in `<script>` (Proposal A Stage 1). */
  actions: ActionIR[] = [],
  /** Shared client-side stores declared on the hosting ui (`store Cart { … }`).
   *  Drives the `<script>` store-import + `$derived` field bindings for any
   *  store this page reads / calls (named-actions-and-stores.md §3, Stage 5). */
  stores: readonly StoreIR[] = [],
): string {
  void pageName;
  const paramNames = new Set(params.map((p) => p.name));
  const stateNames = new Set(state.map((s) => s.name));
  const derivedNames = new Set(derived.map((d) => d.name));
  const {
    tsx,
    imports,
    usedParams,
    usesNavigate,
    usesTableSort,
    usesState,
    usesCurrentUser,
    usesRouteId,
    usedUserComponents,
    usedApiHooks,
    formOfs,
    actionMutations,
    usedExternFunctions,
    usedActions,
    usedStores,
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
    externFunctions,
    derivedNames,
    authUi,
  );
  // Page `derived` bindings → hoisted `$derived` consts (runes auto-track).
  // A derived reading a state field forces the `$state` declaration even
  // when the body never reads it directly.
  const derivedResult = buildDerivedLines(derived, pack, paramNames, stateNames);
  const derivedLines = derivedResult.lines;

  // Named-action handlers → `<script>` arrow consts (Proposal A Stage 1).
  // A handler that mutates state forces the `$state` declaration.  Share the
  // body walk's `usedStores` map so a store referenced ONLY from an action body
  // (`discard() { Cart.clear() }`) still drives the shell's store import + bind.
  const actionResult = buildActionLines(
    actions,
    usedActions ?? new Set(),
    pack,
    paramNames,
    stateNames,
    usedStores,
    // Share the page's api/import sinks + entity lookups so an action body that
    // awaits a remote op (`match await Sales.Order.op()` — async-actions-and-
    // effects.md Stage 2) detects the mutation, hoists `use<Op><Agg>(id)`, and
    // lands the `ApiError` / union-type imports on THIS page.
    {
      imports,
      usedApiHooks,
      apiParams,
      aggregatesByName,
      bcByAggregate,
      workflowsByName,
      bcByWorkflow,
      pageRoutes,
      usedParams,
      usesNavigate,
      authUi,
    },
  );
  const actionLines = actionResult.lines;
  // Store wiring (Stage 5) — import + `$derived` field bindings.  Computed AFTER
  // action handlers so action-body store use is included in `usedStores`.
  const store = renderStoreWiring(
    usedStores,
    stores,
    new Set([...stateNames, ...paramNames, ...derivedNames]),
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
  const effectiveUsesState =
    usesState || usesStateForTitle || derivedResult.usesState || actionResult.usesState;

  const packImports = renderSvelteImportLines(imports);
  // Interactive-table sort helper — imported only when a sortable `Table`
  // renders on this page (M-T1.1).
  const tableSortImport = usesTableSort ? `  import { sortRows } from "$lib/table-sort";\n` : "";
  const userComponentImports = [...usedUserComponents]
    .sort()
    .map((name) => `  import ${name} from "$lib/components/${name}.svelte";\n`)
    .join("");
  // One named-import line per extern function the body calls — the
  // conformance shim at `src/lib/<name>.ts` (the typed seam; see
  // extern-function-hook-escape-hatch.md §3).
  const externFunctionImports = [...(usedExternFunctions ?? [])]
    .sort()
    .map((name) => `  import { ${name} } from "$lib/${name}";\n`)
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
    usesNavigate || form.usesNavigate || actionResult.usesNavigate
      ? `  import { goto as navigate } from "$app/navigation";\n`
      : "";
  // Route params to bind: the declared/used ones plus the magic route `id`
  // (`byId(id)`) when the body — OR an awaited-op action handler (Stage 2, whose
  // `use<Op><Agg>(id)` hook binds off the route id) — referenced it.
  const routeParamNames = new Set(usedParams);
  if (usesRouteId || actionResult.usesRouteId) routeParamNames.add("id");
  const pageStateImport = routeParamNames.size > 0 ? `  import { page } from "$app/state";\n` : "";
  // Used route params derive from the reactive `page.params` — bare
  // refs in the walked body (`{id}`) resolve against these locals.
  const paramLines = [...routeParamNames]
    .sort()
    .map((n) => `  const ${n} = $derived(page.params.${n} ?? "");\n`)
    .join("");
  const stateLines = effectiveUsesState
    ? state.map((f) => `  ${renderRunesState(f, pack)}\n`).join("")
    : "";
  // A money-typed `state {}` field renders as `$state<Decimal>(new
  // Decimal("0"))` — pull decimal.js into the <script> (the dep rides
  // the deployable's money-usage flag in package.json).
  const decimalImport =
    effectiveUsesState && state.some((f) => typeUsesMoney(f.type))
      ? `  import Decimal from "decimal.js";\n`
      : "";

  const templateScope = form.templateScope === "" ? "" : `\n${form.templateScope}`;
  // Page-level `requires` UI gate: bind the verified session user in `<script>`
  // and wrap the body markup in an `{#if}` that renders `<Forbidden/>` when the
  // currentUser-only predicate fails (Svelte has no early-return in markup, so
  // the guard is a template conditional, not a control-flow return).
  const gate = renderSveltePageGate(requires, usesCurrentUser);
  const markup = gate.guardOpen
    ? `${gate.guardOpen}\n${indentJsx(tsx, "  ")}\n${gate.guardClose}`
    : indentJsx(tsx, "");
  return `<!-- Auto-generated.  Do not edit by hand. -->
<script lang="ts">
${gate.import}${navigateImport}${pageStateImport}${decimalImport}${packImports}${tableSortImport}${apiHookImports}${store.imports}${actionWiring.imports}${userComponentImports}${externFunctionImports}${paramLines}${stateLines}${apiHookDecls}${store.decls}${actionWiring.decls}${form.decls}${derivedLines}${actionLines}${gate.binding}${titleEffect}</script>

${markup}
${templateScope}`;
}

/** Render the page's `requires` UI gate fragments: the `useSession` import, the
 *  `<script>` user binding, and the `{#if}` markup wrapper.  All empty when the
 *  page is ungated. */
function renderSveltePageGate(
  requires: ExprIR | undefined,
  usesCurrentUser: boolean,
): {
  import: string;
  binding: string;
  guardOpen: string;
  guardClose: string;
} {
  // The session-user binding + `useSession` import are needed when the page
  // has a `requires` gate OR the body has a currentUser-gated action button
  // (`usesCurrentUser`).  The `{#if}` Forbidden wrap is page-`requires`-only.
  if (!requires && !usesCurrentUser) {
    return { import: "", binding: "", guardOpen: "", guardClose: "" };
  }
  return {
    import: `  import { useSession } from "$lib/auth/AuthGate.svelte";\n`,
    // Dynamic OIDC/JWT claims → loose type so chained access / membership stays
    // svelte-check-clean under the generated project's strict config.
    binding: `  const currentUser = useSession().user as Record<string, any>;\n`,
    guardOpen: requires
      ? `{#if !(${renderGateExpr(requires, "currentUser")})}
  <div style="padding:24px"><h2>Forbidden</h2><p>You do not have access to this page.</p></div>
{:else}`
      : "",
    guardClose: requires ? `{/if}` : "",
  };
}

/** Render the `<script>` store wiring for a page/component
 *  (named-actions-and-stores.md §3, Stage 5).  For every store member the body
 *  used, import it from the store's `.svelte.ts` module and — for FIELD reads —
 *  bind a local named after the field via `$derived` so the reactive read
 *  survives (the walker emits the body ref as the bare field name).  ACTION
 *  calls need only the import; the body invokes the bare imported name.
 *
 *  The store object singleton (`cart`) is imported when any field is read so
 *  `$derived(cart.lines)` resolves; individual action functions are imported by
 *  name.  Distinguishing fields from actions needs the store definitions, hence
 *  the `stores` lookup. */
function renderStoreWiring(
  usedStores: Map<string, Set<string>> | undefined,
  stores: readonly StoreIR[],
  /** Page-level binding names (state / params / derived).  A store member whose
   *  name collides binds/imports a store-qualified local (`cartLines`) so it
   *  doesn't duplicate the page declaration — matching `storeLocalFor` in
   *  walker-core.  An aliased action imports `{ clear as cartClear }`. */
  reserved: ReadonlySet<string> = new Set(),
): { imports: string; decls: string } {
  if (!usedStores || usedStores.size === 0) return { imports: "", decls: "" };
  const storesByName = new Map(stores.map((s) => [s.name, s]));
  const importLines: string[] = [];
  const declLines: string[] = [];
  for (const storeName of [...usedStores.keys()].sort()) {
    const store = storesByName.get(storeName);
    const fieldNames = new Set((store?.state ?? []).map((f) => f.name));
    const storeVar = storeVarName(storeName);
    const used = [...usedStores.get(storeName)!].sort();
    const usedFields = used.filter((m) => fieldNames.has(m));
    const usedActions = used.filter((m) => !fieldNames.has(m));
    // Named imports: the store-object singleton (only when a field is read) +
    // each used action function.  An action whose name collides with a page
    // binding imports aliased (`clear as cartClear`) so the body's bound-local
    // call resolves.  Deduped + sorted for stable output.
    const actionImports = usedActions.map((a) => {
      const local = storeMemberLocal(storeName, a, reserved);
      return local === a ? a : `${a} as ${local}`;
    });
    const named = [...(usedFields.length > 0 ? [storeVar] : []), ...actionImports].sort();
    importLines.push(`  import { ${named.join(", ")} } from "${storeImportSpecifier(storeName)}";`);
    // Field reads → reactive `$derived` binding named after the field (the body
    // references the bare local, store-qualified on collision).
    for (const field of usedFields) {
      const local = storeMemberLocal(storeName, field, reserved);
      declLines.push(`  const ${local} = $derived(${storeVar}.${field});`);
    }
  }
  return {
    imports: importLines.length > 0 ? `${importLines.join("\n")}\n` : "",
    decls: declLines.length > 0 ? `${declLines.join("\n")}\n` : "",
  };
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
  /** Extern frontend function names declared on this ui. */
  externFunctions: ReadonlySet<string> = new Set(),
  /** Component-level `derived` bindings — hoisted as `$derived` consts. */
  derived: DerivedIR[] = [],
  /** True when the hosting deployable has `auth: ui` — enables currentUser-only
   *  operation-`requires` gating on `Action(...)` buttons (a component is the
   *  canonical Action host).  Binding-only: components carry no page gate. */
  authUi = false,
  /** Named, typed component event handlers (Proposal A Stage 1). */
  actions: ActionIR[] = [],
  /** Shared client-side stores declared on the hosting ui — drives the
   *  `<script>` store-import + `$derived` field bindings (Stage 5). */
  stores: readonly StoreIR[] = [],
): string {
  void name;
  const paramNames = new Set(params.map((p) => p.name));
  const stateNames = new Set(state.map((s) => s.name));
  const derivedNames = new Set(derived.map((d) => d.name));
  const {
    tsx,
    imports,
    usesState,
    usesTableSort,
    usesNavigate,
    usesCurrentUser,
    usedUserComponents,
    usesChildren,
    usedApiHooks,
    actionMutations,
    formOfs,
    usedExternFunctions,
    usedActions,
    usedStores,
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
    externFunctions,
    derivedNames,
    authUi,
  );
  // currentUser binding for any gated `Action(...)` button in the body (the
  // action-level mirror of the page gate; binding-only — components have no
  // page `requires`).
  const gate = renderSveltePageGate(undefined, usesCurrentUser);
  // Component `derived` bindings → hoisted `$derived` consts.  A derived
  // reading a state field forces the `$state` declaration.
  const derivedResult = buildDerivedLines(derived, pack, paramNames, stateNames);
  const derivedLines = derivedResult.lines;
  // Named-action handlers → `<script>` arrow consts (Proposal A Stage 1).
  // Share `usedStores` so an action-body store call is recorded for the shell.
  const actionResult = buildActionLines(
    actions,
    usedActions ?? new Set(),
    pack,
    paramNames,
    stateNames,
    usedStores,
  );
  const actionLines = actionResult.lines;
  // Store wiring (Stage 5) — after action handlers so action-body store use is
  // included.
  const store = renderStoreWiring(
    usedStores,
    stores,
    new Set([...stateNames, ...paramNames, ...derivedNames]),
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
  const tableSortImport = usesTableSort ? `  import { sortRows } from "$lib/table-sort";\n` : "";
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
  const externFunctionImports = [...(usedExternFunctions ?? [])]
    .sort()
    .map((n) => `  import { ${n} } from "$lib/${n}";\n`)
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
  const effectiveUsesState = usesState || derivedResult.usesState || actionResult.usesState;
  const stateLines = effectiveUsesState
    ? state.map((f) => `  ${renderRunesState(f, pack)}\n`).join("")
    : "";
  const decimalImport =
    effectiveUsesState && state.some((f) => typeUsesMoney(f.type))
      ? `  import Decimal from "decimal.js";\n`
      : "";
  const templateScope = form.templateScope === "" ? "" : `\n${form.templateScope}`;
  return `<!-- Auto-generated.  Do not edit by hand. -->
<script lang="ts">
${gate.import}${snippetImport}${navigateImport}${decimalImport}${packImports}${tableSortImport}${apiHookImports}${dtoImportLines}${store.imports}${actionWiring.imports}${userComponentImports}${externFunctionImports}${propsDestructure}${gate.binding}${stateLines}${apiHookDecls}${store.decls}${actionWiring.decls}${form.decls}${derivedLines}${actionLines}</script>

${indentJsx(markup, "")}
${templateScope}`;
}

function isSlotShape(t: ParamIR["type"]): boolean {
  return t.kind === "slot" || (t.kind === "optional" && t.inner.kind === "slot");
}

function actionShape(t: ParamIR["type"]): Extract<ParamIR["type"], { kind: "action" }> | undefined {
  if (t.kind === "action") return t;
  if (t.kind === "optional" && t.inner.kind === "action") return t.inner;
  return undefined;
}

/** Machine-owned typed props for an `extern` component, at
 *  `src/lib/components/<Name>.props.ts` — the SvelteKit sibling of
 *  react's `renderExternComponentProps`.  Each declared param becomes a
 *  typed field by the same wire rules the walked component uses: an
 *  aggregate-typed param gets the wire DTO (`<Agg>Response`, imported
 *  from `$lib/api/<agg>`), `slot` / `slot?` map to Svelte 5's `Snippet`,
 *  an `action` param maps to a void callback (Tier 2), everything else
 *  falls back to the route-param shape.  The hand-written `.svelte`
 *  module imports this type to check its `$props()`. */
export function renderSvelteExternComponentProps(
  name: string,
  params: ParamIR[],
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
): string {
  const dtoImports = new Map<string, string>();
  const wireType = (t: ParamIR["type"]): string => {
    if (t.kind === "entity" && aggregatesByName.has(t.name)) {
      dtoImports.set(`${t.name}Response`, `$lib/api/${lowerFirst(t.name)}`);
      return `${t.name}Response`;
    }
    if (t.kind === "array") return `${wireType(t.element)}[]`;
    return "string";
  };
  const propType = (p: ParamIR): string => {
    if (p.type.kind === "entity" || (p.type.kind === "array" && p.type.element.kind === "entity")) {
      return wireType(p.type);
    }
    if (isSlotShape(p.type)) return "Snippet";
    const action = actionShape(p.type);
    if (action) return action.arg ? `(arg: ${wireType(action.arg)}) => void` : "() => void";
    return typeRefAsTsString(p);
  };
  const propLines = params.map((p) => {
    const optional =
      p.type.kind === "optional" &&
      (p.type.inner.kind === "slot" || p.type.inner.kind === "action");
    return `  ${p.name}${optional ? "?:" : ":"} ${propType(p)};`;
  });
  const needsSnippet = params.some((p) => isSlotShape(p.type));
  const snippetImport = needsSnippet ? `import type { Snippet } from "svelte";\n` : "";
  const dtoImportLines = [...dtoImports.entries()]
    .map(([type, mod]) => `import type { ${type} } from "${mod}";\n`)
    .join("");
  const body =
    propLines.length > 0
      ? `export interface ${name}Props {\n${propLines.join("\n")}\n}\n`
      : `export type ${name}Props = Record<string, never>;\n`;
  return `// AUTO-GENERATED by Loom — typed props for the extern component '${name}'.
// Do not edit; overwritten on every generate.  Import this type from your
// hand-written .svelte module (declared via \`component ${name}(...) extern from\`).
${snippetImport}${dtoImportLines}\n${body}`;
}

/** Machine-owned re-export wrapper for an `extern` component, at
 *  `src/lib/components/<Name>.svelte`.  Call sites import
 *  `$lib/components/<Name>.svelte` exactly as for a walked component;
 *  the wrapper forwards its typed `$props()` to the hand-written module
 *  at the `from` path (src-relative, so two `../` hops up from
 *  `src/lib/components/`).  Loom owns this wrapper + `<Name>.props.ts`;
 *  the user owns the target module — a missing target or a props
 *  mismatch fails `svelte-check`, the fail-fast (react's contract,
 *  SvelteKit shape). */
export function renderSvelteExternComponentShim(name: string, externPath: string): string {
  const rel = externPath.replace(/^\.?\//, "");
  return `<!-- AUTO-GENERATED extern component shim.  Forwards to the hand-written
     module declared via \`component ${name}(...) extern from "${externPath}"\`.
     Loom owns this wrapper + './${name}.props'; you own '../../${rel}'. -->
<script lang="ts">
  import Impl from "../../${rel}";
  import type { ${name}Props } from "./${name}.props";

  const props: ${name}Props = $props();
</script>

<Impl {...props} />
`;
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
    derivedNames: new Set(),
    authUi: false,
    usesState: false,
    usesCurrentUser: false,
    usesRouterLink: false,
    usesRouteId: false,
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

/** Build the `<script>` hoist lines for a page/component's
 *  `derived name: T = expr` bindings — each lands as a
 *  `const <name> = $derived(<expr>);`.  Svelte 5's `$derived` rune takes
 *  the expression DIRECTLY (not a thunk) and auto-tracks its `$state` /
 *  `$props` dependencies, so no deps array is derived.  Bindings emit in
 *  declaration order, accumulating `seenDerived` so a later derived can
 *  reference an earlier one (resolved as a bare ref via `derivedNames`).
 *  Runes reads are bare names everywhere, so no `.value` re-pointing is
 *  needed (unlike Vue/React). */
function buildDerivedLines(
  derived: readonly DerivedIR[],
  pack: LoadedPack,
  paramNames: ReadonlySet<string>,
  stateNames: ReadonlySet<string>,
): { lines: string; usesState: boolean } {
  const seenDerived = new Set<string>();
  let lines = "";
  let usesState = false;
  for (const d of derived) {
    const dctx = dummyCtx(pack, paramNames, stateNames, new Set());
    dctx.derivedNames = seenDerived;
    const exprStr = emitExpr(d.expr, dctx);
    if (dctx.usesState) usesState = true;
    lines += `  const ${d.name} = $derived(${exprStr});\n`;
    seenDerived.add(d.name);
  }
  return { lines, usesState };
}

/** Build the `<script>` named-action handlers for a page/component
 *  (named-actions-and-stores.md, Proposal A Stage 1).  Svelte 5 `$state`
 *  reads/writes are bare names everywhere (no `.value` deref), so the shared
 *  `renderActionHandlers` default (`const <name> = (<p>?) => { … }`) is
 *  already correct — only referenced actions emit. */
/** Shared page-level sinks + lookups an action-handler walk must see so an
 *  awaited remote effect (`match await Sales.Order.op()` — async-actions-and-
 *  effects.md Stage 2) in an action body resolves + hoists into the SAME shell
 *  as the main body walk: the api-param handles (`apiParamNames`) let
 *  `tryDetectApiHook` recognise the mutation, and sharing `imports` +
 *  `usedApiHooks` by reference lands the `ApiError` / union-type imports and the
 *  hoisted `use<Op><Agg>(id)` on the page (not a throwaway ctx). */
interface ActionWalkShared {
  imports: ImportMap;
  usedApiHooks: Map<string, ApiHookUse>;
  apiParams: ReadonlyArray<UiApiParamIR>;
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
  bcByAggregate: ReadonlyMap<string, BoundedContextIR>;
  workflowsByName: ReadonlyMap<string, WorkflowIR>;
  bcByWorkflow: ReadonlyMap<string, BoundedContextIR>;
  pageRoutes: ReadonlyMap<string, string>;
  usedParams: Set<string>;
  usesNavigate: boolean;
  authUi: boolean;
}

function buildActionLines(
  actions: readonly ActionIR[],
  used: ReadonlySet<string>,
  pack: LoadedPack,
  paramNames: ReadonlySet<string>,
  stateNames: ReadonlySet<string>,
  /** Shared by reference from the page/component body walk so a store call in an
   *  action body (`discard() { Cart.clear() }`) is recorded for the shell's
   *  store wiring (Stage 5). */
  usedStores?: Map<string, Set<string>>,
  /** When present, the action walk shares the page's api/import sinks + entity
   *  lookups so an awaited op (Stage 2) hoists into the same shell.  Omitted for
   *  components (no api handles to await against). */
  shared?: ActionWalkShared,
): { lines: string; usesState: boolean; usesRouteId: boolean; usesNavigate: boolean } {
  const ctx = dummyCtx(pack, paramNames, stateNames, shared?.usedParams ?? new Set());
  if (usedStores) ctx.usedStores = usedStores;
  if (shared) {
    ctx.imports = shared.imports;
    ctx.usedApiHooks = shared.usedApiHooks;
    ctx.apiParamNames = new Map(shared.apiParams.map((p) => [p.name, p.apiName]));
    ctx.aggregatesByName = shared.aggregatesByName;
    ctx.bcByAggregate = shared.bcByAggregate;
    ctx.workflowsByName = shared.workflowsByName;
    ctx.bcByWorkflow = shared.bcByWorkflow;
    ctx.pageRoutes = shared.pageRoutes;
    ctx.authUi = shared.authUi;
    ctx.usesNavigate = shared.usesNavigate;
  }
  const handlers = renderActionHandlers(actions, used, ctx);
  const lines = handlers
    ? `${handlers
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")}\n`
    : "";
  return {
    lines,
    usesState: ctx.usesState,
    usesRouteId: ctx.usesRouteId,
    usesNavigate: ctx.usesNavigate,
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
