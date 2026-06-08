import { renderHonoLogCall } from "../../../generator/_obs/render-hono.js";
import {
  discriminatedUnionZod,
  type UnionMemberField,
  unionMemberObjects,
  unionMembers,
} from "../../../generator/_payload/union-wire.js";
import { renderTsExpr } from "../../../generator/typescript/render-expr.js";
import {
  chainSingleFieldNative,
  refineClauseFor,
  takeSingleFieldChain,
} from "../../../generator/typescript/zod-refine.js";
import { wireShapeFor } from "../../../ir/enrich/enrichments.js";
import {
  createInputFields,
  hasCreate,
  wireCreateDefault,
} from "../../../ir/enrich/wire-projection.js";
import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  pagedReturn,
} from "../../../ir/stdlib/generics.js";
import { unionInstanceName, variantTag } from "../../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  EnumIR,
  FindIR,
  InvariantIR,
  OperationIR,
  RepositoryIR,
  TypeIR,
  ValueObjectIR,
} from "../../../ir/types/loom-ir.js";
import {
  aggregateUsesMoney,
  findUsesCurrentUser,
  operationIsGuarded,
  operationUsesCurrentUser,
} from "../../../ir/types/loom-ir.js";
import {
  peelCollection,
  peelNullable,
  type WirePrimitive,
  wireTypeInfo,
} from "../../../ir/types/wire-types.js";
import {
  camelId,
  opCreate,
  opDestroy,
  opFind,
  opGetById,
  opOperation,
} from "../../../ir/util/openapi-ids.js";
import { opHasProvSite } from "../../../ir/util/prov-id.js";
import type {
  ClassifyContext,
  SingleFieldPattern,
} from "../../../ir/validate/invariant-classify.js";
import { defaultErrorStatus, errorTitle, errorTypeUri } from "../../../util/error-defaults.js";
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
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
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
    // Money-bearing routes consume the parsed `Decimal` via Zod's
    // type inference through `moneySchema`; the route file itself
    // never names `Decimal` directly, so a `moneySchema` import is
    // sufficient (the underlying `decimal.js` dep is pulled in by
    // the shared helpers file).
    lines.push(`import { moneySchema } from "../lib/schemas";`);
  }
  lines.push(`import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";`);
  lines.push(`import { ProblemDetails, newApp } from "./problem-details";`);
  lines.push(`import { ${agg.name} } from "../domain/${lowerFirst(agg.name)}";`);
  lines.push(
    // Audited / provenanced routes instantiate the repo inside a
    // transaction (`new ${agg.name}Repository(tx, events)`), so the class
    // must be a value import there; otherwise it's only a parameter type.
    needsTx
      ? `import { ${agg.name}Repository } from "../db/repositories/${lowerFirst(agg.name)}-repository";`
      : `import type { ${agg.name}Repository } from "../db/repositories/${lowerFirst(agg.name)}-repository";`,
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
  // Defer the value-objects import line: emit a placeholder so the actual
  // names + per-symbol `type` qualifiers can be derived from the assembled
  // body below (a VO needs a runtime value only when the body constructs
  // it with `new <Vo>(`; otherwise inline `type` keeps the import green).
  const VO_IMPORT_PLACEHOLDER = "/* __LOOM_VO_IMPORT__ */";
  if (usedVOs.length > 0) lines.push(VO_IMPORT_PLACEHOLDER);
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
  // The create schema + route are gated on `hasCreate`: an aggregate
  // that declares no create (explicit/`crudish` → `canonicalCreate`) is
  // not constructible over HTTP and emits neither.  `forCreateInput`
  // excludes server-controlled fields (`managed`, `token`, `internal`)
  // from the client-supplied payload, keeping `immutable` (settable on
  // create) and `secret`.  Matches the .NET CreateRequest shape.
  // Event-sourced aggregates (appliers A2.2) are constructed from their
  // creation command: the POST body is the create action's params (not the
  // field set), and the factory emits-and-folds the creation event.  The
  // single `create` action drives the canonical POST route.
  const esCreate = agg.persistedAs === "eventLog" ? agg.creates?.[0] : undefined;
  // An event-sourced aggregate is constructible only via an emitting `create`
  // action (validator-enforced); without one it exposes no POST route (rather
  // than calling the suppressed field-based factory).
  const emitCreate = esCreate ? true : agg.persistedAs === "eventLog" ? false : hasCreate(agg);
  // Unified create-input shape: `{ name, type, optional, default }`.  ES
  // takes the create action's params (no defaults); state takes the
  // create-input field set (server-controlled fields excluded).
  const requiredFields: {
    name: string;
    type: import("../../../ir/types/loom-ir.js").TypeIR;
    optional: boolean;
    default?: import("../../../ir/types/loom-ir.js").ExprIR;
  }[] = esCreate
    ? esCreate.params.map((p) => ({ name: p.name, type: p.type, optional: false }))
    : createInputFields(agg).map((f) => ({
        name: f.name,
        type: f.type,
        optional: !!f.optional,
        default: wireCreateDefault(f),
      }));
  if (emitCreate) {
    lines.push(
      ...emitWireSchema(
        `const Create${agg.name}Request`,
        `Create${agg.name}Request`,
        requiredFields.map((f) => {
          // An explicit `= default` field is optional input: omitted → the
          // default is applied at the wire (`.default(...)`), so it drops
          // out of the request's required-set (mirrors the bool rule).
          const d = f.default;
          const base = d ? `${zodFor(f.type)}.default(${renderTsExpr(d)})` : zodFor(f.type);
          return { name: f.name, base };
        }),
        agg.invariants,
        // Only fields present in the create input can be validated at the
        // wire boundary — an invariant over a field excluded from create
        // (e.g. a `managed` collection) is enforced in the domain layer,
        // not here.  Passing the create-input set drops those refines so
        // the schema never references an absent field.
        new Set(requiredFields.map((f) => f.name)),
      ),
    );
    lines.push(
      `const Create${agg.name}Response = z.object({ id: z.string() }).openapi("Create${agg.name}Response");`,
    );
    lines.push("");
  }

  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    lines.push(
      ...emitWireSchema(
        `const ${upperFirst(op.name)}${agg.name}Request`,
        `${upperFirst(op.name)}${agg.name}Request`,
        op.params.map((p) => ({ name: p.name, base: zodFor(p.type) })),
        preconditionsAsInvariants(op),
        new Set(op.params.map((p) => p.name)),
      ),
    );
  }
  lines.push("");

  if (repo) {
    for (const find of repo.finds) {
      // Only emit a Query schema when the find takes parameters or is paged —
      // a paged find adds `page` / `pageSize` query controls (P3b).  An empty
      // `<Find>Query = z.object({})` would be dead code otherwise.
      const paged = pagedReturn(find.returnType);
      if (find.params.length === 0 && !paged) continue;
      lines.push(`const ${upperFirst(find.name)}Query = z.object({`);
      for (const p of find.params) {
        lines.push(`  ${p.name}: ${zodFor(p.type, "query")},`);
      }
      if (paged) {
        lines.push(
          `  page: z.coerce.number().int().min(1).default(${PAGED_DEFAULT_PAGE}),`,
          `  pageSize: z.coerce.number().int().min(1).default(${PAGED_DEFAULT_PAGE_SIZE}),`,
        );
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
  // Paged response DTOs (P3b) — one per distinct `<carrier> paged` return on
  // this aggregate's repository finds.  `items` reuses the response-side zod
  // for the carrier (so an entity carrier maps to its `<Agg>Response`),
  // wrapped with the 1-based pagination envelope.
  {
    const pagedSeen = new Set<string>();
    for (const find of repo?.finds ?? []) {
      const paged = pagedReturn(find.returnType);
      if (!paged || pagedSeen.has(paged.name)) continue;
      pagedSeen.add(paged.name);
      lines.push(
        `export const ${paged.name} = z.object({ items: z.array(${zodForResponse(paged.arg, false)}), page: z.number(), pageSize: z.number(), total: z.number(), totalPages: z.number() }).openapi("${paged.name}");`,
      );
    }
  }
  // Discriminated-union response DTOs (P4b) — one `z.discriminatedUnion` per
  // distinct union find return; the tagged-wire shape mirrors the React
  // client's schema byte-for-byte (both derive from `unionMembers`).
  {
    const unionSeen = new Set<string>();
    // Union return shapes come from two sites: repository find returns and
    // exception-less operation returns (`operation foo(): X or NotFound`).
    const unionReturns = [
      ...(repo?.finds ?? []).map((f) => unionForFind(f.returnType, ctx)),
      ...agg.operations.flatMap((op) => (op.returnType ? [unionForFind(op.returnType, ctx)] : [])),
    ];
    for (const u of unionReturns) {
      if (!u || unionSeen.has(u.name)) continue;
      unionSeen.add(u.name);
      const fieldZod = (f: UnionMemberField): string =>
        f.isId ? "z.string()" : zodForResponse(f.type, f.optional);
      const members = unionMemberObjects(
        unionMembers(u.variants, ctx),
        fieldZod,
        zodForResponseInner,
      );
      lines.push(
        `export const ${u.name} = ${discriminatedUnionZod(members)}.openapi("${u.name}");`,
      );
    }
  }
  // RFC 7807 ProblemDetails body — declared once for the project in
  // `http/problem-details.ts` (with the §3.2 `errors[]` extension for
  // validation failures, consumed by the frontend ACL's
  // `applyServerErrors`).  Imported above so OpenAPI route declarations
  // resolve the same Zod schema instance and the cross-backend wire
  // contract stays byte-identical.  See
  // docs/proposals/validation-error-extension.md.
  lines.push("");

  // The router.  Audited / provenanced aggregates also receive `db` +
  // `events` so the operation can run its save + audit insert + provenance
  // flush in one transaction.
  const routerParams = needsTx
    ? `repo: ${agg.name}Repository, db: NodePgDatabase<typeof schema>, events: DomainEventDispatcher`
    : `repo: ${agg.name}Repository`;
  lines.push(`export function ${lowerFirst(agg.name)}Routes(${routerParams}): OpenAPIHono {`);
  // `newApp()` from `./problem-details` constructs OpenAPIHono with the
  // shared validation `defaultHook` pre-wired — Zod parse failures emit
  // 422 ProblemDetails with `errors[]` for the frontend ACL.
  lines.push(`  const app = newApp();`);
  lines.push("");

  // Create — gated on `hasCreate` (no canonical create ⇒ no POST route).
  if (emitCreate) {
    lines.push(`  app.openapi(`);
    lines.push(`    createRoute({`);
    lines.push(`      method: "post",`);
    lines.push(`      path: "/",`);
    lines.push(`      tags: ["${snake(plural(agg.name))}"],`);
    lines.push(`      operationId: "${camelId(opCreate(agg.name))}",`);
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
    // create → 400 (DomainError) + 422 (validation, ProblemDetails with
    // §3.2 `errors[]` extension emitted by the shared defaultHook), per
    // the openapi-errors matrix.  See docs/proposals/validation-error-extension.md.
    lines.push(
      `        400: { description: "Bad Request", content: { "application/problem+json": { schema: ProblemDetails } } },`,
    );
    lines.push(
      `        422: { description: "Unprocessable Entity", content: { "application/problem+json": { schema: ProblemDetails } } },`,
    );
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
      lines.push(`      const out = { id: created.id as string };`);
      lines.push(
        `      ${renderHonoLogCall("wireOut", "keys: Object.keys(out as Record<string, unknown>)")}`,
      );
      lines.push(`      return c.json(out, 201);`);
    } else {
      lines.push(`      return c.json({ id: created.id as string }, 201);`);
    }
    lines.push(`    },`);
    lines.push(`  );`);
    lines.push("");
  }

  // Get by id.
  lines.push(`  app.openapi(`);
  lines.push(`    createRoute({`);
  lines.push(`      method: "get",`);
  lines.push(`      path: "/{id}",`);
  lines.push(`      tags: ["${snake(plural(agg.name))}"],`);
  lines.push(`      operationId: "${camelId(opGetById(agg.name))}",`);
  lines.push(`      request: { params: z.object({ id: z.string().uuid() }) },`);
  lines.push(`      responses: {`);
  lines.push(
    `        200: { description: "OK", content: { "application/json": { schema: ${agg.name}Response } } },`,
  );
  lines.push(
    `        404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  lines.push(`      },`);
  lines.push(`    }),`);
  lines.push(`    async (c) => {`);
  lines.push(`      const { id } = c.req.valid("param");`);
  lines.push(`      const found = await repo.findById(Ids.${agg.name}Id(id));`);
  lines.push(`      if (!found) throw new AggregateNotFoundError("not_found");`);
  if (emitTrace) {
    // toWire isn't trivial — bind once so it's not run twice between
    // Object.keys and c.json.
    lines.push(`      const out = repo.toWire(found);`);
    lines.push(
      `      ${renderHonoLogCall("wireOut", "keys: Object.keys(out as Record<string, unknown>)")}`,
    );
    lines.push(`      return c.json(out as z.infer<typeof ${agg.name}Response>, 200);`);
  } else {
    lines.push(
      `      return c.json(repo.toWire(found) as z.infer<typeof ${agg.name}Response>, 200);`,
    );
  }
  lines.push(`    },`);
  lines.push(`  );`);
  lines.push("");

  // Canonical destroy → DELETE /{id} (hard delete).  Gated on the IR
  // lifecycle: emitted only when the aggregate has an unnamed `destroy`
  // (declared or via `crudish`), so plain aggregates' route files are
  // unchanged.  crudish's destroy is empty-bodied — load (404 guard),
  // then hard-delete (children/join rows cascade via FK).
  if (agg.canonicalDestroy) {
    lines.push(`  app.openapi(`);
    lines.push(`    createRoute({`);
    lines.push(`      method: "delete",`);
    lines.push(`      path: "/{id}",`);
    lines.push(`      tags: ["${snake(plural(agg.name))}"],`);
    lines.push(`      operationId: "${camelId(opDestroy(agg.name))}",`);
    lines.push(`      request: { params: z.object({ id: z.string().uuid() }) },`);
    lines.push(`      responses: {`);
    lines.push(`        204: { description: "No Content" },`);
    lines.push(
      `        404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },`,
    );
    // Deleting a still-referenced aggregate trips a Postgres
    // foreign_key_violation (cross-aggregate `X id` FK is ON DELETE
    // RESTRICT) → 409 Conflict.
    lines.push(
      `        409: { description: "Conflict", content: { "application/problem+json": { schema: ProblemDetails } } },`,
    );
    lines.push(`      },`);
    lines.push(`    }),`);
    lines.push(`    async (c) => {`);
    lines.push(`      const { id } = c.req.valid("param");`);
    // getById throws AggregateNotFoundError (→ 404) when absent.
    lines.push(`      await repo.getById(Ids.${agg.name}Id(id));`);
    lines.push(`      try {`);
    lines.push(`        await repo.delete(Ids.${agg.name}Id(id));`);
    lines.push(`      } catch (err) {`);
    // PG foreign_key_violation (SQLSTATE 23503) — the row is still
    // referenced.  Map to a 409 problem locally so the shared onError
    // (and every other route's behaviour) stays untouched.
    lines.push(
      `        if (err && typeof err === "object" && (err as { code?: string }).code === "23503") {`,
    );
    lines.push(
      `          return c.body(JSON.stringify({ type: "about:blank", title: "Conflict", status: 409, detail: "${agg.name} is still referenced and cannot be deleted.", instance: c.req.path }), 409, { "content-type": "application/problem+json" });`,
    );
    lines.push(`        }`);
    lines.push(`        throw err;`);
    lines.push(`      }`);
    lines.push(`      return c.body(null, 204);`);
    lines.push(`    },`);
    lines.push(`  );`);
    lines.push("");
  }

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
  // RFC 7807 responder — `application/problem+json` body + `x-request-id`
  // header (trace correlation moved off the body so it's byte-identical to
  // .NET / Phoenix).  `instance` is the request path; `type` is `about:blank`
  // (no per-error type registry).  Shared shape across all error arms.
  lines.push(
    `    const problem = (status: 400 | 403 | 404 | 500, title: string, detail: string) => c.body(JSON.stringify({ type: "about:blank", title, status, detail, instance: c.req.path }), status, { "content-type": "application/problem+json", "x-request-id": trace_id });`,
  );
  lines.push(`    if (err instanceof ForbiddenError) {`);
  lines.push(
    `      ${renderHonoLogCall("forbidden", `aggregate: "${agg.name}", message: err.message, status: 403`)}`,
  );
  lines.push(`      return problem(403, "Forbidden", err.message);`);
  lines.push(`    }`);
  lines.push(`    if (err instanceof DomainError) {`);
  lines.push(
    `      ${renderHonoLogCall("domainError", `aggregate: "${agg.name}", message: err.message, status: 400`)}`,
  );
  lines.push(`      return problem(400, "Bad Request", err.message);`);
  lines.push(`    }`);
  lines.push(`    if (err instanceof AggregateNotFoundError) {`);
  lines.push(`      ${renderHonoLogCall("notFound", `aggregate: "${agg.name}", status: 404`)}`);
  lines.push(`      return problem(404, "Not Found", err.message);`);
  lines.push(`    }`);
  lines.push(`    if (err instanceof ExternHandlerError) {`);
  lines.push(
    `      ${renderHonoLogCall("externHandlerThrew", "aggregate: err.aggName, op: err.opName, error: err.message")}`,
  );
  lines.push(`      return problem(500, "Internal Server Error", err.message);`);
  lines.push(`    }`);
  lines.push(
    `    ${renderHonoLogCall("internalError", "error: err instanceof Error ? err.message : String(err), status: 500")}`,
  );
  lines.push(`    return problem(500, "Internal Server Error", "internal");`);
  lines.push(`  });`);
  lines.push("");
  lines.push(`  return app;`);
  lines.push(`}`);
  // Patch the deferred VO import: keep only names the body actually
  // references; tag each as `type` unless the body constructs it via
  // `new <Vo>(`.
  const assembled = lines.join("\n");
  if (usedVOs.length > 0) {
    const usedNames = usedVOs.map((v) => v.name);
    // Strip string-literal contents before scanning so `.openapi("Quantity")`
    // doesn't count as a reference to the `Quantity` symbol.
    const rawAfterImport = assembled.slice(assembled.indexOf(VO_IMPORT_PLACEHOLDER));
    const bodyAfterImport = rawAfterImport
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/`(?:\\.|[^`\\])*`/g, "``");
    const referenced = usedNames.filter((n) => new RegExp(`\\b${n}\\b`).test(bodyAfterImport));
    const isValue = (n: string): boolean => new RegExp(`new\\s+${n}\\(`).test(bodyAfterImport);
    const anyValue = referenced.some(isValue);
    // When every referenced VO is type-only, emit the whole-import form
    // `import type { … }` (Biome's useImportType prefers it over inline
    // `type` qualifiers when all named imports are type-only).
    let replacement = "";
    if (referenced.length > 0 && !anyValue) {
      replacement = `import type { ${referenced.join(", ")} } from "../domain/value-objects";`;
    } else if (referenced.length > 0) {
      const symbols = referenced.map((n) => (isValue(n) ? n : `type ${n}`));
      replacement = `import { ${symbols.join(", ")} } from "../domain/value-objects";`;
    }
    return assembled.replace(VO_IMPORT_PLACEHOLDER, replacement) + "\n";
  }
  return assembled + "\n";
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
  // Operation URL segment from the enriched routeSlug (D-URLSTYLE):
  // op.name under urlStyle:literal, plural(name) under :resource.  The
  // backend owns the snake-casing convention; identity uses (operationId,
  // request DTOs, extern handler keys) stay keyed on op.name below.
  const opSnake = snake(op.routeSlug ?? op.name);
  // Exception-less operation (`operation foo(): X or NotFound`): the route
  // captures the tagged-union result and translates an `error`-variant to an
  // RFC-7807 ProblemDetails status, a success to HTTP 200 (exception-less.md).
  // The spike supports the plain repo path only (audit / prov / extern return-
  // typed ops are a later slice); they fall through to the void handler.
  if (op.returnType && !audit && !prov && !op.extern) {
    return emitReturningOperationRoute(agg, op, ctx, emitTrace);
  }
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "post",`);
  out.push(`    path: "/{id}/${opSnake}",`);
  out.push(`    tags: ["${aggSlug}"],`);
  out.push(`    operationId: "${camelId(opOperation(agg.name, op.name))}",`);
  out.push(`    request: {`);
  out.push(`      params: z.object({ id: z.string().uuid() }),`);
  out.push(
    `      body: { content: { "application/json": { schema: ${upperFirst(op.name)}${agg.name}Request } } },`,
  );
  out.push(`    },`);
  out.push(`    responses: {`);
  out.push(`      204: { description: "No content" },`);
  // operation → 400 (domain) + 404 (aggregate not found) + 422
  // (validation, ProblemDetails with §3.2 `errors[]` extension emitted by
  // the shared defaultHook), per the openapi-errors matrix.  Phase D of
  // docs/proposals/validation-error-extension.md.
  out.push(
    `      400: { description: "Bad Request", content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  out.push(
    `      422: { description: "Unprocessable Entity", content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  // A `requires` guard denies with 403 (ForbiddenError → onError) — declare
  // it so the published contract documents the authorization outcome.
  if (operationIsGuarded(op)) {
    out.push(
      `      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemDetails } } },`,
    );
  }
  out.push(
    `      404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
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
    out.push(
      `    const currentUser = (c as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
    );
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
      out.push(`    const actor = ${actorExpr};`);
    }
    out.push(`    await db.transaction(async (tx) => {`);
    out.push(`      const repoTx = new ${agg.name}Repository(tx, events);`);
    out.push(`      const aggregate = await repoTx.getById(Ids.${agg.name}Id(id));`);
    if (audit) out.push(`      const before = repoTx.toWire(aggregate);`);
    out.push(...mutation("      "));
    out.push(`      await repoTx.save(aggregate);`);
    if (audit) {
      out.push(`      const after = repoTx.toWire(aggregate);`);
      out.push(`      await tx.insert(schema.auditRecords).values({`);
      out.push(`        auditId: randomUUID(),`);
      out.push(`        operationId: "${camelId(opOperation(agg.name, op.name))}",`);
      out.push(`        action: "${op.name}",`);
      out.push(`        targetType: "${agg.name}",`);
      out.push(`        targetId: id,`);
      out.push(`        actor,`);
      out.push(`        before,`);
      out.push(`        after,`);
      out.push(`        at: new Date(),`);
      out.push(`        status: "ok",`);
      out.push(`      });`);
    }
    if (prov) {
      // One history row per provenanced write captured during the mutation;
      // traceId + at are stamped here so the domain layer stays pure.
      out.push(`      for (const t of aggregate.drainProv()) {`);
      out.push(`        await tx.insert(schema.provenanceRecords).values({`);
      out.push(`          traceId: randomUUID(),`);
      out.push(`          snapshotId: t.snapshotId,`);
      out.push(`          targetType: t.target.type,`);
      out.push(`          field: t.target.field,`);
      out.push(`          inputs: t.inputs,`);
      out.push(`          computedValue: t.computedValue,`);
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

/** True when a union variant is an `error` payload — the route maps it to an
 *  RFC-7807 ProblemDetails status instead of serializing it as a success body
 *  (exception-less.md). */
function isErrorVariant(v: TypeIR, ctx: BoundedContextIR): boolean {
  if (v.kind !== "entity") return false;
  return ctx.payloads.some((p) => p.name === v.name && p.kind === "error");
}

/** RFC reason phrase for the HTTP statuses an exception-less route can emit —
 *  used for the OpenAPI response `description`. */
function httpStatusText(status: number): string {
  const TEXT: Readonly<Record<number, string>> = {
    400: "Bad Request",
    402: "Payment Required",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    422: "Unprocessable Entity",
    500: "Internal Server Error",
    502: "Bad Gateway",
  };
  return TEXT[status] ?? "Error";
}

/** The exception-less operation route (`operation foo(): X or NotFound`).  Calls
 *  the aggregate method (which now returns its tagged `or`-union), saves, then
 *  translates: an `error`-variant result → an RFC-7807 ProblemDetails (404 in
 *  the spike), a success variant → HTTP 200 with the tagged body. */
function emitReturningOperationRoute(
  agg: AggregateIR,
  op: OperationIR,
  ctx: BoundedContextIR,
  emitTrace: boolean,
): string[] {
  const aggSlug = snake(plural(agg.name));
  const opSnake = snake(op.routeSlug ?? op.name);
  const variants = op.returnType?.kind === "union" ? op.returnType.variants : [];
  const errorVariants = variants.filter((vv) => isErrorVariant(vv, ctx));
  const u = op.returnType ? unionForFind(op.returnType, ctx) : null;
  const unionName = u?.name ?? `${agg.name}Response`;
  // The HTTP status an error variant maps to: the api's `httpStatus` override
  // for this context (exception-less.md A1) if present, else the stdlib default.
  const statusFor = (tag: string): number =>
    ctx.errorStatusOverrides?.[tag] ?? defaultErrorStatus(tag);
  // The ProblemDetails statuses this route can produce: the framework defaults
  // (400 domain, 422 validation, 404 aggregate-not-found from getById), 403 if
  // guarded, plus each error variant's mapped status.
  const problemStatuses = new Set<number>([400, 422, 404]);
  if (operationIsGuarded(op)) problemStatuses.add(403);
  for (const v of errorVariants) problemStatuses.add(statusFor(variantTag(v)));
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "post",`);
  out.push(`    path: "/{id}/${opSnake}",`);
  out.push(`    tags: ["${aggSlug}"],`);
  out.push(`    operationId: "${camelId(opOperation(agg.name, op.name))}",`);
  out.push(`    request: {`);
  out.push(`      params: z.object({ id: z.string().uuid() }),`);
  out.push(
    `      body: { content: { "application/json": { schema: ${upperFirst(op.name)}${agg.name}Request } } },`,
  );
  out.push(`    },`);
  out.push(`    responses: {`);
  // 200 declares the whole tagged union; only success variants actually reach
  // it (error variants are intercepted below) — the documented shape is the
  // closed set of outcomes, which a typed client narrows on `type`.
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: ${unionName} } } },`,
  );
  for (const status of [...problemStatuses].sort((a, b) => a - b)) {
    out.push(
      `      ${status}: { description: ${JSON.stringify(httpStatusText(status))}, content: { "application/problem+json": { schema: ProblemDetails } } },`,
    );
  }
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (c) => {`);
  out.push(`    const { id } = c.req.valid("param");`);
  out.push(`    const body = c.req.valid("json");`);
  if (emitTrace) {
    out.push(
      `    ${renderHonoLogCall("wireIn", "keys: Object.keys(body as Record<string, unknown>)")}`,
    );
  }
  out.push(
    `    ${renderHonoLogCall("operationInvoked", `aggregate: "${agg.name}", op: "${op.name}", id`)}`,
  );
  const usesUser = operationUsesCurrentUser(op);
  if (usesUser) {
    out.push(
      `    const currentUser = (c as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
    );
  }
  const baseCallArgs = op.params.map((p) => wireToDomainExpr(`body.${p.name}`, p.type, ctx));
  const callArgs = (usesUser ? [...baseCallArgs, "currentUser"] : baseCallArgs).join(", ");
  out.push(`    const aggregate = await repo.getById(Ids.${agg.name}Id(id));`);
  out.push(`    const result = aggregate.${lowerFirst(op.name)}(${callArgs});`);
  out.push(`    await repo.save(aggregate);`);
  // Translate each error variant to a ProblemDetails before the success path.
  // Status / title / type come from the stdlib defaults (exception-less.md A1);
  // the error payload's own fields ride along as RFC-7807 §3.2 extension members
  // (e.g. NotFound's `resource`), with the spec fields overridden.
  for (const v of errorVariants) {
    const tag = variantTag(v);
    const status = statusFor(tag);
    out.push(`    if (result.type === ${JSON.stringify(tag)}) {`);
    out.push(
      `      return c.json({ ...result, type: ${JSON.stringify(errorTypeUri(tag))}, title: ${JSON.stringify(errorTitle(tag))}, status: ${status}, detail: ${JSON.stringify(errorTitle(tag))}, instance: c.req.path }, ${status}, { "content-type": "application/problem+json" });`,
    );
    out.push(`    }`);
  }
  out.push(`    return c.json(result, 200);`);
  out.push(`  },`);
  out.push(`);`);
  return out;
}

/** A find whose return type is a discriminated union — inline `A or B` or a
 *  reference to a named `payload Foo = …`.  Returns the DTO name + variants. */
function unionForFind(
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

function emitFindRoute(
  agg: AggregateIR,
  find: FindIR,
  ctx: BoundedContextIR,
  emitTrace: boolean,
): string[] {
  const aggSlug = snake(plural(agg.name));
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
        : `${agg.name}Response`;
  // A paged find always carries a query (page/pageSize), even with no
  // declared params.
  const hasQuery = find.params.length > 0 || !!paged;
  const path = find.name === "all" ? "/" : `/${findSnake}`;
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "${path}",`);
  out.push(`    tags: ["${aggSlug}"],`);
  out.push(`    operationId: "${camelId(opFind(agg.name, find.name))}",`);
  if (hasQuery) {
    out.push(`    request: { query: ${upperFirst(find.name)}Query },`);
  }
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: ${responseSchema} } } },`,
  );
  if (find.returnType.kind === "optional") {
    out.push(
      `      404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },`,
    );
  }
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (c) => {`);
  if (hasQuery) {
    out.push(`    const params = c.req.valid("query");`);
  }
  // When the find's where clause references currentUser,
  // the repository method gains a trailing `currentUser: User`
  // parameter.  Read it from the request scope where the auth
  // middleware stashed it earlier in the pipeline.
  const usesUser = findUsesCurrentUser(find);
  if (usesUser) {
    out.push(
      `    const currentUser = (c as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
    );
  }
  const baseArgs = find.params.map((p) => wireToDomainExpr(`params.${p.name}`, p.type, ctx));
  if (paged) {
    // Auto-injected pagination controls follow the domain args; the repo
    // method returns `{ items: <domain>[], page, pageSize, total, totalPages }`
    // and the route maps the page items through `toWire`.
    const pagedArgs = [...baseArgs, "params.page", "params.pageSize"];
    const argList = (usesUser ? [...pagedArgs, "currentUser"] : pagedArgs).join(", ");
    out.push(`    const result = await repo.${find.name}(${argList});`);
    out.push(
      `    return c.json({ ...result, items: result.items.map((r) => repo.toWire(r)) } as z.infer<typeof ${paged.name}>, 200);`,
    );
    out.push(`  },`);
    out.push(`);`);
    return out;
  }
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
    out.push(`    if (result == null) throw new AggregateNotFoundError("not_found");`);
    if (emitTrace) {
      out.push(`    const wire = repo.toWire(result);`);
      out.push(
        `    ${renderHonoLogCall("wireOut", "keys: Object.keys(wire as Record<string, unknown>)")}`,
      );
      out.push(`    return c.json(wire as z.infer<typeof ${agg.name}Response>, 200);`);
    } else {
      out.push(
        `    return c.json(repo.toWire(result) as z.infer<typeof ${agg.name}Response>, 200);`,
      );
    }
  } else {
    if (emitTrace) {
      out.push(`    const wire = repo.toWire(result);`);
      out.push(
        `    ${renderHonoLogCall("wireOut", "keys: Object.keys(wire as Record<string, unknown>)")}`,
      );
      out.push(`    return c.json(wire as z.infer<typeof ${agg.name}Response>, 200);`);
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
  ent: EnrichedAggregateIR | EnrichedEntityPartIR,
  ctx: BoundedContextIR,
  isAgg: boolean,
): string[] {
  const lines: string[] = [];
  const name = `${ent.name}Response`;
  lines.push(`export const ${name} = z.object({`);
  // Single canonical walk — populated by `enrichLoomModel` (see
  // src/ir/enrich/enrichments.ts).  Order and field-set match every other
  // emitter (.NET DTO, React Zod, Hono toWire serializer).  Enriched
  // brand flows in via `PlatformSurface.emitProject(contexts:
  // EnrichedBoundedContextIR[])` so no local cast is needed.
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
//
// Two primitive-to-Zod tables — `request` uses `z.coerce.*` because
// inbound JSON arrives as strings/numbers from the wire and Zod handles
// the coercion; `response` uses the strict equivalents because the
// server serialises into the declared shape.  Money crosses as
// `moneySchema` on the request side (a parse chain producing decimal.js
// Decimal) and as `z.string()` on the response side (Decimal's
// canonical JSON form).  Datetime: `z.coerce.date()` inbound, ISO
// `z.string()` outbound.
// ---------------------------------------------------------------------------

const REQUEST_PRIMITIVE: Record<WirePrimitive, string> = {
  int: "z.coerce.number().int()",
  long: "z.coerce.number().int()",
  decimal: "z.coerce.number()",
  money: "moneySchema",
  string: "z.string()",
  bool: "z.coerce.boolean()",
  datetime: "z.coerce.date()",
  guid: "z.string()",
  json: "z.unknown()",
};

const RESPONSE_PRIMITIVE: Record<WirePrimitive, string> = {
  int: "z.number().int()",
  long: "z.number().int()",
  decimal: "z.number()",
  money: "z.string()",
  string: "z.string()",
  bool: "z.boolean()",
  datetime: "z.string()",
  guid: "z.string()",
  json: "z.unknown()",
};

export function zodFor(t: TypeIR, context: "body" | "query" = "body"): string {
  const info = wireTypeInfo(t, "request");
  if (info.isNullable) return `${zodFor(peelNullable(t), context)}.nullish()`;
  if (info.isCollection) return `z.array(${zodFor(peelCollection(t), context)})`;
  switch (info.refKind) {
    case "primitive":
      // A non-nullable bool in a request *body* defaults to `false` when
      // omitted — matching .NET model-binding and Phoenix, which both treat
      // an absent request bool as false and drop it from `required`.  Without
      // this Hono alone marks the bool required, tripping the cross-backend
      // parity required-set (`required-only-honoApi=[<bool>]`).  Query params
      // keep the plain coercion (Phoenix doesn't special-case query bools).
      if (info.primitive === "bool" && context === "body") {
        return "z.coerce.boolean().default(false)";
      }
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

/** Response-side zod for a `TypeIR`.  Decimals are exposed as strings on
 *  the wire (JSON loses precision); datetimes as ISO strings; ids as
 *  plain strings.  Every other shape mirrors the request side. */
function zodForResponse(t: TypeIR, optional: boolean): string {
  const z = zodForResponseInner(t);
  // `zodForResponseInner` already appends `.nullish()` for a nullable type;
  // only add it for an `optional` field whose type isn't already nullable,
  // so an optional `T?` field doesn't emit `.nullish().nullish()`.
  const alreadyNullable = wireTypeInfo(t, "response").isNullable;
  return optional && !alreadyNullable ? `${z}.nullish()` : z;
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
  const info = wireTypeInfo(t, "request");
  if (info.isNullable) {
    return `(${expr} == null ? null : ${wireToDomainExpr(expr, peelNullable(t), ctx)})`;
  }
  if (info.isCollection) {
    return `${expr}.map((e) => ${wireToDomainExpr("e", peelCollection(t), ctx)})`;
  }
  switch (info.refKind) {
    case "primitive":
      return expr;
    case "id":
      return `Ids.${info.idTarget}Id(${expr})`;
    case "enum":
      return expr;
    case "valueObject": {
      // VO ctor args follow the DSL's field declaration order.  Walk
      // ctx.valueObjects to find the field list; bare-name fallback
      // covers the (rare) case where ctx isn't threaded.
      const vo = ctx?.valueObjects.find((v) => v.name === info.base);
      if (!vo) return `new ${info.base}(${expr})`;
      const args = vo.fields
        .map((f) => wireToDomainExpr(`${expr}.${f.name}`, f.type, ctx))
        .join(", ");
      return `new ${info.base}(${args})`;
    }
    case "entity":
      return expr;
  }
}
