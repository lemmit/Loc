// ---------------------------------------------------------------------------
// Frontend API module for QUERY-TIME PROJECTIONS — one file at
// `src/api/projections.ts` aggregating every readable projection in the
// deployable.  The frontend twin of the backend's `http/query-projections.ts`.
//
// Why this exists (M-T1.3 Phase 1): projections were BACKEND-ONLY read models.
// Each owned an HTTP route that no generated frontend ever called, and a page
// that tried (`QueryView { of: Sales.SalesTotals }`) validated clean and emitted
// `/* unresolved: Sales */ undefined.SalesTotals` — a runtime TypeError and a
// build break.  There was no lowering arm and no client; this is the client.
//
// Scope: the UNKEYED query-time projection — the whole-table read model whose
// response is one object (the shape a dashboard KPI reads), plus the `group by`
// LIST shape (one row per group, a `z.array` of the same row — M-T1.3 Phase 4).
// A keyed projection is read by key off its materialized row table; it is gated
// (`loom.ui-projection-read-unsupported`) until that lands.
//
// ---------------------------------------------------------------------------
// HOW THE REMAINING FRONTENDS PORT INTO THIS MODULE  (decided on the Vue port,
// M-T1.3 Phase 1; read this BEFORE reaching for a per-framework seam)
// ---------------------------------------------------------------------------
//
// This module stays ONE shared emitter widened by a plain options object — it
// does NOT get a `ProjectionsTarget` seam object in the `WalkerTarget` shape.
// The rule for picking between the two, and why Vue landed on the first:
//
//   REUSE (widen `options`) while the divergence is LEAF-SHAPED — a string
//     substituted into otherwise identical output.  Vue is exactly that: the
//     only thing that differs from React is the import specifier, because
//     `@tanstack/vue-query`'s `useQuery` is API-compatible with the React one
//     (same call form, same `.data`).  `queryPackage` already existed for it.
//     Svelte is likely still on this side of the line but needs THREE more
//     leaves, all visible in its workflows fork: the factory name
//     (`createQuery` not `useQuery`), the thunk call form
//     (`createQuery(() => ({…}))`), and the module dir (`src/lib/api/`, which
//     moves the `./client` + `../lib/schemas` relative imports).  Add them as
//     named options with React-shaped defaults so every existing caller stays
//     byte-identical.
//
//   FORK when the divergence is STRUCTURAL — the emitted unit stops being "a
//     zod schema plus a query hook" at all.  Angular (an injectable service
//     over RxJS/signals), Feliz (F#, not TypeScript) and Flutter (Dart +
//     Riverpod) are all on this side: none of them can share a TypeScript
//     string emitter, no matter how many knobs it grows.
//
// This is not a new judgement call — `workflows-module.ts` is the same problem
// one feature earlier and already settled it the same way: React and Vue share
// it through `queryPackage`, Svelte forked into `svelte/workflow-builder.ts`,
// Angular into `buildAngularWorkflowsModule`.  Follow that precedent, and
// prefer a shared emitter with defaults over a seam interface until a SECOND
// consumer has actually proved the divergence axis — the `WalkerTarget`
// extraction itself only happened after a real second target existed.
// ---------------------------------------------------------------------------

import type { BoundedContextIR, ProjectionIR } from "../../ir/types/loom-ir.js";
import { contextUsesMoney, isGroupedProjection } from "../../ir/types/loom-ir.js";
import { isFrontendReadableProjection } from "../../ir/util/projection-read.js";
import { snake, upperFirst } from "../../util/naming.js";
import { zodForResponse } from "./api-module.js";

/** Every readable projection across the served contexts, in declaration order. */
export function readableProjections(
  contexts: readonly BoundedContextIR[],
): Array<{ proj: ProjectionIR; ctx: BoundedContextIR }> {
  const out: Array<{ proj: ProjectionIR; ctx: BoundedContextIR }> = [];
  for (const ctx of contexts) {
    for (const proj of ctx.projections ?? []) {
      if (isFrontendReadableProjection(proj)) out.push({ proj, ctx });
    }
  }
  return out;
}

/** Per-framework emission leaves.
 *
 *  Every one is a STRING (or a boolean picking between two fixed spellings)
 *  substituted into otherwise identical output — which is the test for staying
 *  in this shared module rather than forking, per the decision recorded above.
 *  Defaults are React's, so every existing caller stays byte-identical. */
export interface ProjectionsModuleOptions {
  /** TanStack Query package specifier — `@tanstack/{react,vue,svelte}-query`. */
  queryPackage?: string;
  /** Query factory imported from it.  React/Vue call it `useQuery`; Svelte
   *  renamed the whole family to `create*` for the store-flavoured API. */
  queryFactory?: string;
  /** Whether the factory takes a THUNK returning the options object
   *  (`createQuery(() => ({…}))`) rather than the object itself.  Svelte 5's
   *  runes API needs the thunk so the options re-read reactively. */
  thunkOptions?: boolean;
  /** Import specifier for the shared `moneySchema`, relative to this module.
   *  React/Vue put it two hops up from `src/api/`; Svelte's module lives at
   *  `src/lib/api/`, one hop below `src/lib/schemas.ts`. */
  schemasImport?: string;
}

export function buildProjectionsApiModule(
  contexts: BoundedContextIR[],
  options: ProjectionsModuleOptions = {},
): string {
  const queryPackage = options.queryPackage ?? "@tanstack/react-query";
  const queryFactory = options.queryFactory ?? "useQuery";
  const schemasImport = options.schemasImport ?? "../lib/schemas";
  // `createQuery(() => ({ … }))` vs `useQuery({ … })` — the only structural
  // divergence, and it is two fixed spellings rather than a shape the caller
  // supplies, so it stays a boolean instead of a renderer seam.
  const openOptions = options.thunkOptions ? "() => ({" : "{";
  const closeOptions = options.thunkOptions ? "}));" : "});";
  const projections = readableProjections(contexts);

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { z } from "zod";`);
  lines.push(`import { ${queryFactory} } from "${queryPackage}";`);
  lines.push(`import { api } from "./client";`);
  if (contexts.some(contextUsesMoney)) {
    lines.push(`import { moneySchema } from "${schemasImport}";`);
  }
  lines.push("");

  // Enum lookup across the served contexts: a projection row's enum field
  // renders INLINE as `z.enum([...])` — the same self-contained choice the
  // backend's `zodForRow` makes — because the `<Enum>Schema` consts live in the
  // per-AGGREGATE api modules and this module has no ownership rule to import
  // them by (an enum may back several aggregates' modules, or none).
  const enumValues = new Map<string, string[]>();
  for (const ctx of contexts) for (const e of ctx.enums ?? []) enumValues.set(e.name, e.values);
  const zodForProjField = (
    t: import("../../ir/types/loom-ir.js").TypeIR,
    optional: boolean,
  ): string => {
    const inner = t.kind === "optional" ? t.inner : t;
    if (inner.kind === "enum") {
      const values = enumValues.get(inner.name) ?? [];
      const lit = `z.enum([${values.map((v) => JSON.stringify(v)).join(", ")}])`;
      return optional || t.kind === "optional" ? `${lit}.nullish()` : lit;
    }
    return zodForResponse(t, optional);
  };

  for (const { proj } of projections) {
    const T = upperFirst(proj.name);
    const slug = snake(proj.name);
    // A grouped (`group by`) projection returns the LIST shape — one row per
    // group (M-T1.3 Phase 4) — so its Response wraps the object row in
    // `z.array`.  The singleton stays the bare object, byte-identical.
    const grouped = isGroupedProjection(proj);
    // The row schema mirrors the backend's `<Proj>Row` field-for-field — same
    // `wireShape`, so the two can't drift.
    lines.push(`export const ${T}${grouped ? "Row" : "Response"} = z.object({`);
    for (const f of proj.wireShape ?? []) {
      lines.push(`  ${f.name}: ${zodForProjField(f.type, !!f.optional)},`);
    }
    lines.push(`});`);
    if (grouped) lines.push(`export const ${T}Response = z.array(${T}Row);`);
    lines.push(`export type ${T}Response = z.infer<typeof ${T}Response>;`);
    lines.push("");
    // A singleton read takes no arguments and no id: the projection IS the row.
    // `.parse` is a real boundary check, matching every other read hook.
    lines.push(`export function use${T}() {`);
    lines.push(`  return ${queryFactory}(${openOptions}`);
    lines.push(`    queryKey: ["projections", "${slug}"],`);
    lines.push(`    queryFn: async () => {`);
    lines.push(`      const r = await api.get(\`/projections/${slug}\`);`);
    lines.push(`      return ${T}Response.parse(r);`);
    lines.push(`    },`);
    lines.push(`  ${closeOptions}`);
    lines.push(`}`);
    lines.push("");
  }

  return lines.join("\n");
}
