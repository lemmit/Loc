import {
  createInputFields,
  emitsRestCreate,
  forApiRead,
  wireFieldsFor,
} from "../../ir/enrich/wire-projection.js";
import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  pagedReturn,
} from "../../ir/stdlib/generics.js";
import { unionInstanceName, unionReturn, variantTag } from "../../ir/stdlib/unions.js";
import {
  type AggregateIR,
  aggregateUsesMoneyDeep,
  type BoundedContextIR,
  type EnrichedAggregateIR,
  type EnrichedEntityPartIR,
  type EnumIR,
  type InvariantIR,
  type OperationIR,
  type RepositoryIR,
  type TypeIR,
  type ValueObjectIR,
} from "../../ir/types/loom-ir.js";
import {
  peelCollection,
  peelNullable,
  type WirePrimitive,
  wireTypeInfo,
} from "../../ir/types/wire-types.js";
import { partsChildrenFirst } from "../../ir/util/containment-parent.js";
import { collectReachableTypes } from "../../ir/util/reachable-types.js";
import type { ClassifyContext, SingleFieldPattern } from "../../ir/validate/invariant-classify.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import { chainSingleFieldNative, refineClauseFor, takeSingleFieldChain } from "../zod-refine.js";

// ---------------------------------------------------------------------------
// Per-aggregate API module: Zod schemas + TanStack Query hooks.
//
// FRAMEWORK-NEUTRAL — lives in `_frontend/` because the React and Vue
// SPAs share it verbatim: the zod schemas mirror the backend's wire
// shape exactly (see generator/typescript/routes-builder.ts and
// dotnet/dto-mapping.ts), and TanStack Query's `useQuery` /
// `useMutation` / `useQueryClient` call surface is identical across
// `@tanstack/react-query` and `@tanstack/vue-query` — the only
// per-framework divergence is the import specifier, threaded through
// `ApiModuleOptions.queryPackage`.  Hooks parse the response with the
// matching schema before returning, so callers get type-checked,
// validated data — no `as never` casts.
// ---------------------------------------------------------------------------

/** Per-framework knobs for the shared api-module emitter. */
export interface ApiModuleOptions {
  /** TanStack Query package the hooks import from —
   *  `"@tanstack/react-query"` (default, byte-identical to the
   *  pre-extraction React output) or `"@tanstack/vue-query"`. */
  queryPackage?: string;
}

export function buildApiModule(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
  options: ApiModuleOptions = {},
): string {
  const queryPackage = options.queryPackage ?? "@tanstack/react-query";
  // Vue's reactivity is pull-based: a parameterised `find` query takes a
  // `MaybeRefOrGetter` so a bound filter input live-refetches (React
  // re-renders and passes fresh args every render — no wrapper needed).
  const isVueQuery = queryPackage === "@tanstack/vue-query";
  const hasParamFind = !!repo?.finds.some((f) => f.name !== "all");
  // A paged `all` (paged-by-default findAll, M-T2.6) also takes a
  // `MaybeRefOrGetter` query in the Vue hook, so it needs the same vue imports
  // even when there's no other parameterised find.
  const hasVueGetterHook =
    hasParamFind || !!repo?.finds.some((f) => f.name === "all" && pagedReturn(f.returnType));
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { z } from "zod";`);
  lines.push(`import { useQuery, useMutation, useQueryClient } from "${queryPackage}";`);
  if (isVueQuery && hasVueGetterHook) {
    lines.push(`import { type MaybeRefOrGetter, computed, toValue } from "vue";`);
  }
  lines.push(`import { api } from "./client";`);
  if (aggregateUsesMoneyDeep(agg, ctx.valueObjects)) {
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
  // .NET CreateRequest shapes.  Gated on `emitsRestCreate` (symmetric with
  // the `useDelete` / `canonicalDestroy` gate below): an aggregate with no
  // REST create surface emits neither the `Create<Agg>Request` schema nor
  // the `useCreate<Agg>` hook, so we never ship a create hook POSTing to a
  // route that doesn't exist.
  const restCreate = emitsRestCreate(agg);
  const requiredFields = createInputFields(agg);
  if (restCreate) {
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
    // Dual FormState/Payload aliases (frontend-acl.md Phase 3) — only when
    // the schema carries a real transform (a money field somewhere in the
    // create input), so `z.input` ≠ `z.output`.
    if (requiredFields.some((f) => typeReachesMoney(f.type, ctx))) {
      lines.push(...dualTypeAliases(`Create${agg.name}`));
    }
  }
  lines.push("");

  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    // Field-level invariants (SYS-1): the update/mutating-op client schema gets
    // the SAME wire constraints as create, mirroring the server DTO, so the
    // client form validates an update as strictly as a create.  `available =
    // op.params` drops any invariant over a field this op doesn't take.
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
    if (op.params.some((p) => typeReachesMoney(p.type, ctx))) {
      lines.push(...dualTypeAliases(`${upperFirst(op.name)}${agg.name}`));
    }
  }
  lines.push("");

  // Find queries.  `all` has no user params, but a PAGED `all` (paged-by-default
  // findAll, M-T2.6) still needs its page/pageSize/sort/dir query schema — so
  // skip only a NON-paged `all` (the legacy unbounded shape).
  if (repo) {
    for (const find of repo.finds) {
      if (find.name === "all" && !pagedReturn(find.returnType)) continue;
      lines.push(`export const ${upperFirst(find.name)}Query = z.object({`);
      for (const p of find.params) {
        lines.push(`  ${p.name}: ${zodForRequest(p.type)},`);
      }
      // A paged find gains 1-based `page`/`pageSize` + server-side `sort`/`dir`
      // controls (P3b / M-T2.6).  `sort`/`dir` are plain strings (bound directly
      // to the list's `sortKey`/`sortDir` state, which starts empty = unsorted);
      // the repository whitelists the column server-side (unknown → `id`), so the
      // boundary needs no enum — an enum here would reject the empty initial sort.
      if (pagedReturn(find.returnType)) {
        lines.push(
          `  page: z.coerce.number().int().min(1).default(${PAGED_DEFAULT_PAGE}),`,
          `  pageSize: z.coerce.number().int().min(1).default(${PAGED_DEFAULT_PAGE_SIZE}),`,
          `  sort: z.string().default("id"),`,
          `  dir: z.string().default("asc"),`,
        );
      }
      lines.push(`});`);
      lines.push(
        `export type ${upperFirst(find.name)}Query = z.infer<typeof ${upperFirst(find.name)}Query>;`,
      );
      // A paged query carries `.default()`ed `page`/`pageSize`, so its
      // z.input (what a caller supplies) ≠ z.output (post-default): the
      // controls are optional going in, required coming out.  Expose the
      // input shape so the hook signature lets callers omit them.
      if (pagedReturn(find.returnType)) {
        lines.push(
          `export type ${upperFirst(find.name)}QueryInput = z.input<typeof ${upperFirst(find.name)}Query>;`,
        );
      }
    }
  }
  lines.push("");

  // Response schemas.  Inner DTOs must come first so they're declared
  // before the root references them — and a nested part before the sibling
  // that references it (`z.array(LabelResponse)`), hence children-first.
  for (const part of partsChildrenFirst(agg.parts)) {
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
        // Integer pagination counters — match the backend wire contract
        // (every backend's OpenAPI types these `integer`; see the Hono
        // routes-builder paged schema).
        `export const ${paged.name} = z.object({ items: z.array(${zodForResponseInner(paged.arg)}), page: z.number().int(), pageSize: z.number().int(), total: z.number().int(), totalPages: z.number().int() });`,
      );
      lines.push(`export type ${paged.name} = z.infer<typeof ${paged.name}>;`);
    }
  }
  // Single-success union finds emit no discriminated-union DTO: the client
  // parses the success variant's `<Agg>Response` at 200, with the error/absent
  // variant surfaced as a thrown non-2xx (exception-less.md §4).  A tagged
  // `oneOf` DTO would only be needed for a genuine multi-success union (none
  // exist today; gated at IR validation).
  lines.push("");

  // Union-returning OPERATION response DTOs (async-actions-and-effects.md
  // Stage 2).  Unlike a union find, an `operation foo(): X or Err` serves the
  // FULL tagged union at 200 (the domain method returns `{ type, … }`, the
  // route `c.json(result, 200)`s it) — so a frontend action awaiting it and
  // discriminating with `match` needs the discriminated-union TYPE.  The client
  // never receives the error variant at 200 (it's intercepted into a
  // ProblemDetails non-2xx and reified from the thrown `ApiError` at the call
  // site), but the type carries every arm so the `switch (result.type)` narrows.
  let emittedUnionResponse = false;
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    if (!op.returnType) continue;
    const u = unionReturn(op.returnType);
    if (!u) continue;
    lines.push(...emitOperationUnionResponse(op.name, agg, u.variants, ctx));
    emittedUnionResponse = true;
  }
  // Only separate the union-response block from the Hooks section when one was
  // actually emitted — an aggregate with no `or`-union op stays byte-identical
  // to its pre-Stage-2 output (guards the baseline-fixture equivalence gate).
  if (emittedUnionResponse) lines.push("");

  // ---------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------
  const tag = snake(plural(agg.name));
  const aggKey = `["${tag}"]`;
  const detailKey = `["${tag}", id]`;

  // useAll<Agg> — paged-by-default (M-T2.6): the implicit `all` returns the
  // `<Agg>Paged` envelope and accepts page/pageSize/sort/dir query controls, so
  // the hook takes an (optional-with-defaults) query object whose values ride
  // the query key (distinct pages/sorts cache separately) + the URL query
  // string.  A user-declared `find all(): T[]` (non-paged) keeps the legacy
  // no-arg array shape.
  const allFind = repo?.finds.find((f) => f.name === "all");
  const allPaged = allFind ? pagedReturn(allFind.returnType) : null;
  if (allPaged) {
    if (isVueQuery) {
      lines.push(
        `export function useAll${plural(agg.name)}(query: MaybeRefOrGetter<AllQueryInput> = () => ({})) {`,
        `  const q = computed(() => AllQuery.parse(toValue(query)));`,
        `  return useQuery({`,
        `    queryKey: ["${tag}", "list", q],`,
        `    queryFn: async () => {`,
        `      const qs = new URLSearchParams(Object.entries(q.value).map(([k, v]) => [k, String(v)])).toString();`,
        `      const r = await api.get(\`/${tag}\${qs ? "?" + qs : ""}\`);`,
        `      return ${allPaged.name}.parse(r);`,
        `    },`,
        `  });`,
        `}`,
      );
    } else {
      lines.push(
        `export function useAll${plural(agg.name)}(query: AllQueryInput = {}) {`,
        `  const q = AllQuery.parse(query);`,
        `  return useQuery({`,
        `    queryKey: ["${tag}", "list", q],`,
        `    queryFn: async () => {`,
        `      const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();`,
        `      const r = await api.get(\`/${tag}\${qs ? "?" + qs : ""}\`);`,
        `      return ${allPaged.name}.parse(r);`,
        `    },`,
        `  });`,
        `}`,
      );
    }
  } else {
    lines.push(`export function useAll${plural(agg.name)}() {`);
    lines.push(`  return useQuery({`);
    lines.push(`    queryKey: ${aggKey},`);
    lines.push(`    queryFn: async () => {`);
    lines.push(`      const r = await api.get(\`/${tag}\`);`);
    lines.push(`      return ${agg.name}ListResponse.parse(r);`);
    lines.push(`    },`);
    lines.push(`  });`);
    lines.push(`}`);
  }
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

  // useCreate<Agg> — gated on the REST create surface (`emitsRestCreate`),
  // symmetric with `useDelete` below: no canonical create ⇒ no POST route ⇒
  // no create hook.
  if (restCreate) {
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
  }

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
    const u = op.returnType ? unionReturn(op.returnType) : null;
    lines.push(`export function use${upperFirst(op.name)}${agg.name}(id: string) {`);
    lines.push(`  const qc = useQueryClient();`);
    lines.push(`  return useMutation({`);
    lines.push(`    mutationFn: async (input: ${upperFirst(op.name)}${agg.name}Request) => {`);
    if (u) {
      // Union-returning op: parse + RETURN the tagged success variant so the
      // awaiting action's `match` arm carries the payload (the error variant
      // never reaches 200 — it's a thrown non-2xx reified at the call site).
      lines.push(`      const r = await api.post(\`/${tag}/\${id}/${opSnake}\`, input);`);
      lines.push(`      return ${upperFirst(op.name)}${agg.name}Response.parse(r);`);
    } else {
      lines.push(`      await api.post(\`/${tag}/\${id}/${opSnake}\`, input);`);
    }
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
      const isList = find.returnType.kind === "array";
      // A single-success union find (`Agg or Err`) returns the success variant
      // directly at 200 — the error/absent variant is a thrown non-2xx — so the
      // client parses `<Agg>Response`, identical to a plain find (mirrors the
      // backend route; exception-less.md §4).
      const responseSchema = paged
        ? paged.name
        : isList
          ? `${agg.name}ListResponse`
          : find.returnType.kind === "optional"
            ? `${agg.name}Response.nullable()`
            : `${agg.name}Response`;
      // Paged finds accept the caller-facing input shape (page/pageSize
      // optional via their wire defaults); other finds have no input/output
      // divergence, so the plain (z.infer) Query type is precise.
      const queryType = paged
        ? `${upperFirst(find.name)}QueryInput`
        : `${upperFirst(find.name)}Query`;
      if (isVueQuery) {
        // Reactive: the arg is a getter/ref; `computed(toValue)` makes
        // the query key (and fetch) track its source so a bound filter
        // input live-refetches.
        lines.push(
          `export function use${upperFirst(find.name)}${agg.name}(query: MaybeRefOrGetter<${queryType}>) {`,
        );
        lines.push(`  const queryArgs = computed(() => toValue(query));`);
        lines.push(`  return useQuery({`);
        lines.push(`    queryKey: ["${tag}", "find", "${findSnake}", queryArgs],`);
        lines.push(`    queryFn: async () => {`);
        lines.push(
          `      const qs = new URLSearchParams(Object.entries(queryArgs.value).map(([k, v]) => [k, String(v)])).toString();`,
        );
        lines.push(
          `      const r = await api.get(\`/${tag}/${findSnake}\${qs ? "?" + qs : ""}\`);`,
        );
        lines.push(`      return ${responseSchema}.parse(r);`);
        lines.push(`    },`);
        lines.push(`  });`);
        lines.push(`}`);
        lines.push("");
        continue;
      }
      lines.push(`export function use${upperFirst(find.name)}${agg.name}(query: ${queryType}) {`);
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

// ---------------------------------------------------------------------------
// Schema emission helpers
// ---------------------------------------------------------------------------

/** The `<Op><Agg>Response` discriminated-union DTO for a union-returning
 *  operation (async-actions-and-effects.md Stage 2).  Each variant is tagged on
 *  the wire `type` discriminator (the cross-backend P4 convention): a success
 *  entity/value-object extends its response schema with the `type` literal; an
 *  error payload becomes a `z.object` of its own fields (never parsed at 200 —
 *  it exists so the arm binding + reification cast typecheck).  Emitted after
 *  the aggregate's response schemas so `<Agg>Response.extend(…)` resolves. */
export function emitOperationUnionResponse(
  opName: string,
  agg: AggregateIR,
  variants: TypeIR[],
  ctx: BoundedContextIR,
): string[] {
  const name = `${upperFirst(opName)}${agg.name}Response`;
  const member = (v: TypeIR): string => {
    const tag = variantTag(v);
    const literal = `type: z.literal(${JSON.stringify(tag)})`;
    if (v.kind === "entity") {
      const payload = ctx.payloads.find((p) => p.name === v.name);
      if (payload?.kind === "error") {
        // Error variant — a `z.object` of the payload's own fields plus the tag.
        const fields = payload.fields.map(
          (f) => `${f.name}: ${zodForResponse(f.type, !!f.optional)}`,
        );
        return `z.object({ ${[literal, ...fields].join(", ")} })`;
      }
      // Success entity (typically the aggregate) — extend its response schema.
      return `${v.name}Response.extend({ ${literal} })`;
    }
    if (v.kind === "valueobject") return `${v.name}Schema.extend({ ${literal} })`;
    // Scalar / id / none variant — the tagged `{ type, value? }` carrier.
    if (v.kind === "none") return `z.object({ ${literal} })`;
    return `z.object({ ${literal}, value: ${zodForResponse(v, false)} })`;
  };
  return [
    `export const ${name} = z.discriminatedUnion("type", [`,
    ...variants.map((v) => `  ${member(v)},`),
    `]);`,
    `export type ${name} = z.infer<typeof ${name}>;`,
  ];
}

function emitEnumSchema(e: EnumIR): string[] {
  const values = e.values.map((v) => `"${v}"`).join(", ");
  return [`export const ${e.name}Schema = z.enum([${values}]);`];
}

function emitValueObjectSchema(vo: ValueObjectIR): string[] {
  return emitObjectWithRefines(
    `${vo.name}Schema`,
    vo.fields.map((f) => ({ name: f.name, base: zodForResponseInner(f.type) })),
    vo.invariants,
    new Set(vo.fields.map((f) => f.name)),
  );
}

// ---------------------------------------------------------------------------
// `z.object({ ... }).refine(...)` emitter shared by request / VO schemas.
//
// Splits invariants into two buckets:
//   1. recognised single-field shapes — absorbed into the inner field's
//      zod chain (`z.number().min(N)`, `z.string().length(N)`, etc.) so
//      the published JSON-Schema body shape stays correct.
//   2. everything else — emitted as `.refine((data) => ..., { path,
//      message })` chains on the object schema; RHF reads `path` to
//      surface the error inline next to the right input.
//
// Used by all three wire-validator emission sites (Create<Agg>Request,
// <Op>Request, <VO>Schema).  Response schemas don't get refines:
// responses come from a server that already enforced invariants.
// ---------------------------------------------------------------------------
function emitObjectWithRefines(
  exportName: string,
  fields: { name: string; base: string }[],
  invariants: InvariantIR[],
  available: ReadonlySet<string>,
): string[] {
  const ctx: ClassifyContext = { available };
  const chainByField = new Map<string, SingleFieldPattern[]>();
  const remaining: InvariantIR[] = [];
  for (const inv of invariants) {
    const taken = takeSingleFieldChain(inv, ctx);
    if (taken) {
      const list = chainByField.get(taken.field) ?? [];
      list.push(taken.pattern);
      chainByField.set(taken.field, list);
    } else {
      remaining.push(inv);
    }
  }
  const refines = remaining
    .map((inv) => refineClauseFor(inv, ctx))
    .filter((s): s is string => s !== null);

  const out: string[] = [];
  out.push(`export const ${exportName} = z.object({`);
  for (const f of fields) {
    let schema = f.base;
    const patterns = chainByField.get(f.name);
    if (patterns) {
      for (const p of patterns) schema = chainSingleFieldNative(schema, p);
    }
    out.push(`  ${f.name}: ${schema},`);
  }
  out.push(`})${refines.join("")};`);
  return out;
}

/** Operation preconditions are the wire-translatable rules for an
 *  `<Op>Request`.  Lift each `precondition <expr>` statement to an
 *  `InvariantIR` so the same classification + refine pipeline
 *  handles it.  Other statement kinds (assigns / emits / etc.) don't
 *  contribute to wire validation. */
function preconditionsAsInvariants(op: OperationIR): InvariantIR[] {
  const out: InvariantIR[] = [];
  for (const s of op.statements) {
    if (s.kind === "precondition") {
      out.push({ expr: s.expr, source: s.source });
    }
  }
  return out;
}

function emitResponseSchema(
  ent: EnrichedAggregateIR | EnrichedEntityPartIR,
  ctx: BoundedContextIR,
  isAgg: boolean,
): string[] {
  const lines: string[] = [];
  const name = `${ent.name}Response`;
  lines.push(`export const ${name} = z.object({`);
  // Single canonical walk — `wireFieldsFor` recomputes the wire shape from the
  // enriched node's fields (the scaffold-time helper in wire-projection.ts).
  // Backends + frontend all read the same field list, so Zod schemas line up
  // field-for-field with what the wire actually carries.  `forApiRead` strips
  // `internal` and `secret` fields so the response schema matches what the
  // .NET and Hono backends actually serve.
  const fields = forApiRead(wireFieldsFor(ent));
  void ctx;
  void isAgg;
  for (const wf of fields) {
    if (wf.source === "id") {
      lines.push(`  ${wf.name}: z.string(),`);
    } else {
      lines.push(`  ${wf.name}: ${zodForResponse(wf.type, wf.optional)},`);
    }
  }
  lines.push(`});`);
  lines.push(`export type ${name} = z.infer<typeof ${name}>;`);
  return lines;
}

// ---------------------------------------------------------------------------
// Type → Zod helpers
// ---------------------------------------------------------------------------

// Form inputs hand back native JS types where Mantine has a typed
// primitive (number, boolean), and ISO strings for datetime — we use a
// plain <input type="datetime-local"> so values are easy to fill from
// Playwright tests.  JSON.stringify passes numbers and strings through
// untouched, so the request map is the same as response on most
// primitives — only money diverges (`moneySchema` inbound for the
// decimal.js parse chain; `moneySchema` outbound too because the
// response form already produces decimal-string JSON).

const REQUEST_PRIMITIVE: Record<WirePrimitive, string> = {
  int: "z.number().int()",
  long: "z.number().int()",
  decimal: "z.number()",
  money: "moneySchema",
  string: "z.string()",
  bool: "z.boolean()",
  datetime: "z.string()",
  guid: "z.string()",
  json: "z.unknown()",
};

const RESPONSE_PRIMITIVE: Record<WirePrimitive, string> = {
  int: "z.number().int()",
  long: "z.number().int()",
  decimal: "z.number()",
  money: "moneySchema",
  string: "z.string()",
  bool: "z.boolean()",
  datetime: "z.string()",
  guid: "z.string()",
  json: "z.unknown()",
};

/** True when a request field's type reaches the `money` primitive —
 *  directly, through array/optional wrappers, or inside a value object.
 *  Money is the one wire type whose schema TRANSFORMS on parse
 *  (`moneySchema`: decimal string → Decimal), so it gates the dual
 *  FormState/Payload aliases (frontend-acl.md Phase 3 — emitted only
 *  where `z.input` and `z.output` genuinely diverge; structurally
 *  identical aliases would be noise). */
function typeReachesMoney(t: TypeIR, ctx: BoundedContextIR): boolean {
  if (t.kind === "primitive") return t.name === "money";
  if (t.kind === "array") return typeReachesMoney(t.element, ctx);
  if (t.kind === "optional") return typeReachesMoney(t.inner, ctx);
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    return (vo?.fields ?? []).some((f) => typeReachesMoney(f.type, ctx));
  }
  return false;
}

/** The dual-type aliases for a transform-bearing action schema
 *  (frontend-acl.md Phase 3): `FormState` is what a form holds
 *  (`z.input` — money fields are decimal strings pre-parse), `Payload`
 *  what the API client sends after parse (`z.output` — Decimal). */
function dualTypeAliases(name: string): string[] {
  return [
    `/** Pre-parse form shape (z.input) — money fields are decimal strings. */`,
    `export type ${name}FormState = z.input<typeof ${name}Request>;`,
    `/** Post-parse payload shape (z.output) — money fields are Decimal. */`,
    `export type ${name}Payload = z.output<typeof ${name}Request>;`,
  ];
}

function zodForRequest(t: TypeIR): string {
  const info = wireTypeInfo(t, "request");
  if (info.isNullable) return `${zodForRequest(peelNullable(t))}.nullish()`;
  if (info.isCollection) return `z.array(${zodForRequest(peelCollection(t))})`;
  switch (info.refKind) {
    case "primitive":
      return REQUEST_PRIMITIVE[info.primitive!];
    case "id":
      return "z.string()";
    case "enum":
    case "valueObject":
      return `${info.base}Schema`;
    case "entity":
      return "z.unknown()";
  }
}

export function zodForResponse(t: TypeIR, optional: boolean): string {
  const z = zodForResponseInner(t);
  return optional ? `${z}.nullish()` : z;
}

function zodForResponseInner(t: TypeIR): string {
  // Inline discriminated union (`A or B`) → its emitted `<Name>Schema` (the
  // schema is emitted per find return that uses it).
  if (t.kind === "union") return unionInstanceName(t.variants);
  const info = wireTypeInfo(t, "response");
  if (info.isNullable) return `${zodForResponseInner(peelNullable(t))}.nullish()`;
  if (info.isCollection) return `z.array(${zodForResponseInner(peelCollection(t))})`;
  switch (info.refKind) {
    case "primitive":
      return RESPONSE_PRIMITIVE[info.primitive!];
    case "id":
      return "z.string()";
    case "enum":
    case "valueObject":
      return `${info.base}Schema`;
    case "entity":
      return `${info.base}Response`;
  }
}

// Collect every value object and enum whose schema this aggregate's api
// module must declare.  Traversal is TRANSITIVE through value-object
// fields: an emitted `<VO>Schema = z.object({...})` references the schema
// of each field's type (`country: CountrySchema`), so a VO reached only
// through another VO — e.g. `Address.country` pulling in the `Country`
// enum — must be emitted too.  Without the closure those references
// resolve to undeclared variables at bundle time ("Can't find variable:
// CountrySchema").
function collectUsedTypes(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): { valueObjects: ValueObjectIR[]; enums: EnumIR[] } {
  const seeds = function* (): Generator<TypeIR> {
    for (const f of agg.fields) yield f.type;
    for (const d of agg.derived) yield d.type;
    for (const op of agg.operations) for (const p of op.params) yield p.type;
    for (const f of repo?.finds ?? []) for (const p of f.params) yield p.type;
    for (const part of agg.parts) {
      for (const f of part.fields) yield f.type;
      for (const d of part.derived) yield d.type;
    }
  };
  const { valueObjects, enums } = collectReachableTypes(seeds(), ctx.valueObjects);
  return {
    valueObjects: ctx.valueObjects.filter((v) => valueObjects.has(v.name)),
    enums: ctx.enums.filter((e) => enums.has(e.name)),
  };
}
