import type { DerivedIR, ExprIR, PageIR, StateFieldIR } from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";
import type { LoadedPack } from "../../_packs/loader.js";
import { emitExpr, type WalkContext, type WalkResult } from "../../_walker/walker-core.js";
import type { AngularCreateFormSpec } from "../create-form.js";
import { angularTarget } from "./angular-target.js";

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
}

/** PascalCase component class name (`CustomerHome` → `CustomerHomeComponent`). */
export function pageComponentName(page: PageIR): string {
  return `${upperFirst(page.name)}Component`;
}

/** kebab selector (`CustomerHome` → `app-customer-home`). */
export function pageSelector(page: PageIR): string {
  const kebab = page.name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
  return `app-${kebab}`;
}

/** file slug (`CustomerHome` → `customer-home`). */
export function pageSlug(page: PageIR): string {
  return pageSelector(page).slice("app-".length);
}

/** True when the walked body needs features not assembled yet — such a page
 *  is stubbed until a later sub-slice.  Reactive Forms (`formOfs`) are still
 *  deferred; of the api reads, only the collection `findAll` (`useAll*`) is
 *  wired, so a page using `byId` / mutations / parameterised finds stays
 *  stubbed until those sub-slices land. */
export function pageNeedsDeferredFeatures(result: WalkResult): boolean {
  if (result.formOfs.length > 0) return true;
  // `Action(inst.op)` / operation forms record a mutation hook the shell does
  // not assemble yet — stub rather than emit a dangling `<op><Agg>` reference.
  if (result.actionMutations.length > 0) return true;
  for (const h of result.usedApiHooks.values()) {
    // Collection (`useAll…`) and single-record (`use…ById`) reads are
    // supported; anything else (action mutations) still defers.
    if (!h.hookName.startsWith("useAll") && !h.hookName.endsWith("ById")) return true;
  }
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
  const { page, result } = input;
  const coreSymbols = new Set<string>(["Component"]);
  const routerSymbols = new Set<string>();
  const members: string[] = [];
  // Directives the standalone component registers in `imports: []` — the
  // pack-declared `*Module`s plus `RouterLink`.
  const componentImports = new Set<string>();

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

  // State fields → signals (read `name()`, write `name.set()`).  Declared
  // before the derived `computed`s that may read them.
  if (result.usesState || derivedUsesState) {
    coreSymbols.add("signal");
    for (const f of page.state) {
      members.push(`  readonly ${f.name} = signal(${renderStateInit(f)});`);
    }
  }
  members.push(...derivedLines);

  // Navigation → `inject(Router)`; the walked handler calls
  // `router.navigateByUrl(...)`.
  if (result.usesNavigate) {
    coreSymbols.add("inject");
    routerSymbols.add("Router");
    members.push("  readonly router = inject(Router);");
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
  const boundParams = routeParams.filter((p) => result.usedParams.has(p) || argRefs.has(p));
  if (boundParams.length > 0) {
    coreSymbols.add("inject");
    routerSymbols.add("ActivatedRoute");
  }

  const imports: string[] = [
    `import { ${[...coreSymbols].sort().join(", ")} } from "@angular/core";`,
  ];
  if (routerSymbols.size > 0) {
    imports.push(`import { ${[...routerSymbols].sort().join(", ")} } from "@angular/router";`);
  }

  // Format helpers the walked markup calls (Money/DateDisplay/IdLink) — import
  // them from `src/lib/format.ts` and re-expose as members so the template
  // interpolations resolve against the component.
  const usedHelpers = FORMAT_HELPERS.filter((h) => result.tsx.includes(`${h}(`));
  if (usedHelpers.length > 0) {
    imports.push(`import { ${usedHelpers.join(", ")} } from "../../lib/format";`);
    for (const h of usedHelpers) members.push(`  protected readonly ${h} = ${h};`);
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
    // Route-param args resolve against the bound class fields (`id` → `this.id`).
    const bind = (arg: string): string => (boundParams.includes(arg) ? `this.${arg}` : arg);
    const hoisted = angularTarget.renderApiHoisting(
      [...result.usedApiHooks.values()].map((h) => ({
        apiHandle: "",
        aggregateName: "",
        operation: "",
        kind: "query" as const,
        args: [],
        varName: h.varName,
        hookName: h.hookName,
        argsRendered: h.argsRendered.map(bind),
      })),
    );
    for (const line of hoisted) members.push(`  ${line}`);
  }

  // `CreateForm(of: …)` — the Angular renderer recorded one spec per form on
  // the `angularForms` side-channel.  Each hoists the `useCreate<Agg>`
  // mutation, builds the typed Reactive `FormGroup`, and declares the submit
  // handler (`mutate` → navigate).  The form-shell imports (FormGroup /
  // ReactiveFormsModule / Mat modules / the api types) ride `result.imports`.
  const angularForms = (result.angularForms ?? []) as AngularCreateFormSpec[];
  for (const form of angularForms) {
    members.push(`  readonly ${form.mutationVar} = ${form.mutationFn}();`);
    const controls = form.controls
      .map((c) => `${c.name}: new FormControl(${c.init}, { nonNullable: true })`)
      .join(", ");
    members.push(`  readonly ${form.formVar} = new FormGroup({ ${controls} });`);
    members.push(
      [
        `  async ${form.submitMethod}(): Promise<void> {`,
        `    if (this.${form.formVar}.invalid) return;`,
        `    const out = await this.${form.mutationVar}.mutate(this.${form.formVar}.getRawValue());`,
        `    this.router.navigateByUrl(\`/${form.redirectSlug}/\${out.id}\`);`,
        "  }",
      ].join("\n"),
    );
  }

  // Primitive imports collected by `renderPrimitive` (pack-declared) —
  // each becomes an import line, and Angular declarables (the `*Module`
  // symbols a standalone component must register) go into `imports: []`.
  for (const [from, names] of [...result.imports.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const sorted = [...names].sort();
    imports.push(`import { ${sorted.join(", ")} } from ${JSON.stringify(from)};`);
    for (const n of sorted) {
      if (n.endsWith("Module")) componentImports.add(n);
    }
  }
  const componentImportsList = [...componentImports].sort();

  return [
    "// Auto-generated.",
    ...imports,
    "",
    "@Component({",
    `  selector: ${JSON.stringify(pageSelector(page))},`,
    `  imports: [${componentImportsList.join(", ")}],`,
    "  template: `",
    indentTemplate(result.tsx),
    "  `,",
    "})",
    `export class ${pageComponentName(page)} {${members.length > 0 ? "\n" + members.join("\n") + "\n" : ""}}`,
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

/** Stub component for a page whose body needs deferred features. */
export function renderAngularPageStub(page: PageIR): string {
  return [
    "// Auto-generated (stub — body needs api/forms support, a later Slice 4b batch).",
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    `  selector: ${JSON.stringify(pageSelector(page))},`,
    "  imports: [],",
    `  template: \`<section data-testid=${JSON.stringify(`page-${pageSlug(page)}`)}><h2>${page.name}</h2></section>\`,`,
    "})",
    `export class ${pageComponentName(page)} {}`,
    "",
  ].join("\n");
}
