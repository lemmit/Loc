import type { ExprIR, PageIR, StateFieldIR } from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";
import type { WalkResult } from "../../_walker/walker-core.js";
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
  for (const h of result.usedApiHooks.values()) {
    if (!h.hookName.startsWith("useAll")) return true;
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

  // State fields → signals (read `name()`, write `name.set()`).
  if (result.usesState) {
    coreSymbols.add("signal");
    for (const f of page.state) {
      members.push(`  readonly ${f.name} = signal(${renderStateInit(f)});`);
    }
  }

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
    const hoisted = angularTarget.renderApiHoisting(
      [...result.usedApiHooks.values()].map((h) => ({
        apiHandle: "",
        aggregateName: "",
        operation: "",
        kind: "query" as const,
        args: [],
        varName: h.varName,
        hookName: h.hookName,
        argsRendered: h.argsRendered,
      })),
    );
    for (const line of hoisted) members.push(`  ${line}`);
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
