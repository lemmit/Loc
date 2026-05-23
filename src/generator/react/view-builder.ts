import type { BoundedContextIR, TypeIR, ViewIR } from "../../ir/loom-ir.js";
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

export function buildViewsApiModule(contexts: BoundedContextIR[]): string {
  const views = allViews(contexts);
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { z } from "zod";`);
  lines.push(`import { useQuery } from "@tanstack/react-query";`);
  lines.push(`import { api } from "./client";`);
  // Shorthand views reference the source aggregate's response
  // schema from the per-aggregate api module.
  const shorthandSources = new Set<string>();
  for (const { view } of views) {
    if (!view.output) shorthandSources.add(view.aggregateName);
  }
  for (const aggName of [...shorthandSources].sort()) {
    // Shorthand views re-export `<Agg>ListResponse` only; the singular
    // `<Agg>Response` is never referenced here.
    lines.push(`import { ${aggName}ListResponse } from "./${lowerFirst(aggName)}";`);
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
      lines.push(
        `export const ${upperFirst(view.name)}Response = ${view.aggregateName}ListResponse;`,
      );
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
// Playwright page object — one class per view.
// ---------------------------------------------------------------------------

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
  const agg = ctx.aggregates.find((a) => a.name === view.aggregateName);
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

function zodForResponse(t: TypeIR, optional: boolean): string {
  const z = zodForResponseInner(t);
  return optional ? `${z}.nullish()` : z;
}

function zodForResponseInner(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "z.number().int()";
        case "decimal":
          return "z.number()";
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
      return `z.array(${zodForResponseInner(t.element)})`;
    case "optional":
      return `${zodForResponseInner(t.inner)}.nullish()`;
  }
}
