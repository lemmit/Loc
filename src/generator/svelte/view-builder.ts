import {
  type BoundedContextIR,
  contextUsesMoney,
  type TypeIR,
  type ViewIR,
} from "../../ir/types/loom-ir.js";
import { lowerFirst, snake, upperFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// View API module — Zod row schemas + svelte-query factories per
// view.  Sibling of src/generator/react/view-builder.ts with the data
// layer swapped to @tanstack/svelte-query v6 (same exported use*View
// names; createQuery takes a thunk and returns a reactive object).
// Page objects are emitted by the shared Playwright builders.
// ---------------------------------------------------------------------------

export function hasAnyView(contexts: BoundedContextIR[]): boolean {
  return contexts.some((c) => c.views.length > 0);
}

export function allViews(
  contexts: BoundedContextIR[],
): Array<{ view: ViewIR; ctx: BoundedContextIR }> {
  const out: Array<{ view: ViewIR; ctx: BoundedContextIR }> = [];
  for (const ctx of contexts) {
    for (const v of ctx.views) out.push({ view: v, ctx });
  }
  out.sort((a, b) => a.view.name.localeCompare(b.view.name));
  return out;
}

// ---------------------------------------------------------------------------
// API module — Zod schemas + query hooks per view.  One file at
// `src/api/views.ts` aggregating them all.
// ---------------------------------------------------------------------------

export function buildViewsApiModule(contexts: BoundedContextIR[]): string {
  const views = allViews(contexts);
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { z } from "zod";`);
  lines.push(`import { createQuery } from "@tanstack/svelte-query";`);
  lines.push(`import { api } from "./client";`);
  if (contexts.some(contextUsesMoney)) {
    lines.push(`import { moneySchema } from "../schemas";`);
  }
  // Shorthand views reference the source aggregate's response
  // schema from the per-aggregate api module.
  const shorthandSources = new Set<string>();
  const workflowSources = new Set<string>();
  for (const { view } of views) {
    if (view.output) continue;
    // Shorthand views re-export the source's list response: an aggregate's
    // `<Agg>ListResponse` (from `./<agg>`) or a workflow's
    // `<Wf>InstanceListResponse` (from `./workflows`, workflow-instance-views.md).
    if (view.source.kind === "workflow") workflowSources.add(view.source.name);
    else shorthandSources.add(view.source.name);
  }
  for (const aggName of [...shorthandSources].sort()) {
    lines.push(`import { ${aggName}ListResponse } from "./${lowerFirst(aggName)}";`);
  }
  if (workflowSources.size > 0) {
    const names = [...workflowSources].sort().map((w) => `${upperFirst(w)}InstanceListResponse`);
    lines.push(`import { ${names.join(", ")} } from "./workflows";`);
  }
  // Full-form views may reference enum / VO schemas on their fields.
  const enumDeps = collectEnumDeps(views);
  const voDeps = collectVoDeps(views);
  for (const dep of [...enumDeps, ...voDeps]) {
    lines.push(`import { ${dep.schemaName} } from "./${lowerFirst(dep.fromAggregate)}";`);
  }
  lines.push("");

  for (const { view } of views) {
    const slug = snake(view.name);
    if (view.output) {
      lines.push(`export const ${upperFirst(view.name)}Row = z.object({`);
      for (const f of view.output.fields) {
        lines.push(`  ${f.name}: ${zodForResponse(f.type, f.optional)},`);
      }
      lines.push(`});`);
      lines.push(
        `export type ${upperFirst(view.name)}Row = z.infer<typeof ${upperFirst(view.name)}Row>;`,
      );
      lines.push(
        `export const ${upperFirst(view.name)}Response = z.array(${upperFirst(view.name)}Row);`,
      );
      lines.push(
        `export type ${upperFirst(view.name)}Response = z.infer<typeof ${upperFirst(view.name)}Response>;`,
      );
    } else {
      // Shorthand: reuse the source's list-response — an aggregate's
      // `<Agg>ListResponse` or a workflow's `<Wf>InstanceListResponse`
      // (workflow-instance-views.md).
      const listResponse =
        view.source.kind === "workflow"
          ? `${upperFirst(view.source.name)}InstanceListResponse`
          : `${view.source.name}ListResponse`;
      lines.push(`export const ${upperFirst(view.name)}Response = ${listResponse};`);
      lines.push(
        `export type ${upperFirst(view.name)}Response = z.infer<typeof ${upperFirst(view.name)}Response>;`,
      );
    }
    lines.push("");
    lines.push(`export function use${upperFirst(view.name)}View() {`);
    lines.push(`  return createQuery(() => ({`);
    lines.push(`    queryKey: ["views", "${slug}"],`);
    lines.push(`    queryFn: async () => {`);
    lines.push(`      const r = await api.get(\`/views/${slug}\`);`);
    lines.push(`      return ${upperFirst(view.name)}Response.parse(r);`);
    lines.push(`    },`);
    lines.push(`  }));`);
    lines.push(`}`);
    lines.push("");
  }

  return lines.join("\n");
}

interface SchemaDep {
  fromAggregate: string;
  schemaName: string;
}

function collectEnumDeps(views: Array<{ view: ViewIR; ctx: BoundedContextIR }>): SchemaDep[] {
  const out = new Map<string, SchemaDep>();
  for (const { view, ctx } of views) {
    if (!view.output) continue;
    for (const f of view.output.fields) {
      walkType(f.type, (t) => {
        if (t.kind === "enum") {
          const owner = findFirstAggregateWith(
            ctx,
            (typ) => typ.kind === "enum" && typ.name === t.name,
          );
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

function collectVoDeps(views: Array<{ view: ViewIR; ctx: BoundedContextIR }>): SchemaDep[] {
  const out = new Map<string, SchemaDep>();
  for (const { view, ctx } of views) {
    if (!view.output) continue;
    for (const f of view.output.fields) {
      walkType(f.type, (t) => {
        if (t.kind === "valueobject") {
          const owner = findFirstAggregateWith(
            ctx,
            (typ) => typ.kind === "valueobject" && typ.name === t.name,
          );
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

function walkType(t: TypeIR, visit: (t: TypeIR) => void): void {
  visit(t);
  if (t.kind === "array") walkType(t.element, visit);
  else if (t.kind === "optional") walkType(t.inner, visit);
}

function findFirstAggregateWith(
  ctx: BoundedContextIR,
  matches: (t: TypeIR) => boolean,
): string | undefined {
  for (const a of ctx.aggregates) {
    let found = false;
    const visit = (t: TypeIR): void => {
      if (found) return;
      if (matches(t)) {
        found = true;
        return;
      }
      if (t.kind === "array") visit(t.element);
      else if (t.kind === "optional") visit(t.inner);
    };
    for (const f of a.fields) visit(f.type);
    if (found) return a.name;
  }
  return ctx.aggregates[0]?.name;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function unwrapOpt(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

function zodForResponse(t: TypeIR, optional: boolean): string {
  const z = zodForResponseInner(t);
  return optional ? `${z}.nullish()` : z;
}

function zodForResponseInner(t: TypeIR): string {
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
      return `z.array(${zodForResponseInner(t.element)})`;
    case "optional":
      return `${zodForResponseInner(t.inner)}.nullish()`;
    case "slot":
      throw new Error(
        "zodForResponseInner: 'slot' type is UI-only and should not reach the response schema.",
      );
    case "genericInstance":
      throw new Error(
        `zodForResponseInner: generic carrier '${t.ctor}' is not emittable yet (P3b); IR-validate should have rejected it.`,
      );
    case "union":
    case "none":
      throw new Error(
        `zodForResponseInner: discriminated unions are not emittable yet (P4); IR-validate should have rejected '${t.kind}'.`,
      );
  }
}
