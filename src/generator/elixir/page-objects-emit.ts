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

import { createInputFields } from "../../ir/enrich/wire-projection.js";
import type { AggregateIR, BoundedContextIR, PageIR, TypeIR } from "../../ir/types/loom-ir.js";
import { classifyPage, type PageNameCtx, pageEmitName } from "../../ir/util/page-kind.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import { unwrapOpt } from "../_frontend/form-helpers.js";
import { fillBlock } from "../_frontend/page-objects-builder.js";

export interface BuildPlaywrightPageObjectArgs {
  page: PageIR;
  appName: string;
  aggregatesByName: Map<string, AggregateIR>;
  contextByAggName: Map<string, BoundedContextIR>;
}

// ---------------------------------------------------------------------------
// Form-input parameter typing.
//
// The Phoenix backend ships no generated TS request types (unlike React, whose
// page objects import `Create<Agg>Request`), so the `fill`/operation methods
// type their `input` from an inline object type derived HERE — one that mirrors
// exactly the property accesses `fillBlock` emits per field type.  Without it
// the param was `Record<string, unknown>`, and `input.x!` (→ `NonNullable<
// unknown>` = `{}`) blew up against `.fill(string)` / `input.vo!.amount`.
//
// Mapping (must track fillBlock's branching):
//   valueobject → nested `{ field?: … }`   bool → boolean
//   int/long/decimal/money → string | number   id/enum/datetime/string → string
//   anything else (array/entity) → unknown (filled via `String(…)`, no access).
// All fields optional — fillBlock guards every access with `!== undefined`.
function e2eInputFieldType(t: TypeIR, ctx: BoundedContextIR): string {
  const inner = unwrapOpt(t);
  if (inner.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === inner.name);
    if (!vo) return "string";
    const fields = vo.fields.map((f) => `${f.name}?: ${e2eInputFieldType(f.type, ctx)}`).join("; ");
    return `{ ${fields} }`;
  }
  if (inner.kind === "primitive") {
    if (inner.name === "bool") return "boolean";
    if (
      inner.name === "int" ||
      inner.name === "long" ||
      inner.name === "decimal" ||
      inner.name === "money"
    ) {
      return "string | number";
    }
    return "string";
  }
  if (inner.kind === "id" || inner.kind === "enum") return "string";
  return "unknown";
}

/** The `input:` param type for a `fill`/operation method: an all-optional
 *  inline object over the named fields (`Record<string, never>` when empty). */
function e2eInputParamType(
  fields: readonly { name: string; type: TypeIR }[],
  ctx: BoundedContextIR,
): string {
  if (fields.length === 0) return "Record<string, never>";
  const body = fields.map((f) => `${f.name}: ${e2eInputFieldType(f.type, ctx)}`).join("; ");
  return `Partial<{ ${body} }>`;
}

/** Emit a Playwright page-object TypeScript module for one Phoenix LiveView
 *  page.  Caller writes the result to `e2e/pages/<page-snake>.ts`. */
export function buildPlaywrightPageObject(args: BuildPlaywrightPageObjectArgs): string {
  const { page, aggregatesByName, contextByAggName } = args;
  // The page's kind + emitted name are derived from its role-scoped name + area
  // (slice 3c — no stamped `origin`).
  const workflowNames: string[] = [];
  const viewNames: string[] = [];
  for (const bc of contextByAggName.values()) {
    for (const wf of bc.workflows) workflowNames.push(wf.name);
    for (const v of bc.views) viewNames.push(v.name);
  }
  const nameCtx: PageNameCtx = {
    aggregateNames: [...aggregatesByName.keys()],
    workflowNames,
    viewNames,
  };
  const origin = classifyPage(page, nameCtx);
  const emitName = pageEmitName(page, nameCtx);

  if (origin.kind === "custom") {
    // Explicit (walker-emitted, user-written) page — generic
    // param/route pattern.
    return buildGenericPageObject(page, emitName);
  }

  switch (origin.kind) {
    case "aggregate-list": {
      const agg = aggregatesByName.get(origin.aggregateName);
      const ctx = contextByAggName.get(origin.aggregateName);
      if (!agg || !ctx) return buildFallback(page, emitName);
      return buildAggregateListPageObject(page, agg, ctx, emitName);
    }
    case "aggregate-new": {
      const agg = aggregatesByName.get(origin.aggregateName);
      const ctx = contextByAggName.get(origin.aggregateName);
      if (!agg || !ctx) return buildFallback(page, emitName);
      return buildAggregateNewPageObject(page, agg, ctx, emitName);
    }
    case "aggregate-detail": {
      const agg = aggregatesByName.get(origin.aggregateName);
      const ctx = contextByAggName.get(origin.aggregateName);
      if (!agg || !ctx) return buildFallback(page, emitName);
      return buildAggregateDetailPageObject(page, agg, ctx, emitName);
    }
    case "workflow-form": {
      const ctx = [...contextByAggName.values()].find((c) =>
        c.workflows.some((w) => w.name === origin.workflowName),
      );
      const wf = ctx?.workflows.find((w) => w.name === origin.workflowName);
      if (!wf || !ctx) return buildFallback(page, emitName);
      return buildWorkflowFormPageObject(page, wf, ctx, emitName);
    }
    case "view-list": {
      const ctx = [...contextByAggName.values()].find((c) =>
        c.views.some((v) => v.name === origin.viewName),
      );
      const view = ctx?.views.find((v) => v.name === origin.viewName);
      if (!view || !ctx) return buildFallback(page, emitName);
      return buildViewListPageObject(page, view, emitName);
    }
    case "workflows-index":
      return buildWorkflowsIndexPageObject(page, emitName);
    case "views-index":
      return buildViewsIndexPageObject(page, emitName);
    case "home":
      return buildHomePageObject(page, emitName);
    // Workflow-instance read pages (workflow-instance-visibility.md) use the
    // generic param/route page object for v1 — a bespoke instance page object
    // is a later refinement.
    case "workflow-instances-list":
    case "workflow-instance-detail":
      return buildGenericPageObject(page, emitName);
  }
}

// ---------------------------------------------------------------------------
// Aggregate-list page object
// ---------------------------------------------------------------------------

function buildAggregateListPageObject(
  page: PageIR,
  agg: AggregateIR,
  _ctx: BoundedContextIR,
  emitName: string,
): string {
  const slug = snake(plural(agg.name));
  const aggPascal = upperFirst(agg.name);
  const className = `${upperFirst(emitName)}Page`;
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
  // Fill targets the non-optional create-input contract (`createInputFields`
  // — excludes server-owned `managed`/`token`/`internal` fields, incl. stamp
  // targets), matching the inputs the HEEx CreateForm renders.
  const required = createInputFields(agg).filter((f) => !f.optional);
  lines.push(`  async fill(input: ${e2eInputParamType(required, _ctx)}): Promise<this> {`);
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
      lines.push(
        `  async ${opCamel}(input: ${e2eInputParamType(op.params, _ctx)}): Promise<this> {`,
      );
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
  emitName: string,
): string {
  const slug = snake(plural(agg.name));
  const aggPascal = upperFirst(agg.name);
  const className = `${upperFirst(emitName)}Page`;
  const route = page.route ?? `/${slug}/new`;
  // Fill targets the non-optional create-input contract (`createInputFields`
  // — excludes server-owned `managed`/`token`/`internal` fields, incl. stamp
  // targets), matching the inputs the HEEx CreateForm renders.
  const required = createInputFields(agg).filter((f) => !f.optional);

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
  lines.push(`  async fill(input: ${e2eInputParamType(required, ctx)}): Promise<this> {`);
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
  emitName: string,
): string {
  const slug = snake(plural(agg.name));
  const className = `${upperFirst(emitName)}Page`;
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
      lines.push(
        `  async ${opCamel}(input: ${e2eInputParamType(op.params, ctx)}): Promise<this> {`,
      );
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
  wf: import("../../ir/types/loom-ir.js").WorkflowIR,
  ctx: BoundedContextIR,
  emitName: string,
): string {
  const slug = snake(wf.name);
  const className = `${upperFirst(emitName)}Page`;
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
  lines.push(`  async fill(input: ${e2eInputParamType(wf.params, ctx)}): Promise<this> {`);
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

function buildViewListPageObject(
  page: PageIR,
  view: import("../../ir/types/loom-ir.js").ViewIR,
  emitName: string,
): string {
  const slug = snake(view.name);
  const className = `${upperFirst(emitName)}Page`;
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

function buildWorkflowsIndexPageObject(page: PageIR, emitName: string): string {
  const className = `${upperFirst(emitName)}Page`;
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

function buildViewsIndexPageObject(page: PageIR, emitName: string): string {
  const className = `${upperFirst(emitName)}Page`;
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

function buildHomePageObject(page: PageIR, emitName: string): string {
  const className = `${upperFirst(emitName)}Page`;
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

function buildGenericPageObject(page: PageIR, emitName: string): string {
  const hasParams = page.params.length > 0;
  const className = `${upperFirst(emitName)}Page`;
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

function buildFallback(page: PageIR, emitName: string): string {
  const className = `${upperFirst(emitName)}Page`;
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
  let last = 0;
  for (const m of route.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
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
