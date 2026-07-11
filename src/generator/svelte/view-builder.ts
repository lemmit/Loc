import {
  type BoundedContextIR,
  contextUsesMoney,
  type TypeIR,
  type ViewIR,
} from "../../ir/types/loom-ir.js";
import { lowerFirst, snake, upperFirst } from "../../util/naming.js";
import { zodForViewResponse } from "../_frontend/views-module.js";

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
// `src/lib/api/views.ts` aggregating them all.
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
    // A projection source has no frontend api module — a shorthand projection
    // view emits its row schema inline from `proj.wireShape` (below), no import
    // (projection.md v1.1).
    if (view.source.kind === "workflow") workflowSources.add(view.source.name);
    else if (view.source.kind === "projection") {
      /* inline — no import */
    } else shorthandSources.add(view.source.name);
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

  for (const { view, ctx } of views) {
    const slug = snake(view.name);
    if (view.output) {
      lines.push(`export const ${upperFirst(view.name)}Row = z.object({`);
      for (const f of view.output.fields) {
        lines.push(`  ${f.name}: ${zodForViewResponse(f.type, f.optional)},`);
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
    } else if (view.source.kind === "projection") {
      // Shorthand projection view: inline row schema from the projection's wire
      // shape (id token then state fields) — no frontend projection module to
      // reuse (projection.md v1.1).
      const T = upperFirst(view.name);
      const proj = ctx.projections.find((p) => p.name === view.source.name);
      lines.push(`export const ${T}Row = z.object({`);
      for (const f of proj?.wireShape ?? []) {
        lines.push(
          `  ${f.name}: ${f.source === "id" ? "z.string()" : zodForViewResponse(f.type, f.optional)},`,
        );
      }
      lines.push(`});`);
      lines.push(`export type ${T}Row = z.infer<typeof ${T}Row>;`);
      lines.push(`export const ${T}Response = z.array(${T}Row);`);
      lines.push(`export type ${T}Response = z.infer<typeof ${T}Response>;`);
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
