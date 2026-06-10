import { createInputFields } from "../../ir/enrich/wire-projection.js";
import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  pagedReturn,
} from "../../ir/stdlib/generics.js";
import {
  aggregateUsesMoney,
  type BoundedContextIR,
  type EnrichedAggregateIR,
  type RepositoryIR,
} from "../../ir/types/loom-ir.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
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

// Re-export so existing consumers (workflow-builder) keep their path.
export { zodForResponse } from "../_frontend/zod-schemas.js";

// ---------------------------------------------------------------------------
// Per-aggregate API module: Zod schemas + React Query hooks.
//
// The schemas mirror the backend's wire shape exactly (see
// generator/typescript/routes-builder.ts and dotnet/dto-mapping.ts).
// Hooks parse the response with the matching schema before returning,
// so callers get type-checked, validated data — no `as never` casts.
// ---------------------------------------------------------------------------

export function buildApiModule(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): string {
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { z } from "zod";`);
  lines.push(`import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";`);
  lines.push(`import { api } from "./client";`);
  if (aggregateUsesMoney(agg)) {
    // Shared `moneySchema` — single home for the precise-decimal
    // wire shape; emitted to `src/lib/schemas.ts` whenever any
    // context uses money.  Both request and response sides of every
    // route reference this helper rather than redeclaring the
    // string-to-Decimal transform per field.
    lines.push(`import { moneySchema } from "../lib/schemas";`);
  }
  lines.push("");

  // Schemas — enums + value-objects + per-route DTOs.
  const { valueObjects: usedVOs, enums: usedEnums } = collectUsedTypes(agg, repo, ctx);

  for (const e of usedEnums) lines.push(...emitEnumSchema(e));
  for (const vo of usedVOs) lines.push(...emitValueObjectSchema(vo));
  lines.push("");

  // Request schemas.  `forCreateInput` drops server-controlled fields
  // (`managed`, `token`, `internal`) from the client-supplied payload,
  // keeping `immutable` (settable on create) and `secret` (client
  // provides password hashes / API keys).  Aligns with the Hono and
  // .NET CreateRequest shapes.
  const requiredFields = createInputFields(agg);
  lines.push(
    ...emitObjectWithRefines(
      `Create${agg.name}Request`,
      requiredFields.map((f) => ({ name: f.name, base: zodForRequest(f.type) })),
      agg.invariants,
      // Only create-input fields can be validated at the wire boundary —
      // invariants over excluded fields (e.g. a `managed` collection) are
      // enforced server-side, so they must not refine an absent field.
      new Set(requiredFields.map((f) => f.name)),
    ),
  );
  lines.push(`export type Create${agg.name}Request = z.infer<typeof Create${agg.name}Request>;`);
  lines.push("");

  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    const opInvariants = preconditionsAsInvariants(op);
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

  // Find queries (other than `all`, which has no params).
  if (repo) {
    for (const find of repo.finds) {
      if (find.name === "all") continue;
      lines.push(`export const ${upperFirst(find.name)}Query = z.object({`);
      for (const p of find.params) {
        lines.push(`  ${p.name}: ${zodForRequest(p.type)},`);
      }
      // A paged find gains 1-based `page` / `pageSize` controls (P3b),
      // mirroring the backend route's query schema.
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

  // Response schemas.  Inner DTOs must come first so they're declared
  // before the root references them.
  for (const part of agg.parts) {
    lines.push(...emitResponseSchema(part, ctx, /*isAgg*/ false));
  }
  lines.push(...emitResponseSchema(agg, ctx, /*isAgg*/ true));
  lines.push(`export const ${agg.name}ListResponse = z.array(${agg.name}Response);`);
  lines.push(`export type ${agg.name}ListResponse = z.infer<typeof ${agg.name}ListResponse>;`);
  // Paged response DTOs (P3b) — one per distinct `<carrier> paged` find return.
  // `items` reuses the carrier's response schema; the envelope mirrors the
  // backend's `<Agg>Paged` shape byte-for-byte.
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
  // Discriminated-union response DTOs (P4b) — one `z.discriminatedUnion` per
  // distinct union find return (anonymous `A or B` or a named `payload = …`
  // reference).  Each variant carries the `type` discriminator + its wire
  // fields; the frontend narrows on `.type`.
  {
    const unionSeen = new Set<string>();
    for (const find of repo?.finds ?? []) {
      const u = unionForFind(find.returnType, ctx);
      if (!u || unionSeen.has(u.name)) continue;
      unionSeen.add(u.name);
      lines.push(...emitUnionSchema(u.name, u.variants, ctx));
    }
  }
  lines.push("");

  // ---------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------
  const tag = snake(plural(agg.name));
  const aggKey = `["${tag}"]`;
  const detailKey = `["${tag}", id]`;

  // useAll<Agg>
  lines.push(`export function useAll${plural(agg.name)}() {`);
  lines.push(`  return useQuery({`);
  lines.push(`    queryKey: ${aggKey},`);
  lines.push(`    queryFn: async () => {`);
  lines.push(`      const r = await api.get(\`/${tag}\`);`);
  lines.push(`      return ${agg.name}ListResponse.parse(r);`);
  lines.push(`    },`);
  lines.push(`  });`);
  lines.push(`}`);
  lines.push("");

  // use<Agg>ById
  lines.push(`export function use${agg.name}ById(id: string | undefined) {`);
  lines.push(`  return useQuery({`);
  lines.push(`    queryKey: ${detailKey},`);
  lines.push(`    enabled: !!id,`);
  lines.push(`    queryFn: async () => {`);
  lines.push(`      const r = await api.get(\`/${tag}/\${id}\`);`);
  lines.push(`      return ${agg.name}Response.parse(r);`);
  lines.push(`    },`);
  lines.push(`  });`);
  lines.push(`}`);
  lines.push("");

  // useCreate<Agg>
  lines.push(`export function useCreate${agg.name}() {`);
  lines.push(`  const qc = useQueryClient();`);
  lines.push(`  return useMutation({`);
  lines.push(`    mutationFn: async (input: Create${agg.name}Request) => {`);
  lines.push(`      const r = await api.post(\`/${tag}\`, input);`);
  lines.push(`      return z.object({ id: z.string() }).parse(r);`);
  lines.push(`    },`);
  lines.push(`    onSuccess: () => qc.invalidateQueries({ queryKey: ${aggKey} }),`);
  lines.push(`  });`);
  lines.push(`}`);
  lines.push("");

  // useDelete<Agg> — canonical hard delete (DELETE /<tag>/{id}).  Gated on
  // the IR lifecycle: emitted only when the aggregate has a canonical
  // `destroy` (declared or via `crudish`), so plain aggregates' API modules
  // are unchanged.  Pairs with the `api.delete` helper, which the shell
  // emits under the same condition.
  if (agg.canonicalDestroy) {
    lines.push(`export function useDelete${agg.name}() {`);
    lines.push(`  const qc = useQueryClient();`);
    lines.push(`  return useMutation({`);
    lines.push(`    mutationFn: async (id: string) => {`);
    lines.push(`      await api.delete(\`/${tag}/\${id}\`);`);
    lines.push(`    },`);
    lines.push(`    onSuccess: () => qc.invalidateQueries({ queryKey: ${aggKey} }),`);
    lines.push(`  });`);
    lines.push(`}`);
    lines.push("");
  }

  // use<Op><Agg> — one per public operation.
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    // URL segment from routeSlug (D-URLSTYLE); the hook name + request
    // type stay keyed on op.name.
    const opSnake = snake(op.routeSlug ?? op.name);
    lines.push(`export function use${upperFirst(op.name)}${agg.name}(id: string) {`);
    lines.push(`  const qc = useQueryClient();`);
    lines.push(`  return useMutation({`);
    lines.push(`    mutationFn: async (input: ${upperFirst(op.name)}${agg.name}Request) => {`);
    lines.push(`      await api.post(\`/${tag}/\${id}/${opSnake}\`, input);`);
    lines.push(`    },`);
    lines.push(`    onSuccess: () => {`);
    lines.push(`      qc.invalidateQueries({ queryKey: ["${tag}", id] });`);
    lines.push(`      qc.invalidateQueries({ queryKey: ${aggKey} });`);
    lines.push(`    },`);
    lines.push(`  });`);
    lines.push(`}`);
    lines.push("");
  }

  // use<FindName> — one per non-`all` find.
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
        `export function use${upperFirst(find.name)}${agg.name}(query: ${upperFirst(find.name)}Query) {`,
      );
      lines.push(`  return useQuery({`);
      lines.push(`    queryKey: ["${tag}", "find", "${findSnake}", query],`);
      lines.push(`    queryFn: async () => {`);
      lines.push(
        // Stringify each value: query fields may be numbers (paged
        // page/pageSize, numeric find params), which a bare cast to
        // Record<string,string> rejects under strict tsc.
        `      const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();`,
      );
      lines.push(`      const r = await api.get(\`/${tag}/${findSnake}\${qs ? "?" + qs : ""}\`);`);
      lines.push(`      return ${responseSchema}.parse(r);`);
      lines.push(`    },`);
      lines.push(`  });`);
      lines.push(`}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}
