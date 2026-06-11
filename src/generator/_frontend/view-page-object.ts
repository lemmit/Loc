// Per-view Playwright page object — framework-neutral (testids +
// routes only); shared by the React and Svelte frontends.  Extracted
// from src/generator/react/view-builder.ts.

import type { BoundedContextIR, TypeIR, ViewIR } from "../../ir/types/loom-ir.js";
import { lowerFirst, snake, upperFirst } from "../../util/naming.js";

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
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push("");
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${className}.url);`);
  lines.push(`    await this.page.getByTestId("view-${slug}").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async rows(): Promise<${upperFirst(view.name)}RowText[]> {`);
  lines.push(`    const out: ${upperFirst(view.name)}RowText[] = [];`);
  lines.push(`    for (let i = 0; i < 1000; i++) {`);
  lines.push(`      const row = this.page.getByTestId(\`view-${slug}-row-\${i}\`);`);
  lines.push(`      if ((await row.count()) === 0) break;`);
  for (const c of cols) {
    lines.push(
      `      const ${lowerFirst("c_" + c)} = await this.page.getByTestId(\`view-${slug}-row-\${i}-${c}\`).innerText();`,
    );
  }
  const rowLiteral = cols.map((c) => `${c}: ${lowerFirst("c_" + c)}`).join(", ");
  lines.push(`      out.push({ ${rowLiteral} });`);
  lines.push(`    }`);
  lines.push(`    return out;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async count(): Promise<number> {`);
  lines.push(`    return (await this.rows()).length;`);
  lines.push(`  }`);
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

function collectColumnNames(view: ViewIR, ctx: BoundedContextIR): string[] {
  if (view.output) return view.output.fields.map((f) => f.name);
  if (view.source.kind === "workflow") {
    const wf = ctx.workflows.find((w) => w.name === view.source.name);
    return wf?.instanceWireShape?.map((f) => f.name) ?? ["id"];
  }
  const agg = ctx.aggregates.find((a) => a.name === view.source.name);
  if (!agg) return ["id"];
  const cols = ["id"];
  for (const f of agg.fields) {
    const inner = unwrapOpt(f.type);
    if (inner.kind === "primitive" || inner.kind === "enum" || inner.kind === "id") {
      cols.push(f.name);
    }
  }
  return cols;
}

function unwrapOpt(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}
