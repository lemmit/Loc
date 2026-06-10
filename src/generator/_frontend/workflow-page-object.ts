// Per-workflow Playwright page object — framework-neutral (testids +
// routes only); shared by the React and Svelte frontends.  Extracted
// from src/generator/react/workflow-builder.ts.

import type { BoundedContextIR, WorkflowIR } from "../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";
import { fillBlock } from "./page-objects-builder.js";

export function buildWorkflowPageObject(
  wf: WorkflowIR,
  ctx: BoundedContextIR,
  /** Root of the generated api modules as seen from
   *  `e2e/pages/workflows/` — `src/api` on react, `src/lib/api` on
   *  SvelteKit. */
  apiImportRoot = "../../../src/api",
): string {
  const slug = snake(wf.name);
  const className = `${upperFirst(wf.name)}WorkflowPage`;
  const requestType = `${upperFirst(wf.name)}Request`;
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page } from "@playwright/test";`);
  lines.push(`import type { ${requestType} } from "${apiImportRoot}/workflows";`);
  lines.push("");
  lines.push(`export class ${className} {`);
  lines.push(`  static readonly url = "/workflows/${slug}";`);
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push("");
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${className}.url);`);
  lines.push(`    await this.page.getByTestId("workflow-${slug}").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async fill(input: Partial<${requestType}>): Promise<this> {`);
  for (const p of wf.params) {
    const fillLines = fillBlock("input", p.name, p.type, ctx, `workflow-${slug}-input-${p.name}`);
    for (const l of fillLines) lines.push(`    ${l}`);
  }
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async submit(): Promise<void> {`);
  lines.push(`    await this.page.getByTestId("workflow-${slug}-submit").click();`);
  lines.push(`    await this.page.waitForURL(/\\/workflows$/);`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async run(input: ${requestType}): Promise<void> {`);
  lines.push(`    await this.goto();`);
  lines.push(`    await this.fill(input);`);
  lines.push(`    await this.submit();`);
  lines.push(`  }`);
  lines.push(`}`);
  return lines.join("\n") + "\n";
}
