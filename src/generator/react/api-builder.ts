import { wireShapeFor } from "../../ir/enrich/enrichments.js";
import { forApiRead, forCreateInput } from "../../ir/enrich/wire-projection.js";
import {
  type AggregateIR,
  aggregateUsesMoney,
  type BoundedContextIR,
  type EnrichedAggregateIR,
  type EnrichedEntityPartIR,
  type EntityPartIR,
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
import type { ClassifyContext, SingleFieldPattern } from "../../ir/validate/invariant-classify.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import {
  chainSingleFieldNative,
  refineClauseFor,
  takeSingleFieldChain,
} from "../typescript/zod-refine.js";

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
  const usedVOs = collectValueObjects(agg, repo, ctx);
  const usedEnums = collectEnums(agg, repo, ctx);

  for (const e of usedEnums) lines.push(...emitEnumSchema(e));
  for (const vo of usedVOs) lines.push(...emitValueObjectSchema(vo));
  lines.push("");

  // Request schemas.  `forCreateInput` drops server-controlled fields
  // (`managed`, `token`, `internal`) from the client-supplied payload,
  // keeping `immutable` (settable on create) and `secret` (client
  // provides password hashes / API keys).  Aligns with the Hono and
  // .NET CreateRequest shapes.
  const requiredFields = forCreateInput(agg.fields).filter((f) => !f.optional);
  lines.push(
    ...emitObjectWithRefines(
      `Create${agg.name}Request`,
      requiredFields.map((f) => ({ name: f.name, base: zodForRequest(f.type) })),
      agg.invariants,
      new Set(agg.fields.map((f) => f.name)),
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
      const isList = find.returnType.kind === "array";
      const responseSchema = isList
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
        `      const qs = new URLSearchParams(query as Record<string, string>).toString();`,
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
  // Single canonical walk — populated by `enrichLoomModel` (see
  // src/ir/enrich/enrichments.ts).  Backends + frontend all read the same
  // field list, so Zod schemas line up field-for-field with what
  // the wire actually carries.  `forApiRead` strips `internal` and
  // `secret` fields so the React response schema matches what the
  // .NET and Hono backends actually serve.
  const fields = forApiRead(wireShapeFor(ent));
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

function zodForResponse(t: TypeIR, optional: boolean): string {
  const z = zodForResponseInner(t);
  return optional ? `${z}.nullish()` : z;
}

function zodForResponseInner(t: TypeIR): string {
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

function collectValueObjects(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): ValueObjectIR[] {
  const used = new Set<string>();
  const visit = (t: TypeIR) => {
    if (t.kind === "valueobject") used.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const f of agg.fields) visit(f.type);
  for (const d of agg.derived) visit(d.type);
  for (const op of agg.operations) for (const p of op.params) visit(p.type);
  for (const f of repo?.finds ?? []) for (const p of f.params) visit(p.type);
  for (const part of agg.parts) {
    for (const f of part.fields) visit(f.type);
    for (const d of part.derived) visit(d.type);
  }
  return ctx.valueObjects.filter((v) => used.has(v.name));
}

function collectEnums(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): EnumIR[] {
  const used = new Set<string>();
  const visit = (t: TypeIR) => {
    if (t.kind === "enum") used.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const f of agg.fields) visit(f.type);
  for (const d of agg.derived) visit(d.type);
  for (const op of agg.operations) for (const p of op.params) visit(p.type);
  for (const f of repo?.finds ?? []) for (const p of f.params) visit(p.type);
  for (const part of agg.parts) {
    for (const f of part.fields) visit(f.type);
    for (const d of part.derived) visit(d.type);
  }
  return ctx.enums.filter((e) => used.has(e.name));
}
