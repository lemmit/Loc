// ---------------------------------------------------------------------------
// Frontend zod-schema emission — the framework-neutral half of the
// per-aggregate API module builders.  Shared by the React and Svelte
// generators: both emit byte-identical zod request/response/VO/enum/
// union schemas (the wire contract is framework-independent); only
// the data-fetching layer around them differs (React Query hooks vs
// svelte-query factories).  Extracted verbatim from
// src/generator/react/api-builder.ts.
// ---------------------------------------------------------------------------

import { forApiRead, wireFieldsFor } from "../../ir/enrich/wire-projection.js";
import { unionInstanceName } from "../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  EnrichedEntityPartIR,
  EnumIR,
  InvariantIR,
  OperationIR,
  RepositoryIR,
  TypeIR,
  ValueObjectIR,
} from "../../ir/types/loom-ir.js";
import {
  peelCollection,
  peelNullable,
  type WirePrimitive,
  wireTypeInfo,
} from "../../ir/types/wire-types.js";
import { collectReachableTypes } from "../../ir/util/reachable-types.js";
import type { ClassifyContext, SingleFieldPattern } from "../../ir/validate/invariant-classify.js";
import {
  discriminatedUnionZod,
  type UnionMemberField,
  unionMemberObjects,
  unionMembers,
} from "../_payload/union-wire.js";
import { chainSingleFieldNative, refineClauseFor, takeSingleFieldChain } from "../zod-refine.js";

// ---------------------------------------------------------------------------
// Schema emission helpers
// ---------------------------------------------------------------------------

export function emitEnumSchema(e: EnumIR): string[] {
  const values = e.values.map((v) => `"${v}"`).join(", ");
  return [`export const ${e.name}Schema = z.enum([${values}]);`];
}

export function emitValueObjectSchema(vo: ValueObjectIR): string[] {
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
export function emitObjectWithRefines(
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
export function preconditionsAsInvariants(op: OperationIR): InvariantIR[] {
  const out: InvariantIR[] = [];
  for (const s of op.statements) {
    if (s.kind === "precondition") {
      out.push({ expr: s.expr, source: s.source });
    }
  }
  return out;
}

export function emitResponseSchema(
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

export function zodForRequest(t: TypeIR): string {
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

/** A find whose return type is a discriminated union — either an inline `A or
 *  B` (`union` TypeIR) or a reference to a named `payload Foo = …` (resolved to
 *  an `entity` marker backed by a union `PayloadIR`).  Returns the schema name
 *  + variants, or null. */
export function unionForFind(
  t: TypeIR,
  ctx: BoundedContextIR,
): { name: string; variants: TypeIR[] } | null {
  if (t.kind === "union") return { name: unionInstanceName(t.variants), variants: t.variants };
  if (t.kind === "entity") {
    const p = ctx.payloads.find((pl) => pl.name === t.name && pl.variants);
    if (p?.variants) return { name: p.name, variants: p.variants };
  }
  return null;
}

/** Emit `export const <Name>Schema = z.discriminatedUnion("type", […])` + its
 *  inferred type.  Record variants flatten their wire fields; scalars wrap a
 *  `value`; `none` is bare. */
export function emitUnionSchema(name: string, variants: TypeIR[], ctx: BoundedContextIR): string[] {
  const fieldZod = (f: UnionMemberField): string =>
    f.isId ? "z.string()" : zodForResponse(f.type, f.optional);
  const members = unionMemberObjects(unionMembers(variants, ctx), fieldZod, zodForResponseInner);
  return [
    `export const ${name} = ${discriminatedUnionZod(members)};`,
    `export type ${name} = z.infer<typeof ${name}>;`,
  ];
}

export function zodForResponseInner(t: TypeIR): string {
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
export function collectUsedTypes(
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
