import type { AggregateIR, BoundedContextIR, TypeIR } from "../../ir/loom-ir.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import { unwrapOpt } from "./form-helpers.js";

// ---------------------------------------------------------------------------
// Page-object builder — emits Playwright page-object classes per
// aggregate keyed off the data-testids sprinkled by pages-emitter.ts.
//
// Output shape (per aggregate):
//
//   class <Agg>ListPage    — visit /<plural>, click create, open detail by id
//   class <Agg>NewPage     — fill form (typed), submit
//   class <Agg>DetailPage  — read each field, run each public operation
//
// The classes use the same Zod-derived types as the api/<agg>.ts hooks,
// so the test layer is end-to-end type-safe — `await detail.field("status")`
// returns `OrderResponse["status"]`.
// ---------------------------------------------------------------------------

export function buildPageObjectModule(agg: AggregateIR, ctx: BoundedContextIR): string {
  const slug = snake(plural(agg.name));
  const aggCap = upperFirst(agg.name);
  const ops = agg.operations.filter((o) => o.visibility === "public");
  const required = agg.fields.filter((f) => !f.optional);

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page, Locator } from "@playwright/test";`);
  lines.push(`import { expect } from "@playwright/test";`);
  const reqTypes: string[] = [`Create${agg.name}Request`];
  for (const op of ops) reqTypes.push(`${upperFirst(op.name)}Request`);
  reqTypes.push(`${agg.name}Response`);
  lines.push(
    `import type { ${reqTypes.join(", ")} } from "../../src/api/${lowerFirst(agg.name)}";`,
  );
  lines.push("");

  // ---------------------------------------------------------------------
  // List page
  // ---------------------------------------------------------------------
  lines.push(`export class ${aggCap}ListPage {`);
  lines.push(`  static readonly url = "/${slug}";`);
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push("");
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${aggCap}ListPage.url);`);
  lines.push(`    await this.page.getByTestId("${slug}-list").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async create(): Promise<${aggCap}NewPage> {`);
  lines.push(`    await this.page.getByTestId("${slug}-list-create").click();`);
  lines.push(`    return new ${aggCap}NewPage(this.page);`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  row(id: string): Locator {`);
  lines.push(`    return this.page.getByTestId(\`${slug}-row-\${id}\`);`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async open(id: string): Promise<${aggCap}DetailPage> {`);
  lines.push(`    await this.page.getByTestId(\`${slug}-row-\${id}-link\`).click();`);
  lines.push(`    await this.page.waitForURL(new RegExp(\`/${slug}/\${id}$\`));`);
  lines.push(`    return new ${aggCap}DetailPage(this.page, id);`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async expectRow(id: string): Promise<void> {`);
  lines.push(`    await expect(this.row(id)).toBeVisible();`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push("");

  // ---------------------------------------------------------------------
  // New page
  // ---------------------------------------------------------------------
  lines.push(`export class ${aggCap}NewPage {`);
  lines.push(`  static readonly url = "/${slug}/new";`);
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push("");
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${aggCap}NewPage.url);`);
  lines.push(`    await this.page.getByTestId("${slug}-new").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async fill(input: Partial<Create${agg.name}Request>): Promise<this> {`);
  for (const f of required) {
    lines.push(
      ...fillBlock(`input`, f.name, f.type, ctx, `${slug}-new-input-${f.name}`).map(
        (l) => `    ${l}`,
      ),
    );
  }
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async submit(): Promise<${aggCap}DetailPage> {`);
  lines.push(`    await this.page.getByTestId("${slug}-new-submit").click();`);
  lines.push(`    // Wait for the detail page to render rather than matching`);
  lines.push(`    // the URL — \`/${slug}/new\` itself matches a naive regex.`);
  lines.push(`    await this.page.getByTestId("${slug}-detail").waitFor();`);
  lines.push(`    const id = this.page.url().split("/").pop()!;`);
  lines.push(`    return new ${aggCap}DetailPage(this.page, id);`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push("");

  // ---------------------------------------------------------------------
  // Detail page
  // ---------------------------------------------------------------------
  lines.push(`export class ${aggCap}DetailPage {`);
  lines.push(`  constructor(public readonly page: Page, public readonly id: string) {}`);
  lines.push("");
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(\`/${slug}/\${this.id}\`);`);
  lines.push(`    await this.page.getByTestId("${slug}-detail").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push("");
  // Per-field reader — returns the value element as a Locator so callers
  // assert with web-first matchers (`expect(field(...)).toHaveText(...)`),
  // which retry against the live DOM.
  lines.push(`  /** Locator for a primitive / enum field's value cell. */`);
  lines.push(`  field<K extends keyof ${agg.name}Response>(name: K): Locator {`);
  lines.push(`    return this.page.getByTestId(\`${slug}-detail-\${String(name)}\`);`);
  lines.push(`  }`);
  lines.push("");
  // Per-contained-collection locators.
  for (const c of agg.contains) {
    if (!c.collection) continue;
    const part = agg.parts.find((p) => p.name === c.partName);
    if (!part) continue;
    lines.push(`  /** Locator for the row of the contained \`${c.name}\` collection. */`);
    lines.push(`  ${c.name}Row(id: string): Locator {`);
    lines.push(`    return this.page.getByTestId(\`${slug}-detail-${c.name}-row-\${id}\`);`);
    lines.push(`  }`);
    lines.push("");
    lines.push(
      `  /** Locator for the rows of the contained \`${c.name}\` table — assert with toHaveCount. */`,
    );
    lines.push(`  ${c.name}Rows(): Locator {`);
    lines.push(`    return this.page.getByTestId("${slug}-detail-${c.name}").locator("tbody tr");`);
    lines.push(`  }`);
    lines.push("");
  }
  // Per-operation method.
  for (const op of ops) {
    const opCap = upperFirst(op.name);
    if (op.params.length === 0) {
      lines.push(`  /** ${op.name} (no parameters). */`);
      lines.push(`  async ${lowerFirst(op.name)}(): Promise<this> {`);
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}").click();`);
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}-submit").click();`);
      lines.push(
        `    await this.page.getByTestId("${slug}-op-${op.name}-form").waitFor({ state: "detached" });`,
      );
      lines.push(`    await this.page.waitForLoadState("networkidle");`);
      lines.push(`    return this;`);
      lines.push(`  }`);
      lines.push("");
    } else {
      lines.push(`  /** ${op.name} — opens the modal, fills the form, submits. */`);
      lines.push(`  async ${lowerFirst(op.name)}(input: ${opCap}Request): Promise<this> {`);
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}").click();`);
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}-form").waitFor();`);
      for (const p of op.params) {
        lines.push(
          ...fillBlock("input", p.name, p.type, ctx, `${slug}-op-${op.name}-input-${p.name}`).map(
            (l) => `    ${l}`,
          ),
        );
      }
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}-submit").click();`);
      lines.push(
        `    await this.page.getByTestId("${slug}-op-${op.name}-form").waitFor({ state: "detached" });`,
      );
      lines.push(`    await this.page.waitForLoadState("networkidle");`);
      lines.push(`    return this;`);
      lines.push(`  }`);
      lines.push("");
    }
  }
  lines.push(`}`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// fillBlock — emit the lines that fill one input from `input.<path>`,
// branching on type so dates, numbers, selects, switches each take the
// right Playwright action.  Exported so the workflow + view page
// objects drive their own forms with the same per-type interaction
// conventions instead of forking the logic.
// ---------------------------------------------------------------------------

export function fillBlock(
  inputVar: string,
  path: string,
  t: TypeIR,
  ctx: BoundedContextIR,
  testId: string,
): string[] {
  const inner = unwrapOpt(t);
  const lines: string[] = [];
  const accessor = `${inputVar}.${path}`;

  if (inner.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === inner.name);
    if (vo) {
      lines.push(`if (${accessor} !== undefined) {`);
      for (const vf of vo.fields) {
        const sub = fillBlock(`${accessor}!`, vf.name, vf.type, ctx, `${testId}-${vf.name}`);
        for (const l of sub) lines.push(`  ${l}`);
      }
      lines.push(`}`);
      return lines;
    }
  }

  lines.push(`if (${accessor} !== undefined) {`);
  if (inner.kind === "primitive") {
    if (inner.name === "bool") {
      lines.push(`  const __cur = await this.page.getByTestId("${testId}").isChecked();`);
      lines.push(`  if (__cur !== ${accessor}) {`);
      lines.push(`    await this.page.getByTestId("${testId}").click();`);
      lines.push(`  }`);
    } else if (inner.name === "datetime") {
      // Native `<input type="datetime-local">` accepts
      // `YYYY-MM-DDTHH:mm:ss` (with optional sub-second precision).
      // Tests pass an ISO string with `Z`; we slice to 19 chars to
      // strip the timezone marker — the backend treats unmarked
      // datetime values as UTC, so the round-trip is correct as long
      // as the test source uses `Z` consistently.
      lines.push(`  await this.page.getByTestId("${testId}").fill(${accessor}!.slice(0, 19));`);
    } else if (inner.name === "int" || inner.name === "long" || inner.name === "decimal") {
      lines.push(`  await this.page.getByTestId("${testId}").fill(String(${accessor}));`);
    } else {
      lines.push(`  await this.page.getByTestId("${testId}").fill(${accessor}!);`);
    }
  } else if (inner.kind === "id") {
    // `Id<X>` renders as a Mantine `<Select>` populated by
    // `useAll<X>()`.  Each option carries a `data-testid` of the form
    // `<input-tid>-option-<id>`, set by the form's `renderOption`.
    // Click the input to open the listbox, wait for the options to
    // mount, then click the option whose testid matches the id we
    // were given.
    lines.push(`  {`);
    lines.push(`    await this.page.getByTestId("${testId}").click();`);
    lines.push(`    const __opt = this.page.getByTestId(\`${testId}-option-\${${accessor}!}\`);`);
    lines.push(`    await __opt.waitFor({ state: "visible" });`);
    lines.push(`    await __opt.click();`);
    lines.push(`  }`);
  } else if (inner.kind === "enum") {
    // Mantine <Select> opens a portal-mounted listbox on click.  Open
    // it, wait for the listbox role to attach, then click the option
    // by its accessible name (exact match, so "Draft" doesn't match
    // "DraftReview" if values ever share prefixes).
    lines.push(`  {`);
    lines.push(`    const __sel = this.page.getByTestId("${testId}");`);
    lines.push(`    await __sel.click();`);
    lines.push(
      `    const __listbox = this.page.locator('[role="listbox"]').filter({ has: this.page.getByRole("option", { name: ${accessor}!, exact: true }) });`,
    );
    lines.push(`    await __listbox.waitFor({ state: "visible" });`);
    lines.push(
      `    await __listbox.getByRole("option", { name: ${accessor}!, exact: true }).click();`,
    );
    lines.push(`  }`);
  } else {
    lines.push(`  await this.page.getByTestId("${testId}").fill(String(${accessor}));`);
  }
  lines.push(`}`);
  return lines;
}
