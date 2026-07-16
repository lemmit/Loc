import type {
  ActionIR,
  AggregateIR,
  BoundedContextIR,
  DerivedIR,
  ExprIR,
  PageIR,
  StateFieldIR,
  UiApiParamIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { type PageNameCtx, pageEmitName } from "../../../ir/util/page-kind.js";
import { upperFirst } from "../../../util/naming.js";
import { renderGateExpr } from "../../_frontend/gate-expr.js";
import type { LoadedPack } from "../../_packs/loader.js";
import {
  closeUsedActions,
  emitExpr,
  emitStmt,
  extendLambdaParams,
  type WalkContext,
  type WalkResult,
} from "../../_walker/walker-core.js";
import {
  type AngularFieldArraySpec,
  fieldArrayControlDecl,
  fieldArrayMembers,
} from "../form-fields.js";
import { storeClassName, storeFileSlug } from "../store-builder.js";
import { angularTarget } from "./angular-target.js";
import { angularSink } from "./sink.js";

/** The `new FormGroup({ … })` control body for a form spec — flat
 *  `FormControl`s plus any `FormArray` declarations for dynamic-row fields. */
function formGroupBody(form: {
  controls: { name: string; init: string }[];
  fieldArrays?: AngularFieldArraySpec[];
}): string {
  const flat = form.controls.map(
    (c) => `${c.name}: new FormControl(${c.init}, { nonNullable: true })`,
  );
  const arrays = (form.fieldArrays ?? []).map((fa) => fieldArrayControlDecl(fa));
  return [...flat, ...arrays].join(", ");
}

/** The getter + add/remove member lines a form's dynamic-row fields contribute
 *  (empty when the form has none). */
function formArrayMemberLines(
  formVar: string,
  fieldArrays: AngularFieldArraySpec[] | undefined,
): string[] {
  return (fieldArrays ?? []).flatMap((fa) => fieldArrayMembers(formVar, fa));
}

// ---------------------------------------------------------------------------
// Angular page shell — assembles a generated standalone component around a
// walked page body (angular-frontend-plan.md Slice 4b).
//
// Batch 1 scope: static content + signal state + router navigation.  The
// walked markup lands in the component's inline `template`; `state` fields
// become `signal()`s (read `name()` / write `name.set()` per angularTarget),
// and `Button(to:)`-style navigation injects `Router`.  Per-aggregate
// @Injectable api services + Reactive Forms (api-hook / form results) land
// in the following batches — pages that need them are stubbed for now.
// ---------------------------------------------------------------------------

export interface AngularPageShellInput {
  page: PageIR;
  result: WalkResult;
  /** Page-level `derived name: T = expr` bindings — hoisted as
   *  `readonly <name> = computed(() => <expr>)` class fields. */
  derived?: readonly DerivedIR[];
  /** Active design pack — required to build the `WalkContext` the derived
   *  expressions emit through. */
  pack?: LoadedPack;
  /** True when the hosting frontend deployable has `auth: ui` (a verified
   *  session is available client-side).  Enables the page-level `requires`
   *  guard below — without it, a `requires` predicate stays purely a
   *  server-side 403. */
  authUi?: boolean;
  /** Served decl names for the component's emitted identifier (slice 3c). */
  nameCtx: PageNameCtx;
  /** The ui's api handles (`api Sales: SalesApi`) — needed so an action body
   *  that awaits a remote op (`match await Sales.Order.op()`,
   *  async-actions-and-effects.md Stage 2) can resolve the handle and hoist the
   *  mutation.  Empty for pages whose actions never await. */
  apiParams?: readonly UiApiParamIR[];
  /** Aggregate / bounded-context lookups the action-body api-hook detection +
   *  variant-match error-variant classification consult (same maps the main
   *  body walk receives). */
  aggregatesByName?: ReadonlyMap<string, AggregateIR>;
  bcByAggregate?: ReadonlyMap<string, BoundedContextIR>;
  workflowsByName?: ReadonlyMap<string, WorkflowIR>;
  bcByWorkflow?: ReadonlyMap<string, BoundedContextIR>;
  /** Extern frontend function names declared on this ui
   *  (`function f(…): T extern from "…"`) — an action-body call registers a
   *  use so the shell imports the shim and re-exposes it as a component member
   *  (same as a main-body call, resolved via `result.usedExternFunctions`). */
  externFunctions?: ReadonlySet<string>;
}

/** PascalCase component class name (`CustomerHome` → `CustomerHomeComponent`).
 *  Uses the aggregate-qualified emit name (`OrderList`), not the scaffold's
 *  role-scoped page name (`List`), which would collide across aggregates. */
export function pageComponentName(page: PageIR, nameCtx: PageNameCtx): string {
  return `${upperFirst(pageEmitName(page, nameCtx))}Component`;
}

/** kebab selector (`CustomerHome` → `app-customer-home`). */
export function pageSelector(page: PageIR, nameCtx: PageNameCtx): string {
  const kebab = pageEmitName(page, nameCtx)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
  return `app-${kebab}`;
}

/** file slug (`CustomerHome` → `customer-home`). */
export function pageSlug(page: PageIR, nameCtx: PageNameCtx): string {
  return pageSelector(page, nameCtx).slice("app-".length);
}

/** True when the walked body needs features the Angular shell does not assemble
 *  — such a page is stubbed.  EVERY form / mutation primitive is now
 *  Angular-forked through a `WalkerTarget` seam onto its own side-channel:
 *  `CreateForm` / `WorkflowForm` / standalone `OperationForm` (and the spoken
 *  `Form(<inst>.<op>)`) → `angularForms` / `angularWorkflowForms` /
 *  `angularOpForms`; `Action` / `Modal` / `DestroyForm` →
 *  `angularActions` / `angularModals` / `angularDestroyForms`.  Every api read —
 *  collection (`useAll…`), single-record (`use…ById`), reactive parameterised
 *  finds (`use<Find><Agg>`), views (`use<View>View`) and workflow-instance reads
 *  — is hoisted generically.  So the shared React-shaped sinks below stay EMPTY
 *  on Angular for the whole primitive surface; the two checks remain only as
 *  defence-in-depth — a future primitive that records onto the shared sink
 *  before it is forked degrades to a labelled stub rather than emitting a
 *  dangling reference. */
export function pageNeedsDeferredFeatures(result: WalkResult): boolean {
  // Shared RHF form sink — Angular forks every form primitive onto its own
  // side-channel, so this is empty in practice (defence-in-depth only).
  if (result.formOfs.length > 0) return true;
  // Shared mutation sink — likewise empty (Action/Modal/DestroyForm are forked).
  if (result.actionMutations.length > 0) return true;
  return false;
}

/** Render a `state {}` field's `signal(...)` initial value.  Uses the field's
 *  declared `= <init>` when it's a literal (string / number / bool / null) or a
 *  list of literals; otherwise falls back to the type's zero value.  (Init
 *  expressions evaluate before any signal exists, so they can't reference
 *  state/params — literals cover the realistic surface.) */
function renderStateInit(field: StateFieldIR): string {
  const lit = field.init !== undefined ? renderInitLiteral(field.init) : undefined;
  return lit ?? angularTarget.defaultInitFor(field.type);
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

function indentTemplate(markup: string): string {
  return markup
    .split("\n")
    .map((line) => (line.length > 0 ? `      ${line}` : line))
    .join("\n");
}

/** The `src/lib/format.ts` helpers a primitive template may call inside an
 *  Angular interpolation.  Angular evaluates template expressions against the
 *  component instance, so any helper the walked markup references has to be
 *  re-exposed as a component member — detected here by a `<helper>(` call in
 *  the rendered template. */
const FORMAT_HELPERS = [
  "formatMoney",
  "formatDateTime",
  "formatNumber",
  "formatBool",
  "formatPlain",
  "shortId",
] as const;

export function renderAngularPage(input: AngularPageShellInput): string {
  const { page, result, nameCtx } = input;
  // The Angular render seams parked the per-primitive form/action specs on the
  // walker's opaque `sink` slot; drain it here (empty when the body had none).
  const sink = angularSink(result);
  const coreSymbols = new Set<string>(["Component"]);
  const routerSymbols = new Set<string>();
  const members: string[] = [];
  // Directives the standalone component registers in `imports: []` — the
  // pack-declared `*Module`s plus `RouterLink`.
  const componentImports = new Set<string>();

  // Page-level `requires` UI gate (D-AUTH-OIDC): a currentUser-only predicate
  // gates the page body client-side on an `auth: ui` frontend.  Resolved up
  // front so the `inject` core symbol is registered BEFORE the import lines are
  // built (the gate's `inject(SessionService)` member needs it).  Stays
  // undefined — byte-identical to the ungated page — without `auth: ui`.
  const requires = input.authUi ? page.requires : undefined;
  // The verified-session `currentUser` accessor is needed for the page guard
  // (`requires`) AND for a currentUser-gated `Action` button inside the body
  // (the walker sets `result.usesCurrentUser` when it `@if`-hides one) — even
  // when the page itself carries no `requires`.  Inject once for either.
  const needsSession = input.authUi && (!!requires || result.usesCurrentUser);
  if (needsSession) coreSymbols.add("inject");

  // `derived name: T = expr` → `readonly <name> = computed(() => <expr>)`
  // class fields, in declaration order (a later derived may reference an
  // earlier one — resolved as a `<name>()` signal call via `derivedNames`).
  // Angular's `computed` auto-tracks the signals the expression reads, so
  // no deps array is derived; signal reads (`n()`) come from angularTarget.
  // Built first so a derived that reads a state field forces the `signal`
  // declaration below even when the body never reads it directly.
  const derived = input.derived ?? [];
  const derivedLines: string[] = [];
  let derivedUsesState = false;
  if (derived.length > 0 && input.pack) {
    coreSymbols.add("computed");
    const paramNames = new Set(page.params.map((p) => p.name));
    const stateNames = new Set(page.state.map((s) => s.name));
    const seenDerived = new Set<string>();
    for (const d of derived) {
      const dctx = derivedCtx(input.pack, paramNames, stateNames, seenDerived);
      const exprStr = emitExpr(d.expr, dctx);
      if (dctx.usesState) derivedUsesState = true;
      // The `computed(() => …)` body is a CLASS-FIELD initializer (not a
      // template), so signal/computed reads — which angularTarget emits as
      // bare `name()` for the template instance scope — must resolve against
      // `this`.  Prefix `this.` before each state-field / earlier-derived
      // signal call so the field initializer typechecks.
      const refNames = new Set<string>([...stateNames, ...seenDerived]);
      const body = prefixSignalReadsWithThis(exprStr, refNames);
      derivedLines.push(`  readonly ${d.name} = computed(() => ${body});`);
      seenDerived.add(d.name);
    }
  }

  // Named-action handlers → class methods (`<name>(<param>?) { … }`;
  // named-actions-and-stores.md, Proposal A Stage 1).  The body lowers through
  // the shared `emitStmt`, then signal reads (`count()`) + write targets
  // (`count.set(…)`) are `this.`-prefixed for class-method scope (same lift the
  // derived `computed` initializers apply).  Built before state so a handler
  // that mutates state forces the `signal` declaration below.
  const actions = (page.actions ?? []) as readonly ActionIR[];
  const actionMethods: string[] = [];
  let actionUsesState = false;
  if (actions.length > 0 && input.pack && result.usedActions && result.usedActions.size > 0) {
    const paramNames = new Set(page.params.map((p) => p.name));
    const stateNames = new Set(page.state.map((s) => s.name));
    const derivedNames = new Set(derived.map((d) => d.name));
    // Sibling action methods are `this.`-scoped class methods, so a body call
    // `next()` must render `this.next()` (Proposal A Stage 1, Fix 1).  Include
    // every action name in the whole-word prefix set alongside state/derived.
    const actionNames = new Set(actions.map((a) => a.name));
    const refNames = new Set<string>([...stateNames, ...derivedNames, ...actionNames]);
    // Transitively include any sibling action a used action's body calls so its
    // method emits too.
    const effectiveUsed = closeUsedActions(actions, result.usedActions);
    // An action body may `await` a remote op (`match await Sales.Order.op()` —
    // async-actions-and-effects.md Stage 2).  The awaited-op detection + mutation
    // hoist need the api handles + aggregate/BC lookups in scope, and the
    // emitted imports (`ApiError`, the union response type) + hoisted hook must
    // flow back to the shell — so SHARE the walk's object sinks (`imports`,
    // `usedApiHooks`, `usedParams`) and POPULATE the lookups, rather than the
    // isolated `derivedCtx` the Stage-1 named-action path used.
    const actionApiParamNames = new Map((input.apiParams ?? []).map((p) => [p.name, p.apiName]));
    for (const action of actions) {
      if (!effectiveUsed.has(action.name)) continue;
      const param = action.params[0]?.name;
      const baseCtx: WalkContext = {
        ...derivedCtx(input.pack, paramNames, stateNames, derivedNames),
        imports: result.imports,
        usedApiHooks: result.usedApiHooks,
        usedParams: result.usedParams,
        apiParamNames: actionApiParamNames,
        aggregatesByName: input.aggregatesByName ?? new Map(),
        bcByAggregate: input.bcByAggregate ?? new Map(),
        workflowsByName: input.workflowsByName ?? new Map(),
        bcByWorkflow: input.bcByWorkflow ?? new Map(),
        // An action body may call an extern frontend function; register the use
        // into the SHARED result set so the import/member block below covers it
        // exactly like a main-body call.
        externFunctions: input.externFunctions ?? new Set(),
        usedExternFunctions: result.usedExternFunctions,
      };
      const mctx: WalkContext = param
        ? { ...baseCtx, lambdaParams: extendLambdaParams(baseCtx, param, param) }
        : baseCtx;
      const stmts = action.body.map((s) => {
        const rendered = emitStmt(s, mctx);
        return prefixSignalReadsWithThis(prefixWholeWordsWithThis(rendered, refNames), refNames);
      });
      if (mctx.usesState) actionUsesState = true;
      // Copy the by-value boolean sinks the spread snapshotted back into the
      // shell's `result`: an awaited op sets `usesRouteId` (the shell must bind
      // `id` off the route) and a `then:` navigate sets `usesNavigate`.
      result.usesRouteId ||= mctx.usesRouteId;
      result.usesNavigate ||= mctx.usesNavigate;
      // A body containing a `variant-match` awaits, so the method must be `async`.
      const asyncKw = action.body.some((s) => s.kind === "variant-match") ? "async " : "";
      actionMethods.push(`  ${asyncKw}${action.name}(${param ?? ""}) { ${stmts.join(" ")} }`);
    }
  }

  // State fields → signals (read `name()`, write `name.set()`).  Declared
  // before the derived `computed`s that may read them.
  if (result.usesState || derivedUsesState || actionUsesState) {
    coreSymbols.add("signal");
    for (const f of page.state) {
      members.push(`  readonly ${f.name} = signal(${renderStateInit(f)});`);
    }
  }
  members.push(...derivedLines);
  members.push(...actionMethods);

  // Navigation → `inject(Router)`; the walked handler calls
  // `router.navigateByUrl(...)`.
  if (result.usesNavigate) {
    coreSymbols.add("inject");
    routerSymbols.add("Router");
    members.push("  readonly router = inject(Router);");
  }

  // Stores referenced from this body (named-actions-and-stores.md §3, Stage 5)
  // — inject each used store ONCE (`readonly cart = inject(CartStore)`); the
  // body reads `this.cart.lines()` and calls `this.cart.clear(args)` (the
  // walker-core store seam emits the `this.`-qualified member forms).  Pages
  // sit at `src/app/pages/<slug>.component.ts` and stores at
  // `src/app/stores/<dasherized>.store.ts` — both under `src/app/`, so the
  // import path is ONE hop up (`../stores/<dasherized>.store`).  The member
  // declarations register here (alongside `inject`); the import lines ride the
  // `imports` array built below.
  const usedStoreNames = result.usedStores ? [...result.usedStores.keys()].sort() : [];
  if (usedStoreNames.length > 0) {
    coreSymbols.add("inject");
    for (const storeName of usedStoreNames) {
      const className = storeClassName(storeName);
      const member = `${storeName[0]!.toLowerCase()}${storeName.slice(1)}`;
      members.push(`  readonly ${member} = inject(${className});`);
    }
  }

  // `Anchor(to:)` / `IdLink` / `Breadcrumbs` emit `[routerLink]` bindings — the
  // standalone component registers the `RouterLink` directive.
  if (result.usesRouterLink) {
    routerSymbols.add("RouterLink");
    componentImports.add("RouterLink");
  }

  // Route params (`/orders/:id`) the body or a byId read references — bound from
  // the `ActivatedRoute` snapshot below.  Compute + register the imports here
  // (before the import lines are built); the member fields emit further down.
  const routeParams = [...(page.route ?? "").matchAll(/:(\w+)/g)].map((m) => m[1]);
  const argRefs = new Set<string>();
  for (const h of result.usedApiHooks.values()) for (const a of h.argsRendered) argRefs.add(a);
  // The magic route `id` (`usesRouteId` — `byId(id)` / a bare `id` read) binds
  // even when it isn't a declared param or a hook arg, so a `/…/:id` page that
  // references it resolves `id` against the snapshot.
  const boundParams = routeParams.filter(
    (p) => result.usedParams.has(p) || argRefs.has(p) || (result.usesRouteId && p === "id"),
  );
  if (boundParams.length > 0) {
    coreSymbols.add("inject");
    routerSymbols.add("ActivatedRoute");
  }

  // `Modal` operation-dialog forms use `signal()` for their open/id state —
  // register the core import before the import lines are built (the spec block
  // that consumes them runs further down).
  if (sink.modals.length > 0) coreSymbols.add("signal");

  const imports: string[] = [
    `import { ${[...coreSymbols].sort().join(", ")} } from "@angular/core";`,
  ];
  if (routerSymbols.size > 0) {
    imports.push(`import { ${[...routerSymbols].sort().join(", ")} } from "@angular/router";`);
  }

  // Store-service imports for each used store (the `inject(<Store>Store)`
  // members registered above) — `import { CartStore } from
  // "../stores/cart.store"`.
  for (const storeName of usedStoreNames) {
    imports.push(
      `import { ${storeClassName(storeName)} } from "../stores/${storeFileSlug(storeName)}.store";`,
    );
  }

  // Format helpers the walked markup calls (Money/DateDisplay/IdLink) — import
  // them from `src/lib/format.ts` and re-expose as members so the template
  // interpolations resolve against the component.
  const usedHelpers = FORMAT_HELPERS.filter((h) => result.tsx.includes(`${h}(`));
  if (usedHelpers.length > 0) {
    imports.push(`import { ${usedHelpers.join(", ")} } from "../../lib/format";`);
    for (const h of usedHelpers) members.push(`  protected readonly ${h} = ${h};`);
  }

  // Interactive-table sort helper (M-T1.1) — a sortable `Table` renders a
  // `sortRows(…)` call; import it and re-expose as a member so the template
  // resolves it against the component (same lift as FORMAT_HELPERS).
  // A filterable `Table` renders a `filterRows(…)` call (M-T1.1); both helpers
  // share `src/lib/table-sort.ts`, so collect the used names into ONE import to
  // avoid a duplicate-module import, and re-expose each as a member.
  const tableHelpers = (["sortRows", "filterRows"] as const).filter((h) =>
    result.tsx.includes(`${h}(`),
  );
  if (tableHelpers.length > 0) {
    imports.push(`import { ${tableHelpers.join(", ")} } from "../../lib/table-sort";`);
    for (const h of tableHelpers) members.push(`  protected readonly ${h} = ${h};`);
  }

  // Interactive-table pager (M-T1.1) — the "Page N of M" label calls `Math.*`,
  // which Angular templates can't resolve against the global.  Re-expose `Math`
  // as a member so `Math.ceil(…)` binds to the component (same lift pattern).
  if (result.tsx.includes("Math.")) {
    members.push(`  protected readonly Math = Math;`);
  }

  // Extern frontend functions the walked body / action bodies call — import
  // each from its conformance shim (`src/lib/<name>.ts` → `../../lib/<name>`
  // from `src/app/pages/`) and re-expose it as a component member so the
  // template interpolation (`{{ initials(name()) }}`) resolves it against the
  // instance.  Same lift as `FORMAT_HELPERS`; sorted for stable output.
  const usedExternFns = [...(result.usedExternFunctions ?? new Set<string>())].sort();
  for (const fn of usedExternFns) {
    imports.push(`import { ${fn} } from "../../lib/${fn}";`);
    members.push(`  protected readonly ${fn} = ${fn};`);
  }

  // Extern components the walked body renders (extern-component-escape-hatch.md)
  // — invoked via `<ng-container [ngComponentOutlet]="<Name>" …>`
  // (`angularTarget.renderUserComponent`).  Import each component CLASS from its
  // re-export shim (`src/components/<Name>.ts` → `../../components/<Name>` from
  // `src/app/pages/`), re-expose it as a member (the outlet reads it against the
  // instance), and register Angular's `NgComponentOutlet` directive in the
  // standalone `imports: []` (from `@angular/common`).
  const usedComponents = [...result.usedUserComponents].sort();
  if (usedComponents.length > 0) {
    imports.push('import { NgComponentOutlet } from "@angular/common";');
    componentImports.add("NgComponentOutlet");
    for (const name of usedComponents) {
      imports.push(`import { ${name} } from "../../components/${name}";`);
      members.push(`  protected readonly ${name} = ${name};`);
    }
  }

  // Bind each route param synchronously as a class field so both the template
  // (`{{ id }}`) and a `use…ById(this.id)` hoist resolve.  Declared BEFORE the
  // api-read hoists, which reference them via `this.<param>` (class fields
  // initialise top-to-bottom).
  if (boundParams.length > 0) {
    members.push("  private readonly route = inject(ActivatedRoute);");
    for (const p of boundParams) {
      members.push(
        `  readonly ${p} = this.route.snapshot.paramMap.get(${JSON.stringify(p)}) ?? "";`,
      );
    }
  }

  // Per-aggregate api reads — import each `use*` read factory from
  // `src/api/<agg>.ts` and hoist it as a class field (`readonly <var> =
  // use…();`).  The field initializer is the injection context the factory's
  // `inject()` needs; pages sit two hops under `src/`, so the pack's default
  // `../api/<agg>` import path rewrites to `../../api/<agg>`.
  if (result.usedApiHooks.size > 0) {
    const byPath = new Map<string, Set<string>>();
    for (const h of result.usedApiHooks.values()) {
      const from = h.importFrom.replace(/^\.\.\/api\//, "../../api/");
      const names = byPath.get(from) ?? new Set<string>();
      names.add(h.hookName);
      byPath.set(from, names);
    }
    for (const [from, names] of [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      imports.push(`import { ${[...names].sort().join(", ")} } from ${JSON.stringify(from)};`);
    }
    // Hoist args are class-field initializers, so every member they read must
    // resolve against `this`.  A bare route-param arg (`id`) → `this.id`; a
    // parameterised-find query object (`{ status: status() }`) carries state /
    // derived signal CALLS that need `this.` too (`{ status: this.status() }`).
    // Route params bound as plain string fields are read bare inside the object
    // (not as a signal call), so prefix them as whole words there.
    const stateAndDerived = new Set<string>([
      ...page.state.map((s) => s.name),
      ...derived.map((d) => d.name),
    ]);
    const bind = (arg: string): string => {
      if (boundParams.includes(arg)) return `this.${arg}`;
      let out = prefixSignalReadsWithThis(arg, stateAndDerived);
      for (const p of boundParams) {
        out = out.replace(new RegExp(`(?<![.\\w])${p}\\b(?!\\()`, "g"), `this.${p}`);
      }
      return out;
    };
    const hoisted = angularTarget.renderApiHoisting(
      [...result.usedApiHooks.values()].map((h) => {
        const bound = h.argsRendered.map(bind);
        // A parameterised `find` takes a REACTIVE getter, not a snapshot: wrap
        // the resolved query object in `() => (...)` so the `injectQuery`
        // options callback re-reads it and a state-bound filter live-refetches.
        // A bare `{ status: this.status() }` field-initializer would freeze the
        // query at construction.
        const args = h.reactiveQuery && bound.length > 0 ? bound.map((a) => `() => (${a})`) : bound;
        return {
          apiHandle: "",
          aggregateName: "",
          operation: "",
          kind: "query" as const,
          args: [],
          varName: h.varName,
          hookName: h.hookName,
          argsRendered: args,
        };
      }),
    );
    for (const line of hoisted) members.push(`  ${line}`);
  }

  // `CreateForm(of: …)` — the Angular renderer recorded one spec per form on
  // the `angularForms` side-channel.  Each hoists the `useCreate<Agg>`
  // mutation, builds the typed Reactive `FormGroup`, and declares the submit
  // handler (`mutate` → navigate).  The form-shell imports (FormGroup /
  // ReactiveFormsModule / Mat modules / the api types) ride `result.imports`.
  const angularForms = sink.forms;
  for (const form of angularForms) {
    members.push(`  readonly ${form.mutationVar} = ${form.mutationFn}();`);
    members.push(`  readonly ${form.formVar} = new FormGroup({ ${formGroupBody(form)} });`);
    members.push(...formArrayMemberLines(form.formVar, form.fieldArrays));
    members.push(
      [
        `  async ${form.submitMethod}(): Promise<void> {`,
        `    if (this.${form.formVar}.invalid) return;`,
        `    const out = await this.${form.mutationVar}.mutateAsync(this.${form.formVar}.getRawValue());`,
        `    this.router.navigateByUrl(\`/${form.redirectSlug}/\${out.id}\`);`,
        "  }",
      ].join("\n"),
    );
  }

  // `WorkflowForm(runs: …)` — the Angular renderer recorded one spec per form on
  // `angularWorkflowForms`.  Each hoists the `use<Wf>Workflow` mutation, builds
  // the typed Reactive `FormGroup` over the command params, and declares the
  // submit handler (`mutateAsync(getRawValue())` → navigate `/workflows`).  The
  // workflow command returns `void`, so the redirect is a fixed list route (no
  // `out.id`).
  const angularWorkflowForms = sink.workflowForms;
  for (const form of angularWorkflowForms) {
    members.push(`  readonly ${form.mutationVar} = ${form.mutationFn}();`);
    members.push(`  readonly ${form.formVar} = new FormGroup({ ${formGroupBody(form)} });`);
    members.push(...formArrayMemberLines(form.formVar, form.fieldArrays));
    members.push(
      [
        `  async ${form.submitMethod}(): Promise<void> {`,
        `    if (this.${form.formVar}.invalid) return;`,
        `    await this.${form.mutationVar}.mutateAsync(this.${form.formVar}.getRawValue());`,
        '    this.router.navigateByUrl("/workflows");',
        "  }",
      ].join("\n"),
    );
  }

  // Standalone `OperationForm(...)` — the renderer recorded one spec per form on
  // `angularOpForms`.  Each hoists the `use<Op><Agg>()` mutation, builds the
  // typed Reactive `FormGroup` over the op params, and declares the submit
  // handler (`mutateAsync({ id, input: getRawValue() })`).  The id expression
  // resolves in template scope (a bare route `id`, or `<param>.id`); it's
  // `this.`-prefixed here for the method body.
  const angularOpForms = sink.opForms;
  if (angularOpForms.length > 0) {
    // The `use<Op><Agg>` import rides `result.imports` (the renderer `addNg`s it),
    // emitted once by the generic import block below — no separate line here.
    const idFields = new Set<string>([
      ...page.state.map((s) => s.name),
      ...page.params.map((p) => p.name),
      ...boundParams,
    ]);
    for (const f of angularOpForms) {
      members.push(`  readonly ${f.mutationVar} = ${f.mutationFn}();`);
      const opBody = formGroupBody(f);
      members.push(`  readonly ${f.formVar} = new FormGroup(${opBody ? `{ ${opBody} }` : "{}"});`);
      members.push(...formArrayMemberLines(f.formVar, f.fieldArrays));
      // The id expression is a template-scope ref (`id` / `order.id`); class
      // fields read against `this` (`this.id` / `this.order.id`).
      const idExpr = prefixWholeWordsWithThis(f.idExpr, idFields);
      members.push(
        [
          `  async ${f.submitMethod}(): Promise<void> {`,
          `    if (this.${f.formVar}.invalid) return;`,
          `    await this.${f.mutationVar}.mutateAsync({ id: ${idExpr}, input: this.${f.formVar}.getRawValue() });`,
          "  }",
        ].join("\n"),
      );
    }
  }

  // `DestroyForm(of: …)` — the renderer recorded one spec per form on
  // `angularDestroyForms`.  Each hoists `readonly <var> = useDelete<Agg>()` and a
  // confirm-delete method: `window.confirm` → `mutateAsync(id)` → the `then:`
  // redirect (default the aggregate's list route).
  const angularDestroyForms = sink.destroyForms;
  if (angularDestroyForms.length > 0) {
    // The `useDelete<Agg>` import rides `result.imports` (the renderer `addNg`s
    // it), emitted once by the generic import block below.
    for (const f of angularDestroyForms) {
      members.push(`  readonly ${f.localVar} = ${f.hookName}();`);
      members.push(
        [
          `  async ${f.method.name}(): Promise<void> {`,
          `    if (!window.confirm(${f.method.confirmMsg})) return;`,
          `    await this.${f.localVar}.mutateAsync(this.id);`,
          `    ${f.method.thenJs};`,
          "  }",
        ].join("\n"),
      );
    }
  }

  // `Action(inst.op)` — the Angular renderer recorded one spec per operation on
  // the `angularActions` side-channel.  Each hoists `readonly <var> =
  // use<Op><Agg>()` and a "dumb template" method the `(click)="on<Op><Agg>()"`
  // calls: it reads the record id with a `?.id` guard, awaits the mutation,
  // then runs the optional `then:` effect.
  const angularActions = sink.actions;
  if (angularActions.length > 0) {
    const byPath = new Map<string, Set<string>>();
    for (const a of angularActions) {
      const names = byPath.get(a.importFrom) ?? new Set<string>();
      names.add(a.hookName);
      byPath.set(a.importFrom, names);
    }
    for (const [from, names] of [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      imports.push(`import { ${[...names].sort().join(", ")} } from ${JSON.stringify(from)};`);
    }
    for (const a of angularActions) {
      members.push(`  readonly ${a.localVar} = ${a.hookName}();`);
      const body = [
        `  async ${a.method.name}(): Promise<void> {`,
        `    const id = ${a.method.idAccess};`,
        "    if (!id) return;",
        `    await this.${a.localVar}.mutateAsync({ id, input: {} });`,
      ];
      if (a.method.thenJs) body.push(`    ${a.method.thenJs};`);
      body.push("  }");
      members.push(body.join("\n"));
    }
  }

  // `Modal { OperationForm(…) }` — the renderer recorded one spec per
  // operation-dialog on `angularModals`.  Each gets a toggle `<op>Open` signal,
  // an `<op>Id` signal the trigger captures the record id into, the
  // `use<Op><Agg>()` mutation, the op `FormGroup`, and the submit method that
  // mutates (id from the signal) then closes.  The `use…` import + the field /
  // forms modules ride `result.imports`.
  const angularModals = sink.modals;
  if (angularModals.length > 0) {
    coreSymbols.add("signal");
    for (const m of angularModals) {
      members.push(`  readonly ${m.openSig} = signal(false);`);
      members.push(`  readonly ${m.idSig} = signal("");`);
      members.push(`  readonly ${m.mutationVar} = ${m.mutationFn}();`);
      members.push(`  readonly ${m.formVar} = new FormGroup({ ${formGroupBody(m)} });`);
      members.push(...formArrayMemberLines(m.formVar, m.fieldArrays));
      members.push(
        [
          `  async ${m.submitMethod}(): Promise<void> {`,
          `    if (this.${m.formVar}.invalid) return;`,
          `    await this.${m.mutationVar}.mutateAsync({ id: this.${m.idSig}(), input: this.${m.formVar}.getRawValue() });`,
          `    this.${m.openSig}.set(false);`,
          "  }",
        ].join("\n"),
      );
    }
  }

  // `X id` Select fields — every form fork records the `useAll<X>()` queries
  // its reference fields need (`idTargets`).  Hoist each distinct query once as
  // a class field (`readonly <hookVar> = useAll<X>();`) and import its factory;
  // the field markup (`form-fields.ts`) reads its options off `<hookVar>.data()`.
  // Deduped across all forms on the page so two forms sharing a target share the
  // single hoisted query.
  const idTargets = [
    ...angularForms.flatMap((f) => f.idTargets),
    ...angularWorkflowForms.flatMap((f) => f.idTargets),
    ...angularOpForms.flatMap((f) => f.idTargets),
    ...angularModals.flatMap((m) => m.idTargets),
  ];
  if (idTargets.length > 0) {
    const seen = new Set<string>();
    const byPath = new Map<string, Set<string>>();
    for (const t of idTargets) {
      if (seen.has(t.hookVar)) continue;
      seen.add(t.hookVar);
      const from = t.importFrom.replace(/^\.\.\/api\//, "../../api/");
      const names = byPath.get(from) ?? new Set<string>();
      names.add(t.hookFn);
      byPath.set(from, names);
      members.push(`  readonly ${t.hookVar} = ${t.hookFn}();`);
    }
    for (const [from, names] of [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      imports.push(`import { ${[...names].sort().join(", ")} } from ${JSON.stringify(from)};`);
    }
  }

  // Primitive imports collected by `renderPrimitive` (pack-declared) —
  // each becomes an import line, and Angular declarables (the `*Module`
  // symbols a standalone component must register) go into `imports: []`.
  for (const [from, names] of [...result.imports.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    // Pages sit two hops under `src/` (`src/app/pages/…`), so any pack-default
    // `../api/…` path (e.g. the `ApiError` + union-response-type imports the
    // shared variant-match envelope records) rewrites one level deeper.  The
    // Angular renderers that add api imports directly already spell `../../api/`,
    // so this only lifts the framework-neutral single-dot entries.
    const rewritten = from.replace(/^\.\.\/api\//, "../../api/");
    const sorted = [...names].sort();
    imports.push(`import { ${sorted.join(", ")} } from ${JSON.stringify(rewritten)};`);
    for (const n of sorted) {
      if (n.endsWith("Module")) componentImports.add(n);
    }
  }
  const componentImportsList = [...componentImports].sort();

  // Verified-session binding (D-AUTH-OIDC): on an `auth: ui` frontend, `inject`
  // the `SessionService` and expose the verified claims as a `currentUser`
  // accessor the template reads as bare member refs.  Needed by the page-level
  // `requires` guard AND by a currentUser-gated `Action` button in the body
  // (`result.usesCurrentUser`) — one member only, even when both are present.
  // Empty (byte-identical to the ungated page) without `auth: ui` or any gate.
  let template = indentTemplate(result.tsx);
  if (needsSession) {
    imports.push('import { SessionService } from "../auth/session.service";');
    members.push("  readonly session = inject(SessionService);");
    members.push(
      "  get currentUser(): Record<string, unknown> { return this.session.user() ?? {}; }",
    );
  }
  // Page-level `requires` UI gate: wrap the body in an `@if (<gate>) { … }
  // @else { … }` rendering a Forbidden fallback when the gate fails (the client
  // mirror of the backend 403).  The action-button gate, by contrast, is
  // already woven into `result.tsx` by the walker, so it needs no wrap here.
  if (requires) {
    const gateExpr = renderGateExpr(requires, "currentUser");
    template = [
      `      @if (${gateExpr}) {`,
      indentTemplate(result.tsx),
      "      } @else {",
      `        <section style="padding:24px"><h2>Forbidden</h2><p>You don't have access to this page.</p></section>`,
      "      }",
    ].join("\n");
  }

  return [
    "// Auto-generated.",
    ...imports,
    "",
    "@Component({",
    `  selector: ${JSON.stringify(pageSelector(page, nameCtx))},`,
    `  imports: [${componentImportsList.join(", ")}],`,
    "  template: `",
    template,
    "  `,",
    "})",
    `export class ${pageComponentName(page, nameCtx)} {${members.length > 0 ? "\n" + members.join("\n") + "\n" : ""}}`,
    "",
  ].join("\n");
}

/** Prefix `this.` before each signal-call read (`<name>()`) whose name is
 *  in `refNames` (state fields + earlier-derived).  angularTarget emits
 *  these as bare `name()` for the template instance scope, but a `derived`
 *  hoist is a class-field initializer where the names must resolve against
 *  `this`.  The negative lookbehind keeps an already-prefixed `this.name()`
 *  (and any `x.name()` member access) untouched. */
function prefixSignalReadsWithThis(expr: string, refNames: ReadonlySet<string>): string {
  let out = expr;
  for (const n of refNames) {
    out = out.replace(new RegExp(`(?<![.\\w])${n}\\(\\)`, "g"), `this.${n}()`);
  }
  return out;
}

/** Prefix `this.` before each bare WHOLE-WORD class-field reference in
 *  `refNames` (e.g. a route-param field `id` → `this.id`, `order` → `this.order`
 *  in `order.id`).  Used to lift a template-scope id expression into a method
 *  body.  The negative lookbehind keeps an already-prefixed / member access
 *  untouched; the trailing lookahead leaves a signal-CALL read (`name()`) to
 *  `prefixSignalReadsWithThis`. */
function prefixWholeWordsWithThis(expr: string, refNames: ReadonlySet<string>): string {
  let out = expr;
  for (const n of refNames) {
    out = out.replace(new RegExp(`(?<![.\\w])${n}\\b(?!\\()`, "g"), `this.${n}`);
  }
  return out;
}

/** A minimal `WalkContext` for rendering a single `derived` expression
 *  to an Angular `computed(...)` body.  `derivedNames` (accumulating
 *  `seenDerived`) lets a later derived reference an earlier one as a
 *  `<name>()` signal call. */
function derivedCtx(
  pack: LoadedPack,
  paramNames: ReadonlySet<string>,
  stateNames: ReadonlySet<string>,
  derivedNames: ReadonlySet<string>,
): WalkContext {
  return {
    target: angularTarget,
    imports: new Map(),
    pack,
    paramNames,
    usedParams: new Set(),
    usesNavigate: false,
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

/** Stub component for a page whose body needs deferred features. */
export function renderAngularPageStub(page: PageIR, nameCtx: PageNameCtx, authUi = false): string {
  const testid = JSON.stringify(`page-${pageSlug(page, nameCtx)}`);
  const section = `<section data-testid=${testid}><h2>${page.name}</h2></section>`;
  const className = pageComponentName(page, nameCtx);

  // Page-level `requires` UI gate (D-AUTH-OIDC) — applies to the stub too, so a
  // gated page whose body needs deferred features still renders a `<Forbidden>`
  // fallback instead of leaking its (stub) chrome to an unauthorized user.  The
  // gate validator guarantees a page `requires` is currentUser-only, so
  // `renderGateExpr` can't throw.  Without `auth: ui` / no `requires` the stub
  // stays byte-identical (no injection, no wrap).
  const requires = authUi ? page.requires : undefined;
  if (requires) {
    const gate = renderGateExpr(requires, "currentUser");
    return [
      "// Auto-generated (stub — body needs api/forms support, a later Slice 4b batch).",
      'import { Component, inject } from "@angular/core";',
      'import { SessionService } from "../auth/session.service";',
      "",
      "@Component({",
      `  selector: ${JSON.stringify(pageSelector(page, nameCtx))},`,
      "  imports: [],",
      "  template: `",
      `    @if (${gate}) {`,
      `      ${section}`,
      "    } @else {",
      `      <section style="padding:24px"><h2>Forbidden</h2><p>You don't have access to this page.</p></section>`,
      "    }",
      "  `,",
      "})",
      `export class ${className} {`,
      "  readonly session = inject(SessionService);",
      "  get currentUser(): Record<string, unknown> { return this.session.user() ?? {}; }",
      "}",
      "",
    ].join("\n");
  }

  return [
    "// Auto-generated (stub — body needs api/forms support, a later Slice 4b batch).",
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    `  selector: ${JSON.stringify(pageSelector(page, nameCtx))},`,
    "  imports: [],",
    `  template: \`${section}\`,`,
    "})",
    `export class ${className} {}`,
    "",
  ].join("\n");
}
