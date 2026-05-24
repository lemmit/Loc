import { renderHonoLogCall } from "../../../generator/_obs/render-hono.js";
import {
  chainSingleFieldNative,
  refineClauseFor,
  takeSingleFieldChain,
} from "../../../generator/typescript/zod-refine.js";
import { wireShapeFor } from "../../../ir/enrichments.js";
import type { ClassifyContext, SingleFieldPattern } from "../../../ir/invariant-classify.js";
import type {
  AggregateIR,
  BoundedContextIR,
  EntityPartIR,
  EnumIR,
  FindIR,
  InvariantIR,
  OperationIR,
  RepositoryIR,
  TypeIR,
  ValueObjectIR,
} from "../../../ir/loom-ir.js";
import {
  aggregateUsesMoney,
  findUsesCurrentUser,
  operationUsesCurrentUser,
} from "../../../ir/loom-ir.js";
import { opHasProvSite } from "../../../ir/prov-id.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";

// ---------------------------------------------------------------------------
// Hono routes file with OpenAPI annotations.
//
// Uses `@hono/zod-openapi`'s `OpenAPIHono` + `createRoute({...})` so every
// route is fully typed and self-describes via /openapi.json.  The response
// shape is the full wire DTO — root id + every field + nested DTOs for
// contained parts and value objects + derived values — so a frontend can
// render real data, not just the row's primary key.
//
// The wire shape is symmetric with the .NET path: same field set, same
// nesting, same casing.  The cross-check e2e test diffs the two specs to
// catch drift.
// ---------------------------------------------------------------------------

export function buildRoutesFile(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
  emitAudit = false,
  emitProvenance = false,
  emitTrace = false,
): string {
  // An audited public operation instruments its route handler with a
  // `recordAudit(...)` call; the SDK file (`domain/audit.ts`) is only
  // emitted when some operation is audited, so the import is gated on the
  // same presence to keep "auditing off pays nothing".
  const auditOps = emitAudit
    ? agg.operations.filter((o) => o.audited && o.visibility === "public")
    : [];
  const fileHasAudit = auditOps.length > 0;
  // A provenanced write needs the same save+flush transaction: the
  // operation's `provenance_records` history rows must commit atomically
  // with the state change.  Detected by presence of a write-site (mirrors
  // emitProvenance), so an op that's neither audited nor provenanced keeps
  // the plain non-transactional handler.
  const provOps = emitProvenance
    ? agg.operations.filter((o) => o.visibility === "public" && opHasProvSite(o))
    : [];
  const fileHasProv = provOps.length > 0;
  // The co-located lineage surface (response DTO field + the shared
  // `ProvenanceLineage` schema) follows the field's existence, not whether
  // it is ever written — so a never-written provenanced field still emits
  // a (perpetually null) column and DTO key.
  const fileHasProvField =
    emitProvenance &&
    (agg.fields.some((f) => f.provenanced) ||
      agg.parts.some((p) => p.fields.some((f) => f.provenanced)));
  // Either feature pulls in the transactional handler + its db/events/
  // schema/randomUUID imports.
  const needsTx = fileHasAudit || fileHasProv;
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  if (aggregateUsesMoney(agg)) {
    lines.push(`import Decimal from "decimal.js";`);
  }
  lines.push(`import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";`);
  lines.push(`import { ${agg.name} } from "../domain/${lowerFirst(agg.name)}";`);
  lines.push(
    `import type { ${agg.name}Repository } from "../db/repositories/${lowerFirst(agg.name)}-repository";`,
  );
  lines.push(`import * as Ids from "../domain/ids";`);
  lines.push(
    `import { DomainError, AggregateNotFoundError, ForbiddenError, ExternHandlerError } from "../domain/errors";`,
  );
  // Extern handler registry — the per-aggregate file is always emitted
  // when the aggregate has at least one extern op, never imported when
  // it has none.  Type-only import keeps the route file fine when
  // there are no extern ops; the runtime ref is gated below.
  if (agg.operations.some((o) => o.extern)) {
    lines.push(`import { externHandlers } from "../domain/${lowerFirst(agg.name)}-extern";`);
  }
  if (needsTx) {
    // Audited / provenanced operations write extra rows per successful
    // invocation, inside the same transaction as the aggregate save.
    // Needs the schema tables (runtime value), a UUID, and the db/events
    // types for the transactional repo (mirrors the workflow routes' imports).
    lines.push(`import { randomUUID } from "node:crypto";`);
    lines.push(`import * as schema from "../db/schema";`);
    lines.push(`import { type DomainEventDispatcher } from "../domain/events";`);
    lines.push(`import type { NodePgDatabase } from "drizzle-orm/node-postgres";`);
  }

  // Schemas — value objects, enums, then per-DTO request / response
  // shapes.  Named via `.openapi("Foo")` so they appear in the spec's
  // `components.schemas` section (referenced rather than inlined).
  const usedVOs = collectUsedValueObjects(agg, repo, ctx);
  const usedEnums = collectUsedEnums(agg, repo, ctx);
  // Value objects are constructed inside route handlers
  // (`new Money(...)` from the validated body), so the runtime classes
  // must be in scope.  Enums travel as strings on the wire — no
  // import needed.
  if (usedVOs.length > 0) {
    lines.push(
      `import { ${usedVOs.map((v) => v.name).join(", ")} } from "../domain/value-objects";`,
    );
  }
  lines.push("");

  for (const e of usedEnums) {
    const values = e.values.map((v) => `"${v}"`).join(", ");
    lines.push(`const ${e.name}Schema = z.enum([${values}]).openapi("${e.name}");`);
  }
  for (const vo of usedVOs) {
    lines.push(
      ...emitWireSchema(
        `const ${vo.name}Schema`,
        `${vo.name}`,
        vo.fields.map((f) => ({ name: f.name, base: zodFor(f.type) })),
        vo.invariants,
        new Set(vo.fields.map((f) => f.name)),
      ),
    );
  }
  lines.push("");

  // Request schemas — Create, per-public-operation, per-find query.
  const requiredFields = agg.fields.filter((f) => !f.optional);
  lines.push(
    ...emitWireSchema(
      `const Create${agg.name}Request`,
      `Create${agg.name}Request`,
      requiredFields.map((f) => ({ name: f.name, base: zodFor(f.type) })),
      agg.invariants,
      new Set(agg.fields.map((f) => f.name)),
    ),
  );
  lines.push(
    `const Create${agg.name}Response = z.object({ id: z.string() }).openapi("Create${agg.name}Response");`,
  );
  lines.push("");

  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    lines.push(
      ...emitWireSchema(
        `const ${upperFirst(op.name)}Request`,
        `${upperFirst(op.name)}Request`,
        op.params.map((p) => ({ name: p.name, base: zodFor(p.type) })),
        preconditionsAsInvariants(op),
        new Set(op.params.map((p) => p.name)),
      ),
    );
  }
  lines.push("");

  if (repo) {
    for (const find of repo.finds) {
      // Only emit a Query schema when the find takes parameters — the route
      // (route emitter, ~line 475) is gated the same way, so an empty
      // `<Find>Query = z.object({})` would be dead code.
      if (find.params.length === 0) continue;
      lines.push(`const ${upperFirst(find.name)}Query = z.object({`);
      for (const p of find.params) {
        lines.push(`  ${p.name}: ${zodFor(p.type)},`);
      }
      lines.push(`}).openapi("${upperFirst(find.name)}Query");`);
    }
  }

  // Co-located provenance lineage schema, referenced (nullable) by every
  // provenanced field's `<field>_provenance` key.  A concrete object
  // schema rather than `z.unknown()` — the latter collapses zod-openapi's
  // response `_data` type to `never`.
  if (fileHasProvField) {
    lines.push(
      `const ProvenanceLineage = z.object({ snapshotId: z.string(), target: z.object({ type: z.string(), field: z.string() }), inputs: z.array(z.object({ path: z.string(), value: z.unknown() })), computedValue: z.unknown() }).openapi("ProvenanceLineage");`,
    );
    lines.push("");
  }

  // Response DTOs — parts first (inner), value-object response variants
  // (already declared above as <Vo>Schema; re-used), then the aggregate
  // root.  Forward references aren't possible in zod, so the order
  // matters: parts referenced from the root must be declared first.
  // Aggregate-level + part-level response schemas are exported so
  // the per-context views router (`http/views.ts`) can reuse them
  // verbatim without duplicating field-by-field declarations.
  for (const part of agg.parts) {
    lines.push(...emitResponseDtoSchema(part, ctx, /*isAgg*/ false));
  }
  lines.push(...emitResponseDtoSchema(agg, ctx, /*isAgg*/ true));
  lines.push(
    `export const ${agg.name}ListResponse = z.array(${agg.name}Response).openapi("${agg.name}ListResponse");`,
  );
  lines.push(`const ErrorResponse = z.object({ error: z.string() }).openapi("ErrorResponse");`);
  lines.push("");

  // The router.  Audited / provenanced aggregates also receive `db` +
  // `events` so the operation can run its save + audit insert + provenance
  // flush in one transaction.
  const routerParams = needsTx
    ? `repo: ${agg.name}Repository, db: NodePgDatabase<typeof schema>, events: DomainEventDispatcher`
    : `repo: ${agg.name}Repository`;
  lines.push(`export function ${lowerFirst(agg.name)}Routes(${routerParams}): OpenAPIHono {`);
  lines.push(`  const app = new OpenAPIHono();`);
  lines.push("");

  // Create.
  lines.push(`  app.openapi(`);
  lines.push(`    createRoute({`);
  lines.push(`      method: "post",`);
  lines.push(`      path: "/",`);
  lines.push(`      tags: ["${snake(plural(agg.name))}"],`);
  lines.push(`      operationId: "create${agg.name}",`);
  lines.push(`      request: {`);
  lines.push(
    `        body: { content: { "application/json": { schema: Create${agg.name}Request } } },`,
  );
  lines.push(`      },`);
  lines.push(`      responses: {`);
  lines.push(`        201: {`);
  lines.push(`          description: "Created",`);
  lines.push(`          content: { "application/json": { schema: Create${agg.name}Response } },`);
  lines.push(`        },`);
  lines.push(`      },`);
  lines.push(`    }),`);
  lines.push(`    async (c) => {`);
  lines.push(`      const body = c.req.valid("json");`);
  // Wrap each wire-shape field into the typed factory argument (brand
  // ids, instantiate value objects).  Avoids `as never` and lets
  // strict tsc catch shape drift between Zod and the domain class.
  const createArgs = requiredFields
    .map((f) => `${f.name}: ${wireToDomainExpr(`body.${f.name}`, f.type, ctx)}`)
    .join(", ");
  lines.push(`      const created = ${agg.name}.create({ ${createArgs} });`);
  lines.push(`      await repo.save(created);`);
  lines.push(
    `      ${renderHonoLogCall("aggregateCreated", `aggregate: "${agg.name}", id: created.id as string`)}`,
  );
  if (emitTrace) {
    // wire_out — outbound payload shape (keys only).  Bound to a const
    // so `c.json` doesn't re-evaluate the payload expression alongside
    // Object.keys.  See docs/proposals/observability.md.
    lines.push(`      const __out = { id: created.id as string };`);
    lines.push(
      `      ${renderHonoLogCall("wireOut", "keys: Object.keys(__out as Record<string, unknown>)")}`,
    );
    lines.push(`      return c.json(__out, 201);`);
  } else {
    lines.push(`      return c.json({ id: created.id as string }, 201);`);
  }
  lines.push(`    },`);
  lines.push(`  );`);
  lines.push("");

  // Get by id.
  lines.push(`  app.openapi(`);
  lines.push(`    createRoute({`);
  lines.push(`      method: "get",`);
  lines.push(`      path: "/{id}",`);
  lines.push(`      tags: ["${snake(plural(agg.name))}"],`);
  lines.push(`      operationId: "get${agg.name}ById",`);
  lines.push(`      request: { params: z.object({ id: z.string() }) },`);
  lines.push(`      responses: {`);
  lines.push(
    `        200: { description: "OK", content: { "application/json": { schema: ${agg.name}Response } } },`,
  );
  lines.push(
    `        404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },`,
  );
  lines.push(`      },`);
  lines.push(`    }),`);
  lines.push(`    async (c) => {`);
  lines.push(`      const { id } = c.req.valid("param");`);
  lines.push(`      const found = await repo.findById(Ids.${agg.name}Id(id));`);
  lines.push(`      if (!found) return c.json({ error: "not_found" }, 404);`);
  if (emitTrace) {
    // toWire isn't trivial — bind once so it's not run twice between
    // Object.keys and c.json.
    lines.push(`      const __out = repo.toWire(found);`);
    lines.push(
      `      ${renderHonoLogCall("wireOut", "keys: Object.keys(__out as Record<string, unknown>)")}`,
    );
    lines.push(`      return c.json(__out as z.infer<typeof ${agg.name}Response>, 200);`);
  } else {
    lines.push(
      `      return c.json(repo.toWire(found) as z.infer<typeof ${agg.name}Response>, 200);`,
    );
  }
  lines.push(`    },`);
  lines.push(`  );`);
  lines.push("");

  // Operations.
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    lines.push(
      ...emitOperationRoute(
        agg,
        op,
        ctx,
        auditOps.includes(op),
        provOps.includes(op),
        emitTrace,
      ).map((l) => `  ${l}`),
    );
    lines.push("");
  }

  // Find queries (including the auto-included `all`).
  if (repo) {
    for (const find of repo.finds) {
      lines.push(...emitFindRoute(agg, find, ctx, emitTrace).map((l) => `  ${l}`));
      lines.push("");
    }
  }

  // Domain-error handler.  Order matters — ForbiddenError checked
  // before DomainError so 403 wins over 400 when a `requires`
  // clause throws; ExternHandlerError checked before the generic
  // 500 fallback so its descriptive envelope wins.  trace_id
  // mirrors the request id stamped on the response by the request
  // middleware so an operator can join the response back to the
  // structured log line.
  lines.push(`  app.onError((err, c) => {`);
  // The requestIdMiddleware mounts on the parent app (http/index.ts)
  // and stashes the id on the request scope.  This sub-router's
  // OpenAPIHono is constructed without a typed Variables block
  // (zod-openapi's internal Env constraint rejects a custom one), so
  // the cast bridges the untyped get to a strongly-typed read without
  // leaking `any` into the user's surface.  Same pattern bridges the
  // bound child logger at every log call site below — see render-hono.
  lines.push(
    `    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";`,
  );
  // Each error class lands a structured log line at the catalog-defined
  // level (warn for client/domain faults; error for system faults) on
  // the per-request child logger, so the line auto-carries request_id.
  // No more bare console.error — pino handles serialization, redaction,
  // and level filtering.
  lines.push(`    if (err instanceof ForbiddenError) {`);
  lines.push(
    `      ${renderHonoLogCall("forbidden", `aggregate: "${agg.name}", message: err.message, status: 403`)}`,
  );
  lines.push(`      return c.json({ error: err.message, trace_id }, 403);`);
  lines.push(`    }`);
  lines.push(`    if (err instanceof DomainError) {`);
  lines.push(
    `      ${renderHonoLogCall("domainError", `aggregate: "${agg.name}", message: err.message, status: 400`)}`,
  );
  lines.push(`      return c.json({ error: err.message, trace_id }, 400);`);
  lines.push(`    }`);
  lines.push(`    if (err instanceof AggregateNotFoundError) {`);
  lines.push(`      ${renderHonoLogCall("notFound", `aggregate: "${agg.name}", status: 404`)}`);
  lines.push(`      return c.json({ error: err.message, trace_id }, 404);`);
  lines.push(`    }`);
  lines.push(`    if (err instanceof ExternHandlerError) {`);
  lines.push(
    `      ${renderHonoLogCall("externHandlerThrew", "aggregate: err.aggName, op: err.opName, error: err.message")}`,
  );
  lines.push(`      return c.json({ error: err.message, trace_id }, 500);`);
  lines.push(`    }`);
  lines.push(
    `    ${renderHonoLogCall("internalError", "error: err instanceof Error ? err.message : String(err), status: 500")}`,
  );
  lines.push(`    return c.json({ error: "internal", trace_id }, 500);`);
  lines.push(`  });`);
  lines.push("");
  lines.push(`  return app;`);
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

function emitOperationRoute(
  agg: AggregateIR,
  op: OperationIR,
  ctx: BoundedContextIR,
  audit: boolean,
  prov: boolean,
  emitTrace: boolean,
): string[] {
  const aggSlug = snake(plural(agg.name));
  const opSnake = snake(op.name);
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "post",`);
  out.push(`    path: "/{id}/${opSnake}",`);
  out.push(`    tags: ["${aggSlug}"],`);
  out.push(`    operationId: "${lowerFirst(op.name)}${agg.name}",`);
  out.push(`    request: {`);
  out.push(`      params: z.object({ id: z.string() }),`);
  out.push(
    `      body: { content: { "application/json": { schema: ${upperFirst(op.name)}Request } } },`,
  );
  out.push(`    },`);
  out.push(`    responses: {`);
  out.push(`      204: { description: "No content" },`);
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (c) => {`);
  out.push(`    const { id } = c.req.valid("param");`);
  out.push(`    const body = c.req.valid("json");`);
  if (emitTrace) {
    // wire_in (trace) — the validated body's structural shape (keys only;
    // values aren't logged here to avoid leaking PII in dev streams).
    // Object.keys is safe because Zod always parses to a plain object.
    out.push(
      `    ${renderHonoLogCall("wireIn", "keys: Object.keys(body as Record<string, unknown>)")}`,
    );
  }
  // Business-narrative line — what the system was asked to do, before
  // any mutation runs.  Pairs with the audit row / provenance flush
  // emitted later when the op is audited / provenanced.
  out.push(
    `    ${renderHonoLogCall("operationInvoked", `aggregate: "${agg.name}", op: "${op.name}", id`)}`,
  );
  // When the operation body references `currentUser`, the aggregate
  // method's signature picks up a trailing `currentUser: User`
  // parameter (see operationUsesCurrentUser).  The route reads the
  // user from the request scope where the auth middleware stashed it
  // earlier in the pipeline; without `auth: required` on the
  // deployable, the validator already prevents currentUser from
  // appearing in operation bodies, so this branch is dead.
  const usesUser = operationUsesCurrentUser(op);
  if (usesUser) {
    out.push(`    const currentUser = c.get("currentUser") as import("../auth/user-types").User;`);
  }
  const baseCallArgs = op.params.map((p) => wireToDomainExpr(`body.${p.name}`, p.type, ctx));
  const callArgs = (usesUser ? [...baseCallArgs, "currentUser"] : baseCallArgs).join(", ");

  // The mutation block — extern dispatch or the direct method call —
  // operates on `aggregate` and is independent of which repo loaded it,
  // so it's shared verbatim between the plain and transactional paths.
  const mutation = (pad: string): string[] => {
    if (op.extern) {
      // Extern: run preconditions, dispatch to the user-registered
      // handler, then run invariants.  The handler call is wrapped so any
      // non-domain throw becomes an ExternHandlerError naming the op +
      // aggregate (see app.onError below for the 500 mapping).  Domain
      // errors re-throw unchanged so 400 / 403 / 404 still apply.
      const handlerKey = `${lowerFirst(op.name)}${agg.name}`;
      return [
        `${pad}aggregate.check${upperFirst(op.name)}(${callArgs});`,
        `${pad}const handler = externHandlers.${handlerKey};`,
        `${pad}if (!handler) throw new Error("Missing extern handler for ${handlerKey}. Register one via register${upperFirst(op.name)}${agg.name}Handler(...) before app.listen().");`,
        `${pad}try {`,
        `${pad}  await handler(aggregate, body);`,
        `${pad}} catch (err) {`,
        `${pad}  if (err instanceof DomainError) throw err;`,
        `${pad}  if (err instanceof ForbiddenError) throw err;`,
        `${pad}  if (err instanceof AggregateNotFoundError) throw err;`,
        `${pad}  throw new ExternHandlerError("${op.name}", "${agg.name}", err);`,
        `${pad}}`,
        `${pad}aggregate.assertInvariants();`,
      ];
    }
    return [`${pad}aggregate.${lowerFirst(op.name)}(${callArgs});`];
  };

  if (!audit && !prov) {
    out.push(`    const aggregate = await repo.getById(Ids.${agg.name}Id(id));`);
    out.push(...mutation("    "));
    out.push(`    await repo.save(aggregate);`);
  } else {
    // Audited / provenanced: load, mutate, save, then write the audit row
    // and/or flush the provenance history in ONE transaction (built on
    // `db`, mirroring the workflow routes) so the state change and its
    // derived records commit or roll back atomically.
    if (audit) {
      // Actor = the typed currentUser if the body already reads it, else
      // the inbound claim via the untyped-key bridge (null when no auth).
      const actorExpr = usesUser
        ? "currentUser"
        : `(c as unknown as { get(k: "currentUser"): unknown }).get("currentUser") ?? null`;
      out.push(`    const __actor = ${actorExpr};`);
    }
    out.push(`    await db.transaction(async (tx) => {`);
    out.push(`      const repoTx = new ${agg.name}Repository(tx, events);`);
    out.push(`      const aggregate = await repoTx.getById(Ids.${agg.name}Id(id));`);
    if (audit) out.push(`      const __before = repoTx.toWire(aggregate);`);
    out.push(...mutation("      "));
    out.push(`      await repoTx.save(aggregate);`);
    if (audit) {
      out.push(`      const __after = repoTx.toWire(aggregate);`);
      out.push(`      await tx.insert(schema.auditRecords).values({`);
      out.push(`        auditId: randomUUID(),`);
      out.push(`        operationId: "${lowerFirst(op.name)}${agg.name}",`);
      out.push(`        action: "${op.name}",`);
      out.push(`        targetType: "${agg.name}",`);
      out.push(`        targetId: id,`);
      out.push(`        actor: __actor,`);
      out.push(`        before: __before,`);
      out.push(`        after: __after,`);
      out.push(`        at: new Date(),`);
      out.push(`        status: "ok",`);
      out.push(`      });`);
    }
    if (prov) {
      // One history row per provenanced write captured during the mutation;
      // traceId + at are stamped here so the domain layer stays pure.
      out.push(`      for (const __t of aggregate.__drainProv()) {`);
      out.push(`        await tx.insert(schema.provenanceRecords).values({`);
      out.push(`          traceId: randomUUID(),`);
      out.push(`          snapshotId: __t.snapshotId,`);
      out.push(`          targetType: __t.target.type,`);
      out.push(`          field: __t.target.field,`);
      out.push(`          inputs: __t.inputs,`);
      out.push(`          computedValue: __t.computedValue,`);
      out.push(`          at: new Date(),`);
      out.push(`        });`);
      out.push(`      }`);
    }
    out.push(`    });`);
  }
  out.push(`    return c.body(null, 204);`);
  out.push(`  },`);
  out.push(`);`);
  return out;
}

function emitFindRoute(
  agg: AggregateIR,
  find: FindIR,
  ctx: BoundedContextIR,
  emitTrace: boolean,
): string[] {
  const aggSlug = snake(plural(agg.name));
  const findSnake = snake(find.name);
  const isList = find.returnType.kind === "array";
  const responseSchema = isList ? `${agg.name}ListResponse` : `${agg.name}Response`;
  const path = find.name === "all" ? "/" : `/${findSnake}`;
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "${path}",`);
  out.push(`    tags: ["${aggSlug}"],`);
  out.push(`    operationId: "${lowerFirst(find.name)}${agg.name}",`);
  if (find.params.length > 0) {
    out.push(`    request: { query: ${upperFirst(find.name)}Query },`);
  }
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: ${responseSchema} } } },`,
  );
  if (find.returnType.kind === "optional") {
    out.push(
      `      404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },`,
    );
  }
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (c) => {`);
  if (find.params.length > 0) {
    out.push(`    const params = c.req.valid("query");`);
  }
  // When the find's where clause references currentUser,
  // the repository method gains a trailing `currentUser: User`
  // parameter.  Read it from the request scope where the auth
  // middleware stashed it earlier in the pipeline.
  const usesUser = findUsesCurrentUser(find);
  if (usesUser) {
    out.push(`    const currentUser = c.get("currentUser") as import("../auth/user-types").User;`);
  }
  const baseArgs = find.params.map((p) => wireToDomainExpr(`params.${p.name}`, p.type, ctx));
  const argList = (usesUser ? [...baseArgs, "currentUser"] : baseArgs).join(", ");
  out.push(`    const result = await repo.${find.name}(${argList});`);
  if (isList) {
    // Array responses skip wire_out — `Object.keys` over an array
    // returns positional indices, which aren't a useful shape signal.
    // (The catalog's `wire_out` is a key-set marker, not a length one.)
    out.push(
      `    return c.json(result.map((r) => repo.toWire(r)) as z.infer<typeof ${agg.name}Response>[], 200);`,
    );
  } else if (find.returnType.kind === "optional") {
    out.push(`    if (result == null) return c.json({ error: "not_found" }, 404);`);
    if (emitTrace) {
      out.push(`    const __out = repo.toWire(result);`);
      out.push(
        `    ${renderHonoLogCall("wireOut", "keys: Object.keys(__out as Record<string, unknown>)")}`,
      );
      out.push(`    return c.json(__out as z.infer<typeof ${agg.name}Response>, 200);`);
    } else {
      out.push(
        `    return c.json(repo.toWire(result) as z.infer<typeof ${agg.name}Response>, 200);`,
      );
    }
  } else {
    if (emitTrace) {
      out.push(`    const __out = repo.toWire(result);`);
      out.push(
        `    ${renderHonoLogCall("wireOut", "keys: Object.keys(__out as Record<string, unknown>)")}`,
      );
      out.push(`    return c.json(__out as z.infer<typeof ${agg.name}Response>, 200);`);
    } else {
      out.push(
        `    return c.json(repo.toWire(result) as z.infer<typeof ${agg.name}Response>, 200);`,
      );
    }
  }
  out.push(`  },`);
  out.push(`);`);
  return out;
}

// ---------------------------------------------------------------------------
// Response DTO schema emission — full wire shape, derived from the IR.
// ---------------------------------------------------------------------------

function emitResponseDtoSchema(
  ent: AggregateIR | EntityPartIR,
  ctx: BoundedContextIR,
  isAgg: boolean,
): string[] {
  const lines: string[] = [];
  const name = `${ent.name}Response`;
  lines.push(`export const ${name} = z.object({`);
  // Single canonical walk — populated by `enrichLoomModel` (see
  // src/ir/enrichments.ts).  Order and field-set match every other
  // emitter (.NET DTO, React Zod, Hono toWire serializer).
  const fields = wireShapeFor(ent);
  void ctx;
  void isAgg;
  for (const wf of fields) {
    if (wf.source === "id") {
      lines.push(`  ${wf.name}: z.string(),`);
    } else {
      lines.push(`  ${wf.name}: ${zodForResponse(wf.type, wf.optional)},`);
    }
  }
  // Co-located provenance rides the wire DTO (see repo.toWire); the
  // lineage object is nullable when the field was never written.
  for (const f of ent.fields.filter((f) => f.provenanced)) {
    lines.push(`  ${f.name}_provenance: ProvenanceLineage.nullable(),`);
  }
  lines.push(`}).openapi("${name}");`);
  return lines;
}

// ---------------------------------------------------------------------------
// zod helpers
// ---------------------------------------------------------------------------

export function zodFor(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "z.coerce.number().int()";
        case "decimal":
          return "z.coerce.number()";
        case "money":
          // Inbound: JSON string → `new Decimal(...)` after a regex
          // sanity check.  Refuses raw JS numbers (per OpenAPI finance
          // convention; matches the canonical wire shape declared in
          // `.loom/wire-spec.json` as `{type: "string", format:
          // "decimal"}`).
          return 'z.string().regex(/^-?\\d+(\\.\\d+)?$/, "must be a decimal-formatted string").transform((s) => new Decimal(s))';
        case "string":
        case "guid":
          return "z.string()";
        case "bool":
          return "z.coerce.boolean()";
        case "datetime":
          return "z.coerce.date()";
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return "z.string()";
    case "enum":
      return `${t.name}Schema`;
    case "valueobject":
      return `${t.name}Schema`;
    case "entity":
      return "z.unknown()";
    case "array":
      return `z.array(${zodFor(t.element)})`;
    case "optional":
      return `${zodFor(t.inner)}.nullish()`;
  }
}

/**
 * Response-side zod for a `TypeIR`.  Decimals are exposed as strings on
 * the wire (JSON loses precision); datetimes as ISO strings; ids as
 * plain strings.  Every other shape mirrors the request side.
 */
function zodForResponse(t: TypeIR, optional: boolean): string {
  const z = zodForResponseInner(t);
  return optional ? `${z}.nullish()` : z;
}

function zodForResponseInner(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "z.number().int()";
        case "decimal":
          return "z.number()";
        case "money":
          // Outbound: every Decimal instance turns into a decimal-
          // formatted string.  decimal.js already exposes `toJSON`
          // returning the canonical string form, so JSON.stringify of
          // a response containing Decimals produces strings without
          // any helper.  We still declare the schema as z.string() so
          // OpenAPI mirrors the wire shape.
          return "z.string()";
        case "string":
        case "guid":
          return "z.string()";
        case "bool":
          return "z.boolean()";
        case "datetime":
          return "z.string()";
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return "z.string()";
    case "enum":
      return `${t.name}Schema`;
    case "valueobject":
      return `${t.name}Schema`;
    case "entity":
      return `${t.name}Response`;
    case "array":
      return `z.array(${zodForResponseInner(t.element)})`;
    case "optional":
      return `${zodForResponseInner(t.inner)}.nullish()`;
  }
}

function collectUsedValueObjects(
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

function collectUsedEnums(
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

// ---------------------------------------------------------------------------
// `z.object({...}).openapi("Name").refine(...)` emitter.
//
// Same two-phase classification as the React side (api-builder.ts):
// recognised single-field shapes are absorbed into the inner field's
// zod chain (`z.string().min(N)`, …) so the published JSON-Schema
// body stays correct; cross-field / non-recognised invariants emit
// `.refine((data) => ..., { path, message })` chains AFTER the
// `.openapi("Name")` call so the schema's openapi metadata stays
// pinned to the same component name.
// ---------------------------------------------------------------------------
export function emitWireSchema(
  declPrefix: string, // e.g. `const Create<Agg>Request` or `const <VO>Schema`
  openapiName: string, // component name passed to `.openapi(...)`
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
  out.push(`${declPrefix} = z.object({`);
  for (const f of fields) {
    let schema = f.base;
    const patterns = chainByField.get(f.name);
    if (patterns) {
      for (const p of patterns) schema = chainSingleFieldNative(schema, p);
    }
    out.push(`  ${f.name}: ${schema},`);
  }
  out.push(`}).openapi("${openapiName}")${refines.join("")};`);
  return out;
}

/** Lift each `precondition` statement on an operation to an
 *  `InvariantIR` so the same classification + refine pipeline
 *  handles wire-translatable preconditions for `<Op>Request`. */
function preconditionsAsInvariants(op: OperationIR): InvariantIR[] {
  const out: InvariantIR[] = [];
  for (const s of op.statements) {
    if (s.kind === "precondition") {
      out.push({ expr: s.expr, source: s.source });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// wire → domain conversion
//
// Wraps each Zod-validated wire value into the typed argument the
// domain factory / operation expects: brand `X id` strings via
// `Ids.<X>Id(...)`, instantiate value objects via `new <Vo>(...)`,
// recurse into arrays / optionals.  Mirrors the .NET path's
// `wireToCommandArgument` (see dotnet/dto-mapping.ts) so request
// handling stays symmetric across backends.
// ---------------------------------------------------------------------------

export function wireToDomainExpr(expr: string, t: TypeIR, ctx?: BoundedContextIR): string {
  switch (t.kind) {
    case "primitive":
      return expr;
    case "id":
      return `Ids.${t.targetName}Id(${expr})`;
    case "enum":
      return expr;
    case "valueobject": {
      // VO ctor args follow the DSL's field declaration order.  Walk
      // ctx.valueObjects to find the field list; bare-name fallback
      // covers the (rare) case where ctx isn't threaded.
      const vo = ctx?.valueObjects.find((v) => v.name === t.name);
      if (!vo) return `new ${t.name}(${expr})`;
      const args = vo.fields
        .map((f) => wireToDomainExpr(`${expr}.${f.name}`, f.type, ctx))
        .join(", ");
      return `new ${t.name}(${args})`;
    }
    case "entity":
      return expr;
    case "array":
      return `${expr}.map((__e) => ${wireToDomainExpr("__e", t.element, ctx)})`;
    case "optional":
      return `(${expr} == null ? null : ${wireToDomainExpr(expr, t.inner, ctx)})`;
  }
}
