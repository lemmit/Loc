// ---------------------------------------------------------------------------
// Phoenix LiveView Playwright page-object emitter.
//
// Exports `buildPlaywrightPageObject`, which emits TypeScript content for
// `e2e/pages/<page-snake>.ts` — a Playwright page-object class for one
// PageIR.  The HTML structure LiveView renders is testid-equivalent to the
// React generator's output, so the same testid-keyed selectors work against
// both targets.
//
// This module mirrors src/generator/react/page-objects-builder.ts for the
// scaffold archetype pages (aggregate-list / new / detail / workflow-form /
// view-list) and src/generator/react/walker-page-objects.ts for the
// general param/route pattern.
//
// Output shape per page:
//
//   import type { Page, Locator } from "@playwright/test";
//   import { expect } from "@playwright/test";
//
//   export class <Page>Page {
//     static readonly url = "<route>";           // or urlFor(...) for params
//     constructor(public readonly page: Page) {}
//     async goto(...): Promise<this> { … }
//     // — archetype-specific methods —
//   }
// ---------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR, PageIR, TypeIR } from "../../ir/loom-ir.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import { fillBlock } from "../react/page-objects-builder.js";

export interface BuildPlaywrightPageObjectArgs {
  page: PageIR;
  appName: string;
  aggregatesByName: Map<string, AggregateIR>;
  contextByAggName: Map<string, BoundedContextIR>;
}

/** Emit a Playwright page-object TypeScript module for one Phoenix LiveView
 *  page.  Caller writes the result to `e2e/pages/<page-snake>.ts`. */
export function buildPlaywrightPageObject(args: BuildPlaywrightPageObjectArgs): string {
  const { page, aggregatesByName, contextByAggName } = args;
  const origin = page.origin;

  if (!origin || origin.kind === "custom") {
    // Explicit (walker-emitted, user-written) page — generic
    // param/route pattern.
    return buildGenericPageObject(page);
  }

  switch (origin.kind) {
    case "aggregate-list": {
      const agg = aggregatesByName.get(origin.aggregateName);
      const ctx = contextByAggName.get(origin.aggregateName);
      if (!agg || !ctx) return buildFallback(page);
      return buildAggregateListPageObject(page, agg, ctx);
    }
    case "aggregate-new": {
      const agg = aggregatesByName.get(origin.aggregateName);
      const ctx = contextByAggName.get(origin.aggregateName);
      if (!agg || !ctx) return buildFallback(page);
      return buildAggregateNewPageObject(page, agg, ctx);
    }
    case "aggregate-detail": {
      const agg = aggregatesByName.get(origin.aggregateName);
      const ctx = contextByAggName.get(origin.aggregateName);
      if (!agg || !ctx) return buildFallback(page);
      return buildAggregateDetailPageObject(page, agg, ctx);
    }
    case "workflow-form": {
      const ctx = [...contextByAggName.values()].find((c) =>
        c.workflows.some((w) => w.name === origin.workflowName),
      );
      const wf = ctx?.workflows.find((w) => w.name === origin.workflowName);
      if (!wf || !ctx) return buildFallback(page);
      return buildWorkflowFormPageObject(page, wf, ctx);
    }
    case "view-list": {
      const ctx = [...contextByAggName.values()].find((c) =>
        c.views.some((v) => v.name === origin.viewName),
      );
      const view = ctx?.views.find((v) => v.name === origin.viewName);
      if (!view || !ctx) return buildFallback(page);
      return buildViewListPageObject(page, view);
    }
    case "workflows-index":
      return buildWorkflowsIndexPageObject(page);
    case "views-index":
      return buildViewsIndexPageObject(page);
    case "home":
      return buildHomePageObject(page);
  }
}

// ---------------------------------------------------------------------------
// Aggregate-list page object
// ---------------------------------------------------------------------------

function buildAggregateListPageObject(
  page: PageIR,
  agg: AggregateIR,
  _ctx: BoundedContextIR,
): string {
  const slug = snake(plural(agg.name));
  const aggPascal = upperFirst(agg.name);
  const className = `${upperFirst(page.name)}Page`;
  const route = page.route ?? `/${slug}`;

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page, Locator } from "@playwright/test";`);
  lines.push(`import { expect } from "@playwright/test";`);
  lines.push(``);
  lines.push(`export class ${className} {`);
  lines.push(`  static readonly url = ${JSON.stringify(route)};`);
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push(``);
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${className}.url);`);
  lines.push(`    await this.page.getByTestId("${slug}-list").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async create(): Promise<${aggPascal}NewPage> {`);
  lines.push(`    await this.page.getByTestId("${slug}-list-create").click();`);
  lines.push(`    return new ${aggPascal}NewPage(this.page);`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  row(id: string): Locator {`);
  lines.push(`    return this.page.getByTestId(\`${slug}-row-\${id}\`);`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async rowCount(): Promise<number> {`);
  lines.push(`    return await this.page.getByTestId("${slug}-list").locator("tbody tr").count();`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async getRow(id: string): Promise<Locator> {`);
  lines.push(`    const row = this.row(id);`);
  lines.push(`    await expect(row).toBeVisible();`);
  lines.push(`    return row;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async open(id: string): Promise<${aggPascal}DetailPage> {`);
  lines.push(`    await this.page.getByTestId(\`${slug}-row-\${id}-link\`).click();`);
  lines.push(`    await this.page.waitForURL(new RegExp(\`/${slug}/\${id}$\`));`);
  lines.push(`    return new ${aggPascal}DetailPage(this.page, id);`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);

  // Companion New + Detail stubs (referenced above)
  lines.push(`export class ${aggPascal}NewPage {`);
  lines.push(`  static readonly url = ${JSON.stringify(`${route}/new`)};`);
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push(``);
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${aggPascal}NewPage.url);`);
  lines.push(`    await this.page.getByTestId("${slug}-new").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(``);
  const required = agg.fields.filter((f) => !f.optional);
  lines.push(`  async fill(input: Partial<Record<string, unknown>>): Promise<this> {`);
  for (const f of required) {
    const fillLines = fillBlock("input", f.name, f.type, _ctx, `${slug}-new-input-${f.name}`);
    for (const l of fillLines) lines.push(`    ${l}`);
  }
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async submit(): Promise<${aggPascal}DetailPage> {`);
  lines.push(`    await this.page.getByTestId("${slug}-new-submit").click();`);
  lines.push(`    await this.page.getByTestId("${slug}-detail").waitFor();`);
  lines.push(`    const id = this.page.url().split("/").pop()!;`);
  lines.push(`    return new ${aggPascal}DetailPage(this.page, id);`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);

  lines.push(`export class ${aggPascal}DetailPage {`);
  lines.push(`  constructor(public readonly page: Page, public readonly id: string) {}`);
  lines.push(``);
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(\`${route}/\${this.id}\`);`);
  lines.push(`    await this.page.getByTestId("${slug}-detail").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async field(name: string): Promise<string> {`);
  lines.push(`    return await this.page.getByTestId(\`${slug}-detail-\${name}\`).innerText();`);
  lines.push(`  }`);
  const ops = agg.operations.filter((o) => o.visibility === "public");
  for (const op of ops) {
    const opCamel = lowerFirst(op.name);
    if (op.params.length === 0) {
      lines.push(``);
      lines.push(`  async ${opCamel}(): Promise<this> {`);
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}").click();`);
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}-submit").click();`);
      lines.push(
        `    await this.page.getByTestId("${slug}-op-${op.name}-form").waitFor({ state: "detached" });`,
      );
      lines.push(`    return this;`);
      lines.push(`  }`);
    } else {
      lines.push(``);
      lines.push(`  async ${opCamel}(input: Record<string, unknown>): Promise<this> {`);
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}").click();`);
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}-form").waitFor();`);
      for (const p of op.params) {
        const fillLines = fillBlock(
          "input",
          p.name,
          p.type,
          _ctx,
          `${slug}-op-${op.name}-input-${p.name}`,
        );
        for (const l of fillLines) lines.push(`    ${l}`);
      }
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}-submit").click();`);
      lines.push(
        `    await this.page.getByTestId("${slug}-op-${op.name}-form").waitFor({ state: "detached" });`,
      );
      lines.push(`    return this;`);
      lines.push(`  }`);
    }
  }
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Aggregate-new page object (standalone — for pages synthesised separately)
// ---------------------------------------------------------------------------

function buildAggregateNewPageObject(
  page: PageIR,
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string {
  const slug = snake(plural(agg.name));
  const aggPascal = upperFirst(agg.name);
  const className = `${upperFirst(page.name)}Page`;
  const route = page.route ?? `/${slug}/new`;
  const required = agg.fields.filter((f) => !f.optional);

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page } from "@playwright/test";`);
  lines.push(``);
  lines.push(`export class ${className} {`);
  lines.push(`  static readonly url = ${JSON.stringify(route)};`);
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push(``);
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${className}.url);`);
  lines.push(`    await this.page.getByTestId("${slug}-new").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async fill(input: Partial<Record<string, unknown>>): Promise<this> {`);
  for (const f of required) {
    const fillLines = fillBlock("input", f.name, f.type, ctx, `${slug}-new-input-${f.name}`);
    for (const l of fillLines) lines.push(`    ${l}`);
  }
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async submit(): Promise<${aggPascal}DetailPage> {`);
  lines.push(`    await this.page.getByTestId("${slug}-new-submit").click();`);
  lines.push(`    await this.page.getByTestId("${slug}-detail").waitFor();`);
  lines.push(`    const id = this.page.url().split("/").pop()!;`);
  lines.push(`    return new ${aggPascal}DetailPage(this.page, id);`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  // Companion detail stub
  lines.push(`export class ${aggPascal}DetailPage {`);
  lines.push(`  constructor(public readonly page: Page, public readonly id: string) {}`);
  lines.push(``);
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(\`/${slug}/\${this.id}\`);`);
  lines.push(`    await this.page.getByTestId("${slug}-detail").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async field(name: string): Promise<string> {`);
  lines.push(`    return await this.page.getByTestId(\`${slug}-detail-\${name}\`).innerText();`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Aggregate-detail page object (standalone)
// ---------------------------------------------------------------------------

function buildAggregateDetailPageObject(
  page: PageIR,
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string {
  const slug = snake(plural(agg.name));
  const className = `${upperFirst(page.name)}Page`;
  const ops = agg.operations.filter((o) => o.visibility === "public");

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page } from "@playwright/test";`);
  lines.push(``);
  lines.push(`export class ${className} {`);
  lines.push(`  constructor(public readonly page: Page, public readonly id: string) {}`);
  lines.push(``);
  lines.push(`  static urlFor(id: string): string {`);
  lines.push(`    return \`/${slug}/\${id}\`;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${className}.urlFor(this.id));`);
  lines.push(`    await this.page.getByTestId("${slug}-detail").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async field(name: string): Promise<string> {`);
  lines.push(`    return await this.page.getByTestId(\`${slug}-detail-\${name}\`).innerText();`);
  lines.push(`  }`);
  for (const op of ops) {
    const opCamel = lowerFirst(op.name);
    if (op.params.length === 0) {
      lines.push(``);
      lines.push(`  async ${opCamel}(): Promise<this> {`);
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}").click();`);
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}-submit").click();`);
      lines.push(
        `    await this.page.getByTestId("${slug}-op-${op.name}-form").waitFor({ state: "detached" });`,
      );
      lines.push(`    return this;`);
      lines.push(`  }`);
    } else {
      lines.push(``);
      lines.push(`  async ${opCamel}(input: Record<string, unknown>): Promise<this> {`);
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}").click();`);
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}-form").waitFor();`);
      for (const p of op.params) {
        const fillLines = fillBlock(
          "input",
          p.name,
          p.type,
          ctx,
          `${slug}-op-${op.name}-input-${p.name}`,
        );
        for (const l of fillLines) lines.push(`    ${l}`);
      }
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}-submit").click();`);
      lines.push(
        `    await this.page.getByTestId("${slug}-op-${op.name}-form").waitFor({ state: "detached" });`,
      );
      lines.push(`    return this;`);
      lines.push(`  }`);
    }
  }
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Workflow-form page object
// ---------------------------------------------------------------------------

function buildWorkflowFormPageObject(
  page: PageIR,
  wf: import("../../ir/loom-ir.js").WorkflowIR,
  ctx: BoundedContextIR,
): string {
  const slug = snake(wf.name);
  const className = `${upperFirst(page.name)}Page`;
  const route = page.route ?? `/workflows/${slug}`;

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page } from "@playwright/test";`);
  lines.push(``);
  lines.push(`export class ${className} {`);
  lines.push(`  static readonly url = ${JSON.stringify(route)};`);
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push(``);
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${className}.url);`);
  lines.push(`    await this.page.getByTestId("workflow-${slug}").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async fill(input: Partial<Record<string, unknown>>): Promise<this> {`);
  for (const p of wf.params) {
    const fillLines = fillBlock("input", p.name, p.type, ctx, `workflow-${slug}-input-${p.name}`);
    for (const l of fillLines) lines.push(`    ${l}`);
  }
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async submit(): Promise<this> {`);
  lines.push(`    await this.page.getByTestId("workflow-${slug}-submit").click();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// View-list page object
// ---------------------------------------------------------------------------

function buildViewListPageObject(page: PageIR, view: import("../../ir/loom-ir.js").ViewIR): string {
  const slug = snake(view.name);
  const className = `${upperFirst(page.name)}Page`;
  const route = page.route ?? `/views/${slug}`;

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page, Locator } from "@playwright/test";`);
  lines.push(``);
  lines.push(`export class ${className} {`);
  lines.push(`  static readonly url = ${JSON.stringify(route)};`);
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push(``);
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${className}.url);`);
  lines.push(`    await this.page.getByTestId("view-${slug}").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  row(idx: number): Locator {`);
  lines.push(`    return this.page.getByTestId(\`view-${slug}-row-\${idx}\`);`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async rowCount(): Promise<number> {`);
  lines.push(`    return await this.page.getByTestId("view-${slug}").locator("tbody tr").count();`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Workflows-index page object
// ---------------------------------------------------------------------------

function buildWorkflowsIndexPageObject(page: PageIR): string {
  const className = `${upperFirst(page.name)}Page`;
  const route = page.route ?? "/workflows";

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page, Locator } from "@playwright/test";`);
  lines.push(``);
  lines.push(`export class ${className} {`);
  lines.push(`  static readonly url = ${JSON.stringify(route)};`);
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push(``);
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${className}.url);`);
  lines.push(`    await this.page.getByTestId("workflows-index").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  workflowCard(slug: string): Locator {`);
  lines.push(`    return this.page.getByTestId(\`workflow-card-\${slug}\`);`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async runWorkflow(slug: string): Promise<void> {`);
  lines.push(`    await this.page.getByTestId(\`workflow-\${slug}-run\`).click();`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Views-index page object
// ---------------------------------------------------------------------------

function buildViewsIndexPageObject(page: PageIR): string {
  const className = `${upperFirst(page.name)}Page`;
  const route = page.route ?? "/views";

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page, Locator } from "@playwright/test";`);
  lines.push(``);
  lines.push(`export class ${className} {`);
  lines.push(`  static readonly url = ${JSON.stringify(route)};`);
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push(``);
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${className}.url);`);
  lines.push(`    await this.page.getByTestId("views-index").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  viewCard(slug: string): Locator {`);
  lines.push(`    return this.page.getByTestId(\`view-card-\${slug}\`);`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async openView(slug: string): Promise<void> {`);
  lines.push(`    await this.page.getByTestId(\`view-\${slug}-open\`).click();`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Home page object
// ---------------------------------------------------------------------------

function buildHomePageObject(page: PageIR): string {
  const className = `${upperFirst(page.name)}Page`;
  const route = page.route ?? "/";

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page } from "@playwright/test";`);
  lines.push(``);
  lines.push(`export class ${className} {`);
  lines.push(`  static readonly url = ${JSON.stringify(route)};`);
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push(``);
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${className}.url);`);
  lines.push(`    await this.page.getByTestId("home").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async clickAggregatesLink(): Promise<void> {`);
  lines.push(`    await this.page.getByTestId("home-aggregates-link").click();`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async clickWorkflowsLink(): Promise<void> {`);
  lines.push(`    await this.page.getByTestId("home-workflows-link").click();`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  async clickViewsLink(): Promise<void> {`);
  lines.push(`    await this.page.getByTestId("home-views-link").click();`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Generic (walker-emitted / explicit) page — mirrors walker-page-objects.ts
// ---------------------------------------------------------------------------

function buildGenericPageObject(page: PageIR): string {
  const hasParams = page.params.length > 0;
  const className = `${upperFirst(page.name)}Page`;
  const route = page.route ?? "/";

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page } from "@playwright/test";`);
  lines.push(``);
  lines.push(`export class ${className} {`);

  if (hasParams) {
    const paramList = page.params.map((p) => `${p.name}: string`).join(", ");
    const urlExpr = routeAsTemplateLiteral(
      route,
      page.params.map((p) => p.name),
    );
    lines.push(`  static urlFor(${paramList}): string {`);
    lines.push(`    return ${urlExpr};`);
    lines.push(`  }`);
    lines.push(`  constructor(public readonly page: Page) {}`);
    lines.push(``);
    lines.push(`  async goto(${paramList}): Promise<this> {`);
    lines.push(
      `    await this.page.goto(${className}.urlFor(${page.params.map((p) => p.name).join(", ")}));`,
    );
    lines.push(`    return this;`);
    lines.push(`  }`);
  } else {
    lines.push(`  static readonly url = ${JSON.stringify(route)};`);
    lines.push(`  constructor(public readonly page: Page) {}`);
    lines.push(``);
    lines.push(`  async goto(): Promise<this> {`);
    lines.push(`    await this.page.goto(${className}.url);`);
    lines.push(`    return this;`);
    lines.push(`  }`);
  }

  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fallback — page whose IR lookup failed
// ---------------------------------------------------------------------------

function buildFallback(page: PageIR): string {
  const className = `${upperFirst(page.name)}Page`;
  const route = page.route ?? "/";

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`// NOTE: IR lookup failed for page '${page.name}'; this is a minimal stub.`);
  lines.push(`import type { Page } from "@playwright/test";`);
  lines.push(``);
  lines.push(`export class ${className} {`);
  lines.push(`  static readonly url = ${JSON.stringify(route)};`);
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push(``);
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${className}.url);`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Route → template-literal helper (mirrors walker-page-objects.ts)
// ---------------------------------------------------------------------------

function routeAsTemplateLiteral(route: string, paramNames: string[]): string {
  const paramSet = new Set(paramNames);
  const parts: string[] = [];
  const re = /:([A-Za-z_][A-Za-z0-9_]*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(route)) !== null) {
    if (m.index > last) parts.push(escapeTemplate(route.slice(last, m.index)));
    const name = m[1]!;
    parts.push(paramSet.has(name) ? "${" + name + "}" : `:${name}`);
    last = m.index + m[0].length;
  }
  if (last < route.length) parts.push(escapeTemplate(route.slice(last)));
  return "`" + parts.join("") + "`";
}

function escapeTemplate(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

// Keep import used.
void (plural as typeof plural);

// Suppress TypeIR import lint — used only in fillBlock call sites via the
// type parameter of the re-exported helper.
void ({} as TypeIR);
