import type {
  ActionIR,
  AggregateIR,
  BoundedContextIR,
  DerivedIR,
  ExprIR,
  PageIR,
  ParamIR,
  StateFieldIR,
  StoreIR,
  TypeIR,
  UiApiParamIR,
} from "../../../ir/types/loom-ir.js";
import { typeUsesMoney } from "../../../ir/types/loom-ir.js";
import { humanize, lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { renderGateExpr } from "../../_frontend/gate-expr.js";
import type { ImportSpec, LoadedPack } from "../../_packs/loader.js";
import { storeHookName, storeMemberLocal } from "../../_walker/js-target-helpers.js";
import type { ApiHookUse } from "../../_walker/walker-core.js";
import {
  closeUsedActions,
  emitExpr,
  emitStmt,
  extendLambdaParams,
  type FormOfState,
  type OperationFormState,
  type WalkContext,
  type WalkResult,
  walkBody,
} from "../../_walker/walker-core.js";
import { idTargetHookVar } from "../../react/form-helpers.js";
import { vueTarget } from "./vue-target.js";

/** A `state {}` field's `ref(...)` initial value: the declared `= <init>` when
 *  it's a simple literal (string / number / bool / null / list of literals),
 *  else the type's zero value.  Init expressions evaluate before any ref
 *  exists, so they can't reference state/params — literals cover the surface
 *  (mirrors the Angular/Svelte page-shells honouring `field.init`). */
function renderVueStateInit(field: StateFieldIR): string {
  const lit = field.init !== undefined ? renderInitLiteral(field.init) : undefined;
  return lit ?? vueTarget.defaultInitFor(field.type);
}

function renderInitLiteral(e: ExprIR): string | undefined {
  if (e.kind === "literal") {
    if (e.lit === "string") return JSON.stringify(e.value);
    if (e.lit === "null") return "null";
    // int / decimal / bool already carry their JS-literal text.
    return e.value;
  }
  if (e.kind === "list") {
    const els = e.elements.map(renderInitLiteral);
    return els.every((x): x is string => x !== undefined) ? `[${els.join(", ")}]` : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Vue page shell — assembles a generated `.vue` SFC around a walked
// page body.  The Vue analogue of `react/walker/page-shell.ts`, v1
// scope (vue-frontend-plan.md Slice 4):
//
//   - `<script setup lang="ts">` carries the api-composable hoists,
//     route-param reads, `ref()` state fields, and the `navigate`
//     adapter the walked markup references.
//   - api handles are wrapped in `reactive(...)`: vue-query returns
//     an object of nested Refs, and Vue templates only auto-unwrap
//     TOP-LEVEL refs — `customerAll.data` in a `v-if` would otherwise
//     be an always-truthy Ref.  `reactive()` deep-unwraps, so the
//     SAME rendered expression reads correctly in template and
//     script positions.  (This is the vue-query surface decision the
//     plan gates in this slice.)
//   - the walker emits `navigate("/path")` for `Button(to:)` — a
//     local `const navigate = (to: string) => { void router.push(to) }`
//     adapter keeps that contract without a new WalkerTarget seam.
//   - form wiring assembles from the FormOfState records: an
//     aggregate create-form gets the `form` LoomForm instance + the
//     `create` mutation handle the pack's primitive-form-of markup
//     references; a workflow run-form gets the same with the `run`
//     mutation handle; each operation form gets a v-dialog appended
//     after the walked body, dialog state, an open-fn, and its own
//     `<op>Form` instance.  A default-submit create/workflow form
//     imports `pushToast` for its success toast (the host is mounted
//     by the app-shell — see `hasToastHost` in index.ts).
// ---------------------------------------------------------------------------

/** Everything the SFC assembler needs beyond the walk result. */
export interface VuePageShellInput {
  page: PageIR;
  /** Route params the page's route declares (`:id` → `id`). */
  routeParams: readonly string[];
  result: WalkResult;
  /** Active design pack — operation dialogs render through its
   *  `op-dialog` template so the modal markup stays pack-owned
   *  (v-dialog on vuetify, the ui Dialog components on shadcnVue). */
  pack: LoadedPack;
  /** Names of `extern` user components — imported without the `.vue`
   *  extension (they resolve to a `<Name>.ts` re-export shim forwarding
   *  the hand-written module), unlike walked components (`<Name>.vue`). */
  externComponents?: ReadonlySet<string>;
  /** True when the frontend opts into `auth: ui` — a page's `requires` gate
   *  then renders a `v-if` `<Forbidden/>` guard against the verified session
   *  claims (`useSession().user`).  Absent ⇒ ungated. */
  authUi?: boolean;
  /** The ui's `store` declarations — the field/action shape the store
   *  wiring needs to bind each used member (a field → reactive `computed`,
   *  an action → a bound callable).  Empty when the ui declares no stores. */
  stores?: readonly StoreIR[];
  /** The ui's `api X: Y` bindings — the api-param handles a page action may
   *  await (`match await Sales.Order.op()` — async-actions-and-effects.md
   *  Stage 2).  Threaded into the action-handler walk so `tryDetectApiHook`
   *  recognises the awaited op + hoists its vue-query mutation. */
  apiParams?: readonly UiApiParamIR[];
  /** Aggregates reachable from this UI's deployable — the awaited op's
   *  aggregate is looked up here (its `operation` params build the request
   *  payload; its `or`-union response type names the discriminated DTO). */
  aggregatesByName?: ReadonlyMap<string, AggregateIR>;
  /** Bounded-context map keyed by aggregate name — classifies the awaited
   *  union's error variant (via the owning context's `error` payloads). */
  bcByAggregate?: ReadonlyMap<string, BoundedContextIR>;
}

export function renderVuePage(input: VuePageShellInput): string {
  const { page, routeParams, result } = input;
  const script: string[] = [];
  const vueImports = new Set<string>();

  // Route params — `const id = computed(() => route.params.id as string)`
  // would be the reactive form, but walker-rendered expressions read
  // the bare name (`id`), so bind plain consts off `useRoute()`; a
  // param change remounts via the router's default behaviour for
  // generated CRUD pages.
  // Form wiring (the reactive()+zod runtime, D-VUE-FRONTEND):
  //   - an aggregate create-form gets `const form = useLoomForm(...)`
  //     + the `create` mutation handle the pack's primitive-form-of
  //     markup references;
  //   - each operation form gets a v-dialog appended after the walked
  //     body, an open-fn the trigger button calls, its own
  //     `<op>Form` instance, and the mutation handle.
  const opFormLines: string[] = [];
  const opFormStates = result.formOfs.filter(
    (f): f is OperationFormState => f.kind === "operation",
  );
  const aggFormState = result.formOfs.find((f) => f.kind === "aggregate");
  const wfFormState = result.formOfs.find((f) => f.kind === "workflow");
  const usesLoomForm =
    aggFormState !== undefined || wfFormState !== undefined || opFormStates.length > 0;
  // A default-submit create/workflow form (no custom `onSubmit:`) renders
  // the pack's `form-default-onsubmit` body, which pushes a success toast
  // on completion — so the page imports `pushToast` and the app-shell
  // mounts the toast host (gated on `hasToastHost` in index.ts).
  const usesFormToast = formNeedsToast(aggFormState) || formNeedsToast(wfFormState);
  // Create + workflow forms' default submit bodies navigate.
  const needsNavigate =
    result.usesNavigate || aggFormState !== undefined || wfFormState !== undefined;
  const idExprParams = new Set<string>();
  for (const state of opFormStates) {
    for (const p of routeParams) {
      if (state.idExpr.includes(p)) idExprParams.add(p);
    }
  }

  // Api-composable hoists, deduped by var name; `reactive()` wrapper
  // per the header note.
  const hookLines: string[] = [];
  const apiImports = new Map<string, Set<string>>();
  const seenVars = new Set<string>();
  // Hoisted hook args were rendered at WALK time (template-position
  // forms: state refs are bare names) but the hoist line lives in
  // SCRIPT position — re-point state-field reads at `.value`.  Plain
  // captured values, not reactive inputs: a vue filter input doesn't
  // live-refetch yet (the api module would need MaybeRefOrGetter
  // params — tracked as a parity follow-up).
  const stateNames = new Set(page.state.map((f) => f.name));

  // Page `derived` bindings → hoisted `computed`s.  The expression runs
  // in script position, so state reads re-point to `.value` (the same
  // rewrite the hoisted hook args use); `computed` auto-tracks deps.
  const repointDerived = (s: string): string => {
    let out = s;
    for (const n of stateNames) {
      out = out.replace(new RegExp(`\\b${n}\\b(?!\\.value)`, "g"), `${n}.value`);
    }
    return out;
  };
  const derivedResult = buildDerivedLines(
    page.derived,
    input.pack,
    new Set(page.params.map((p) => p.name)),
    stateNames,
    repointDerived,
    result.usedStores,
  );
  const derivedLines = derivedResult.lines;
  if (derivedLines.length > 0) vueImports.add("computed");

  // Named-action handlers → `<script setup>` arrow consts (Proposal A
  // Stage 1).  Built before stateLines so a handler that mutates state
  // forces the `ref()` declaration (same as a derived that reads state).
  // The shared `result.usedStores` map flows in so a store referenced ONLY
  // from an action body (`discard() { Cart.clear() }`) still drives the
  // shell's store import + member bind (Stage 5).
  const actionResult = buildActionLines(
    page.actions,
    result.usedActions ?? new Set(),
    input.pack,
    new Set(page.params.map((p) => p.name)),
    stateNames,
    repointDerived,
    result.usedStores,
    {
      // An action may `match await Sales.Order.op()` (Stage 2) — thread the
      // api-param handles + aggregate/context maps so the awaited op is detected
      // and its vue-query mutation hoisted (registered into the shared
      // `result.usedApiHooks`, drained by the hoist loop below).
      apiParamNames: new Map((input.apiParams ?? []).map((p) => [p.name, p.apiName])),
      aggregatesByName: input.aggregatesByName,
      bcByAggregate: input.bcByAggregate,
      usedApiHooks: result.usedApiHooks,
    },
  );
  const actionLines = actionResult.lines;

  // The magic route `id` (`byId(id)`, or a `DestroyForm`'s hoisted handler)
  // binds from `route.params.id` whenever the body — OR an action that awaited
  // an instance op (Stage 2) — referenced it, regardless of an `:id` segment.
  // Matches React's unconditional `useParams<{id:string}>()`: a `DestroyForm`
  // on a non-detail page still needs `id` declared (it reads `undefined` at
  // runtime there, typed via the `as string` cast — same as React's generic).
  const usesRouteId = result.usesRouteId || actionResult.usesRouteId;
  const routeIdParam = usesRouteId ? ["id"] : [];
  const usedParams = [
    ...new Set([
      ...[...result.usedParams].filter((p) => routeParams.includes(p)),
      ...idExprParams,
      ...routeIdParam,
    ]),
  ];
  const needsRoute = usedParams.length > 0;
  // Reification imports the action walk resolved (`ApiError`, the op's union
  // response type) — route them into the api-import block, which the shell
  // emits (and depth-adjusts each `../api/*` key on drain).  `result.imports`
  // is the walker's own sink and is filtered for relative specifiers, so these
  // must land here instead.
  for (const [from, names] of actionResult.imports) {
    if (names.size === 0) continue;
    const set = apiImports.get(from) ?? new Set<string>();
    for (const n of names) set.add(n);
    apiImports.set(from, set);
  }

  // Store wiring (Stage 5) — computed AFTER the action/derived walks so a
  // store member referenced only from a handler body is recorded.  One hook
  // import + singleton bind + per-member local for each used store; a field
  // bind is a reactive `computed`, so pull `computed` into the import.
  const storeWiring = renderStoreWiring(
    result.usedStores,
    input.stores ?? [],
    relPrefix(input),
    new Set([...stateNames, ...page.params.map((p) => p.name), ...page.derived.map((d) => d.name)]),
  );
  if (storeWiring.usesComputed) vueImports.add("computed");

  // State fields — `ref()` per declared field; the walked markup
  // reads bare names (template auto-unwrap) per vueTarget.  A `derived`
  // that reads a state field also forces the `ref()` declaration even
  // when the body never reads it directly.
  const stateLines: string[] = [];
  if (result.usesState || derivedResult.usesState || actionResult.usesState) {
    for (const f of page.state) {
      // A `File`-typed state field (FileUpload bind target) holds a nullable
      // FileRef.  Its `ref()` init (undefined) would infer `Ref<undefined>` and
      // reject the uploaded FileRef, so type it explicitly and import FileRef.
      const base = f.type.kind === "optional" ? f.type.inner : f.type;
      const isFile = base.kind === "primitive" && base.name === "File";
      if (isFile) {
        stateLines.push(`const ${f.name} = ref<FileRef | null>(null);`);
        const set = apiImports.get("../api/client") ?? new Set<string>();
        set.add("FileRef");
        apiImports.set("../api/client", set);
      } else {
        stateLines.push(`const ${f.name} = ref(${renderVueStateInit(f)});`);
      }
      // The shared input primitives' VM carries the React-style
      // `set<Pascal>` setter name (`@update:model-value` callbacks in
      // the vue packs call it) — provide it as a plain function.
      const pascal = f.name[0]!.toUpperCase() + f.name.slice(1);
      stateLines.push(
        `const set${pascal} = (v: typeof ${f.name}.value) => { ${f.name}.value = v; };`,
      );
      vueImports.add("ref");
    }
  }
  // Controlled tab state — a `Tabs` on the body v-models `__loomTab` in the
  // vuetify pack, so declare the ref (defaulting to the first tab's value).
  if (result.tabsDefault !== undefined) {
    stateLines.push(`const __loomTab = ref(${JSON.stringify(result.tabsDefault)});`);
    vueImports.add("ref");
  }
  const scriptArgs = (rendered: readonly string[]): string =>
    rendered
      .map((a) => {
        let out = a;
        for (const n of stateNames) {
          out = out.replace(new RegExp(`\\b${n}\\b(?!\\.value)`, "g"), `${n}.value`);
        }
        return out;
      })
      .join(", ");
  for (const use of result.usedApiHooks.values()) {
    if (seenVars.has(use.varName)) continue;
    seenVars.add(use.varName);
    const args = scriptArgs(use.argsRendered ?? []);
    // A parameterised `find` query takes a `MaybeRefOrGetter` arg on
    // Vue: pass it as a getter so vue-query re-runs when a bound filter
    // input changes (a snapshot `{ status: status.value }` would freeze
    // the query at setup).  Other hooks take their captured value.
    const callArg = use.reactiveQuery && args !== "" ? `() => (${args})` : args;
    hookLines.push(`const ${use.varName} = reactive(${use.hookName}(${callArg}));`);
    vueImports.add("reactive");
    const names = apiImports.get(use.importFrom) ?? new Set<string>();
    names.add(use.hookName);
    apiImports.set(use.importFrom, names);
  }
  // Aggregate create-form wiring — the pack's primitive-form-of
  // markup references `form` (the LoomForm instance) and `create`
  // (the mutation handle); its default submit body navigates.
  if (aggFormState && aggFormState.kind === "aggregate") {
    const agg = aggFormState.agg.name;
    if (!seenVars.has("create")) {
      seenVars.add("create");
      opFormLines.push(`const create = reactive(useCreate${agg}());`);
      vueImports.add("reactive");
    }
    opFormLines.push(
      `const form = useLoomForm(Create${agg}Request, ${aggFormState.defaultValuesTs});`,
    );
    const from = `../api/${lowerFirst(agg)}`;
    const names = apiImports.get(from) ?? new Set<string>();
    names.add(`useCreate${agg}`);
    names.add(`Create${agg}Request`);
    apiImports.set(from, names);
  }
  // Workflow run-form wiring — the pack markup references `form` +
  // `run` (the workflow mutation handle); default submit navigates
  // to /workflows.  Mutually exclusive with an aggregate form on the
  // same page in practice (one `form` instance per page).
  if (wfFormState && wfFormState.kind === "workflow") {
    const wf = upperFirst(wfFormState.workflow.name);
    if (!seenVars.has("run")) {
      seenVars.add("run");
      opFormLines.push(`const run = reactive(use${wf}Workflow());`);
      vueImports.add("reactive");
    }
    opFormLines.push(`const form = useLoomForm(${wf}Request, ${wfFormState.defaultValuesTs});`);
    const from = "../api/workflows";
    const names = apiImports.get(from) ?? new Set<string>();
    names.add(`use${wf}Workflow`);
    names.add(`${wf}Request`);
    apiImports.set(from, names);
  }
  // Operation forms — dialog state + open-fn + per-op LoomForm.
  const dialogBlocks: string[] = [];
  for (const state of opFormStates) {
    if (state.kind !== "operation") continue;
    const opCamel = lowerFirst(state.op.name);
    const opPascal = upperFirst(state.op.name);
    const agg = state.agg.name;
    const from = `../api/${lowerFirst(agg)}`;
    const names = apiImports.get(from) ?? new Set<string>();
    if (!seenVars.has(opCamel)) {
      seenVars.add(opCamel);
      const hookName = `use${opPascal}${agg}`;
      opFormLines.push(`const ${opCamel} = reactive(${hookName}(${state.idExpr}));`);
      vueImports.add("reactive");
      names.add(hookName);
    }
    const openFn = `open${opPascal}Modal`;
    if (seenVars.has(openFn)) {
      apiImports.set(from, names);
      continue;
    }
    seenVars.add(openFn);
    names.add(`${opPascal}${agg}Request`);
    apiImports.set(from, names);
    opFormLines.push(`const ${opCamel}Open = ref(false);`);
    vueImports.add("ref");
    opFormLines.push(`const ${openFn} = (_mut: unknown) => { ${opCamel}Open.value = true; };`);
    opFormLines.push(
      `const ${opCamel}Form = useLoomForm(${opPascal}${agg}Request, ${state.defaultValuesTs});`,
    );
    // Field markup was walked with the create-form instance name
    // (`form.`) — re-point it at this dialog's instance.  Provisional
    // until the field VM carries a `formVar` slot.
    const fields = state.fieldHtmls
      .map((h) => h.replaceAll("form.values.", `${opCamel}Form.values.`))
      .map((h) => h.replaceAll("form.errors[", `${opCamel}Form.errors[`))
      .map((h) => `            ${h}`)
      .join("\n");
    const ns = state.testidNamespace;
    dialogBlocks.push(
      input.pack.render("op-dialog", {
        openVar: `${opCamel}Open`,
        formVar: `${opCamel}Form`,
        mutVar: opCamel,
        title: humanize(state.op.name),
        submitLabel: humanize(state.op.name),
        ns,
        fieldsHtml: fields,
      }),
    );
    // The dialog template's component imports (pack.json
    // `imports["op-dialog"]`) merge into the page's import lines —
    // the walk never sees this template, so the walker's ImportMap
    // can't carry them.
    for (const spec of (input.pack.manifest.imports?.["op-dialog"] ?? []) as ImportSpec[]) {
      const names = result.imports.get(spec.from) ?? new Set<string>();
      for (const n of spec.named) names.add(n);
      result.imports.set(spec.from, names);
    }
  }
  // Id-target lookup hooks (`X id` form fields render as selects fed
  // by `useAll<Target>()` — the field templates reference the
  // `idTargetHookVar` name baked in at walk time), deduped across
  // all form states.
  for (const state of result.formOfs) {
    for (const t of state.idTargets) {
      const hookVar = idTargetHookVar(t);
      if (seenVars.has(hookVar)) continue;
      seenVars.add(hookVar);
      opFormLines.push(`const ${hookVar} = reactive(useAll${plural(t.name)}());`);
      vueImports.add("reactive");
      const from = `../api/${lowerFirst(t.name)}`;
      const names = apiImports.get(from) ?? new Set<string>();
      names.add(`useAll${plural(t.name)}`);
      apiImports.set(from, names);
    }
  }
  // `Action(<inst>.<op>)` mutation hoists — same reactive() wrapper.  The
  // hook targets a specific instance, so it takes the instance id
  // (`use<Op><Agg>(<idExpr>)` — matches React/Svelte); `scriptArgs` applies
  // the page's state `.value` rewrite to the idExpr, as for find hooks above.
  for (const m of result.actionMutations) {
    if (seenVars.has(m.localVar)) continue;
    seenVars.add(m.localVar);
    hookLines.push(`const ${m.localVar} = reactive(${m.hookName}(${scriptArgs([m.idExpr])}));`);
    vueImports.add("reactive");
    const from = `../api/${m.aggCamel}`;
    const names = apiImports.get(from) ?? new Set<string>();
    names.add(m.hookName);
    apiImports.set(from, names);
  }

  // --- script assembly, imports first -------------------------------------
  if (vueImports.size > 0) {
    script.push(`import { ${[...vueImports].sort().join(", ")} } from "vue";`);
  }
  // A money-typed `state {}` field refs as `ref(new Decimal("0"))` —
  // pull decimal.js into the <script setup> (the dep rides the
  // deployable's money-usage flag in package.json).
  if (result.usesState && page.state.some((f) => typeUsesMoney(f.type))) {
    script.push(`import Decimal from "decimal.js";`);
  }
  if (needsRoute && needsNavigate) {
    script.push(`import { useRoute, useRouter } from "vue-router";`);
  } else if (needsRoute) {
    script.push(`import { useRoute } from "vue-router";`);
  } else if (needsNavigate) {
    script.push(`import { useRouter } from "vue-router";`);
  }
  // Format helpers — imported unconditionally (generated tsconfig
  // keeps noUnusedLocals off, mirroring the React project) so pack
  // templates can call them without an import-registration channel.
  script.push(
    `import { EMPTY, formatBool, formatDateTime, formatMoney, formatNumber, formatPlain, isEmpty, shortId } from "${relPrefix(input)}lib/format";`,
  );
  // Interactive-table helpers — imported only when a `Table` on this page
  // renders sortable columns / a filter box (M-T1.1); both share one module.
  const tableHelpers = [
    ...(result.usesTableSort ? ["sortRows"] : []),
    ...(result.usesTableFilter ? ["filterRows"] : []),
  ];
  if (tableHelpers.length > 0) {
    script.push(`import { ${tableHelpers.join(", ")} } from "${relPrefix(input)}lib/table-sort";`);
  }
  // Page-level `requires` UI gate (D-AUTH-OIDC): bind the verified session
  // user so the `<template>` can `v-if`-guard a `<Forbidden/>` fallback — the
  // client mirror of the backend 403.  The currentUser binding is also needed
  // when the body has a currentUser-gated `Action(...)` button
  // (`usesCurrentUser`); the `v-if` Forbidden wrap is page-`requires`-only.
  const gated = !!input.authUi && !!page.requires;
  const needsUser = gated || result.usesCurrentUser;
  if (needsUser) {
    script.push(`import { useSession } from "${relPrefix(input)}auth/useSession";`);
  }
  if (usesLoomForm) {
    script.push(`import { useLoomForm } from "${relPrefix(input)}lib/form";`);
  }
  if (usesFormToast) {
    script.push(`import { pushToast } from "${relPrefix(input)}lib/toast";`);
  }
  // Extern frontend functions called from the body — one conformance-
  // shim import per used name (`src/lib/<name>.ts`).  The shim re-exports
  // the user's impl behind the Loom-derived signature, so call sites get
  // a stable import regardless of where the user's module lives.
  for (const name of [...(result.usedExternFunctions ?? new Set<string>())].sort()) {
    script.push(`import { ${name} } from "${relPrefix(input)}lib/${name}";`);
  }
  // User components the body invoked — one default-import per name.
  // Walked components resolve to `<Name>.vue`; `extern` ones resolve to
  // the `<Name>.ts` re-export shim (imported without the extension), so
  // the walker's `<Name :prop="…" />` tag binds either way.
  for (const n of [...result.usedUserComponents].sort()) {
    const ext = input.externComponents?.has(n) ? "" : ".vue";
    script.push(`import ${n} from "${relPrefix(input)}components/${n}${ext}";`);
  }
  // The file-upload templates (`field-input-file` / `primitive-file-upload`)
  // declare `import { api } from "../api/client"` via their pack.json `imports`
  // table, which lands in `result.imports`.  The relative-import skip below
  // drops it, so fold `../api/client` into `apiImports` here — this loop
  // depth-adjusts the specifier and dedupes with any `ApiError` import from the
  // same module into one line.
  const clientNames = result.imports.get("../api/client");
  if (clientNames && clientNames.size > 0) {
    const set = apiImports.get("../api/client") ?? new Set<string>();
    for (const n of clientNames) set.add(n);
    apiImports.set("../api/client", set);
  }
  for (const [from, names] of [...apiImports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const adjusted = adjustDepth(from, input);
    script.push(`import { ${[...names].sort().join(", ")} } from "${adjusted}";`);
  }
  // Pack-declared per-primitive imports (pack.json `imports` tables) —
  // shadcnVue's ui-component barrel (`@/components/ui`) flows in here;
  // packs with globally-registered components (vuetify) declare none.
  // `@/` specifiers resolve through the pack's vite/tsconfig alias and
  // need no depth adjustment.
  //
  // The shared walker also drops React-pipeline imports into the same
  // sink (`react-hook-form` / `@hookform/resolvers/zod` from
  // `prepareFormFields`, plus un-depth-adjusted `../api/<agg>` request
  // imports the Vue shell already hoists itself via `apiImports`).
  // Those are TSX-shell concerns — emitting them here produces
  // duplicate identifiers and unresolvable modules — so only
  // non-relative, non-RHF specifiers pass through.
  const walkerInternalSources = new Set(["react-hook-form", "@hookform/resolvers/zod"]);
  for (const [from, names] of [...result.imports.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (names.size === 0) continue;
    if (walkerInternalSources.has(from) || from.startsWith("./") || from.startsWith("../")) {
      continue;
    }
    script.push(`import { ${[...names].sort().join(", ")} } from "${from}";`);
  }
  for (const line of storeWiring.imports) script.push(line);
  script.push("");
  if (needsRoute) {
    script.push("const route = useRoute();");
    for (const p of usedParams) {
      script.push(`const ${p} = route.params.${p} as string;`);
    }
  }
  if (needsNavigate) {
    script.push("const router = useRouter();");
    // The walker's `Button(to:)` contract (and the create-form's
    // default redirect) reference a bare `navigate(path)` — adapt it
    // onto vue-router locally.
    script.push("const navigate = (to: string) => { void router.push(to); };");
  }
  if (needsUser) {
    // Dynamic OIDC/JWT claims → loose type so chained claim access stays
    // vue-tsc-clean; `?? {}` is a safe default (AuthGate guarantees a session
    // before the page mounts, so this branch is for typing only).
    script.push(`const currentUser = (useSession().user.value ?? {}) as Record<string, any>;`);
  }
  if (gated) {
    script.push(`const loomPageAllowed = ${renderGateExpr(page.requires!, "currentUser")};`);
  }
  for (const line of storeWiring.decls) script.push(line);
  script.push(...stateLines);
  script.push(...hookLines);
  // Handlers a target hoisted out of template position (Vue `DestroyForm`'s
  // `window.confirm` handler) — after the route-id + mutation decls they read.
  if (result.hoistedHandlers) script.push(...result.hoistedHandlers);
  script.push(...opFormLines);
  script.push(...derivedLines);
  script.push(...actionLines);
  // Trim trailing blanks.
  while (script.length > 0 && script[script.length - 1] === "") script.pop();

  const title = humanize(page.name);
  const dialogs = dialogBlocks.length > 0 ? `\n${dialogBlocks.join("\n")}` : "";
  // Page-`requires` guard: a forbidden caller sees `<Forbidden/>` instead of
  // the body (Vue 3 allows multiple template roots, so the guard `div` + the
  // `v-else` body sit side by side).  Ungated pages keep the bare body.
  const templateBody = gated
    ? `  <div v-if="!loomPageAllowed" style="padding: 24px;">
    <h2>Forbidden</h2>
    <p>You do not have access to this page.</p>
  </div>
  <template v-else>
${indent(result.tsx, "    ")}${dialogs}
  </template>`
    : `${indent(result.tsx, "  ")}${dialogs}`;
  return `<!-- Auto-generated.  Do not edit by hand.  (${title}) -->
<script setup lang="ts">
${script.join("\n")}
</script>

<template>
${templateBody}
</template>
`;
}

/** Wire the stores a page/component body references (named-actions-and-
 *  stores.md §3, Stage 5).  For each used store, emit one hook import
 *  (`import { useCart } from "<prefix>stores/cart"`), one singleton bind
 *  (`const cart = useCart()`), and one local per used member:
 *
 *    - a FIELD read (`Cart.lines`) → `const lines = computed(() => cart.state.lines)`
 *      — a `ComputedRef` the template auto-unwraps (the body reads the bare
 *      name, per `vueTarget.renderStoreFieldRead`), staying reactive;
 *    - an ACTION call (`Cart.clear()`) → `const clear = cart.clear` — a bound
 *      callable the body invokes bare.
 *
 *  Returns the import lines + the script-decl lines and whether any field bind
 *  was emitted (so the caller pulls `computed` into the `vue` import). */
function renderStoreWiring(
  usedStores: Map<string, Set<string>> | undefined,
  stores: readonly StoreIR[],
  srcImportPrefix: string,
  /** Page-level binding names (state / params / derived).  A store member whose
   *  name collides binds a store-qualified local (`cartLines`) so it doesn't
   *  duplicate the page declaration — matching `storeLocalFor` in walker-core. */
  reserved: ReadonlySet<string> = new Set(),
): { imports: string[]; decls: string[]; usesComputed: boolean } {
  if (!usedStores || usedStores.size === 0) {
    return { imports: [], decls: [], usesComputed: false };
  }
  const storesByName = new Map(stores.map((s) => [s.name, s]));
  const imports: string[] = [];
  const decls: string[] = [];
  let usesComputed = false;
  for (const storeName of [...usedStores.keys()].sort()) {
    const hook = storeHookName(storeName);
    const local = lowerFirst(storeName);
    imports.push(`import { ${hook} } from "${srcImportPrefix}stores/${snake(storeName)}";`);
    decls.push(`const ${local} = ${hook}();`);
    const store = storesByName.get(storeName);
    const actionNames = new Set((store?.actions ?? []).map((a) => a.name));
    for (const member of [...usedStores.get(storeName)!].sort()) {
      const memberLocal = storeMemberLocal(storeName, member, reserved);
      if (actionNames.has(member)) {
        decls.push(`const ${memberLocal} = ${local}.${member};`);
      } else {
        usesComputed = true;
        decls.push(`const ${memberLocal} = computed(() => ${local}.state.${member});`);
      }
    }
  }
  return { imports, decls, usesComputed };
}

/** Relative prefix from the page's emit dir up to `src/` —
 *  `src/pages/x.vue` → `../`; `src/pages/orders/list.vue` → `../../`. */
function relPrefix(input: VuePageShellInput): string {
  const depth = pageDirDepth(input.page);
  return "../".repeat(depth);
}

/** Adjust an `ApiHookUse.importFrom` (recorded as `../api/<agg>` —
 *  the one-level-deep convention) to the page's actual directory
 *  depth. */
function adjustDepth(importFrom: string, input: VuePageShellInput): string {
  const depth = pageDirDepth(input.page);
  if (!importFrom.startsWith("../")) return importFrom;
  return "../".repeat(depth) + importFrom.slice(3);
}

function pageDirDepth(page: PageIR): number {
  const path = page.emitPath
    ? page.emitPath.replace(/\.tsx$/, ".vue")
    : `src/pages/${snake(page.name)}.vue`;
  // segments under src/ minus the filename = number of `../` hops
  // back to src/.
  return path.replace(/^src\//, "").split("/").length - 1;
}

function indent(markup: string, prefix: string): string {
  return markup
    .split("\n")
    .map((l) => (l.length > 0 ? prefix + l : l))
    .join("\n");
}

// ---------------------------------------------------------------------------
// User components — `src/components/<Name>.vue`
//
// The Vue analogue of react's `renderUserComponentFile`, common-case
// scope: a typed `defineProps`, `ref()` state, nested user-component
// invocation, extern-function shims, and `Action(<inst>.<op>)` mutation
// hoists.  Component files sit one hop from `src/`, so api / lib / format
// imports resolve via `../`, and sibling components via `./<Name>.vue`.
//
// Forms inside a component (an aggregate/operation/workflow `Form`) are a
// parity follow-up: they throw loudly here rather than emit broken markup
// — host the form on a page (the same posture Svelte shipped components
// with).
// ---------------------------------------------------------------------------

/** Map a Loom type to its prop TS spelling — wire-DTO for aggregate
 *  params (recorded into `dtoImports`), primitives/ids/enums to their TS
 *  equivalents.  Mirrors `_frontend/extern-functions.ts`'s `wireTsType`. */
function componentPropTsType(
  t: TypeIR,
  aggregatesByName: ReadonlyMap<string, AggregateIR>,
  dtoImports: Map<string, string>,
): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
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
        case "json":
          return "unknown";
        default:
          throw new Error(`vue component: unsupported primitive '${t.name}' in prop.`);
      }
    case "entity":
      if (aggregatesByName.has(t.name)) {
        dtoImports.set(`${t.name}Response`, `../api/${lowerFirst(t.name)}`);
        return `${t.name}Response`;
      }
      return "unknown";
    case "id":
      return "string";
    case "enum":
      return "string";
    case "array":
      return `${componentPropTsType(t.element, aggregatesByName, dtoImports)}[]`;
    case "optional":
      return `${componentPropTsType(t.inner, aggregatesByName, dtoImports)} | undefined`;
    default:
      throw new Error(`vue component: unsupported prop type kind '${t.kind}'.`);
  }
}

/** A `slot`-typed param (`head: slot` / `head: slot?`). Vue slots are template
 *  content (`<slot>`), not props, so these are kept OUT of the props interface
 *  in both the extern and walked-component paths. */
function isSlotParam(p: ParamIR): boolean {
  return p.type.kind === "slot" || (p.type.kind === "optional" && p.type.inner.kind === "slot");
}

/** The TS prop type for a non-slot component param. An `action(T)` param becomes
 *  a callback prop (`(arg: TResponse) => void`) — the parent wires the handler —
 *  mirroring the React/Svelte frontends; everything else defers to
 *  `componentPropTsType`. */
function paramPropType(
  p: ParamIR,
  aggregatesByName: ReadonlyMap<string, AggregateIR>,
  dtoImports: Map<string, string>,
): string {
  const t = p.type;
  const action =
    t.kind === "action"
      ? t
      : t.kind === "optional" && t.inner.kind === "action"
        ? t.inner
        : undefined;
  if (action) {
    return action.arg
      ? `(arg: ${componentPropTsType(action.arg, aggregatesByName, dtoImports)}) => void`
      : "() => void";
  }
  return componentPropTsType(t, aggregatesByName, dtoImports);
}

// ---------------------------------------------------------------------------
// Extern components — the UI escape hatch.  A `component <Name>(...) extern
// from "<path>"` makes Loom own two files and import the user's `.vue`
// module:
//   ① `src/components/<Name>.props.ts` — the typed props interface derived
//      from the params' wire shape; the user annotates their `defineProps`.
//   ② `src/components/<Name>.ts` — a re-export shim forwarding the user
//      module's default + the props type, so call sites import
//      `components/<Name>` (no extension) exactly as for a walked component.
// Vue slots are a template construct (`<slot>`), not props, so a `slot`
// param on a vue extern component is a narrow deferral (throws) — pass slot
// content as children at the call site instead.
// ---------------------------------------------------------------------------

/** ① The typed props interface at `src/components/<Name>.props.ts`. */
export function renderVueExternComponentProps(
  name: string,
  params: readonly ParamIR[],
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
): string {
  const dtoImports = new Map<string, string>();
  // Vue slots are template content (`<slot>`), not props — a `slot`
  // param maps to a typed `<Name>Slots` contract (for the user's
  // `defineSlots`), kept OUT of the props interface.
  const slotParams = params.filter(isSlotParam);
  const propParams = params.filter((p) => !isSlotParam(p));
  const propLines = propParams.map((p) => {
    const optional = p.type.kind === "optional" && p.type.inner.kind === "action";
    return `  ${p.name}${optional ? "?:" : ":"} ${paramPropType(p, aggregatesByName, dtoImports)};`;
  });
  const dtoImportLines = [...dtoImports.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, mod]) => `import type { ${type} } from "${mod}";\n`)
    .join("");
  const propsBody =
    propLines.length > 0
      ? `export interface ${name}Props {\n${propLines.join("\n")}\n}\n`
      : `export type ${name}Props = Record<string, never>;\n`;
  // Slots: `aside: slot` → required, `aside: slot?` → optional render fn.
  const slotsBody =
    slotParams.length > 0
      ? `\nexport interface ${name}Slots {\n${slotParams
          .map((p) => `  ${p.name}${p.type.kind === "optional" ? "?" : ""}(): unknown;`)
          .join("\n")}\n}\n`
      : "";
  return `// AUTO-GENERATED by Loom — typed props for the extern component '${name}'.
// Do not edit; overwritten on every generate.  Import this type into your
// hand-written .vue module (declared via \`component ${name}(...) extern from\`).
${dtoImportLines}\n${propsBody}${slotsBody}`;
}

/** ② The re-export shim at `src/components/<Name>.ts`.  `hasSlots` adds
 *  the `<Name>Slots` re-export when the component declares slot params. */
export function renderVueExternComponentShim(
  name: string,
  externPath: string,
  hasSlots = false,
): string {
  const rel = externPath.replace(/^\.?\//, "");
  const typeExports = hasSlots ? `${name}Props, ${name}Slots` : `${name}Props`;
  return `// AUTO-GENERATED extern component shim.  Re-exports the hand-written
// module declared via \`component ${name}(...) extern from "${externPath}"\`.
// Loom owns this shim and './${name}.props'; you own '../${rel}'.
export { default } from "../${rel}";
export type { ${typeExports} } from "./${name}.props";
`;
}

export function renderVueComponentFile(
  name: string,
  params: readonly ParamIR[],
  state: readonly StateFieldIR[],
  body: ExprIR,
  pack: LoadedPack,
  userComponents: ReadonlyMap<string, readonly ParamIR[]>,
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
  bcByAggregate: ReadonlyMap<string, BoundedContextIR> = new Map(),
  pageRoutes: ReadonlyMap<string, string> = new Map(),
  externFunctions: ReadonlySet<string> = new Set(),
  externComponents: ReadonlySet<string> = new Set(),
  derived: readonly DerivedIR[] = [],
  /** True when the hosting deployable has `auth: ui` — enables currentUser-only
   *  operation-`requires` gating on `Action(...)` buttons (a component is the
   *  canonical Action host).  Binding-only: components carry no page gate. */
  authUi = false,
  /** Named, typed component event handlers (Proposal A Stage 1). */
  actions: readonly ActionIR[] = [],
  /** The ui's `store` declarations — drives store-member binding (Stage 5).
   *  Components reference stores by dotted name exactly like pages do. */
  stores: readonly StoreIR[] = [],
): { source: string; usesFormToast: boolean } {
  const paramNames = new Set(params.map((p) => p.name));
  const stateNames = new Set(state.map((s) => s.name));
  const derivedNames = new Set(derived.map((d) => d.name));
  // Aggregate-typed params power `Action(<inst>.<op>)` resolution.
  const paramTypes = new Map<string, string>();
  for (const p of params) {
    if (p.type.kind === "entity" && aggregatesByName.has(p.type.name)) {
      paramTypes.set(p.name, p.type.name);
    }
  }
  const result = walkBody(
    body,
    vueTarget,
    pack,
    paramNames,
    stateNames,
    userComponents,
    [],
    aggregatesByName,
    bcByAggregate,
    new Map(),
    new Map(),
    paramTypes,
    pageRoutes,
    externFunctions,
    derivedNames,
    authUi,
  );
  // Operation forms (Action dialogs).  Same op-dialog host + per-op
  // LoomForm the page shell emits — the only twist is the instance
  // `idExpr`: in a component the instance is an aggregate-typed PROP
  // (`OperationForm { order.confirm }`), so `idExpr` reads off `props`
  // (rewritten below) rather than a route param.
  const opFormStates = result.formOfs.filter(
    (f): f is OperationFormState => f.kind === "operation",
  );
  const aggFormState = result.formOfs.find((f) => f.kind === "aggregate");
  const wfFormState = result.formOfs.find((f) => f.kind === "workflow");
  // Default-submit create/workflow form → the pack body pushes a success
  // toast, so the component imports `pushToast` (the host is mounted by
  // the app-shell — see `hasToastHost` in index.ts).
  const usesFormToast = formNeedsToast(aggFormState) || formNeedsToast(wfFormState);

  const script: string[] = [];
  const vueImports = new Set<string>();

  // Prop typing. Slot params are template content (`<slot>`), not props, so
  // they're excluded here (the body's `Slot { }` renders `<slot>`); `action(T)`
  // params become callback props — matching the extern-component path and the
  // React/Svelte frontends.
  const dtoImports = new Map<string, string>();
  const propFields = params
    .filter((p) => !isSlotParam(p))
    .map((p) => {
      const optional = p.type.kind === "optional" && p.type.inner.kind === "action";
      return `${p.name}${optional ? "?:" : ":"} ${paramPropType(p, aggregatesByName, dtoImports)};`;
    });

  // `Action(<inst>.<op>)` mutation hoists — the only api a component
  // body reaches (no apiParams in component scope).  Hoist args (when
  // present) reference props/state; re-point them for script position.
  const rewriteScript = (s: string): string => {
    let out = s;
    for (const n of stateNames) {
      out = out.replace(new RegExp(`\\b${n}\\b(?!\\.value)`, "g"), `${n}.value`);
    }
    for (const n of paramNames) {
      out = out.replace(new RegExp(`\\b${n}\\b(?!\\.value)`, "g"), `props.${n}`);
    }
    return out;
  };

  // Component `derived` bindings → hoisted `computed`s.  `rewriteScript`
  // re-points state reads to `.value` and param reads to `props.<name>`
  // (the same rewrite the action-mutation hoists use), so a derived can
  // read both; `computed` auto-tracks deps.
  const derivedResult = buildDerivedLines(
    derived,
    pack,
    paramNames,
    stateNames,
    rewriteScript,
    result.usedStores,
  );
  const derivedLines = derivedResult.lines;
  if (derivedLines.length > 0) vueImports.add("computed");

  // Named-action handlers → `<script setup>` arrow consts (Proposal A
  // Stage 1).  `rewriteScript` re-points state reads/writes to `.value` and
  // param reads to `props.<name>`, matching the component derived path.  The
  // shared `result.usedStores` map flows in so a store action called only
  // from a handler (`addOne() { Cart.add(...) }`) drives store wiring.
  const actionResult = buildActionLines(
    actions,
    result.usedActions ?? new Set(),
    pack,
    paramNames,
    stateNames,
    rewriteScript,
    result.usedStores,
  );
  const actionLines = actionResult.lines;

  // Store wiring (Stage 5) — computed AFTER the action/derived walks so a
  // store member referenced only from a handler body is recorded.  A
  // component lives at `src/components/<name>.vue`, so the import prefix up
  // to `src/` is always `../`.
  const storeWiring = renderStoreWiring(
    result.usedStores,
    stores,
    "../",
    new Set([...stateNames, ...paramNames, ...derivedNames]),
  );
  if (storeWiring.usesComputed) vueImports.add("computed");

  // State — `ref()` per field + a `set<Pascal>` setter (the shared input
  // primitives' VM references it), matching the page shell.  A `derived`
  // reading a state field also forces the `ref()` declaration.
  const stateLines: string[] = [];
  if (result.usesState || derivedResult.usesState || actionResult.usesState) {
    for (const f of state) {
      stateLines.push(`const ${f.name} = ref(${renderVueStateInit(f)});`);
      const pascal = upperFirst(f.name);
      stateLines.push(
        `const set${pascal} = (v: typeof ${f.name}.value) => { ${f.name}.value = v; };`,
      );
      vueImports.add("ref");
    }
  }

  const apiImports = new Map<string, Set<string>>();
  const seenVars = new Set<string>();
  const hookLines: string[] = [];
  for (const m of result.actionMutations) {
    if (seenVars.has(m.localVar)) continue;
    seenVars.add(m.localVar);
    // The mutation hook targets a specific instance, so it takes the
    // instance id (`use<Op><Agg>(<idExpr>)` — matches React/Svelte).  The
    // raw `idExpr` (`order.id`) is rewritten to `props.order.id` by the
    // `rewriteScript` map below, since the instance is a component prop.
    hookLines.push(`const ${m.localVar} = reactive(${m.hookName}(${m.idExpr}));`);
    vueImports.add("reactive");
    const from = `../api/${m.aggCamel}`;
    const names = apiImports.get(from) ?? new Set<string>();
    names.add(m.hookName);
    apiImports.set(from, names);
  }
  const rewrittenHooks = hookLines.map(rewriteScript);

  // Form wiring — the same create-/workflow-form decls the page shell
  // emits (no route dependency, so they transplant verbatim; component
  // files sit one hop from `src/`, matching the page's `../api` / `../lib`
  // import depth).  Operation forms were rejected above.
  const formLines: string[] = [];
  let usesLoomForm = false;
  if (aggFormState && aggFormState.kind === "aggregate") {
    const agg = aggFormState.agg.name;
    usesLoomForm = true;
    if (!seenVars.has("create")) {
      seenVars.add("create");
      formLines.push(`const create = reactive(useCreate${agg}());`);
      vueImports.add("reactive");
    }
    formLines.push(
      `const form = useLoomForm(Create${agg}Request, ${aggFormState.defaultValuesTs});`,
    );
    const from = `../api/${lowerFirst(agg)}`;
    const names = apiImports.get(from) ?? new Set<string>();
    names.add(`useCreate${agg}`);
    names.add(`Create${agg}Request`);
    apiImports.set(from, names);
  }
  if (wfFormState && wfFormState.kind === "workflow") {
    const wf = upperFirst(wfFormState.workflow.name);
    usesLoomForm = true;
    if (!seenVars.has("run")) {
      seenVars.add("run");
      formLines.push(`const run = reactive(use${wf}Workflow());`);
      vueImports.add("reactive");
    }
    formLines.push(`const form = useLoomForm(${wf}Request, ${wfFormState.defaultValuesTs});`);
    const from = "../api/workflows";
    const names = apiImports.get(from) ?? new Set<string>();
    names.add(`use${wf}Workflow`);
    names.add(`${wf}Request`);
    apiImports.set(from, names);
  }
  // Operation forms — dialog state + open-fn + per-op LoomForm + the
  // pack op-dialog host appended after the body.  Identical to the page
  // shell except the mutation-hook arg is `rewriteScript(state.idExpr)`
  // (the instance is a prop, so `order.id` → `props.order.id`).
  const dialogBlocks: string[] = [];
  for (const st of opFormStates) {
    usesLoomForm = true;
    const opCamel = lowerFirst(st.op.name);
    const opPascal = upperFirst(st.op.name);
    const agg = st.agg.name;
    const from = `../api/${lowerFirst(agg)}`;
    const names = apiImports.get(from) ?? new Set<string>();
    if (!seenVars.has(opCamel)) {
      seenVars.add(opCamel);
      const hookName = `use${opPascal}${agg}`;
      formLines.push(`const ${opCamel} = reactive(${hookName}(${rewriteScript(st.idExpr)}));`);
      vueImports.add("reactive");
      names.add(hookName);
    }
    const openFn = `open${opPascal}Modal`;
    if (seenVars.has(openFn)) {
      apiImports.set(from, names);
      continue;
    }
    seenVars.add(openFn);
    names.add(`${opPascal}${agg}Request`);
    apiImports.set(from, names);
    formLines.push(`const ${opCamel}Open = ref(false);`);
    vueImports.add("ref");
    formLines.push(`const ${openFn} = (_mut: unknown) => { ${opCamel}Open.value = true; };`);
    formLines.push(
      `const ${opCamel}Form = useLoomForm(${opPascal}${agg}Request, ${st.defaultValuesTs});`,
    );
    const fields = st.fieldHtmls
      .map((h) => h.replaceAll("form.values.", `${opCamel}Form.values.`))
      .map((h) => h.replaceAll("form.errors[", `${opCamel}Form.errors[`))
      .map((h) => `            ${h}`)
      .join("\n");
    dialogBlocks.push(
      pack.render("op-dialog", {
        openVar: `${opCamel}Open`,
        formVar: `${opCamel}Form`,
        mutVar: opCamel,
        title: humanize(st.op.name),
        submitLabel: humanize(st.op.name),
        ns: st.testidNamespace,
        fieldsHtml: fields,
      }),
    );
    // The op-dialog template's pack component imports (pack.json
    // `imports["op-dialog"]`) — the walk never sees this template, so
    // merge them into the result import sink the loop below drains.
    for (const spec of (pack.manifest.imports?.["op-dialog"] ?? []) as ImportSpec[]) {
      const set = result.imports.get(spec.from) ?? new Set<string>();
      for (const n of spec.named) set.add(n);
      result.imports.set(spec.from, set);
    }
  }
  // Id-target select hooks (`X id` form fields render as `useAll<Target>()`
  // selects), deduped across the form states.
  for (const st of result.formOfs) {
    for (const t of st.idTargets) {
      const hookVar = idTargetHookVar(t);
      if (seenVars.has(hookVar)) continue;
      seenVars.add(hookVar);
      formLines.push(`const ${hookVar} = reactive(useAll${plural(t.name)}());`);
      vueImports.add("reactive");
      const from = `../api/${lowerFirst(t.name)}`;
      const names = apiImports.get(from) ?? new Set<string>();
      names.add(`useAll${plural(t.name)}`);
      apiImports.set(from, names);
    }
  }
  // `const props =` when any hoist/form/derived line reads a prop.
  const propsReferenced = [...rewrittenHooks, ...formLines, ...derivedLines].some((l) =>
    l.includes("props."),
  );
  // Create / workflow forms' default submit navigates.
  const needsNavigate =
    result.usesNavigate || aggFormState !== undefined || wfFormState !== undefined;

  // --- script assembly, imports first -------------------------------------
  if (vueImports.size > 0) {
    script.push(`import { ${[...vueImports].sort().join(", ")} } from "vue";`);
  }
  // A money-typed `state {}` field refs as `ref(new Decimal("0"))` —
  // pull decimal.js in, same as the page shell.
  if (result.usesState && state.some((f) => typeUsesMoney(f.type))) {
    script.push(`import Decimal from "decimal.js";`);
  }
  if (needsNavigate) {
    script.push(`import { useRouter } from "vue-router";`);
  }
  for (const [type, mod] of [...dtoImports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    script.push(`import type { ${type} } from "${mod}";`);
  }
  // Format helpers — imported unconditionally (mirrors the page shell;
  // the generated tsconfig keeps unused named imports tolerable).
  script.push(
    `import { EMPTY, formatBool, formatDateTime, formatMoney, formatNumber, formatPlain, isEmpty, shortId } from "../lib/format";`,
  );
  const componentTableHelpers = [
    ...(result.usesTableSort ? ["sortRows"] : []),
    ...(result.usesTableFilter ? ["filterRows"] : []),
  ];
  if (componentTableHelpers.length > 0) {
    script.push(`import { ${componentTableHelpers.join(", ")} } from "../lib/table-sort";`);
  }
  // currentUser binding for a gated `Action(...)` button in the body (the
  // action-level mirror of the page gate; binding-only — a component has no
  // page `requires`).
  if (result.usesCurrentUser) {
    script.push(`import { useSession } from "../auth/useSession";`);
  }
  if (usesLoomForm) {
    script.push(`import { useLoomForm } from "../lib/form";`);
  }
  if (usesFormToast) {
    script.push(`import { pushToast } from "../lib/toast";`);
  }
  for (const [from, names] of [...apiImports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    script.push(`import { ${[...names].sort().join(", ")} } from "${from}";`);
  }
  for (const fn of [...(result.usedExternFunctions ?? new Set<string>())].sort()) {
    script.push(`import { ${fn} } from "../lib/${fn}";`);
  }
  for (const n of [...result.usedUserComponents].sort()) {
    const ext = externComponents.has(n) ? "" : ".vue";
    script.push(`import ${n} from "./${n}${ext}";`);
  }
  // Pack per-primitive imports (shadcnVue barrel etc.) — same filter as
  // the page shell: only non-relative, non-RHF specifiers pass through.
  const walkerInternalSources = new Set(["react-hook-form", "@hookform/resolvers/zod"]);
  for (const [from, names] of [...result.imports.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (names.size === 0) continue;
    if (walkerInternalSources.has(from) || from.startsWith("./") || from.startsWith("../")) {
      continue;
    }
    script.push(`import { ${[...names].sort().join(", ")} } from "${from}";`);
  }
  for (const line of storeWiring.imports) script.push(line);
  script.push("");
  if (propFields.length > 0) {
    // `const props =` only when the script references a prop — keeps an
    // otherwise-unused binding out (template auto-exposes props by name).
    script.push(`${propsReferenced ? "const props = " : ""}defineProps<{`);
    for (const f of propFields) script.push(`  ${f}`);
    script.push(`}>();`);
  }
  if (needsNavigate) {
    script.push("const router = useRouter();");
    script.push("const navigate = (to: string) => { void router.push(to); };");
  }
  if (result.usesCurrentUser) {
    script.push(`const currentUser = (useSession().user.value ?? {}) as Record<string, any>;`);
  }
  for (const line of storeWiring.decls) script.push(line);
  script.push(...stateLines);
  script.push(...rewrittenHooks);
  script.push(...formLines);
  script.push(...derivedLines);
  script.push(...actionLines);
  while (script.length > 0 && script[script.length - 1] === "") script.pop();

  const dialogs = dialogBlocks.length > 0 ? `\n${dialogBlocks.join("\n")}` : "";
  const source = `<!-- Auto-generated.  Do not edit by hand.  (${name}) -->
<script setup lang="ts">
${script.join("\n")}
</script>

<template>
${indent(result.tsx, "  ")}${dialogs}
</template>
`;
  return { source, usesFormToast };
}

/** Build the `<script setup>` hoist lines for a page/component's
 *  `derived name: T = expr` bindings — each lands as a
 *  `const <name> = computed(() => <expr>);`.  Vue's `computed` tracks
 *  its dependencies automatically, so no deps array is derived.  Bindings
 *  emit in declaration order, accumulating `seenDerived` so a later
 *  derived can reference an earlier one (resolved as a bare ref via
 *  `derivedNames`).  The expression is walked in SCRIPT position, where
 *  state refs are `ref`s — `repointToScript` rewrites them to `.value`
 *  (and a component rewrites param refs to `props.<name>`), matching the
 *  api-hook hoists. */
function buildDerivedLines(
  derived: readonly DerivedIR[],
  pack: LoadedPack,
  paramNames: ReadonlySet<string>,
  stateNames: ReadonlySet<string>,
  repointToScript: (s: string) => string,
  usedStores?: Map<string, Set<string>>,
): { lines: string[]; usesState: boolean } {
  const lines: string[] = [];
  const seenDerived = new Set<string>();
  let usesState = false;
  for (const d of derived) {
    const dctx: WalkContext = {
      target: vueTarget,
      imports: new Map(),
      pack,
      paramNames,
      usedParams: new Set(),
      usesNavigate: false,
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
      // Share the body's store-usage map so a store read in a derived
      // expression records into the shell's store wiring (Stage 5).
      usedStores,
    };
    let exprStr = repointToScript(emitExpr(d.expr, dctx));
    if (dctx.usesState) usesState = true;
    // Earlier-derived reads land as bare `name` (walker reads a derived
    // like a state field), but each hoisted derived is a `ComputedRef`, so
    // in SCRIPT position the read must `.value`-deref — same as state.
    for (const prior of seenDerived) {
      exprStr = exprStr.replace(new RegExp(`\\b${prior}\\b(?!\\.value)`, "g"), `${prior}.value`);
    }
    lines.push(`const ${d.name} = computed(() => ${exprStr});`);
    seenDerived.add(d.name);
  }
  return { lines, usesState };
}

/** Build the `<script setup>` action handlers for a page/component's named
 *  `action`s (named-actions-and-stores.md, Proposal A Stage 1).  Mirrors
 *  `buildDerivedLines`: only referenced actions emit; the body lowers through
 *  the shared `emitStmt` against `vueTarget`, then `repointToScript` re-points
 *  every state ref to `.value` (vueTarget renders bare names for template
 *  inline-handler position, but a script-position `const <name> = () => …`
 *  arrow needs the explicit `.value` deref/assign).  The negative-lookahead
 *  in `repointToScript` keeps already-`.value` refs from double-pointing, so
 *  a `step := step + 1` write renders `step.value = step.value + 1`. */
/** Detection context an action body needs to lower a `variant-match`
 *  (`match await <op>() { … }` — async-actions-and-effects.md Stage 2): the
 *  api-param handles + aggregate/context maps `tryDetectApiHook` and the error-
 *  variant classifier consult, plus the SHARED sinks the resolved mutation
 *  hook + reification imports must land in (the page shell hoists the hook from
 *  `usedApiHooks` and routes `imports` into its api-import block).  All optional
 *  — a body with no awaited effect (the Stage-1 case, and every component body)
 *  passes none and behaves exactly as before. */
interface ActionWalkCtx {
  apiParamNames?: Map<string, string>;
  usedApiHooks?: Map<string, ApiHookUse>;
  imports?: Map<string, Set<string>>;
  aggregatesByName?: ReadonlyMap<string, AggregateIR>;
  bcByAggregate?: ReadonlyMap<string, BoundedContextIR>;
}

function buildActionLines(
  actions: readonly ActionIR[],
  used: ReadonlySet<string>,
  pack: LoadedPack,
  paramNames: ReadonlySet<string>,
  stateNames: ReadonlySet<string>,
  repointToScript: (s: string) => string,
  usedStores?: Map<string, Set<string>>,
  ctxOpts: ActionWalkCtx = {},
): {
  lines: string[];
  usesState: boolean;
  usesRouteId: boolean;
  imports: Map<string, Set<string>>;
} {
  const lines: string[] = [];
  let usesState = false;
  let usesRouteId = false;
  // Shared across every action's handler walk: the mutation hooks a
  // `variant-match` registers (the shell hoists them from here) and the
  // reification imports (`ApiError`, the op's union response type) it needs.
  const usedApiHooks = ctxOpts.usedApiHooks ?? new Map<string, ApiHookUse>();
  const imports = ctxOpts.imports ?? new Map<string, Set<string>>();
  // Transitively include any sibling action a used action's body calls
  // (Proposal A Stage 1, Fix 1) so its handler emits too.
  const effectiveUsed = closeUsedActions(actions, used);
  for (const action of actions) {
    if (!effectiveUsed.has(action.name)) continue;
    const param = action.params[0]?.name;
    const baseCtx: WalkContext = {
      target: vueTarget,
      imports,
      pack,
      paramNames,
      usedParams: new Set(),
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
      apiParamNames: ctxOpts.apiParamNames ?? new Map(),
      usedApiHooks,
      lambdaParams: new Map(),
      shellLocals: new Set(),
      aggregatesByName: ctxOpts.aggregatesByName ?? new Map(),
      bcByAggregate: ctxOpts.bcByAggregate ?? new Map(),
      workflowsByName: new Map(),
      bcByWorkflow: new Map(),
      formOfs: [],
      actionMutations: [],
      collectedTestids: new Set(),
      usesCodeBlock: false,
      // Share the body's store-usage map so a store action called ONLY from
      // an action handler (`discard() { Cart.clear() }`) drives the shell's
      // store import + member bind (Stage 5).
      usedStores,
    };
    const handlerCtx: WalkContext = param
      ? { ...baseCtx, lambdaParams: extendLambdaParams(baseCtx, param, param) }
      : baseCtx;
    const body = action.body.map((s) => repointToScript(emitStmt(s, handlerCtx))).join(" ");
    if (handlerCtx.usesState) usesState = true;
    // An awaited op mutation hoists `use<Op><Agg>(id)` off the route id, so the
    // shell must bind `id` from `route.params` even if the body never did.
    if (handlerCtx.usesRouteId) usesRouteId = true;
    // A body that awaits a remote effect (`variant-match`) must be `async`.
    const isAsync = action.body.some((s) => s.kind === "variant-match");
    lines.push(`const ${action.name} = ${isAsync ? "async " : ""}(${param ?? ""}) => { ${body} };`);
  }
  return { lines, usesState, usesRouteId, imports };
}

/** True when a form state renders the pack's default-submit body — an
 *  aggregate create-form or a workflow run-form with no custom
 *  `onSubmit:` (so the `form-default-onsubmit` template, which pushes a
 *  success toast, is what runs).  Drives both the per-page/component
 *  `pushToast` import and the app-shell toast-host gate. */
function formNeedsToast(state: FormOfState | undefined): boolean {
  return (
    state !== undefined &&
    (state.kind === "aggregate" || state.kind === "workflow") &&
    state.onSubmitJs === null
  );
}
