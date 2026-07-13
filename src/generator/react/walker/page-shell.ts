// Page-file shell assembly: wraps a walked body in the full page
// module (imports, hooks, useForm/mutation wiring, state, typed
// useParams) and renders user-defined component files. This is the
// page-assembly layer that sits on top of the core walker engine in
// body-walker.ts; it consumes the FormOfState records the form
// primitives push onto the walk sink.

import type {
  ActionIR,
  AggregateIR,
  BoundedContextIR,
  DerivedIR,
  ExprIR,
  ParamIR,
  StateFieldIR,
  TypeIR,
  UiApiParamIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { typeUsesMoney } from "../../../ir/types/loom-ir.js";
import { humanize, lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { renderGateExpr } from "../../_frontend/gate-expr.js";
import type { LoadedPack } from "../../_packs/loader.js";
import { routerPackageForStack } from "../../_packs/stack-runtime.js";
import { storeHookName, storeMemberLocal } from "../../_walker/js-target-helpers.js";
import { renderActionHandlers } from "../../_walker/walker-core.js";
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
   *  Required for `CreateForm(of: <Agg>)` field dispatch and
   *  `IdLink(of: <Agg>)` display-field resolution. */
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
  /** Owning bounded context per aggregate (drives
   *  enum / value-object resolution inside the form-field
   *  preparer). */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR> = new Map(),
  /** Relative-path prefix from the emitted page TSX
   *  back to the `src/` root.  Defaults to `"../"` for pages at
   *  `src/pages/<name>.tsx` (1 hop).  Scaffold-expanded pages live
   *  at `src/pages/<plural>/<arch>.tsx` (2 hops) so the caller
   *  passes `"../../"`.  Used to resolve api-hook + format-helper
   *  imports the shell emits at function-top. */
  srcImportPrefix: string = "../",
  /** Workflows reachable from this UI's deployable.
   *  Required for `WorkflowForm(runs: <wf>)` field dispatch. */
  workflowsByName: ReadonlyMap<string, WorkflowIR> = new Map(),
  /** Owning bounded context per workflow. */
  bcByWorkflow: ReadonlyMap<string, BoundedContextIR> = new Map(),
  /** Page name → route path, for `Action`'s `then: navigate(<Page>)`. */
  pageRoutes: ReadonlyMap<string, string> = new Map(),
  /** Extern frontend functions declared on this ui — body calls
   *  register a use; the shell imports each used one from its
   *  `src/lib/<name>` conformance shim. */
  externFunctions: ReadonlySet<string> = new Set(),
  /** Page-level `derived name: T = expr` bindings — read-only computed
   *  values hoisted as `useMemo` before the body. */
  derived: DerivedIR[] = [],
  /** Page-level `requires <expr>` UI authorization gate (D-AUTH-OIDC).  When
   *  set (the frontend has `auth: ui`), the component binds the verified
   *  session user and renders a `<Forbidden/>` fallback instead of the body
   *  when the currentUser-only predicate fails — the client mirror of the
   *  backend 403.  Undefined → no gate (byte-identical to the ungated page). */
  requires: ExprIR | undefined = undefined,
  /** True when the hosting frontend deployable has `auth: ui`.  Threaded into
   *  the walk so `Action(<instance>.<op>)` buttons gate on currentUser-only
   *  operation `requires` predicates (the action-level mirror of the page
   *  `requires` guard).  When any such button is gated, the shell binds
   *  `currentUser` even if the page itself has no `requires`. */
  authUi: boolean = false,
  /** Named, typed page event handlers — `action next() { … }` (Proposal A
   *  Stage 1).  Each referenced action hoists to a `const <name> = … =>`
   *  handler before the body; a bare `onSubmit: <name>` reference binds it. */
  actions: ActionIR[] = [],
): string {
  const paramNames = new Set(params.map((p) => p.name));
  const stateNames = new Set(state.map((s) => s.name));
  const derivedNames = new Set(derived.map((d) => d.name));
  const {
    tsx,
    imports,
    usedParams,
    usesNavigate,
    usesState,
    usesCurrentUser,
    usesRouterLink,
    usesRouteId,
    usedUserComponents,
    usedApiHooks,
    formOfs,
    actionMutations,
    usedExternFunctions,
    usedActions,
    usedStores,
    usesFragment,
  } = walkBodyToTsx(
    body,
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
  // Page-derived bindings → hoisted `useMemo` computeds, in declaration
  // order (a derived may reference state, params, and EARLIER derived).
  // Body refs resolve to the bare const via the walker's `derivedNames`.
  // The deps array is the referenced state/param/earlier-derived names so
  // the memo recomputes reactively (over state).
  let derivedLines = "";
  let usesMemo = false;
  let usesStateForDerived = false;
  const seenDerived = new Set<string>();
  for (const d of derived) {
    const dctx: WalkContext = {
      target: tsxTarget,
      imports,
      pack,
      paramNames,
      usedParams,
      usesNavigate,
      stateNames,
      derivedNames: seenDerived,
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
    const exprStr = emitExpr(d.expr, dctx);
    if (dctx.usesState) usesStateForDerived = true;
    const refs = new Set<string>();
    collectExprRefs(d.expr, refs);
    const deps = [...refs]
      .filter((n) => paramNames.has(n) || stateNames.has(n) || seenDerived.has(n))
      .sort();
    derivedLines += `  const ${d.name} = useMemo(() => ${exprStr}, [${deps.join(", ")}]);\n`;
    seenDerived.add(d.name);
    usesMemo = true;
  }
  // Named-action handlers → hoisted `const <name> = (<p>?) => { … }` consts
  // before the body (Proposal A Stage 1).  Only referenced actions emit
  // (`usedActions`).  Bodies reuse `emitStmt` against a ctx with the page's
  // state/derived/params in scope, so a handler that mutates state sets
  // `usesState` (tracked into `effectiveUsesState`) and resolves `setX`.
  let actionLines = "";
  let usesStateForActions = false;
  let usesRouteIdForActions = false;
  if (actions.length > 0 && usedActions && usedActions.size > 0) {
    const actx: WalkContext = {
      target: tsxTarget,
      imports,
      pack,
      paramNames,
      usedParams,
      usesNavigate,
      stateNames,
      derivedNames,
      authUi: false,
      usesState: false,
      usesCurrentUser: false,
      usesRouterLink: false,
      usesRouteId: false,
      userComponents: new Map(),
      usedUserComponents: new Set(),
      usesChildren: false,
      // An action body may await a remote op (`match await Sales.Order.op()` —
      // async-actions-and-effects.md Stage 2), so the api-param handles must be
      // in scope for `tryDetectApiHook` to recognise the mutation + hoist it.
      apiParamNames: new Map(apiParams.map((p) => [p.name, p.apiName])),
      usedApiHooks,
      lambdaParams: new Map(),
      shellLocals: new Set(),
      aggregatesByName,
      bcByAggregate,
      workflowsByName,
      bcByWorkflow,
      formOfs: [],
      actionMutations: [],
      collectedTestids: new Set(),
      usesCodeBlock: false,
      externFunctions,
      usedExternFunctions,
      // Share the body walk's store-usage map so a store referenced ONLY from
      // an action body (`discard() { Cart.clear() }`) still drives the shell's
      // store-hook import + binding hoist (Stage 5).
      usedStores,
    };
    const handlers = renderActionHandlers(actions, usedActions, actx);
    if (handlers) {
      actionLines = `${handlers
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")}\n`;
    }
    usesStateForActions = actx.usesState;
    // An awaited op mutation hoists `use<Op><Agg>(id)` off the route id, so the
    // shell must destructure `id` from `useParams` even if the body never did.
    usesRouteIdForActions = actx.usesRouteId;
  }
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
      target: tsxTarget,
      imports,
      pack,
      paramNames,
      usedParams,
      usesNavigate,
      stateNames,
      derivedNames,
      authUi: false,
      usesState,
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
  const effectiveUsesState =
    usesState || usesStateForTitle || usesStateForDerived || usesStateForActions;
  const effectiveUsesRouteId = usesRouteId || usesRouteIdForActions;

  const mantineImport = renderImportLines(imports, srcImportPrefix);
  // One default-import line per user component
  // referenced in the body, sorted alphabetically.
  const userComponentImports = [...usedUserComponents]
    .sort()
    .map((name) => `import ${name} from "${srcImportPrefix}components/${name}";\n`)
    .join("");
  // One named-import line per extern function the body calls — the
  // conformance shim at `src/lib/<name>.ts` (the typed seam; see
  // extern-function-hook-escape-hatch.md §3).
  const externFunctionImports = [...(usedExternFunctions ?? [])]
    .sort()
    .map((name) => `import { ${name} } from "${srcImportPrefix}lib/${name}";\n`)
    .join("");
  // Api hook imports, grouped per `from` path so
  // multiple ops on the same aggregate dedupe to one import line
  // (matching the existing scaffold output's per-aggregate api file).
  const apiHookImports = renderApiHookImports(usedApiHooks, srcImportPrefix);
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
  // RHF wiring when the body included `CreateForm(of:)` /
  // `WorkflowForm(runs:)` / `OperationForm(of:, op:)` primitives.  Emits the
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
  // The magic route `id` (`byId(id)`) binds from `useParams` too, even when
  // the page declares no params — synthesize an `id: string` route param.
  const routeIdParam = effectiveUsesRouteId && !paramNames.has("id");
  const needsUseParams = hasParams || effectiveUsesRouteId;
  const routerSpecifiers: string[] = [];
  if (needsUseParams) routerSpecifiers.push("useParams");
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
  if (usesFragment) reactSpecifiers.push("Fragment");
  if (effectiveUsesState) reactSpecifiers.push("useState");
  if (usesEffect) reactSpecifiers.push("useEffect");
  if (usesMemo) reactSpecifiers.push("useMemo");
  const reactImport =
    reactSpecifiers.length > 0 ? `import { ${reactSpecifiers.join(", ")} } from "react";\n` : "";
  const stateLines = effectiveUsesState
    ? state.map((f) => `  ${renderUseState(f, pack)}\n`).join("")
    : "";
  // A money-typed `state {}` field renders as `useState<Decimal>(new
  // Decimal("0"))` — pull decimal.js into scope (the dep is added to
  // package.json via the deployable's money-usage flag).
  const decimalImport =
    effectiveUsesState && state.some((f) => typeUsesMoney(f.type))
      ? `import Decimal from "decimal.js";\n`
      : "";
  const typeEntries = params.map((p) => `${p.name}: ${typeRefAsTsString(p)}`);
  if (routeIdParam) typeEntries.push("id: string");
  const paramsType = needsUseParams ? `<{ ${typeEntries.join("; ")} }>` : "";
  const usedSet = new Set([...usedParams]);
  if (effectiveUsesRouteId) usedSet.add("id");
  const used = [...usedSet].sort();
  const paramsLine =
    used.length > 0
      ? `  const { ${used.join(", ")} } = useParams${paramsType}();\n`
      : needsUseParams
        ? `  useParams${paramsType}();\n`
        : "";
  const navigateLine =
    usesNavigate || form.usesNavigate ? `  const navigate = useNavigate();\n` : "";
  // Page-level `requires` UI gate (D-AUTH-OIDC): bind the verified session user
  // and render a `<Forbidden/>` fallback when the currentUser-only predicate
  // fails.  The guard lands AFTER every hook (useSession is itself a hook, so it
  // stays unconditional) and right before the body `return`, keeping the
  // rules-of-hooks contract intact while short-circuiting the render.
  const gate = renderPageGate(requires, usesCurrentUser, srcImportPrefix);
  const store = renderStoreWiring(
    usedStores,
    srcImportPrefix,
    new Set([...stateNames, ...paramNames, ...derivedNames]),
  );
  return `// Auto-generated.  Do not edit by hand.
${gate.import}${reactImport}${decimalImport}${reactRouterImport}${mantineImport}${apiHookImports}${actionWiring.imports}${store.imports}${userComponentImports}${externFunctionImports}${form.moduleScope}
export default function ${pageName}() {
${paramsLine}${navigateLine}${store.decls}${stateLines}${apiHookDecls}${actionWiring.decls}${form.decls}${derivedLines}${actionLines}${titleEffect}${gate.guard}  return (
    ${indentJsx(tsx, "    ")}
  );
}
`;
}

/** Render the page's currentUser binding + optional `requires` guard.
 *
 *  The verified-session-user binding (`const currentUser = useSession().user`)
 *  + its `useSession` import are emitted when the page has a `requires` gate
 *  OR the body contains a currentUser-gated action button (`usesCurrentUser`)
 *  — either path needs `currentUser` in scope.  The bind happens exactly once
 *  (no double-import / double-const when both are present).
 *
 *  The `if (!(gate)) return <Forbidden/>` short-circuit is emitted ONLY when
 *  the page itself declares `requires` — a page whose only currentUser
 *  consumer is a gated button binds the user but renders its body normally
 *  (the button hides itself).  All empty when neither applies (byte-identical
 *  to the ungated page). */
function renderPageGate(
  requires: ExprIR | undefined,
  usesCurrentUser: boolean,
  srcImportPrefix: string,
): { import: string; guard: string } {
  if (!requires && !usesCurrentUser) return { import: "", guard: "" };
  // Dynamic JWT claims → the session user is loosely typed; the cast keeps
  // chained claim access (`currentUser.org.tier`) and membership (`.includes`)
  // clean under the generated project's `strict` tsconfig.  `any` (not
  // `unknown`) because an `unknown` claim can't be indexed/called past one hop.
  const binding = `  const currentUser = useSession().user as Record<string, any>;`;
  // The Forbidden short-circuit only fires for a page-level `requires`.
  const forbidden = requires
    ? [
        `  if (!(${renderGateExpr(requires, "currentUser")})) {`,
        `    return (`,
        `      <div style={{ padding: 24 }}>`,
        `        <h2>Forbidden</h2>`,
        `        <p>You do not have access to this page.</p>`,
        `      </div>`,
        `    );`,
        `  }`,
      ].join("\n")
    : "";
  const guard = forbidden ? `${binding}\n${forbidden}\n` : `${binding}\n`;
  return {
    import: `import { useSession } from "${srcImportPrefix}auth/AuthGate";\n`,
    guard,
  };
}

/** Wire the stores a page/component body references (named-actions-and-
 *  stores.md §3, Stage 5).  For each used store, emit one hook import
 *  (`import { useCart } from "<prefix>stores/cart"`) and one selector binding
 *  per used member (`const lines = useCart((s) => s.lines)`).  Field reads and
 *  action calls share the SAME Zustand selector form, so the shell binds every
 *  used member uniformly — the body / action handlers reference the bare local. */
function renderStoreWiring(
  usedStores: Map<string, Set<string>> | undefined,
  srcImportPrefix: string,
  /** Page-level binding names (state / params / derived).  A store member whose
   *  name collides with one of these binds a store-qualified local (`cartLines`)
   *  so the selector binding doesn't shadow/duplicate the page declaration —
   *  matching the body use-site (`storeLocalFor` in walker-core). */
  reserved: ReadonlySet<string> = new Set(),
): { imports: string; decls: string } {
  if (!usedStores || usedStores.size === 0) return { imports: "", decls: "" };
  const importLines: string[] = [];
  const declLines: string[] = [];
  for (const storeName of [...usedStores.keys()].sort()) {
    const hook = storeHookName(storeName);
    importLines.push(`import { ${hook} } from "${srcImportPrefix}stores/${snake(storeName)}";`);
    for (const member of [...usedStores.get(storeName)!].sort()) {
      const local = storeMemberLocal(storeName, member, reserved);
      declLines.push(`  const ${local} = ${hook}((s) => s.${member});`);
    }
  }
  return {
    imports: importLines.length > 0 ? `${importLines.join("\n")}\n` : "",
    decls: declLines.length > 0 ? `${declLines.join("\n")}\n` : "",
  };
}

/** Assemble the RHF + create-mutation wiring around a
 *  `CreateForm(of: <Agg>)` body emission.  Rendered through per-pack
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

/** `OperationForm(of: <Agg>, op: <name>)` wiring.  Splits into three
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
      // setError is required by the catch-block `applyServerErrors` call
      // emitted by the pack's form-op-module template (see
      // docs/old/proposals/frontend-acl.md).  Always included.
      parts.push("setError");
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
  /** Extern frontend functions declared on this ui (shim imports for
   *  body calls — same seam as pages). */
  externFunctions: ReadonlySet<string> = new Set(),
  /** Component-level `derived` bindings — read-only computed values
   *  hoisted as `useMemo` before the body (same as pages). */
  derived: DerivedIR[] = [],
  /** True when the hosting frontend deployable has `auth: ui`.  A component
   *  is the canonical host for `Action(<instance>.<op>)` buttons, so the same
   *  currentUser-only operation-`requires` gating applies here — when a button
   *  is gated, the component binds `currentUser` + imports `useSession`.
   *  Components never carry a page-level `requires`, so no Forbidden guard. */
  authUi: boolean = false,
  /** Named, typed component event handlers — the component twin of the page
   *  `actions` (Proposal A Stage 1). */
  actions: ActionIR[] = [],
): string {
  const paramNames = new Set(params.map((p) => p.name));
  const stateNames = new Set(state.map((s) => s.name));
  const derivedNames = new Set(derived.map((d) => d.name));
  const {
    tsx,
    imports,
    usedParams,
    usesState,
    usesCurrentUser,
    usesRouterLink,
    usesNavigate,
    usedUserComponents,
    usesChildren,
    actionMutations,
    formOfs,
    usedExternFunctions,
    usedActions,
    usedStores,
    usesFragment,
  } = walkBodyToTsx(
    body,
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
  // Component-derived bindings → hoisted `useMemo` computeds (same as the
  // page shell). Body refs resolve to the bare const via `derivedNames`.
  let derivedLines = "";
  let usesMemo = false;
  let usesStateForDerived = false;
  const seenDerived = new Set<string>();
  for (const d of derived) {
    const dctx: WalkContext = {
      target: tsxTarget,
      imports,
      pack,
      paramNames,
      usedParams,
      usesNavigate,
      stateNames,
      derivedNames: seenDerived,
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
    const exprStr = emitExpr(d.expr, dctx);
    if (dctx.usesState) usesStateForDerived = true;
    const refs = new Set<string>();
    collectExprRefs(d.expr, refs);
    const deps = [...refs]
      .filter((n) => paramNames.has(n) || stateNames.has(n) || seenDerived.has(n))
      .sort();
    derivedLines += `  const ${d.name} = useMemo(() => ${exprStr}, [${deps.join(", ")}]);\n`;
    seenDerived.add(d.name);
    usesMemo = true;
  }
  // Named-action handlers → hoisted `const <name> = … =>` consts (same as the
  // page shell; Proposal A Stage 1).
  let actionLines = "";
  let usesStateForActions = false;
  if (actions.length > 0 && usedActions && usedActions.size > 0) {
    const actx: WalkContext = {
      target: tsxTarget,
      imports,
      pack,
      paramNames,
      usedParams,
      usesNavigate,
      stateNames,
      derivedNames,
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
      aggregatesByName,
      bcByAggregate,
      workflowsByName: new Map(),
      bcByWorkflow: new Map(),
      formOfs: [],
      actionMutations: [],
      collectedTestids: new Set(),
      usesCodeBlock: false,
      externFunctions,
      usedExternFunctions,
      // Share the body walk's store-usage map so a store referenced ONLY from
      // an action body (`discard() { Cart.clear() }`) still drives the shell's
      // store-hook import + binding hoist (Stage 5).
      usedStores,
    };
    const handlers = renderActionHandlers(actions, usedActions, actx);
    if (handlers) {
      actionLines = `${handlers
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")}\n`;
    }
    usesStateForActions = actx.usesState;
  }
  const compUsesState = usesState || usesStateForDerived || usesStateForActions;
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
  const reactSpecifiers: string[] = [];
  if (usesFragment) reactSpecifiers.push("Fragment");
  if (compUsesState) reactSpecifiers.push("useState");
  if (usesMemo) reactSpecifiers.push("useMemo");
  const reactImport =
    reactSpecifiers.length > 0 ? `import { ${reactSpecifiers.join(", ")} } from "react";\n` : "";
  const decimalImport =
    usesState && state.some((f) => typeUsesMoney(f.type))
      ? `import Decimal from "decimal.js";\n`
      : "";
  // Components that reference Slot() or declare a `slot`-typed
  // param get `ReactNode` in scope — Slot() emits `{children}` and
  // slot params are typed as `ReactNode`.  `slot?` (optional) lowers
  // to `{kind: "optional", inner: {kind: "slot"}}` and gets the same
  // treatment, but emits as `name?: ReactNode` so the caller can
  // omit it.
  const hasSlotParam = params.some((p) => isSlotShape(p.type));
  const needsReactNode = usesChildren || hasSlotParam;
  const reactTypesImport = needsReactNode ? `import type { ReactNode } from "react";\n` : "";
  const userComponentImports = [...usedUserComponents]
    .sort()
    .map((n) => `import ${n} from "./${n}";\n`)
    .join("");
  // Extern-function shim imports — components live at
  // `src/components/<Name>.tsx`, one hop from `src/lib/`.
  const externFunctionImports = [...(usedExternFunctions ?? [])]
    .sort()
    .map((n) => `import { ${n} } from "../lib/${n}";\n`)
    .join("");
  // Props interface — every declared param becomes a typed field;
  // Slot()-using components also get a `children` field.  An
  // aggregate-typed param (`order: Order`) gets the aggregate's wire
  // DTO type (`OrderResponse`, imported from its api module) so member
  // accesses like `order.id` / `order.customerId` typecheck;
  // slot-typed params (`heading: slot` / `heading: slot?`) render as
  // `ReactNode` so the caller can drop any walker expression into the
  // prop; other params fall back to the route-param `string` shape.
  const dtoImports = new Map<string, string>(); // DTO type → api module
  const propType = (p: ParamIR): string => {
    if (p.type.kind === "entity" && aggregatesByName.has(p.type.name)) {
      dtoImports.set(`${p.type.name}Response`, `../api/${lowerFirst(p.type.name)}`);
      return `${p.type.name}Response`;
    }
    if (isSlotShape(p.type)) {
      return "ReactNode";
    }
    // `action` / `action(Order)` → void callback (Tier 2); the arg
    // maps by the same wire-DTO rule as a data param.
    const action = actionShape(p.type);
    if (action) {
      if (action.arg?.kind === "entity" && aggregatesByName.has(action.arg.name)) {
        dtoImports.set(`${action.arg.name}Response`, `../api/${lowerFirst(action.arg.name)}`);
        return `(arg: ${action.arg.name}Response) => void`;
      }
      return action.arg ? "(arg: string) => void" : "() => void";
    }
    return typeRefAsTsString(p);
  };
  const propLines = params.map((p) => {
    // `slot?` / `action?` → optional prop (`name?: ReactNode`) so the
    // caller can omit it.  Required (`name: slot`) stays mandatory.
    const optional =
      p.type.kind === "optional" &&
      (p.type.inner.kind === "slot" || p.type.inner.kind === "action");
    const sep = optional ? "?:" : ":";
    return `  ${p.name}${sep} ${propType(p)};`;
  });
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
  const stateLines = compUsesState
    ? state.map((f) => `  ${renderUseState(f, pack)}\n`).join("")
    : "";
  // currentUser binding for any gated `Action(...)` button in the body
  // (the action-level mirror of the page `requires` guard).  A component
  // never has a page-level `requires`, so this is binding-only — no
  // Forbidden short-circuit.  Components sit one hop from `src/`, so the
  // `useSession` shim resolves via `../`.
  const gate = renderPageGate(undefined, usesCurrentUser, "../");
  // Suppress used-prop warnings — params declared but unused at
  // walker-emit time (e.g. typed pass-through to a child component
  // not yet wired) shouldn't trigger TS lint noise.  We reference
  // them with a `void` block when none made it into `tsx`.
  void usedParams;
  const store = renderStoreWiring(
    usedStores,
    "../",
    new Set([...stateNames, ...paramNames, ...derivedNames]),
  );
  return `// Auto-generated.  Do not edit by hand.
${gate.import}${reactImport}${reactTypesImport}${reactRouterImport}${mantineImport}${dtoImportLines}${actionWiring.imports}${store.imports}${userComponentImports}${externFunctionImports}${propsType}${form.moduleScope}
export default function ${name}(${propDestructure}) {
${navigateLine}${store.decls}${actionWiring.decls}${form.decls}${stateLines}${derivedLines}${actionLines}${gate.guard}  return (
    ${indentJsx(tsx, "    ")}
  );
}
`;
}

/** True when a param type is `slot` or `slot?` — both render as
 *  `ReactNode` in props. */
function isSlotShape(t: ParamIR["type"]): boolean {
  return t.kind === "slot" || (t.kind === "optional" && t.inner.kind === "slot");
}

/** Unwrap an `action` / `action?` param type to the action TypeIR, else
 *  undefined (extern-component-escape-hatch.md, Tier 2). */
export function actionShape(
  t: ParamIR["type"],
): Extract<ParamIR["type"], { kind: "action" }> | undefined {
  if (t.kind === "action") return t;
  if (t.kind === "optional" && t.inner.kind === "action") return t.inner;
  return undefined;
}

/** Emit the machine-owned typed-props interface for an `extern`
 *  component, at `src/components/<Name>.props.ts`.  Each declared
 *  param becomes a typed field by the same rules `renderUserComponentFile`
 *  uses: an aggregate-typed param (`order: Order`) gets the wire DTO
 *  (`OrderResponse`, imported from its api module) so member accesses
 *  typecheck in the hand-written component; `slot` / `slot?` render as
 *  `ReactNode`; everything else falls back to the route-param shape.
 *  Regenerated every run — the user imports it to type their module. */
export function renderExternComponentProps(
  name: string,
  params: ParamIR[],
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
): string {
  const dtoImports = new Map<string, string>(); // DTO type → api module
  const wireType = (t: ParamIR["type"]): string => {
    if (t.kind === "entity" && aggregatesByName.has(t.name)) {
      dtoImports.set(`${t.name}Response`, `../api/${lowerFirst(t.name)}`);
      return `${t.name}Response`;
    }
    // `orders: Order[]` — the doc's headline extern signature — maps to
    // the wire-DTO array so the widget sees `OrderResponse[]`.
    if (t.kind === "array") return `${wireType(t.element)}[]`;
    return "string";
  };
  const propType = (p: ParamIR): string => {
    if (p.type.kind === "entity" || (p.type.kind === "array" && p.type.element.kind === "entity")) {
      return wireType(p.type);
    }
    if (isSlotShape(p.type)) return "ReactNode";
    // `action` / `action(Order)` → a void callback the component fires
    // (Tier 2); the arg type maps by the same wire-DTO rule as a data
    // param, so the hand-written widget sees `(order: OrderResponse) =>
    // void` and calls it from its own handlers.
    const action = actionShape(p.type);
    if (action) {
      return action.arg ? `(arg: ${wireType(action.arg)}) => void` : "() => void";
    }
    return typeRefAsTsString(p);
  };
  const propLines = params.map((p) => {
    // `slot?` / `action?` → optional prop so the caller can omit it.
    const optional =
      p.type.kind === "optional" &&
      (p.type.inner.kind === "slot" || p.type.inner.kind === "action");
    return `  ${p.name}${optional ? "?:" : ":"} ${propType(p)};`;
  });
  const needsReactNode = params.some((p) => isSlotShape(p.type));
  const reactTypesImport = needsReactNode ? `import type { ReactNode } from "react";\n` : "";
  const dtoImportLines = [...dtoImports.entries()]
    .map(([type, mod]) => `import type { ${type} } from "${mod}";\n`)
    .join("");
  const body =
    propLines.length > 0
      ? `export interface ${name}Props {\n${propLines.join("\n")}\n}\n`
      : `export type ${name}Props = Record<string, never>;\n`;
  return `// AUTO-GENERATED by Loom — typed props for the extern component '${name}'.
// Do not edit; overwritten on every generate.  Import this type from your
// hand-written module (declared via \`component ${name}(...) extern from\`).
${reactTypesImport}${dtoImportLines}\n${body}`;
}

/** Emit the machine-owned re-export shim for an `extern` component, at
 *  `src/components/<Name>.tsx`.  Call sites import `components/<Name>`
 *  exactly as for any user component; the shim forwards the default
 *  export to the hand-written module at the `from` path (src-relative,
 *  so one `../` hop up from `src/components/`).  Loom owns this shim
 *  and `<Name>.props.ts`; the user owns the target module.  A missing
 *  target is a `tsc` error here — the fail-fast. */
export function renderExternComponentShim(name: string, externPath: string): string {
  const rel = externPath.replace(/^\.?\//, "");
  return `// AUTO-GENERATED extern component shim. Re-exports the hand-written module
// declared via \`component ${name}(...) extern from "${externPath}"\`.
// Loom owns this shim and './${name}.props'; you own '../${rel}'.
export { default } from "../${rel}";
export type { ${name}Props } from "./${name}.props";
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
    target: tsxTarget,
    imports: new Map(),
    pack,
    paramNames: new Set(),
    usedParams: new Set(),
    usesNavigate: false,
    stateNames: new Set(),
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
