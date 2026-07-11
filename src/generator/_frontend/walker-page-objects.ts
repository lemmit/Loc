// Walker-side Playwright page-object emitter.
//
// Parallel to `page-objects-builder.ts` (which emits the scaffold
// archetype trio: `<Agg>ListPage` / `<Agg>NewPage` / `<Agg>DetailPage`).
// This module covers explicit (walker-emitted) pages: one page-
// object class per page, exposing a typed `Locator` getter per
// static `testid:` literal the walker encountered while walking
// the body.
//
// Output shape (per page):
//
//   import type { Page, Locator } from "@playwright/test";
//
//   export class <Page>Page {
//     static readonly url = "<route or builder>";
//     constructor(public readonly page: Page) {}
//     async goto(<params?>): Promise<this> { … }
//     get <name>(): Locator { return this.page.getByTestId("<id>"); }
//     …
//   }
//
// Route shape:
//   - Static routes ("/welcome") expose `static readonly url`.
//   - Parameterised routes ("/orders/:id") expose a `urlFor(id)`
//     static and a `goto(id: string)` instance method whose body
//     interpolates the params.
//   - Multi-param routes interpolate every `:name` segment.
//
// Locator getter naming:
//   - testid `orders-list` → getter `ordersList`
//   - testid `orders-row-link-${id}` is NOT walker-captured (only
//     literal testids surface; dynamic strings get caller-supplied
//     `byTestId(id)` accessors in a future slice).

import type { ParamIR } from "../../ir/types/loom-ir.js";

/** Inputs for the walker page-object emitter.  Kept narrow so
 *  callers in `pages-emitter.ts` don't have to thread additional
 *  page-level state in. */
export interface WalkerPageObjectInput {
  /** Page name as declared in the DSL (PascalCase, e.g. "OrderList"). */
  pageName: string;
  /** Page's typed route params (e.g. `id: string` for "/orders/:id"). */
  params: readonly ParamIR[];
  /** Raw route literal from the DSL (e.g. "/orders/:id"). */
  route: string;
  /** Every static `testid:` literal the walker accumulated while
   *  walking the body, including form-synthesised ones (e.g.
   *  `orders-new-input-<f>`). */
  testids: ReadonlySet<string>;
}

/** Emit a Playwright page-object TypeScript module for a walker-
 *  emitted page.  Caller writes the result to
 *  `e2e/pages/<page-snake>.ts`. */
export function buildWalkerPageObject(input: WalkerPageObjectInput): string {
  const { pageName, params, route, testids } = input;
  const hasParams = params.length > 0;
  const className = `${pageName}Page`;
  // Sort testids deterministically so the generated file is stable
  // across runs (Set iteration order is insertion-order, which is
  // body-shape-dependent — sorting yields a friendlier diff).
  const sortedTestids = [...testids].sort();

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page, Locator } from "@playwright/test";`);
  lines.push("");
  lines.push(`export class ${className} {`);
  if (hasParams) {
    // Parameterised route: `urlFor(...)` interpolates each `:name`.
    const paramList = params.map((p) => `${p.name}: ${typeRefAsTsString(p)}`).join(", ");
    const urlExpr = routeAsTemplateLiteral(route, params);
    lines.push(`  static urlFor(${paramList}): string {`);
    lines.push(`    return ${urlExpr};`);
    lines.push(`  }`);
    // Explicit field declaration + constructor assignment, not a
    // parameter property — see emit/value-objects.ts's renderValueObject.
    lines.push(`  readonly page: Page;`);
    lines.push(`  constructor(page: Page) {`);
    lines.push(`    this.page = page;`);
    lines.push(`  }`);
    lines.push("");
    lines.push(`  async goto(${paramList}): Promise<this> {`);
    lines.push(
      `    await this.page.goto(${className}.urlFor(${params.map((p) => p.name).join(", ")}));`,
    );
    lines.push(`    return this;`);
    lines.push(`  }`);
  } else {
    lines.push(`  static readonly url = ${JSON.stringify(route)};`);
    // Explicit field declaration + constructor assignment, not a
    // parameter property — see emit/value-objects.ts's renderValueObject.
    lines.push(`  readonly page: Page;`);
    lines.push(`  constructor(page: Page) {`);
    lines.push(`    this.page = page;`);
    lines.push(`  }`);
    lines.push("");
    lines.push(`  async goto(): Promise<this> {`);
    lines.push(`    await this.page.goto(${className}.url);`);
    lines.push(`    return this;`);
    lines.push(`  }`);
  }
  if (sortedTestids.length > 0) lines.push("");
  for (const tid of sortedTestids) {
    const getterName = locatorGetterName(tid);
    lines.push(`  get ${getterName}(): Locator {`);
    lines.push(`    return this.page.getByTestId(${JSON.stringify(tid)});`);
    lines.push(`  }`);
  }
  lines.push(`}`);
  lines.push("");
  return lines.join("\n");
}

/** Turn a free-form testid (kebab / snake / camel / mixed) into
 *  a valid JS identifier suitable for a class getter.  Splits on
 *  `-` and `_`, then camel-cases each segment after the first.
 *  Non-identifier characters (anything outside `[A-Za-z0-9]`)
 *  are stripped; a leading digit gets prefixed with `_` so the
 *  result is always a legal identifier.
 *
 *  Examples:
 *    "orders-list"            → "ordersList"
 *    "orders-new-submit"      → "ordersNewSubmit"
 *    "order-detail-h"         → "orderDetailH"
 *    "orders-new-input-customerId" → "ordersNewInputCustomerId"
 *    "alreadyCamel"           → "alreadyCamel"
 */
function locatorGetterName(testid: string): string {
  const parts = testid.split(/[-_]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return "_testid";
  const head = stripNonIdent(parts[0]!);
  const tail = parts
    .slice(1)
    .map((p) => {
      const s = stripNonIdent(p);
      return s.length === 0 ? "" : s[0]!.toUpperCase() + s.slice(1);
    })
    .join("");
  let out = head[0]!.toLowerCase() + head.slice(1) + tail;
  if (out.length === 0) return "_testid";
  if (/^[0-9]/.test(out)) out = "_" + out;
  return out;
}

function stripNonIdent(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "");
}

/** Convert a DSL route like `/orders/:id/items/:idx` into a TS
 *  template literal that interpolates each `:name` segment.  Used
 *  by `urlFor(...)` for parameterised routes.  Non-param segments
 *  pass through verbatim. */
function routeAsTemplateLiteral(route: string, params: readonly ParamIR[]): string {
  const paramNames = new Set(params.map((p) => p.name));
  // Split route on `:name` segments and rebuild as a template
  // literal.  Param refs become `${name}`; literal segments stay
  // as text inside the backticks.
  const parts: string[] = [];
  let last = 0;
  for (const m of route.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (m.index > last) parts.push(escapeTemplateText(route.slice(last, m.index)));
    const name = m[1]!;
    if (paramNames.has(name)) {
      parts.push("${" + name + "}");
    } else {
      // Defensive: route has `:name` but no matching ParamIR;
      // preserve the literal so a downstream review can spot it.
      parts.push(`:${name}`);
    }
    last = m.index + m[0].length;
  }
  if (last < route.length) parts.push(escapeTemplateText(route.slice(last)));
  return "`" + parts.join("") + "`";
}

/** Escape characters that would terminate or interpolate inside a
 *  TS template literal (backtick, dollar sign, backslash). */
function escapeTemplateText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

/** v0 — render a route param's TS type.  Pages only carry string
 *  params today (every route param is a path segment); this can
 *  broaden when typed query params arrive. */
function typeRefAsTsString(_p: ParamIR): string {
  return "string";
}
