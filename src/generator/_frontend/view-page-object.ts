// Per-view Playwright page object — framework-neutral (testids +
// routes only); shared by the React and Svelte frontends.  Extracted
// from src/generator/react/view-builder.ts.

import type { BoundedContextIR, TypeIR, ViewIR } from "../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";

export function buildViewPageObject(view: ViewIR, ctx: BoundedContextIR): string {
  const slug = snake(view.name);
  const className = `${upperFirst(view.name)}ViewPage`;
  const cols = collectColumnNames(view, ctx);
  const rowFields = cols.map((c) => `  ${c}: string;`).join("\n");
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page } from "@playwright/test";`);
  lines.push("");
  lines.push(`export interface ${upperFirst(view.name)}RowText {`);
  lines.push(rowFields);
  lines.push(`}`);
  lines.push("");
  lines.push(`export class ${className} {`);
  lines.push(`  static readonly url = "/views/${slug}";`);
  // Explicit field declaration + constructor assignment, not a
  // parameter property — see emit/value-objects.ts's renderValueObject.
  lines.push(`  readonly page: Page;`);
  lines.push(`  constructor(page: Page) {`);
  lines.push(`    this.page = page;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${className}.url);`);
  lines.push(`    await this.page.getByTestId("view-${slug}").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push("");
  // Read the rendered rows STRUCTURALLY — the view table renders semantic
  // `<tbody><tr><td>` across every design pack, and the cells are emitted in
  // the same column order `collectColumnNames` derives (both follow the view's
  // projected field list).  Per-row/cell testids would otherwise have to be
  // threaded through every pack's table template; reading the table body keeps
  // this pack-agnostic (and matches the Phoenix page object).
  lines.push(`  async rows(): Promise<${upperFirst(view.name)}RowText[]> {`);
  lines.push(`    const body = this.page.getByTestId("view-${slug}").locator("tbody tr");`);
  lines.push(`    const n = await body.count();`);
  lines.push(`    const out: ${upperFirst(view.name)}RowText[] = [];`);
  lines.push(`    for (let i = 0; i < n; i++) {`);
  lines.push(`      const cells = body.nth(i).locator("td");`);
  cols.forEach((_c, j) => {
    lines.push(`      const c_${j} = (await cells.nth(${j}).innerText()).trim();`);
  });
  const rowLiteral = cols.map((c, j) => `${c}: c_${j}`).join(", ");
  lines.push(`      out.push({ ${rowLiteral} });`);
  lines.push(`    }`);
  lines.push(`    return out;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async count(): Promise<number> {`);
  lines.push(`    return this.page.getByTestId("view-${slug}").locator("tbody tr").count();`);
  lines.push(`  }`);
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

/** The view's rendered column order — must match the table built by
 *  `scaffoldViewList` (rows() indexes `<td>`s by position): the view's
 *  projected fields, dropping value-object and array fields (which the table
 *  doesn't render as plain cells).  No synthetic `id` column. */
function collectColumnNames(view: ViewIR, ctx: BoundedContextIR): string[] {
  let fields: Array<{ name: string; type: TypeIR }> = [];
  if (view.output) {
    fields = view.output.fields;
  } else if (view.source.kind === "workflow") {
    const wf = ctx.workflows.find((w) => w.name === view.source.name);
    fields = wf?.instanceWireShape?.map((f) => ({ name: f.name, type: f.type })) ?? [];
  } else if (view.source.kind === "projection") {
    const proj = ctx.projections.find((p) => p.name === view.source.name);
    fields = proj?.wireShape?.map((f) => ({ name: f.name, type: f.type })) ?? [];
  } else {
    const agg = ctx.aggregates.find((a) => a.name === view.source.name);
    fields = agg?.fields ?? [];
  }
  return fields
    .filter((f) => {
      const inner = unwrapOpt(f.type);
      return inner.kind !== "valueobject" && inner.kind !== "array";
    })
    .map((f) => f.name);
}

function unwrapOpt(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}
