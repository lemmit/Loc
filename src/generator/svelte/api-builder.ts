import { createInputFields } from "../../ir/enrich/wire-projection.js";
import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  pagedReturn,
} from "../../ir/stdlib/generics.js";
import { unionReturn } from "../../ir/stdlib/unions.js";
import {
  aggregateUsesMoneyDeep,
  type BoundedContextIR,
  type EnrichedAggregateIR,
  type RepositoryIR,
} from "../../ir/types/loom-ir.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import { emitOperationUnionResponse } from "../_frontend/api-module.js";
import {
  collectUsedTypes,
  emitEnumSchema,
  emitObjectWithRefines,
  emitResponseSchema,
  emitUnionSchema,
  emitValueObjectSchema,
  preconditionsAsInvariants,
  unionForFind,
  zodForRequest,
  zodForResponseInner,
} from "../_frontend/zod-schemas.js";

// ---------------------------------------------------------------------------
// Per-aggregate API module: Zod schemas + svelte-query factories.
//
// The schema half is byte-identical with the React generator's output
// (shared via src/generator/_frontend/zod-schemas.ts) — the wire
// contract is framework-independent.  The data layer swaps React
// Query hooks for @tanstack/svelte-query v6 factories: `createQuery`
// takes a thunk of options and returns a runes-reactive object with
// the same `.data` / `.isPending` / `.mutate` surface, so pages wire
// against the same `useAll<Plural>` / `useCreate<Single>` names the
// TSX target uses.  Parameterised reads take accessors (`id: () =>
// string`) so route-param changes re-run the query without a remount.
// ---------------------------------------------------------------------------

export function buildSvelteApiModule(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): string {
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { z } from "zod";`);
  lines.push(
    `import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";`,
  );
  lines.push(`import { api } from "./client";`);
  if (aggregateUsesMoneyDeep(agg, ctx.valueObjects)) {
    lines.push(`import { moneySchema } from "../schemas";`);
  }
  lines.push("");

  // Schemas — identical emission path to the React module.
  const { valueObjects: usedVOs, enums: usedEnums } = collectUsedTypes(agg, repo, ctx);
  for (const e of usedEnums) lines.push(...emitEnumSchema(e));
  for (const vo of usedVOs) lines.push(...emitValueObjectSchema(vo));
  lines.push("");

  const requiredFields = createInputFields(agg);
  lines.push(
    ...emitObjectWithRefines(
      `Create${agg.name}Request`,
      requiredFields.map((f) => ({ name: f.name, base: zodForRequest(f.type) })),
      agg.invariants,
      new Set(requiredFields.map((f) => f.name)),
    ),
  );
  lines.push(`export type Create${agg.name}Request = z.infer<typeof Create${agg.name}Request>;`);
  lines.push("");

  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    // Field-level invariants (SYS-1): mirror create's wire constraints onto the
    // update/mutating-op client schema; `available = op.params` drops any
    // invariant over a field this op doesn't take.
    const opInvariants = [...agg.invariants, ...preconditionsAsInvariants(op)];
    lines.push(
      ...emitObjectWithRefines(
        `${upperFirst(op.name)}${agg.name}Request`,
        op.params.map((p) => ({ name: p.name, base: zodForRequest(p.type) })),
        opInvariants,
        new Set(op.params.map((p) => p.name)),
      ),
    );
    lines.push(
      `export type ${upperFirst(op.name)}${agg.name}Request = z.infer<typeof ${upperFirst(op.name)}${agg.name}Request>;`,
    );
  }
  lines.push("");

  if (repo) {
    for (const find of repo.finds) {
      if (find.name === "all") continue;
      lines.push(`export const ${upperFirst(find.name)}Query = z.object({`);
      for (const p of find.params) {
        lines.push(`  ${p.name}: ${zodForRequest(p.type)},`);
      }
      if (pagedReturn(find.returnType)) {
        lines.push(
          `  page: z.coerce.number().int().min(1).default(${PAGED_DEFAULT_PAGE}),`,
          `  pageSize: z.coerce.number().int().min(1).default(${PAGED_DEFAULT_PAGE_SIZE}),`,
        );
      }
      lines.push(`});`);
      lines.push(
        `export type ${upperFirst(find.name)}Query = z.infer<typeof ${upperFirst(find.name)}Query>;`,
      );
    }
  }
  lines.push("");

  for (const part of agg.parts) {
    lines.push(...emitResponseSchema(part, ctx, /*isAgg*/ false));
  }
  lines.push(...emitResponseSchema(agg, ctx, /*isAgg*/ true));
  lines.push(`export const ${agg.name}ListResponse = z.array(${agg.name}Response);`);
  lines.push(`export type ${agg.name}ListResponse = z.infer<typeof ${agg.name}ListResponse>;`);
  {
    const pagedSeen = new Set<string>();
    for (const find of repo?.finds ?? []) {
      const paged = pagedReturn(find.returnType);
      if (!paged || pagedSeen.has(paged.name)) continue;
      pagedSeen.add(paged.name);
      lines.push(
        `export const ${paged.name} = z.object({ items: z.array(${zodForResponseInner(paged.arg)}), page: z.number(), pageSize: z.number(), total: z.number(), totalPages: z.number() });`,
      );
      lines.push(`export type ${paged.name} = z.infer<typeof ${paged.name}>;`);
    }
  }
  {
    const unionSeen = new Set<string>();
    for (const find of repo?.finds ?? []) {
      const u = unionForFind(find.returnType, ctx);
      if (!u || unionSeen.has(u.name)) continue;
      unionSeen.add(u.name);
      lines.push(...emitUnionSchema(u.name, u.variants, ctx));
    }
  }
  // Union-returning OPERATION response DTOs (async-actions-and-effects.md
  // Stage 2) — the full tagged union served at 200, which a frontend action
  // awaiting the op discriminates with `match`.  Byte-identical to the shared
  // (React/Vue) module's emission; the wire contract is framework-independent.
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    if (!op.returnType) continue;
    const u = unionReturn(op.returnType);
    if (!u) continue;
    lines.push(...emitOperationUnionResponse(op.name, agg, u.variants, ctx));
  }
  lines.push("");

  // ---------------------------------------------------------------------
  // svelte-query factories — same exported names as the React hooks.
  // ---------------------------------------------------------------------
  const tag = snake(plural(agg.name));
  const aggKey = `["${tag}"]`;

  lines.push(`export function useAll${plural(agg.name)}() {`);
  lines.push(`  return createQuery(() => ({`);
  lines.push(`    queryKey: ${aggKey},`);
  lines.push(`    queryFn: async () => {`);
  lines.push(`      const r = await api.get(\`/${tag}\`);`);
  lines.push(`      return ${agg.name}ListResponse.parse(r);`);
  lines.push(`    },`);
  lines.push(`  }));`);
  lines.push(`}`);
  lines.push("");

  lines.push(`export function use${agg.name}ById(id: () => string | undefined) {`);
  lines.push(`  return createQuery(() => ({`);
  lines.push(`    queryKey: ["${tag}", id()],`);
  lines.push(`    enabled: !!id(),`);
  lines.push(`    queryFn: async () => {`);
  lines.push(`      const r = await api.get(\`/${tag}/\${id()}\`);`);
  lines.push(`      return ${agg.name}Response.parse(r);`);
  lines.push(`    },`);
  lines.push(`  }));`);
  lines.push(`}`);
  lines.push("");

  lines.push(`export function useCreate${agg.name}() {`);
  lines.push(`  const qc = useQueryClient();`);
  lines.push(`  return createMutation(() => ({`);
  lines.push(`    mutationFn: async (input: Create${agg.name}Request) => {`);
  lines.push(`      const r = await api.post(\`/${tag}\`, input);`);
  lines.push(`      return z.object({ id: z.string() }).parse(r);`);
  lines.push(`    },`);
  lines.push(`    onSuccess: () => qc.invalidateQueries({ queryKey: ${aggKey} }),`);
  lines.push(`  }));`);
  lines.push(`}`);
  lines.push("");

  if (agg.canonicalDestroy) {
    lines.push(`export function useDelete${agg.name}() {`);
    lines.push(`  const qc = useQueryClient();`);
    lines.push(`  return createMutation(() => ({`);
    lines.push(`    mutationFn: async (id: string) => {`);
    lines.push(`      await api.delete(\`/${tag}/\${id}\`);`);
    lines.push(`    },`);
    lines.push(`    onSuccess: () => qc.invalidateQueries({ queryKey: ${aggKey} }),`);
    lines.push(`  }));`);
    lines.push(`}`);
    lines.push("");
  }

  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    const opSnake = snake(op.routeSlug ?? op.name);
    const u = op.returnType ? unionReturn(op.returnType) : null;
    lines.push(`export function use${upperFirst(op.name)}${agg.name}(id: () => string) {`);
    lines.push(`  const qc = useQueryClient();`);
    lines.push(`  return createMutation(() => ({`);
    lines.push(`    mutationFn: async (input: ${upperFirst(op.name)}${agg.name}Request) => {`);
    if (u) {
      // Union-returning op: parse + RETURN the tagged success variant so the
      // awaiting action's `match` arm carries the payload (the error variant
      // never reaches 200 — it's a thrown non-2xx reified at the call site).
      lines.push(`      const r = await api.post(\`/${tag}/\${id()}/${opSnake}\`, input);`);
      lines.push(`      return ${upperFirst(op.name)}${agg.name}Response.parse(r);`);
    } else {
      lines.push(`      await api.post(\`/${tag}/\${id()}/${opSnake}\`, input);`);
    }
    lines.push(`    },`);
    lines.push(`    onSuccess: () => {`);
    lines.push(`      qc.invalidateQueries({ queryKey: ["${tag}", id()] });`);
    lines.push(`      qc.invalidateQueries({ queryKey: ${aggKey} });`);
    lines.push(`    },`);
    lines.push(`  }));`);
    lines.push(`}`);
    lines.push("");
  }

  if (repo) {
    for (const find of repo.finds) {
      if (find.name === "all") continue;
      const findSnake = snake(find.name);
      const paged = pagedReturn(find.returnType);
      const union = unionForFind(find.returnType, ctx);
      const isList = find.returnType.kind === "array";
      const responseSchema = paged
        ? paged.name
        : union
          ? union.name
          : isList
            ? `${agg.name}ListResponse`
            : find.returnType.kind === "optional"
              ? `${agg.name}Response.nullable()`
              : `${agg.name}Response`;
      lines.push(
        `export function use${upperFirst(find.name)}${agg.name}(query: () => ${upperFirst(find.name)}Query) {`,
      );
      lines.push(`  return createQuery(() => ({`);
      lines.push(`    queryKey: ["${tag}", "find", "${findSnake}", query()],`);
      lines.push(`    queryFn: async () => {`);
      lines.push(
        `      const qs = new URLSearchParams(Object.entries(query()).map(([k, v]) => [k, String(v)])).toString();`,
      );
      lines.push(`      const r = await api.get(\`/${tag}/${findSnake}\${qs ? "?" + qs : ""}\`);`);
      lines.push(`      return ${responseSchema}.parse(r);`);
      lines.push(`    },`);
      lines.push(`  }));`);
      lines.push(`}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}
