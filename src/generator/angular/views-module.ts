import type { BoundedContextIR, TypeIR, ViewIR } from "../../ir/types/loom-ir.js";
import { peelCollection, peelNullable, wireTypeInfo } from "../../ir/types/wire-types.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, snake, upperFirst } from "../../util/naming.js";
import { allViews } from "../_frontend/views-module.js";

// ---------------------------------------------------------------------------
// Angular views API module (`src/api/views.ts`).
//
// The Angular sibling of `_frontend/views-module.ts` (the React/Vue zod +
// `useQuery` emitter).  Angular reads through TanStack `injectQuery` off an
// `@Injectable` `ViewsService` wrapping `HttpClient`, so the surface is
// TS-interface (not zod) shaped — matching the per-aggregate `api/<agg>.ts`
// module the angular generator already emits.  Each view becomes:
//
//   - a `<View>Row` interface (full-form views project their own fields;
//     shorthand views reuse the source aggregate's row shape via `unknown`-
//     typed pass-through — the read path only needs the collection shape),
//   - a `ViewsService.<view>()` GET `/views/<snake>` method,
//   - a `use<View>View()` `injectQuery` factory the page-shell hoists.
// ---------------------------------------------------------------------------

/** Map a wire `TypeIR` to a TS type string for a view-row interface field.
 *  Mirrors the per-aggregate module's `wireTsType` (primitives + ids precise,
 *  enums / value objects / nested entities fall back to `unknown`). */
function wireTsType(t: TypeIR): string {
  const info = wireTypeInfo(t, "response");
  if (info.isNullable) return `${wireTsType(peelNullable(t))} | null`;
  if (info.isCollection) return `${wireTsType(peelCollection(t))}[]`;
  switch (info.refKind) {
    case "primitive":
      switch (info.primitive) {
        case "int":
        case "long":
        case "decimal":
          return "number";
        case "money":
          return "string";
        case "bool":
          return "boolean";
        case "string":
        case "datetime":
        case "guid":
          return "string";
        default:
          return "unknown";
      }
    case "id":
      return "string";
    default:
      return "unknown";
  }
}

/** Column names for a shorthand view's row shape — `id` plus the source
 *  aggregate's scalar fields (the same projection the page-side table walk
 *  reads).  Used when the view declares no explicit `output`. */
function shorthandRow(view: ViewIR, ctx: BoundedContextIR): Array<{ name: string; ts: string }> {
  if (view.source.kind === "workflow") {
    const wf = ctx.workflows.find((w) => w.name === view.source.name);
    const shape = wf?.instanceWireShape;
    if (!shape) return [{ name: "id", ts: "string" }];
    return shape.map((f) => ({
      name: f.name,
      ts: f.source === "id" ? "string" : wireTsType(f.type),
    }));
  }
  if (view.source.kind === "projection") {
    // A projection source's row is its canonical wire shape — correlation id
    // token then the state fields (projection.md v1.1).
    const proj = ctx.projections.find((p) => p.name === view.source.name);
    const shape = proj?.wireShape;
    if (!shape) return [{ name: "id", ts: "string" }];
    return shape.map((f) => ({
      name: f.name,
      ts: f.source === "id" ? "string" : wireTsType(f.type),
    }));
  }
  const agg = ctx.aggregates.find((a) => a.name === view.source.name);
  const out: Array<{ name: string; ts: string }> = [{ name: "id", ts: "string" }];
  for (const f of agg?.fields ?? []) {
    const inner = f.type.kind === "optional" ? f.type.inner : f.type;
    if (inner.kind === "primitive" || inner.kind === "enum" || inner.kind === "id") {
      out.push({ name: f.name, ts: wireTsType(f.type) });
    }
  }
  return out;
}

/** Emit the `src/api/views.ts` module aggregating every view across the
 *  served contexts. */
export function buildAngularViewsModule(contexts: BoundedContextIR[]): string {
  const views = allViews(contexts);
  const out: string[] = [
    "// Auto-generated.  Do not edit by hand.",
    'import { HttpClient } from "@angular/common/http";',
    'import { Injectable, inject } from "@angular/core";',
    'import { injectQuery } from "@tanstack/angular-query-experimental";',
    'import { firstValueFrom } from "rxjs";',
    'import { API_BASE_URL } from "./config";',
    "",
  ];

  // Row interfaces.
  for (const { view, ctx } of views) {
    const T = upperFirst(view.name);
    out.push(`export interface ${T}Row {`);
    if (view.output) {
      for (const f of view.output.fields) {
        out.push(`  ${f.name}: ${wireTsType(f.type)};`);
      }
    } else {
      for (const c of shorthandRow(view, ctx)) out.push(`  ${c.name}: ${c.ts};`);
    }
    out.push("}");
    out.push("");
  }

  // Service: one GET `/views/<snake>` per view.
  out.push(`@Injectable({ providedIn: "root" })`);
  out.push(`export class ViewsService {`);
  out.push("  private readonly http = inject(HttpClient);");
  for (const { view } of views) {
    const T = upperFirst(view.name);
    const method = lowerFirst(view.name);
    out.push("");
    out.push(`  ${method}() {`);
    out.push(
      `    return this.http.get<${T}Row[]>(\`\${API_BASE_URL}/views/${snake(view.name)}\`);`,
    );
    out.push("  }");
  }
  out.push("}");
  out.push("");

  // `use<View>View` injectQuery factories.
  for (const { view } of views) {
    const T = upperFirst(view.name);
    const method = lowerFirst(view.name);
    out.push(
      `/** \`${view.name}\` view read (TanStack \`injectQuery\`) — hoisted as a component`,
      " *  field; the injection context is the field initializer.  `data` is a",
      " *  `T[] | undefined` signal the QueryView template reads via `()`. */",
      `export function use${T}View() {`,
      "  const service = inject(ViewsService);",
      "  return injectQuery(() => ({",
      `    queryKey: ["views", "${snake(view.name)}"] as const,`,
      `    queryFn: () => firstValueFrom(service.${method}()),`,
      "  }));",
      "}",
      "",
    );
  }

  return lines(...out);
}
