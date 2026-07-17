import { createInputFields, emitsRestCreate } from "../../ir/enrich/wire-projection.js";
import type { AggregateIR, BoundedContextIR, TypeIR } from "../../ir/types/loom-ir.js";
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

export function buildPageObjectModule(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  /** Project-relative root of the generated api modules, as seen
   *  from `e2e/pages/` — react projects keep them at `src/api`,
   *  SvelteKit projects at `src/lib/api`. */
  apiImportRoot = "../../src/api",
  selectStyle: SelectStyle = "combobox",
): string {
  const slug = snake(plural(agg.name));
  const aggCap = upperFirst(agg.name);
  // The New page (and its list "New" button + create() navigation) exists
  // only when the aggregate exposes a REST create surface — the SAME
  // `emitsRestCreate` gate the scaffold uses to drop the `<Agg>New` page and
  // the `Create<Agg>Request` schema.  Without it, emit no NewPage page object
  // and no ListPage.create() (which would dangle on the dropped types/route).
  const restCreate = emitsRestCreate(agg);
  const ops = agg.operations.filter((o) => o.visibility === "public");
  // The New-page fill targets the inputs the CreateForm actually renders:
  // the non-optional create-input contract (`createInputFields` — excludes
  // server-owned `managed`/`token`/`internal` fields, incl. stamp targets).
  const required = createInputFields(agg).filter((f) => !f.optional);

  // Collect the candidate api/* type imports, then narrow them once the
  // body is assembled — page-object classes rarely use every Request/Response,
  // and dead `import type {}` lines fail the generated-code Biome gate.
  const candidateApiTypes: string[] = [];
  if (restCreate) candidateApiTypes.push(`Create${agg.name}Request`);
  for (const op of ops) candidateApiTypes.push(`${upperFirst(op.name)}${agg.name}Request`);
  candidateApiTypes.push(`${agg.name}Response`);

  const lines: string[] = [];

  // ---------------------------------------------------------------------
  // List page
  // ---------------------------------------------------------------------
  lines.push(`export class ${aggCap}ListPage {`);
  lines.push(`  static readonly url = "/${slug}";`);
  // Explicit field declaration + constructor assignment, not a
  // parameter property — see emit/value-objects.ts's renderValueObject.
  lines.push(`  readonly page: Page;`);
  lines.push(`  constructor(page: Page) {`);
  lines.push(`    this.page = page;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${aggCap}ListPage.url);`);
  lines.push(`    await this.page.getByTestId("${slug}-list").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push("");
  if (restCreate) {
    lines.push(`  async create(): Promise<${aggCap}NewPage> {`);
    lines.push(`    await this.page.getByTestId("${slug}-list-create").click();`);
    lines.push(`    return new ${aggCap}NewPage(this.page);`);
    lines.push(`  }`);
    lines.push("");
  }
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
  // New page — only when the aggregate exposes a REST create surface.
  // ---------------------------------------------------------------------
  if (restCreate) {
    lines.push(`export class ${aggCap}NewPage {`);
    lines.push(`  static readonly url = "/${slug}/new";`);
    // Explicit field declaration + constructor assignment, not a
    // parameter property — see emit/value-objects.ts's renderValueObject.
    lines.push(`  readonly page: Page;`);
    lines.push(`  constructor(page: Page) {`);
    lines.push(`    this.page = page;`);
    lines.push(`  }`);
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
        ...fillBlock(`input`, f.name, f.type, ctx, `${slug}-new-input-${f.name}`, selectStyle).map(
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
  }

  // ---------------------------------------------------------------------
  // Detail page
  // ---------------------------------------------------------------------
  lines.push(`export class ${aggCap}DetailPage {`);
  // Explicit field declarations + constructor assignments, not
  // parameter properties — see emit/value-objects.ts's renderValueObject.
  lines.push(`  readonly page: Page;`);
  lines.push(`  readonly id: string;`);
  lines.push(`  constructor(page: Page, id: string) {`);
  lines.push(`    this.page = page;`);
  lines.push(`    this.id = id;`);
  lines.push(`  }`);
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
      lines.push(
        `  async ${lowerFirst(op.name)}(input: ${opCap}${agg.name}Request): Promise<this> {`,
      );
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}").click();`);
      lines.push(`    await this.page.getByTestId("${slug}-op-${op.name}-form").waitFor();`);
      for (const p of op.params) {
        lines.push(
          ...fillBlock(
            "input",
            p.name,
            p.type,
            ctx,
            `${slug}-op-${op.name}-input-${p.name}`,
            selectStyle,
          ).map((l) => `    ${l}`),
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

  const body = lines.join("\n");
  const usedApiTypes = candidateApiTypes.filter((t) => new RegExp(`\\b${t}\\b`).test(body));
  const header: string[] = [
    "// Auto-generated.  Do not edit by hand.",
    `import type { Page, Locator } from "@playwright/test";`,
    `import { expect } from "@playwright/test";`,
  ];
  if (usedApiTypes.length > 0) {
    header.push(
      `import type { ${usedApiTypes.join(", ")} } from "${apiImportRoot}/${lowerFirst(agg.name)}";`,
    );
  }
  header.push("");
  return [...header, body].join("\n");
}

// ---------------------------------------------------------------------------
// fillBlock — emit the lines that fill one input from `input.<path>`,
// branching on type so dates, numbers, selects, switches each take the
// right Playwright action.  Exported so the workflow + view page
// objects drive their own forms with the same per-type interaction
// conventions instead of forking the logic.
// ---------------------------------------------------------------------------

/** How the generated form renders `enum` / `X id` choice fields.
 *  React packs render portal-combobox components (Mantine `<Select>`
 *  et al.) driven by click-to-open-then-click-option; svelte packs
 *  render native `<select>` elements, which Playwright drives via
 *  `selectOption()` — clicking a closed native select's options would
 *  time out. */
export type SelectStyle = "combobox" | "native";

/** A framework-robust text fill.  A design pack may put the field's `data-testid`
 *  on the actual `<input>` (Mantine) or on a wrapper that CONTAINS it (Vuetify's
 *  `v-text-field` forwards attrs to its root `<div>`, so `getByTestId(id).fill()`
 *  hits the div and Playwright errors "Element is not an <input>").  Prefer a
 *  fillable descendant when present, else the testid element itself — so the
 *  SHARED page objects drive any pack.  Caught by the nightly frontend-fullstack
 *  matrix (a Vue round-trip), invisible to the React-only per-PR UI cell. */
function robustFill(testId: string, valueExpr: string): string[] {
  return [
    `  {`,
    `    const __f = this.page.getByTestId("${testId}");`,
    `    const __i = __f.locator("input, textarea");`,
    `    await ((await __i.count()) ? __i.first() : __f).fill(${valueExpr});`,
    `  }`,
  ];
}

export function fillBlock(
  inputVar: string,
  path: string,
  t: TypeIR,
  ctx: BoundedContextIR,
  testId: string,
  selectStyle: SelectStyle = "combobox",
): string[] {
  const inner = unwrapOpt(t);
  const lines: string[] = [];
  const accessor = `${inputVar}.${path}`;

  if (inner.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === inner.name);
    if (vo) {
      lines.push(`if (${accessor} !== undefined) {`);
      for (const vf of vo.fields) {
        const sub = fillBlock(
          `${accessor}!`,
          vf.name,
          vf.type,
          ctx,
          `${testId}-${vf.name}`,
          selectStyle,
        );
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
      // The form renders a plain `<input type="datetime-local">` with no
      // `step`, so the control is minute-precision: the browser rejects a
      // value carrying seconds (`YYYY-MM-DDTHH:mm:ss`) as "Malformed
      // value".  Tests pass an ISO string (often with `Z`); slice to 16
      // chars (`YYYY-MM-DDTHH:mm`) — dropping seconds and the timezone
      // marker — so the fill matches the input's accepted format.  The
      // backend treats the unmarked value as UTC and accepts
      // minute-precision datetimes, so the round-trip stays correct as
      // long as the test source uses `Z` consistently.
      lines.push(...robustFill(testId, `${accessor}!.slice(0, 16)`));
    } else if (inner.name === "int" || inner.name === "long" || inner.name === "decimal") {
      lines.push(...robustFill(testId, `String(${accessor})`));
    } else if (inner.name === "money") {
      // Money form fields render as text inputs; the test passes a
      // Decimal instance (or string) and we fill its .toString()
      // value so the precise wire-shape is what hits the form.
      lines.push(...robustFill(testId, `String(${accessor})`));
    } else {
      lines.push(...robustFill(testId, `${accessor}!`));
    }
  } else if (inner.kind === "id") {
    if (selectStyle === "native") {
      // Native `<select>` populated by `useAll<X>()` — option values
      // carry the id.  `selectOption` auto-waits for the matching
      // option to mount, covering the async options load.
      lines.push(`  await this.page.getByTestId("${testId}").selectOption(${accessor}!);`);
      lines.push(`}`);
      return lines;
    }
    // `X id` renders as a Mantine `<Select>` populated by
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
    if (selectStyle === "native") {
      // Native `<select>` — option values are the enum values.
      lines.push(`  await this.page.getByTestId("${testId}").selectOption(${accessor}!);`);
      lines.push(`}`);
      return lines;
    }
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
