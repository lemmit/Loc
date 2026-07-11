import {
  type BoundedContextIR,
  contextUsesMoney,
  type TypeIR,
  type ViewIR,
} from "../../ir/types/loom-ir.js";
import { lowerFirst, snake, upperFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// View API module + Playwright page object emission.
//
// The page-side emission (views index, per-view table page) lives in
// src/generator/react/templating/preparers/view-{table,s-index}.ts.
// What remains here is two emission paths that aren't pack-shaped:
//
//   buildViewsApiModule  — Zod row schemas + react-query query
//                          hooks per view
//   buildViewPageObject  — Playwright page object per view
//
// Plus the `allViews` / `hasAnyView` iterators that the orchestrator
// and templating preparers share.
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

export function buildViewsApiModule(
  contexts: BoundedContextIR[],
  options: { queryPackage?: string } = {},
): string {
  const queryPackage = options.queryPackage ?? "@tanstack/react-query";
  const views = allViews(contexts);
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { z } from "zod";`);
  lines.push(`import { useQuery } from "${queryPackage}";`);
  lines.push(`import { api } from "./client";`);
  if (contexts.some(contextUsesMoney)) {
    lines.push(`import { moneySchema } from "../lib/schemas";`);
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
    // A projection source has no frontend api module, so a shorthand projection
    // view emits its row schema INLINE from `proj.wireShape` (below) — nothing
    // to import here (projection.md v1.1).
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
      // Shorthand projection view: no frontend api module for a projection, so
      // emit the row schema inline from the projection's canonical wire shape —
      // correlation field as an id string, then the state fields (projection.md
      // v1.1).  Mirrors the full-form branch's inline `z.object`.
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
    lines.push(`  return useQuery({`);
    lines.push(`    queryKey: ["views", "${slug}"],`);
    lines.push(`    queryFn: async () => {`);
    lines.push(`      const r = await api.get(\`/views/${slug}\`);`);
    lines.push(`      return ${upperFirst(view.name)}Response.parse(r);`);
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
// Playwright page object — moved to `view-page-object.ts` (the
// selectStyle-aware builder the svelte frontend parameterizes; the
// defaults reproduce this module's original output byte-for-byte).
// ---------------------------------------------------------------------------

export { buildViewPageObject } from "./view-page-object.js";

function _collectColumnNames(view: ViewIR, ctx: BoundedContextIR): string[] {
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function unwrapOpt(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

/** View-row zod spellings — the simple per-kind switch the view rows
 *  need (no unions / generics in view projections).  Shared with the
 *  svelte views module, which forks the builder for createQuery/$lib
 *  but emits identical row schemas. */
export function zodForViewResponse(t: TypeIR, optional: boolean): string {
  const z = zodForViewResponseInner(t);
  return optional ? `${z}.nullish()` : z;
}

export function zodForViewResponseInner(t: TypeIR): string {
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
        case "duration":
          // A5: expression-only primitive — never a view-row / wire type.
          throw new Error("internal: 'duration' is expression-only and never reaches a view row");
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
      return `z.array(${zodForViewResponseInner(t.element)})`;
    case "optional":
      return `${zodForViewResponseInner(t.inner)}.nullish()`;
    case "action":
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
