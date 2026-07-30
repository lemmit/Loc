// ---------------------------------------------------------------------------
// Typed in-system api client (M-T4.8 slice 3) — the Hono caller half.
//
// For a `resource { kind: api, use: <Api> }`, emit one typed function per
// operation the CALLEE exposes, instead of the untyped `get(path): json` /
// `post(path, body): json` verbs the `storage restApi` binding carries.
//
// Two properties make this worth generating rather than hand-writing:
//
//   1. The operation set comes from `deriveContextOperations` — the same
//      derivation the callee's own route builder answers to.  A path can't
//      drift from what the callee actually mounts, which is the failure the
//      untyped path allowed (a hand-written "/orders/{id}" compiled clean and
//      404'd at runtime).
//   2. The response schema comes from `emitResponseSchema`, which walks
//      `forApiRead(wireFieldsFor(agg))` — literally the field list the callee
//      serializes.  So the caller parses exactly what the callee sends, and a
//      wire-shape change breaks the caller at build time.
//
// The base URL rides `resourceEnvUrlVar`, the same seam `src/system/index.ts`
// injects into compose.  A drift there is invisible at compile time, which is
// why both sides read one helper.
// ---------------------------------------------------------------------------

import { zodForResponse } from "../../../../generator/_frontend/zod-schemas.js";
import { forApiRead, wireFieldsForAggregate } from "../../../../ir/enrich/wire-projection.js";
import type { AggregateIR, SystemIR, TypeIR } from "../../../../ir/types/loom-ir.js";
import {
  type ApiResourceBinding,
  servedContextsFor,
} from "../../../../ir/util/api-resource-binding.js";
import {
  type ApiOperationIR,
  absenceUnionSuccess,
  collectionSuccess,
  deriveContextOperations,
} from "../../../../ir/util/api-surface.js";
import { resourceEnvUrlVar } from "../../../../util/resource-env.js";

/** The aggregate an operation answers with, looked up ACROSS the system — the
 *  callee's context belongs to another deployable, so it isn't in the caller's
 *  own `contexts`. */
function aggregateNamed(sys: SystemIR, name: string): AggregateIR | undefined {
  for (const sd of sys.subdomains) {
    for (const ctx of sd.contexts) {
      const agg = ctx.aggregates.find((a) => a.name === name);
      if (agg) return agg;
    }
  }
  return undefined;
}

/** TS parameter type for one operation parameter.  Ids and every scalar the
 *  path/query can carry are strings on the wire; a body param takes the
 *  callee's request shape, which we keep as the zod-inferred type. */
function tsParamType(t: TypeIR): string {
  if (t.kind === "id") return "string";
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
      case "decimal":
        return "number";
      case "bool":
        return "boolean";
      default:
        return "string";
    }
  }
  // An entity-typed body is the callee's createInput projection.  Typing it
  // properly means emitting that projection's schema on the caller side —
  // real work, and not what slice 3 promised — so it stays `unknown` rather
  // than pretending to a precision the emitter does not have.
  return "unknown";
}

/** Interpolate `{id}` placeholders against the operation's path params. */
function pathExpr(op: ApiOperationIR): string {
  let out = op.path;
  for (const p of op.params) {
    if (p.location !== "path") continue;
    out = out.replace(`{${p.name}}`, `\${encodeURIComponent(String(${p.name}))}`);
  }
  return `\`${out}\``;
}

/** Zod schema for an aggregate's read wire shape.
 *
 *  Deliberately built from `forApiRead(wireFieldsForAggregate(agg))` — the same
 *  walk the CALLEE's own response emitter uses — rather than from
 *  `_frontend/emitResponseSchema`, whose parameter is branded
 *  `EnrichedAggregateIR`.  The brand is stricter than the real dependency
 *  (`wireFieldsForAggregate` takes a plain `AggregateIR` and recomputes from
 *  `agg.fields`), and the Hono emitter only receives `SystemIR`.  Casting to
 *  the brand to satisfy a requirement the code does not actually have is how
 *  the `as Storage` bug in `checkDataSource` happened; this stays honest
 *  instead, at the cost of a dozen lines. */
function responseSchema(agg: AggregateIR, schemaName: string): string[] {
  const lines: string[] = [`export const ${schemaName} = z.object({`];
  for (const wf of forApiRead(wireFieldsForAggregate(agg))) {
    lines.push(
      wf.source === "id"
        ? `  ${wf.name}: z.string(),`
        : `  ${wf.name}: ${zodForResponse(wf.type, wf.optional)},`,
    );
  }
  lines.push(`});`);
  return lines;
}

/** Emit the typed client module for every api-bound resource this deployable
 *  wires.  Empty when it wires none — the gate that keeps existing projects
 *  byte-identical. */
export function emitApiClientModule(
  bindings: readonly ApiResourceBinding[],
  sys: SystemIR,
): string[] {
  if (bindings.length === 0) return [];
  const out: string[] = [];
  out.push(`import { z } from "zod";`);
  out.push(``);
  out.push(`/** Raised when an in-system call answers with a status the callee's`);
  out.push(` *  contract doesn't describe as a success.  Carries the status so a`);
  out.push(` *  caller can branch on it rather than string-matching a message. */`);
  out.push(`export class RemoteCallError extends Error {`);
  out.push(`  constructor(`);
  out.push(`    readonly resource: string,`);
  out.push(`    readonly operationId: string,`);
  out.push(`    readonly status: number,`);
  out.push(`  ) {`);
  out.push("    super(`in-system call ${resource}.${operationId} failed with status ${status}`);");
  out.push(`  }`);
  out.push(`}`);
  out.push(``);

  // One response schema per aggregate reached, emitted once and shared by every
  // operation that answers with it.
  const emittedSchemas = new Set<string>();

  for (const b of bindings) {
    const envVar = resourceEnvUrlVar(b.resource.name);
    const ops = servedContextsFor(b, sys).flatMap((ctx) => deriveContextOperations(ctx));
    out.push(`// ---- ${b.resource.name} → api '${b.apiName}' (served by '${b.server.name}')`);
    out.push(
      `export const ${b.resource.name}BaseUrl = process.env.${envVar} ?? "http://localhost:3000";`,
    );
    out.push(``);

    for (const op of ops) {
      // A union find answers the success body directly at 200 and rides the
      // absent variant on its own status — no `type` discriminator on the wire
      // (payloads.md §Union finds).  So it parses the SAME schema as a plain
      // entity response; only the absent status becomes `null` instead of a
      // throw.  Without this arm a union responseType fell through to `void`,
      // and the call site read fields off nothing.
      const absentAgg = absenceUnionSuccess(op.responseType);
      // A COLLECTION response carries the same per-row schema, wrapped: the
      // auto-`findAll` answers with the paged envelope, a declared `T[]` find
      // with a bare array.  Without this arm both fell through to `void` — the
      // client issued the request and discarded every row.
      const coll = collectionSuccess(op.responseType);
      const respAgg =
        op.responseType?.kind === "entity" ? op.responseType.name : (absentAgg ?? coll?.agg);
      const agg = respAgg ? aggregateNamed(sys, respAgg) : undefined;
      const schemaName = agg ? `${agg.name}Response` : undefined;
      if (agg && schemaName && !emittedSchemas.has(schemaName)) {
        emittedSchemas.add(schemaName);
        out.push(...responseSchema(agg, schemaName));
        out.push(``);
      }
      // The paged envelope is emitted once per aggregate, beside its row
      // schema.  Its field list mirrors the callee's `<Agg>Paged` exactly —
      // `{ items, page, pageSize, total, totalPages }`.
      // The SHIPPED create route answers `201 { id }` — not the whole entity
      // its declared responseType names.  Parsing the entity schema against
      // that body fails on every other field, which is a RUNTIME error a
      // compile gate cannot see (the client type-checks perfectly).
      const createName = agg && op.kind === "create" ? `${agg.name}Created` : undefined;
      if (createName && !emittedSchemas.has(createName)) {
        emittedSchemas.add(createName);
        out.push(`export const ${createName} = z.object({ id: z.string() });`, ``);
      }
      const pagedName = agg && coll?.carrier === "paged" ? `${agg.name}Paged` : undefined;
      if (pagedName && schemaName && !emittedSchemas.has(pagedName)) {
        emittedSchemas.add(pagedName);
        out.push(
          `export const ${pagedName} = z.object({ items: z.array(${schemaName}), page: z.number().int(), pageSize: z.number().int(), total: z.number().int(), totalPages: z.number().int() });`,
          ``,
        );
      }

      const bodyParams = op.params.filter((p) => p.location === "body");
      // Two body shapes, both derived (api-surface.ts): `create` carries ONE
      // whole-shape param (the createInput projection), while a domain
      // operation carries one param PER declared argument, which the callee
      // reads as a flat JSON object.  Sending the first body param alone —
      // which a naive `JSON.stringify(bodyParams[0])` does — silently drops
      // every argument after the first.
      const wholeShapeBody = bodyParams.length === 1 && bodyParams[0]?.type.kind === "entity";
      const params = op.params.map((p) => `${p.name}: ${tsParamType(p.type)}`);
      // The parsed shape and the declared return move together: whichever
      // schema the body is parsed against is the one the signature names.
      const parseSchema = createName ?? pagedName ?? schemaName;
      const returns = createName
        ? `z.infer<typeof ${createName}>`
        : pagedName
          ? `z.infer<typeof ${pagedName}>`
          : schemaName
            ? `z.infer<typeof ${schemaName}>${absentAgg ? " | null" : ""}${coll ? "[]" : ""}`
            : "void";
      const query = op.params.filter((p) => p.location === "query");

      out.push(
        `export async function ${b.resource.name}$${op.id}(${params.join(", ")}): Promise<${returns}> {`,
      );
      out.push(`  const url = new URL(${pathExpr(op)}, ${b.resource.name}BaseUrl);`);
      for (const q of query) {
        out.push(
          `  if (${q.name} !== undefined) url.searchParams.set(${JSON.stringify(q.name)}, String(${q.name}));`,
        );
      }
      out.push(`  const res = await fetch(url, {`);
      out.push(`    method: ${JSON.stringify(op.method.toUpperCase())},`);
      if (bodyParams.length > 0) {
        const payload = wholeShapeBody
          ? (bodyParams[0]?.name ?? "body")
          : `{ ${bodyParams.map((p) => p.name).join(", ")} }`;
        out.push(`    headers: { "content-type": "application/json" },`);
        out.push(`    body: JSON.stringify(${payload}),`);
      }
      out.push(`  });`);
      if (absentAgg) {
        // The absent variant is a VALUE, not a failure: `match o { Order x =>
        // …, else => … }` narrows on presence.  Every OTHER non-2xx is still a
        // real error.
        out.push(`  if (res.status === 404) return null;`);
      }
      out.push(
        `  if (!res.ok) throw new RemoteCallError(${JSON.stringify(b.resource.name)}, ${JSON.stringify(op.id)}, res.status);`,
      );
      if (parseSchema) {
        // Parse at the boundary: the callee's wire shape is a contract, and a
        // violation should fail here, not three frames deeper on a field read.
        // A bare-array find is wrapped at the parse site rather than given its
        // own named schema — there is no envelope to name.
        const expr =
          !createName && coll?.carrier === "array"
            ? `z.array(${parseSchema})`
            : (parseSchema as string);
        out.push(`  return ${expr}.parse(await res.json());`);
      }
      out.push(`}`);
      out.push(``);
    }
  }
  return out;
}
