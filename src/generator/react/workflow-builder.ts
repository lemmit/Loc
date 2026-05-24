import type { BoundedContextIR, TypeIR, WorkflowIR } from "../../ir/loom-ir.js";
import { lowerFirst, snake, upperFirst } from "../../util/naming.js";
import { fillBlock } from "./page-objects-builder.js";

// ---------------------------------------------------------------------------
// Workflow API module + Playwright page object emission.
//
// The page-side emission (workflows index, per-workflow form) lives in
// src/generator/react/templating/preparers/workflow-{index,form}.ts.
// What remains here is two emission paths that aren't pack-shaped:
//
//   buildWorkflowsApiModule  — Zod schemas + react-query mutation
//                              hooks for every workflow
//   buildWorkflowPageObject  — Playwright page object per workflow
//
// Plus the `allWorkflows` / `hasAnyWorkflow` iterators that the
// orchestrator and the templating preparers share.
// ---------------------------------------------------------------------------

/** Whether any workflow exists across the deployable's contexts. */
export function hasAnyWorkflow(contexts: BoundedContextIR[]): boolean {
  return contexts.some((c) => c.workflows.length > 0);
}

/** Gather every workflow with its owning context, sorted by name for
 *  stable emission. */
export function allWorkflows(
  contexts: BoundedContextIR[],
): Array<{ wf: WorkflowIR; ctx: BoundedContextIR }> {
  const out: Array<{ wf: WorkflowIR; ctx: BoundedContextIR }> = [];
  for (const ctx of contexts) {
    for (const wf of ctx.workflows) out.push({ wf, ctx });
  }
  out.sort((a, b) => a.wf.name.localeCompare(b.wf.name));
  return out;
}

// ---------------------------------------------------------------------------
// API module — Zod schemas + mutation hooks for every workflow in the
// deployable.  One file at `src/api/workflows.ts` aggregating them all.
// ---------------------------------------------------------------------------

export function buildWorkflowsApiModule(contexts: BoundedContextIR[]): string {
  const workflows = allWorkflows(contexts);
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { z } from "zod";`);
  lines.push(`import { useMutation } from "@tanstack/react-query";`);
  lines.push(`import { api } from "./client";`);
  const enumDeps = collectEnumDeps(workflows);
  const voDeps = collectValueObjectDeps(workflows);
  for (const dep of [...enumDeps, ...voDeps]) {
    lines.push(`import { ${dep.schemaName} } from "./${lowerFirst(dep.fromAggregate)}";`);
  }
  lines.push("");

  for (const { wf } of workflows) {
    lines.push(`export const ${upperFirst(wf.name)}Request = z.object({`);
    for (const p of wf.params) {
      lines.push(`  ${p.name}: ${zodForRequest(p.type)},`);
    }
    lines.push(`});`);
    lines.push(
      `export type ${upperFirst(wf.name)}Request = z.infer<typeof ${upperFirst(wf.name)}Request>;`,
    );
    lines.push("");
    lines.push(`export function use${upperFirst(wf.name)}Workflow() {`);
    lines.push(`  return useMutation({`);
    lines.push(`    mutationFn: async (input: ${upperFirst(wf.name)}Request) => {`);
    lines.push(`      await api.post(\`/workflows/${snake(wf.name)}\`, input);`);
    lines.push(`    },`);
    lines.push(`  });`);
    lines.push(`}`);
    lines.push("");
  }

  return lines.join("\n");
}

interface SchemaDep {
  fromAggregate: string;
  schemaName: string;
}

function collectEnumDeps(workflows: Array<{ wf: WorkflowIR; ctx: BoundedContextIR }>): SchemaDep[] {
  const out = new Map<string, SchemaDep>();
  for (const { wf, ctx } of workflows) {
    for (const p of wf.params) {
      walkType(p.type, (t) => {
        if (t.kind === "enum") {
          const owner = findFirstAggregateUsingEnum(ctx, t.name);
          if (owner && !out.has(t.name)) {
            out.set(t.name, {
              fromAggregate: owner,
              schemaName: `${t.name}Schema`,
            });
          }
        }
      });
    }
  }
  return [...out.values()];
}

function collectValueObjectDeps(
  workflows: Array<{ wf: WorkflowIR; ctx: BoundedContextIR }>,
): SchemaDep[] {
  const out = new Map<string, SchemaDep>();
  for (const { wf, ctx } of workflows) {
    for (const p of wf.params) {
      walkType(p.type, (t) => {
        if (t.kind === "valueobject") {
          const owner = findFirstAggregateUsingValueObject(ctx, t.name);
          if (owner && !out.has(t.name)) {
            out.set(t.name, {
              fromAggregate: owner,
              schemaName: `${t.name}Schema`,
            });
          }
        }
      });
    }
  }
  return [...out.values()];
}

function findFirstAggregateUsingEnum(ctx: BoundedContextIR, enumName: string): string | undefined {
  for (const a of ctx.aggregates) {
    let used = false;
    const visit = (t: TypeIR): void => {
      if (used) return;
      if (t.kind === "enum" && t.name === enumName) used = true;
      else if (t.kind === "array") visit(t.element);
      else if (t.kind === "optional") visit(t.inner);
    };
    for (const f of a.fields) visit(f.type);
    if (used) return a.name;
  }
  return ctx.aggregates[0]?.name;
}

function findFirstAggregateUsingValueObject(
  ctx: BoundedContextIR,
  voName: string,
): string | undefined {
  for (const a of ctx.aggregates) {
    let used = false;
    const visit = (t: TypeIR): void => {
      if (used) return;
      if (t.kind === "valueobject" && t.name === voName) used = true;
      else if (t.kind === "array") visit(t.element);
      else if (t.kind === "optional") visit(t.inner);
    };
    for (const f of a.fields) visit(f.type);
    if (used) return a.name;
  }
  return ctx.aggregates[0]?.name;
}

function walkType(t: TypeIR, visit: (t: TypeIR) => void): void {
  visit(t);
  if (t.kind === "array") walkType(t.element, visit);
  else if (t.kind === "optional") walkType(t.inner, visit);
}

// ---------------------------------------------------------------------------
// Playwright page object emission — one class per workflow.
// ---------------------------------------------------------------------------

export function buildWorkflowPageObject(wf: WorkflowIR, ctx: BoundedContextIR): string {
  const slug = snake(wf.name);
  const className = `${upperFirst(wf.name)}WorkflowPage`;
  const requestType = `${upperFirst(wf.name)}Request`;
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page } from "@playwright/test";`);
  lines.push(`import type { ${requestType} } from "../../../src/api/workflows";`);
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function zodForRequest(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "z.number().int()";
        case "decimal":
          return "z.number()";
        case "money":
          return 'z.string().regex(/^-?\\d+(\\.\\d+)?$/, "must be a decimal-formatted string").transform((s) => new Decimal(s))';
        case "string":
        case "guid":
          return "z.string()";
        case "bool":
          return "z.boolean()";
        case "datetime":
          return "z.string()";
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return "z.string()";
    case "enum":
      return `${t.name}Schema`;
    case "valueobject":
      return `${t.name}Schema`;
    case "entity":
      return "z.unknown()";
    case "array":
      return `z.array(${zodForRequest(t.element)})`;
    case "optional":
      return `${zodForRequest(t.inner)}.nullish()`;
  }
}
