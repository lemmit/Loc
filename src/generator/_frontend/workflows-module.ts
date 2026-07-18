import {
  type BoundedContextIR,
  contextUsesMoney,
  type TypeIR,
  type WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { lowerFirst, snake, upperFirst } from "../../util/naming.js";
import { zodForResponse } from "./api-module.js";

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

export function buildWorkflowsApiModule(
  contexts: BoundedContextIR[],
  options: { queryPackage?: string } = {},
): string {
  const queryPackage = options.queryPackage ?? "@tanstack/react-query";
  const workflows = allWorkflows(contexts);
  // Observable workflows (a persisted correlation-state row) get read-only
  // instance query hooks (workflow-instance-visibility.md) — `useQuery` is
  // only imported when at least one exists, so a saga-less project's module
  // stays byte-identical.
  const anyInstances = workflows.some(({ wf }) => wf.instanceWireShape);
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { z } from "zod";`);
  lines.push(
    `import { ${anyInstances ? "useMutation, useQuery" : "useMutation"} } from "${queryPackage}";`,
  );
  lines.push(`import { api } from "./client";`);
  if (contexts.some(contextUsesMoney)) {
    lines.push(`import { moneySchema } from "../lib/schemas";`);
  }
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
    if (wf.instanceWireShape) {
      lines.push(...emitInstanceHooks(wf));
    }
  }

  return lines.join("\n");
}

/** Read-only instance query hooks for an observable workflow
 *  (workflow-instance-visibility.md): the `<Wf>InstanceResponse` /
 *  `<Wf>InstanceListResponse` Zod schemas (the React mirror of the Hono DTOs)
 *  plus `useAll<Wf>Instances()` / `use<Wf>InstanceById(id)` — the same
 *  react-query shape as an aggregate's `useAll<Agg>` / `use<Agg>ById`. */
function emitInstanceHooks(wf: WorkflowIR): string[] {
  const T = upperFirst(wf.name);
  const slug = snake(wf.name);
  const key = `["workflow_instances", "${slug}"]`;
  const lines: string[] = [];
  lines.push(`export const ${T}InstanceResponse = z.object({`);
  for (const f of wf.instanceWireShape ?? []) {
    lines.push(
      `  ${f.name}: ${f.source === "id" ? "z.string()" : zodForResponse(f.type, f.optional)},`,
    );
  }
  lines.push(`});`);
  lines.push(`export type ${T}InstanceResponse = z.infer<typeof ${T}InstanceResponse>;`);
  lines.push(`export const ${T}InstanceListResponse = z.array(${T}InstanceResponse);`);
  lines.push("");
  lines.push(`export function useAll${T}Instances() {`);
  lines.push(`  return useQuery({`);
  lines.push(`    queryKey: ${key},`);
  lines.push(`    queryFn: async () => {`);
  lines.push(`      const r = await api.get(\`/workflows/${slug}/instances\`);`);
  lines.push(`      return ${T}InstanceListResponse.parse(r);`);
  lines.push(`    },`);
  lines.push(`  });`);
  lines.push(`}`);
  lines.push("");
  lines.push(`export function use${T}InstanceById(id: string | undefined) {`);
  lines.push(`  return useQuery({`);
  lines.push(`    queryKey: [...${key}, id],`);
  lines.push(`    enabled: !!id,`);
  lines.push(`    queryFn: async () => {`);
  lines.push(`      const r = await api.get(\`/workflows/${slug}/instances/\${id}\`);`);
  lines.push(`      return ${T}InstanceResponse.parse(r);`);
  lines.push(`    },`);
  lines.push(`  });`);
  lines.push(`}`);
  lines.push("");
  return lines;
}

interface SchemaDep {
  fromAggregate: string;
  schemaName: string;
}

/** The types a workflow's API surface references: its command params plus —
 *  for an observable workflow — its instance wire-shape fields (whose response
 *  schema may name enum / value-object schemas that must be imported). */
function apiSurfaceTypes(wf: WorkflowIR): TypeIR[] {
  return [...wf.params.map((p) => p.type), ...(wf.instanceWireShape ?? []).map((f) => f.type)];
}

function collectEnumDeps(workflows: Array<{ wf: WorkflowIR; ctx: BoundedContextIR }>): SchemaDep[] {
  const out = new Map<string, SchemaDep>();
  for (const { wf, ctx } of workflows) {
    for (const t0 of apiSurfaceTypes(wf)) {
      walkType(t0, (t) => {
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
    for (const t0 of apiSurfaceTypes(wf)) {
      walkType(t0, (t) => {
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
// Playwright page object — moved to `workflow-page-object.ts` (the
// selectStyle-aware builder the svelte frontend parameterizes; the
// defaults reproduce this module's original output byte-for-byte).
// ---------------------------------------------------------------------------

export { buildWorkflowPageObject } from "./workflow-page-object.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function zodForRequest(t: TypeIR): string {
  switch (t.kind) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: inner switch on the primitive name union is exhaustive (every arm returns)
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "z.number().int()";
        case "decimal":
          return "z.number()";
        case "money":
          return "moneySchema";
        case "string":
        case "guid":
          return "z.string()";
        case "bool":
          return "z.boolean()";
        case "datetime":
          return "z.string()";
        case "json":
          return "z.unknown()";
        case "File":
          return "z.object({ url: z.string(), key: z.string(), contentType: z.string(), size: z.number().int() })";
        case "duration":
          // A5: expression-only primitive — never a request / wire type.
          throw new Error("internal: 'duration' is expression-only and never reaches a request");
      }
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
    case "action":
    case "slot":
      throw new Error(
        "zodForRequest: 'slot' type is UI-only and should not reach a workflow request schema.",
      );
    case "genericInstance":
      throw new Error(
        `zodForRequest: generic carrier '${t.ctor}' is not emittable yet (P3b); IR-validate should have rejected it.`,
      );
    case "union":
    case "none":
      throw new Error(
        `zodForRequest: discriminated unions are not emittable yet (P4); IR-validate should have rejected '${t.kind}'.`,
      );
  }
}
