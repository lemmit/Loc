import type { BoundedContextIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, snake, upperFirst } from "../../util/naming.js";
import { readableProjections } from "../_frontend/projections-module.js";
import { wireTsType } from "./workflows-module.js";

// ---------------------------------------------------------------------------
// Angular query-time PROJECTION client (`src/api/projections.ts`) — M-T1.3
// Phase 1.  The Angular sibling of `_frontend/projections-module.ts`.
//
// WHY THIS IS A FORK, not another options-widening of the shared module.
//
// #2366 (the Vue port) set the rule the frontend ports follow: REUSE the shared
// emitter while the divergence is LEAF-SHAPED — a string substituted into
// otherwise identical output — and FORK when it is STRUCTURAL, i.e. when the
// emitted unit stops being "a zod schema plus a query hook".  Svelte (#2369)
// was the reuse case and cost three leaf options.  Angular is the first fork,
// and it is not a close call — four independent structural divergences:
//
//   1. NO ZOD.  Angular's client surface is TS-interface shaped (`<Proj>Row`),
//      typed through `HttpClient`'s generic, so there is no `z.object({…})` and
//      no `.parse(r)` runtime boundary check to emit at all.
//   2. A SERVICE.  The read goes through an `@Injectable({providedIn:"root"})`
//      class wrapping `HttpClient`, not a free `api.get(...)` call.
//   3. DI IN THE FACTORY.  `use<Proj>()` must `inject(ProjectionsService)` and
//      wrap an Observable — `injectQuery(() => ({ queryFn: () =>
//      firstValueFrom(service.x()) }))`.
//   4. NO DECIMAL.  Angular maps wire `money` to `string`, so the shared
//      module's `moneySchema` import has no counterpart here.
//
// Growing the shared options object to cover any of those would mean passing
// the caller a *shape* rather than a spelling — which is the line the rule
// draws.  Same call `angular/workflows-module.ts` already made against
// `_frontend/workflows-module.ts`, for the same four reasons.
//
// What IS still shared: `readableProjections` — the readability predicate and
// declaration-order inventory are IR facts, identical on every frontend, and
// they stay in one place (`ir/util/projection-read.ts` via the shared module).
// A fork of the EMITTER is not a fork of the RULE about what is emittable.
// ---------------------------------------------------------------------------

/** Whether this deployable serves any frontend-readable projection. */
export function hasReadableProjections(contexts: BoundedContextIR[]): boolean {
  return readableProjections(contexts).length > 0;
}

/** Emit `src/api/projections.ts` — every readable projection across the served
 *  contexts as a row interface + a `ProjectionsService` method + a read
 *  factory.  Structural twin of `buildAngularWorkflowsModule`. */
export function buildAngularProjectionsModule(contexts: BoundedContextIR[]): string {
  const projections = readableProjections(contexts);
  const out: string[] = [
    "// Auto-generated.  Do not edit by hand.",
    'import { HttpClient } from "@angular/common/http";',
    'import { Injectable, inject } from "@angular/core";',
    'import { injectQuery } from "@tanstack/angular-query-experimental";',
    'import { firstValueFrom } from "rxjs";',
    'import { API_BASE_URL } from "./config";',
    "",
  ];

  // Row interfaces — field-for-field off the SAME `wireShape` the backend's
  // `<Proj>Row` is built from, so the two cannot drift.  Typed through
  // `HttpClient`'s generic rather than parsed, which is why there is no zod
  // schema here (see the fork rationale above).
  for (const { proj } of projections) {
    out.push(`export interface ${upperFirst(proj.name)}Row {`);
    for (const f of proj.wireShape ?? []) {
      out.push(`  ${f.name}${f.optional ? "?" : ""}: ${wireTsType(f.type)};`);
    }
    out.push("}");
    out.push("");
  }

  out.push(`@Injectable({ providedIn: "root" })`);
  out.push(`export class ProjectionsService {`);
  out.push("  private readonly http = inject(HttpClient);");
  for (const { proj } of projections) {
    // A singleton read takes no id and no query params — the projection IS the
    // row — so the method is nullary, unlike the aggregate services' `byId`.
    out.push("");
    out.push(`  ${lowerFirst(proj.name)}() {`);
    out.push(
      `    return this.http.get<${upperFirst(proj.name)}Row>(\`\${API_BASE_URL}/projections/${snake(proj.name)}\`);`,
    );
    out.push("  }");
  }
  out.push("}");
  out.push("");

  for (const { proj } of projections) {
    const T = upperFirst(proj.name);
    out.push(
      `/** \`${proj.name}\` singleton projection read — one row, no arguments. */`,
      `export function use${T}() {`,
      "  const service = inject(ProjectionsService);",
      "  return injectQuery(() => ({",
      `    queryKey: ["projections", "${snake(proj.name)}"] as const,`,
      `    queryFn: () => firstValueFrom(service.${lowerFirst(proj.name)}()),`,
      "  }));",
      "}",
      "",
    );
  }

  return lines(...out);
}
