import type { BoundedContextIR, TypeIR, WorkflowIR } from "../../ir/types/loom-ir.js";
import { peelCollection, peelNullable, wireTypeInfo } from "../../ir/types/wire-types.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, snake, upperFirst } from "../../util/naming.js";
import { allWorkflows } from "../_frontend/workflows-module.js";

// ---------------------------------------------------------------------------
// Angular workflows API module (`src/api/workflows.ts`).
//
// The Angular sibling of `_frontend/workflows-module.ts` (the React/Vue zod +
// `useMutation`/`useQuery` emitter).  Angular reads/writes through TanStack
// `injectMutation` / `injectQuery` off an `@Injectable` `WorkflowsService`
// wrapping `HttpClient`, so the surface is TS-interface (not zod) shaped —
// matching the per-aggregate `api/<agg>.ts` module.  Each workflow becomes:
//
//   - a `<Wf>Request` interface (the command params),
//   - a `WorkflowsService.<wf>()` POST `/workflows/<snake>` method,
//   - a `use<Wf>Workflow()` `injectMutation` factory,
//   - for an observable workflow, a `<Wf>InstanceRow` interface, the
//     `instances()` / `instance(id)` GET methods, and the
//     `useAll<Wf>Instances()` / `use<Wf>InstanceById(id)` read factories.
// ---------------------------------------------------------------------------

/** Map a wire `TypeIR` to a TS type string (primitives + ids precise; enums /
 *  value objects / nested entities fall back to `unknown`). */
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

function instanceRowLines(wf: WorkflowIR): string[] {
  const T = upperFirst(wf.name);
  const out: string[] = [`export interface ${T}InstanceRow {`];
  for (const f of wf.instanceWireShape ?? []) {
    out.push(`  ${f.name}: ${f.source === "id" ? "string" : wireTsType(f.type)};`);
  }
  out.push("}");
  out.push("");
  return out;
}

/** Emit the `src/api/workflows.ts` module aggregating every workflow across the
 *  served contexts. */
export function buildAngularWorkflowsModule(contexts: BoundedContextIR[]): string {
  const workflows = allWorkflows(contexts);
  const anyInstances = workflows.some(({ wf }) => wf.instanceWireShape);
  const out: string[] = [
    "// Auto-generated.  Do not edit by hand.",
    'import { HttpClient } from "@angular/common/http";',
    'import { Injectable, inject } from "@angular/core";',
    `import { ${anyInstances ? "injectMutation, injectQuery" : "injectMutation"} } from "@tanstack/angular-query-experimental";`,
    'import { firstValueFrom } from "rxjs";',
    'import { API_BASE_URL } from "./config";',
    "",
  ];

  // Request + instance-row interfaces.
  for (const { wf } of workflows) {
    const T = upperFirst(wf.name);
    out.push(`export interface ${T}Request {`);
    for (const p of wf.params) out.push(`  ${p.name}: ${wireTsType(p.type)};`);
    out.push("}");
    out.push("");
    if (wf.instanceWireShape) out.push(...instanceRowLines(wf));
  }

  // Service.
  out.push(`@Injectable({ providedIn: "root" })`);
  out.push(`export class WorkflowsService {`);
  out.push("  private readonly http = inject(HttpClient);");
  for (const { wf } of workflows) {
    const T = upperFirst(wf.name);
    const m = lowerFirst(wf.name);
    const slug = snake(wf.name);
    out.push("");
    out.push(`  ${m}(input: ${T}Request) {`);
    out.push(`    return this.http.post<void>(\`\${API_BASE_URL}/workflows/${slug}\`, input);`);
    out.push("  }");
    if (wf.instanceWireShape) {
      out.push("");
      out.push(`  ${m}Instances() {`);
      out.push(
        `    return this.http.get<${T}InstanceRow[]>(\`\${API_BASE_URL}/workflows/${slug}/instances\`);`,
      );
      out.push("  }");
      out.push("");
      out.push(`  ${m}InstanceById(id: string) {`);
      out.push(
        `    return this.http.get<${T}InstanceRow>(\`\${API_BASE_URL}/workflows/${slug}/instances/\${id}\`);`,
      );
      out.push("  }");
    }
  }
  out.push("}");
  out.push("");

  // Factories.
  for (const { wf } of workflows) {
    const T = upperFirst(wf.name);
    const m = lowerFirst(wf.name);
    out.push(
      `/** \`${wf.name}\` workflow command (TanStack \`injectMutation\`) — \`mutateAsync(input)\``,
      " *  POSTs the command params. */",
      `export function use${T}Workflow() {`,
      "  const service = inject(WorkflowsService);",
      "  return injectMutation(() => ({",
      `    mutationFn: (input: ${T}Request) => firstValueFrom(service.${m}(input)),`,
      "  }));",
      "}",
      "",
    );
    if (wf.instanceWireShape) {
      out.push(
        `/** \`${wf.name}\` instance list read — the saga-state rows. */`,
        `export function useAll${T}Instances() {`,
        "  const service = inject(WorkflowsService);",
        "  return injectQuery(() => ({",
        `    queryKey: ["workflow_instances", "${snake(wf.name)}"] as const,`,
        `    queryFn: () => firstValueFrom(service.${m}Instances()),`,
        "  }));",
        "}",
        "",
        `/** \`${wf.name}\` single-instance read by correlation id (idle until id resolves). */`,
        `export function use${T}InstanceById(id: string | undefined) {`,
        "  const service = inject(WorkflowsService);",
        "  return injectQuery(() => ({",
        `    queryKey: ["workflow_instances", "${snake(wf.name)}", id] as const,`,
        `    queryFn: () => firstValueFrom(service.${m}InstanceById(id as string)),`,
        "    enabled: !!id,",
        "  }));",
        "}",
        "",
      );
    }
  }

  return lines(...out);
}
