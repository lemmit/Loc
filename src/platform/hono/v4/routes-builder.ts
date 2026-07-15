import { renderHonoLogCall } from "../../../generator/_obs/render-hono.js";
import {
  discriminatedUnionZod,
  findUnionSpec,
  type UnionMemberField,
  unionMemberObjects,
  unionMembers,
} from "../../../generator/_payload/union-wire.js";
import { renderTsExpr } from "../../../generator/typescript/render-expr.js";
import {
  chainSingleFieldNative,
  refineClauseFor,
  takeSingleFieldChain,
} from "../../../generator/zod-refine.js";
import {
  createInputFields,
  emitsRestCreate,
  forApiRead,
  wireCreateDefault,
  wireFieldsFor,
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
  ExprIR,
  FindIR,
  InvariantIR,
  OperationIR,
  RepositoryIR,
  TypeIR,
  ValueObjectIR,
} from "../../../ir/types/loom-ir.js";
import {
  aggregateUsesMoneyDeep,
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
import { partsChildrenFirst } from "../../../ir/util/containment-parent.js";
import {
  camelId,
  opCreate,
  opDestroy,
  opFind,
  opGetById,
  opOperation,
} from "../../../ir/util/openapi-ids.js";
import { opHasProvSite } from "../../../ir/util/prov-id.js";
import { collectReachableTypes } from "../../../ir/util/reachable-types.js";
import { aggregateIsEventSourced } from "../../../ir/util/resolve-datasource.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { walkExpr } from "../../../ir/validate/checks/shared.js";
import type {
  ClassifyContext,
  SingleFieldPattern,
} from "../../../ir/validate/invariant-classify.js";
import {
  defaultErrorStatus,
  errorTitle,
  errorTypeUri,
  resolveErrorStatus,
} from "../../../util/error-defaults.js";
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
  // An audited public command action instruments its route handler with an
  // `audit_records` insert; the schema table is only emitted when some
  // action is audited, so the imports are gated on the same presence to keep
  // "auditing off pays nothing".
  const auditOps = emitAudit
    ? agg.operations.filter((o) => o.audited && o.visibility === "public")
    : [];
  // Audited LIFECYCLE actions (`create(...) audited` / `destroy audited`).
  // The canonical create/destroy drive the POST `/` and DELETE `/{id}`
  // routes; an ES aggregate's create action is `agg.creates?.[0]`.  A named
  // create has no route, so only the route-driving action's flag matters.
  const auditedCreateAction =
    agg.persistedAs === "eventLog" ? (agg.creates?.[0] ?? null) : (agg.canonicalCreate ?? null);
  const auditCreate = emitAudit && !!auditedCreateAction?.audited;
  const auditDestroy = emitAudit && !!agg.canonicalDestroy?.audited;
  const fileHasAudit = auditOps.length > 0 || auditCreate || auditDestroy;
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
  // Lifecycle stamps (audit / softDelete) no longer touch the route handler:
  // node-persist-time-auditing relocated stamping into the drizzle save()
  // (db/audit-stamp.ts), reading the principal from the ambient request context.
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  if (aggregateUsesMoneyDeep(agg, ctx.valueObjects)) {
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
  // `ConcurrencyError` only when this aggregate is `versioned` OR event-sourced — a
  // non-versioned aggregate's route file stays byte-identical.
  lines.push(
    aggregateIsVersioned(agg) || aggregateIsEventSourced(agg)
      ? `import { DomainError, AggregateNotFoundError, DisallowedError, ForbiddenError, ExternHandlerError, ConcurrencyError } from "../domain/errors";`
      : `import { DomainError, AggregateNotFoundError, DisallowedError, ForbiddenError, ExternHandlerError } from "../domain/errors";`,
  );
  // `when` gates (and their auto-exposed can-query companions) render enum
  // values like `OrderStatus.Shipped` in the route file; import those enums
  // from value-objects so the predicate type-checks (else TS2304).
  const whenEnums = new Set<string>();
  for (const op of agg.operations) {
    walkExpr(op.when, (e) => {
      if (e.kind === "ref" && e.refKind === "enum-value" && e.enumName) {
        whenEnums.add(e.enumName);
      }
    });
  }
  if (whenEnums.size > 0) {
    lines.push(`import { ${[...whenEnums].sort().join(", ")} } from "../domain/value-objects";`);
  }
  // Extern operations (extern (b) Phase 2) are now aggregate-owned hooks: the
  // route calls `aggregate.<op>(...)` like any other operation, so there is no
  // handler-registry import.
  if (needsTx) {
    // Audited / provenanced operations write extra rows per successful
    // invocation, inside the same transaction as the aggregate save.
    // Needs the schema tables (runtime value), a UUID, and the db/events
    // types for the transactional repo (mirrors the workflow routes' imports).
    lines.push(`import { randomUUID } from "node:crypto";`);
    lines.push(`import * as schema from "../db/schema";`);
    lines.push(`import { requestContext } from "../obs/als";`);
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
  const emitCreate = emitsRestCreate(agg);
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
          // out of the request's required-set (mirrors the bool rule).  The
          // literal is passed to `emitWireSchema` separately so the
          // `.default(...)` lands AFTER any `.min`/`.max` chain (a
          // `ZodDefault` has no `.min`).
          const d = f.default;
          // A non-nullable bool's `.default(false)` normally comes from
          // `zodFor` (the implicit bool rule).  When the field carries an
          // EXPLICIT default we drop that baked-in `.default(false)` and let
          // the declared literal drive the `.default(...)` below — otherwise a
          // `bool = true` would emit `z.coerce.boolean().default(false).default(true)`.
          const info = wireTypeInfo(f.type, "request");
          const plainBool =
            info.refKind === "primitive" &&
            info.primitive === "bool" &&
            !info.isNullable &&
            !info.isCollection;
          return {
            name: f.name,
            base: plainBool && d !== undefined ? "z.coerce.boolean()" : zodFor(f.type),
            default: d ? wireDefaultLiteral(f.type, d) : undefined,
          };
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
        // Field-level invariants (SYS-1): the update/mutating-op request DTO
        // gets the SAME wire constraints as create, not just the op's own
        // preconditions.  The `available = op.params` set below drops any
        // invariant over a field this op doesn't take (identical to the
        // create-input filtering above), so an invalid update is rejected at
        // the wire (422) instead of reaching the domain floor.
        [...agg.invariants, ...preconditionsAsInvariants(op)],
        new Set(op.params.map((p) => p.name)),
      ),
    );
  }
  lines.push("");

  if (repo) {
    for (const find of repo.finds) {
      // A synthesized find (paged-run queryHandler support) is never
      // auto-exposed by the aggregate router — the queryHandler's own route is
      // the exposure — so it emits no query schema / DTO / route here.
      if (find.synthesized) continue;
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
        // Server-side pagination + sort controls (M-T2.6).  `sort`/`dir` are
        // plain strings (the client binds them to its sort state, which starts
        // empty = unsorted); the repository whitelists the column server-side
        // (`sortColumns[sort] ?? id`), so an enum boundary is unnecessary — and
        // would reject the empty initial sort the scaffold list sends.
        lines.push(
          `  page: z.coerce.number().int().min(1).default(${PAGED_DEFAULT_PAGE}),`,
          `  pageSize: z.coerce.number().int().min(1).default(${PAGED_DEFAULT_PAGE_SIZE}),`,
          `  sort: z.string().default("id"),`,
          `  dir: z.string().default("asc"),`,
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
  // matters: parts referenced from the root must be declared first —
  // AND a nested part must precede the sibling that references it
  // (`Shipment.labels: z.array(LabelResponse)`), hence children-first.
  // Aggregate-level + part-level response schemas are exported so
  // the per-context views router (`http/views.ts`) can reuse them
  // verbatim without duplicating field-by-field declarations.
  for (const part of partsChildrenFirst(agg.parts)) {
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
      if (find.synthesized) continue;
      const paged = pagedReturn(find.returnType);
      if (!paged || pagedSeen.has(paged.name)) continue;
      pagedSeen.add(paged.name);
      lines.push(
        // The pagination counters are integers on every other backend's
        // OpenAPI (.NET/Java/Python/Phoenix emit `integer`), so mark them
        // `z.number().int()` here too — a bare `z.number()` emits `number` and
        // drifts the conformance-parity property-type check (M-T2.6).
        `export const ${paged.name} = z.object({ items: z.array(${zodForResponse(paged.arg, false)}), page: z.number().int(), pageSize: z.number().int(), total: z.number().int(), totalPages: z.number().int() }).openapi("${paged.name}");`,
      );
    }
  }
  // Discriminated-union response DTOs (P4b) — one `z.discriminatedUnion` per
  // distinct union find return; the tagged-wire shape mirrors the React
  // client's schema byte-for-byte (both derive from `unionMembers`).
  {
    const unionSeen = new Set<string>();
    // Tagged discriminated-union DTOs are emitted only for exception-less
    // operation returns (`operation foo(): X or NotFound`).  Union FINDS no
    // longer use one — a single-success find returns `<Agg>Response` directly
    // at 200 with the error/absent variant at its own status (exception-less.md
    // §4), so there is no tagged component to declare.
    const unionReturns = [
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
  // docs/old/proposals/validation-error-extension.md.
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
    // the openapi-errors matrix.  See docs/old/proposals/validation-error-extension.md.
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
    // Lifecycle stamps (createdAt/createdBy/…) are NO LONGER set here.
    // node-persist-time-auditing relocated stamping into the drizzle save()
    // (db/audit-stamp.ts), which reads the principal from the ambient request
    // context — so the handler is just create → save.
    if (auditCreate) {
      // Audited create — persist + write the lifecycle audit row in ONE
      // transaction (mirrors the operation audit path).  Asymmetry: create
      // has no `before` (JSON null on the not-NULL column), `after` is the
      // freshly-created wire snapshot, keyed by the generated id.  Actor =
      // the inbound claim via the untyped-key bridge (null when no auth).
      const actorExpr = `(c as unknown as { get(k: "currentUser"): unknown }).get("currentUser") ?? null`;
      lines.push(`      const actor = ${actorExpr};`);
      lines.push(`      const reqCtx = requestContext();`);
      lines.push(`      await db.transaction(async (tx) => {`);
      lines.push(`        const repoTx = new ${agg.name}Repository(tx, events);`);
      lines.push(`        await repoTx.save(created);`);
      lines.push(`        await tx.insert(schema.auditRecords).values({`);
      lines.push(`          auditId: randomUUID(),`);
      lines.push(`          operationId: "${camelId(opCreate(agg.name))}",`);
      lines.push(`          action: "create",`);
      lines.push(`          targetType: "${agg.name}",`);
      lines.push(`          targetId: created.id as string,`);
      lines.push(`          actor,`);
      lines.push(`          before: null,`);
      lines.push(`          after: repoTx.toWire(created),`);
      lines.push(`          at: new Date(),`);
      lines.push(`          status: "ok",`);
      lines.push(`          correlationId: reqCtx?.correlationId ?? null,`);
      lines.push(`          scopeId: reqCtx?.scopeId ?? null,`);
      lines.push(`          parentId: reqCtx?.parentId ?? null,`);
      lines.push(`        });`);
      lines.push(
        `        ${renderHonoLogCall("auditRecorded", `action: "create", target: "${agg.name}", actor`)}`,
      );
      lines.push(`      });`);
    } else {
      lines.push(`      await repo.save(created);`);
    }
    lines.push(
      `      ${renderHonoLogCall("aggregateCreated", `aggregate: "${agg.name}", id: created.id as string`)}`,
    );
    if (emitTrace) {
      // wire_out — outbound payload shape (keys only).  Bound to a const
      // so `c.json` doesn't re-evaluate the payload expression alongside
      // Object.keys.  See docs/old/proposals/observability.md.
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

  // Named find queries with STATIC paths (`find byHolder(...)` → GET
  // /by_holder) must register BEFORE the `GET /{id}` param route: Hono
  // matches in registration order, and `@hono/zod-openapi` validates the
  // `/{id}` param as `z.string().uuid()`, so a static segment registered
  // after `/{id}` is shadowed — `GET /by_holder` would match `/{id}` first
  // and 422 on the non-UUID segment.  The auto-`all` find stays at the root
  // (`GET /`, no conflict) and is emitted with the rest below.
  if (repo) {
    for (const find of repo.finds) {
      if (find.name === "all" || find.synthesized) continue;
      lines.push(...emitFindRoute(agg, find, ctx, emitTrace).map((l) => `  ${l}`));
      lines.push("");
    }
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
    // FK-restrict conflict status resolved through the `httpStatus` mapper
    // (M-T3.4a) — `ReferencedInUse`, 409 by default. Drives both the OpenAPI
    // declaration and the runtime arm below so they can't drift.
    const referencedInUseStatus = resolveErrorStatus(
      "ReferencedInUse",
      ctx.structuralErrorStatuses,
    );
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
    // RESTRICT) → 409 Conflict (or the `httpStatus ReferencedInUse` override).
    lines.push(
      `        ${referencedInUseStatus}: { description: ${JSON.stringify(httpStatusText(referencedInUseStatus))}, content: { "application/problem+json": { schema: ProblemDetails } } },`,
    );
    lines.push(`      },`);
    lines.push(`    }),`);
    lines.push(`    async (c) => {`);
    lines.push(`      const { id } = c.req.valid("param");`);
    if (!auditDestroy) {
      // Non-audited: the not-found probe stays OUTSIDE the FK-violation
      // try, byte-identical to the pre-audit baseline.  getById throws
      // AggregateNotFoundError (→ 404) when absent.
      lines.push(`      await repo.getById(Ids.${agg.name}Id(id));`);
    }
    lines.push(`      try {`);
    if (auditDestroy) {
      // Audited destroy — snapshot the loaded wire shape, write the
      // lifecycle audit row, THEN hard-delete, all in ONE transaction so
      // the row + deletion commit or roll back together (a failed delete
      // must not leave a spurious destroy record).  Asymmetry: `before` is
      // the last wire snapshot, `after` is JSON null (hard delete).  Actor
      // = the inbound claim via the untyped-key bridge (null when no auth).
      lines.push(
        `        const actor = (c as unknown as { get(k: "currentUser"): unknown }).get("currentUser") ?? null;`,
      );
      lines.push(`        const reqCtx = requestContext();`);
      lines.push(`        await db.transaction(async (tx) => {`);
      lines.push(`          const repoTx = new ${agg.name}Repository(tx, events);`);
      // getById throws AggregateNotFoundError (→ 404) when absent.
      lines.push(`          const loaded = await repoTx.getById(Ids.${agg.name}Id(id));`);
      lines.push(`          const before = repoTx.toWire(loaded);`);
      lines.push(`          await tx.insert(schema.auditRecords).values({`);
      lines.push(`            auditId: randomUUID(),`);
      lines.push(`            operationId: "${camelId(opDestroy(agg.name))}",`);
      lines.push(`            action: "destroy",`);
      lines.push(`            targetType: "${agg.name}",`);
      lines.push(`            targetId: id,`);
      lines.push(`            actor,`);
      lines.push(`            before,`);
      lines.push(`            after: null,`);
      lines.push(`            at: new Date(),`);
      lines.push(`            status: "ok",`);
      lines.push(`            correlationId: reqCtx?.correlationId ?? null,`);
      lines.push(`            scopeId: reqCtx?.scopeId ?? null,`);
      lines.push(`            parentId: reqCtx?.parentId ?? null,`);
      lines.push(`          });`);
      lines.push(
        `          ${renderHonoLogCall("auditRecorded", `action: "destroy", target: "${agg.name}", actor`)}`,
      );
      lines.push(`          await repoTx.delete(Ids.${agg.name}Id(id));`);
      lines.push(`        });`);
    } else {
      lines.push(`        await repo.delete(Ids.${agg.name}Id(id));`);
    }
    lines.push(`      } catch (err) {`);
    // PG foreign_key_violation (SQLSTATE 23503) — the row is still
    // referenced.  Map to a 409 problem locally so the shared onError
    // (and every other route's behaviour) stays untouched.  drizzle-orm
    // (>= the DrizzleQueryError era, e.g. the v5 zod-4 stack) wraps the driver
    // error, so the pg SQLSTATE rides `err.cause.code`, not `err.code`; read
    // both so the map works on the wrapped and the raw (older-drizzle) shapes.
    lines.push(
      `        if (err && typeof err === "object" && (((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code) === "23503")) {`,
    );
    lines.push(
      `          return c.body(JSON.stringify({ type: "about:blank", title: ${JSON.stringify(httpStatusText(referencedInUseStatus))}, status: ${referencedInUseStatus}, detail: "${agg.name} is still referenced and cannot be deleted.", instance: c.req.path }), ${referencedInUseStatus}, { "content-type": "application/problem+json" });`,
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
    if (op.when) {
      lines.push("");
      lines.push(...emitCanOpRoute(agg, op, emitTrace).map((l) => `  ${l}`));
    }
    lines.push("");
  }

  // The auto-included `all` find (`GET /`, root path — no conflict with
  // `/{id}`).  Named static-path finds were emitted ABOVE, before the
  // `GET /{id}` param route, so they win Hono's registration-order match.
  if (repo) {
    for (const find of repo.finds) {
      if (find.name !== "all") continue;
      lines.push(...emitFindRoute(agg, find, ctx, emitTrace).map((l) => `  ${l}`));
      lines.push("");
    }
  }

  // Structural-conflict statuses resolved through the `httpStatus` mapper
  // (expressible-builtins.md §3 / M-T3.4a): a literal 409 by default, or the
  // api's `httpStatus <Conflict> -> <Code>` override. Both the runtime arm and the
  // OpenAPI declaration read the same resolved value so they can't drift. The
  // `problem` helper's status union widens to the set actually used — with no
  // override every value is 409, so the union stays `400 | 403 | 404 | 409 | 500`
  // (byte-identical); an override adds its code.
  const disallowedStatus = resolveErrorStatus("Disallowed", ctx.structuralErrorStatuses);
  const uniquenessStatus = resolveErrorStatus("UniquenessConflict", ctx.structuralErrorStatuses);
  const concurrencyStatus = resolveErrorStatus("ConcurrencyConflict", ctx.structuralErrorStatuses);
  // The status literals this router's `problem()` helper is actually called
  // with — the always-present base set plus each structural-conflict status
  // whose arm is emitted (gated exactly as the arms below). With no override
  // every conflict is 409, so the union stays `400 | 403 | 404 | 409 | 500`.
  const emittedProblemStatuses = new Set<number>([400, 403, 404, 500, disallowedStatus]);
  if ((agg.uniqueKeys?.length ?? 0) > 0) emittedProblemStatuses.add(uniquenessStatus);
  if (aggregateIsVersioned(agg) || aggregateIsEventSourced(agg))
    emittedProblemStatuses.add(concurrencyStatus);
  const problemStatusUnion = [...emittedProblemStatuses].sort((a, b) => a - b).join(" | ");
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
    `    const problem = (status: ${problemStatusUnion}, title: string, detail: string) => c.body(JSON.stringify({ type: "about:blank", title, status, detail, instance: c.req.path }), status, { "content-type": "application/problem+json", "x-request-id": trace_id });`,
  );
  lines.push(`    if (err instanceof ForbiddenError) {`);
  lines.push(
    `      ${renderHonoLogCall("forbidden", `aggregate: "${agg.name}", message: err.message, status: 403`)}`,
  );
  lines.push(`      return problem(403, "Forbidden", err.message);`);
  lines.push(`    }`);
  lines.push(`    if (err instanceof DisallowedError) {`);
  lines.push(
    `      ${renderHonoLogCall("disallowed", `aggregate: "${agg.name}", message: err.message, status: ${disallowedStatus}`)}`,
  );
  lines.push(`      return problem(${disallowedStatus}, "Disallowed", err.message);`);
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
  // PG unique_violation (SQLSTATE 23505) — a `unique (...)` domain invariant
  // was breached (the DB unique index is the enforcement contract,
  // uniqueness-and-indexes.md D-UNIQUE-DB-AUTHORITATIVE).  Map to 409 Conflict
  // (mirrors the local 23503 FK-violation handling on the delete route).  The
  // constraint name (`<table>_<cols>_uq`) rides the pg error for traceability.
  // Gated on a declared `unique` key so a model with none emits byte-identically
  // (the proposal's strict-additivity guarantee) — only such a table can 23505.
  if ((agg.uniqueKeys?.length ?? 0) > 0) {
    // drizzle-orm wraps the driver error (DrizzleQueryError), so the pg
    // SQLSTATE + constraint ride `err.cause`, not `err` directly — read both so
    // a genuine unique breach maps to 409 under the wrapped (v5) and raw
    // (older-drizzle) shapes alike, instead of falling through to a 500.
    lines.push(
      `    if (err && typeof err === "object" && (((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code) === "23505")) {`,
    );
    lines.push(
      `      ${renderHonoLogCall("disallowed", `aggregate: "${agg.name}", message: (err as { constraint?: string }).constraint ?? (err as { cause?: { constraint?: string } }).cause?.constraint ?? "unique_violation", status: ${uniquenessStatus}`)}`,
    );
    lines.push(
      `      return problem(${uniquenessStatus}, "Conflict", \`A ${agg.name} with these values already exists.\`);`,
    );
    lines.push(`    }`);
  }
  // Optimistic-concurrency conflict (`versioned` capability): the repository's
  // guarded write affected zero rows — the expected version no longer matches
  // the stored row (another request won the race).  Map to 409 Conflict, same
  // status as the `when` state-gate and 23505 arms above but a DISTINCT log
  // event (`conflict`, not `disallowed`) so a dashboard can separate a stale
  // write from a uniqueness clash or a state-gate refusal.  Gated on the
  // aggregate declaring `versioned` OR being event-sourced so a plain model
  // emits byte-identically — only such a table's save ever throws
  // ConcurrencyError (the guarded write's stale-write rejection, or the
  // event-log append's `(stream_id, version)` 23505 collision).
  if (aggregateIsVersioned(agg) || aggregateIsEventSourced(agg)) {
    lines.push(`    if (err instanceof ConcurrencyError) {`);
    lines.push(
      `      ${renderHonoLogCall("conflict", `aggregate: "${agg.name}", message: err.message, status: ${concurrencyStatus}`)}`,
    );
    lines.push(`      return problem(${concurrencyStatus}, "Conflict", err.message);`);
    lines.push(`    }`);
  }
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

/** The `when` canCommand gate (criterion.md use site 2): evaluate the
 *  predicate against the loaded aggregate; false → DisallowedError,
 *  which the shared onError maps to a 409 ProblemDetails.  Throwing
 *  (rather than an inline `return c.json`) keeps one shape across the
 *  plain, returning, and transactional (audit/prov) paths. */
function whenGateLine(agg: AggregateIR, op: OperationIR, pad: string): string[] {
  if (!op.when) return [];
  const pred = renderTsExpr(op.when, { thisName: "aggregate" });
  return [
    `${pad}if (!(${pred})) throw new DisallowedError(${JSON.stringify(
      `operation '${op.name}' is not allowed in the current state of ${agg.name}.`,
    )});`,
  ];
}

/** The auto-exposed, side-effect-free `GET /{id}/can_<op>` companion of a
 *  `when`-gated operation — returns `{ allowed }` so a UI can enable or
 *  disable the action without invoking it (the canCommand pattern). */
function emitCanOpRoute(agg: AggregateIR, op: OperationIR, emitTrace: boolean): string[] {
  if (!op.when) return [];
  void emitTrace;
  const aggSlug = snake(plural(agg.name));
  const opSnake = snake(op.routeSlug ?? op.name);
  const pred = renderTsExpr(op.when, { thisName: "aggregate" });
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "/{id}/can_${opSnake}",`);
  out.push(`    tags: ["${aggSlug}"],`);
  out.push(`    operationId: "${camelId(opOperation(agg.name, `can_${op.name}`))}",`);
  out.push(`    request: {`);
  out.push(`      params: z.object({ id: z.string().uuid() }),`);
  out.push(`    },`);
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: z.object({ allowed: z.boolean() }) } } },`,
  );
  out.push(
    `      404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (c) => {`);
  out.push(`    const { id } = c.req.valid("param");`);
  out.push(`    const aggregate = await repo.getById(Ids.${agg.name}Id(id));`);
  out.push(`    return c.json({ allowed: ${pred} }, 200);`);
  out.push(`  },`);
  out.push(`);`);
  return out;
}

function emitOperationRoute(
  agg: AggregateIR,
  op: OperationIR,
  ctx: BoundedContextIR,
  audit: boolean,
  prov: boolean,
  emitTrace: boolean,
): string[] {
  // Lifecycle stamps are applied persist-time in the drizzle save()
  // (node-persist-time-auditing); the operation route no longer stamps.
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
  // The canonical `update(...)` operation (crudish, or a hand-declared one of
  // the same name) is the one route that honours the client's optimistic-
  // concurrency precondition (`updatePreconditions(agg.wireShape)` — the
  // `version` token field) via an `If-Match` request header.  Every other
  // mutate route on a versioned aggregate still gets a guarded write (see
  // repository-save-builder.ts), just via the write-time CAS fallback
  // (`aggregate.version`, the value the route just loaded) rather than a
  // client-supplied header.
  const isVersionedUpdate = op.name === "update" && aggregateIsVersioned(agg);
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
  // docs/old/proposals/validation-error-extension.md.
  out.push(
    `      400: { description: "Bad Request", content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  out.push(
    `      422: { description: "Unprocessable Entity", content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  // A `when` state gate denies with 409 (DisallowedError → onError); a
  // versioned `update` can also 409 on a stale `If-Match` (ConcurrencyError →
  // onError).  Each status resolves through the `httpStatus` mapper (M-T3.4a):
  // 409 by default (both reasons collapse to one `409:` line, byte-identical),
  // or a per-conflict override.
  const opConflictStatuses = new Set<number>();
  if (op.when)
    opConflictStatuses.add(resolveErrorStatus("Disallowed", ctx.structuralErrorStatuses));
  if (isVersionedUpdate)
    opConflictStatuses.add(resolveErrorStatus("ConcurrencyConflict", ctx.structuralErrorStatuses));
  for (const status of [...opConflictStatuses].sort((a, b) => a - b)) {
    out.push(
      `      ${status}: { description: ${JSON.stringify(httpStatusText(status))}, content: { "application/problem+json": { schema: ProblemDetails } } },`,
    );
  }
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
  // The operation body reads the typed `currentUser` only when it references
  // it directly; lifecycle stamps no longer thread the principal through the
  // handler (stamped persist-time in the drizzle save()).
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
  // Extern operations (extern (b) Phase 2) re-home to an aggregate-owned hook,
  // so the operation method itself runs preconditions → hook → invariants —
  // the route calls it exactly like a non-extern op.
  const mutation = (pad: string): string[] => [
    `${pad}aggregate.${lowerFirst(op.name)}(${callArgs});`,
  ];

  if (!audit && !prov) {
    out.push(`    const aggregate = await repo.getById(Ids.${agg.name}Id(id));`);
    if (isVersionedUpdate) {
      // `If-Match` carries the client's expected version
      // (docs/old/plans/optimistic-concurrency-versioned.md /
      // updatePreconditions); absent header falls back to the version just
      // loaded, so an unaware client still gets a coherent guarded write.
      out.push(`    const ifMatch = c.req.header("if-match");`);
      out.push(
        `    const expectedVersion = ifMatch !== undefined ? Number(ifMatch) : aggregate.version;`,
      );
    }
    out.push(...whenGateLine(agg, op, "    "));
    out.push(...mutation("    "));
    out.push(
      isVersionedUpdate
        ? `    await repo.save(aggregate, expectedVersion);`
        : `    await repo.save(aggregate);`,
    );
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
    // The request correlation id + frame scope id stamped onto every audit /
    // provenance row, tying each to the request (and its causality position)
    // that produced it.  Read from the ambient RequestContext opened by the
    // request-id middleware.
    out.push(`    const reqCtx = requestContext();`);
    out.push(`    await db.transaction(async (tx) => {`);
    out.push(`      const repoTx = new ${agg.name}Repository(tx, events);`);
    out.push(`      const aggregate = await repoTx.getById(Ids.${agg.name}Id(id));`);
    if (isVersionedUpdate) {
      out.push(`      const ifMatch = c.req.header("if-match");`);
      out.push(
        `      const expectedVersion = ifMatch !== undefined ? Number(ifMatch) : aggregate.version;`,
      );
    }
    out.push(...whenGateLine(agg, op, "      "));
    if (audit) out.push(`      const before = repoTx.toWire(aggregate);`);
    out.push(...mutation("      "));
    out.push(
      isVersionedUpdate
        ? `      await repoTx.save(aggregate, expectedVersion);`
        : `      await repoTx.save(aggregate);`,
    );
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
      out.push(`        correlationId: reqCtx?.correlationId ?? null,`);
      out.push(`        scopeId: reqCtx?.scopeId ?? null,`);
      out.push(`        parentId: reqCtx?.parentId ?? null,`);
      out.push(`      });`);
      out.push(
        `      ${renderHonoLogCall("auditRecorded", `action: "${op.name}", target: "${agg.name}", actor`)}`,
      );
    }
    if (prov) {
      // One history row per provenanced write captured during the mutation;
      // traceId + at are stamped here so the domain layer stays pure.
      out.push(`      const __prov = aggregate.drainProv();`);
      out.push(`      for (const t of __prov) {`);
      out.push(`        await tx.insert(schema.provenanceRecords).values({`);
      out.push(`          traceId: randomUUID(),`);
      out.push(`          snapshotId: t.snapshotId,`);
      out.push(`          targetType: t.target.type,`);
      out.push(`          field: t.target.field,`);
      out.push(`          inputs: t.inputs,`);
      out.push(`          computedValue: t.computedValue,`);
      out.push(`          at: new Date(),`);
      out.push(`          correlationId: reqCtx?.correlationId ?? null,`);
      out.push(`          scopeId: reqCtx?.scopeId ?? null,`);
      out.push(`          actorId: reqCtx?.actorId ?? null,`);
      out.push(`          parentId: reqCtx?.parentId ?? null,`);
      out.push(`        });`);
      out.push(`      }`);
      out.push(`      if (__prov.length > 0) {`);
      out.push(
        `        ${renderHonoLogCall("provenanceRecorded", `aggregate: "${agg.name}", count: __prov.length`)}`,
      );
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
    // Codes a `httpStatus <StructuralConflict> -> <Code>` override may retarget a
    // conflict to (M-T3.4a) — so the OpenAPI `description` stays a real reason
    // phrase, not a generic fallback.
    423: "Locked",
    428: "Precondition Required",
    429: "Too Many Requests",
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
  // Lifecycle stamps are applied persist-time in the drizzle save()
  // (node-persist-time-auditing); the operation route no longer stamps.
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
  if (op.when) problemStatuses.add(resolveErrorStatus("Disallowed", ctx.structuralErrorStatuses));
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
  out.push(...whenGateLine(agg, op, "    "));
  // Lifecycle stamps are applied persist-time in the drizzle save()
  // (node-persist-time-auditing) — the handler no longer stamps.
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
  const isList = find.returnType.kind === "array";
  // A union find's 200 body is the SUCCESS variant directly (the aggregate),
  // not a tagged `oneOf` component — the error/absent variant is a separate
  // status response (below), never part of the 200 schema (exception-less.md
  // §4: "success bodies carry the variant data directly with HTTP 200").  So
  // a single-success union find shares the plain `<Agg>Response` 200 shape
  // with `<Agg>?` / `<Agg> option`.
  const responseSchema = paged
    ? paged.name
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
  // Union finds (`Agg or NotFound` / `Agg option`) translate absence to a
  // ProblemDetails at the absent variant's status — same edge translation as
  // the exception-less operation routes (exception-less.md).
  const unionSpec = findUnionSpec(find.returnType, agg.name, ctx);
  const unionAbsentStatus = unionSpec
    ? unionSpec.absent.kind === "none"
      ? 404
      : (ctx.errorStatusOverrides?.[unionSpec.absent.tag] ??
        defaultErrorStatus(unionSpec.absent.tag))
    : undefined;
  if (find.returnType.kind === "optional" || unionAbsentStatus !== undefined) {
    const st = unionAbsentStatus ?? 404;
    out.push(
      `      ${st}: { description: ${JSON.stringify(httpStatusText(st))}, content: { "application/problem+json": { schema: ProblemDetails } } },`,
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
    const pagedArgs = [...baseArgs, "params.page", "params.pageSize", "params.sort", "params.dir"];
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
  if (unionSpec) {
    // Absence → the absent variant's edge translation: `none` rides the same
    // AggregateNotFoundError → 404 path optional finds use; an `error` payload
    // becomes an RFC-7807 ProblemDetails at its mapped status (title/type from
    // the stdlib defaults), carrying `resource: "<Agg>"` when declared.
    if (unionSpec.absent.kind === "none") {
      out.push(`    if (result == null) throw new AggregateNotFoundError("not_found");`);
    } else {
      const tag = unionSpec.absent.tag;
      const st = unionAbsentStatus ?? defaultErrorStatus(tag);
      const resourceExt = unionSpec.absent.hasResource
        ? `resource: ${JSON.stringify(agg.name)}, `
        : "";
      out.push(`    if (result == null) {`);
      out.push(
        `      return c.json({ ${resourceExt}type: ${JSON.stringify(errorTypeUri(tag))}, title: ${JSON.stringify(errorTitle(tag))}, status: ${st}, detail: ${JSON.stringify(errorTitle(tag))}, instance: c.req.path }, ${st}, { "content-type": "application/problem+json" });`,
      );
      out.push(`    }`);
    }
    // Found → the success variant directly (untagged).  A single-success
    // union find carries no discriminator: the 200 body is `<Agg>Response`,
    // identical to `<Agg>?` / `<Agg> option` (exception-less.md §4).
    out.push(`    return c.json(repo.toWire(result) as z.infer<typeof ${agg.name}Response>, 200);`);
  } else if (isList) {
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
  // forApiRead: `internal`/`secret` fields never reach a read response —
  // toWire projects through the same filter, and the schema must decide
  // visibility identically or the OpenAPI spec drifts from the wire.
  // M-T5.10 (PR3): when the context declares a `response <Agg>Response` record
  // (spliced by `scaffoldHandlers`), READ that record's fields for the aggregate
  // root instead of re-deriving from `wireShape` — byte-identical for the
  // scaffolded form, authoritative for a hand-declared divergent one.  Only the
  // aggregate root is rewired; part/VO schemas stay on the wireShape path
  // (emitted as before).  The record omits `id` (grammar-reserved), so the
  // leading `id: z.string()` is re-prepended, mirroring the synthetic wire-shape
  // id row `responseRecordParams` / this walk would emit.
  const declaredResponse = isAgg
    ? ctx.payloads.find((p) => p.kind === "response" && p.name === name)
    : undefined;
  if (declaredResponse) {
    lines.push(`  id: z.string(),`);
    for (const f of declaredResponse.fields) {
      lines.push(`  ${f.name}: ${zodForResponseField(f.type, f.optional, ctx)},`);
    }
  } else {
    const fields = forApiRead(wireFieldsFor(ent));
    for (const wf of fields) {
      if (wf.source === "id") {
        lines.push(`  ${wf.name}: z.string(),`);
      } else {
        lines.push(`  ${wf.name}: ${zodForResponse(wf.type, wf.optional)},`);
      }
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
export function zodForResponse(t: TypeIR, optional: boolean): string {
  const z = zodForResponseInner(t);
  // `zodForResponseInner` already appends `.nullish()` for a nullable type;
  // only add it for an `optional` field whose type isn't already nullable,
  // so an optional `T?` field doesn't emit `.nullish().nullish()`.
  const alreadyNullable = wireTypeInfo(t, "response").isNullable;
  return optional && !alreadyNullable ? `${z}.nullish()` : z;
}

/** Zod for a field of a DECLARED `response` payload record (M-T5.10 PR3).  A VO /
 *  scalar / enum / id field carries its DOMAIN type, so `zodForResponse` maps it
 *  exactly as the wireShape path.  A CONTAINMENT field is ALREADY the sibling
 *  `<Part>Response` name (context scope can't reference a raw entity part, so PR1
 *  rewrote it to the part's own response record) — it lowers to an `entity`
 *  TypeIR whose name is a declared `response` payload, which must be rendered
 *  DIRECTLY (`z.array(LabelResponse)`); running it through `zodForResponse` would
 *  append a second `Response` (`z.array(LabelResponseResponse)`). */
function zodForResponseField(t: TypeIR, optional: boolean, ctx: BoundedContextIR): string {
  const info = wireTypeInfo(t, "response");
  if (info.refKind === "entity" && isResponsePayloadName(ctx, info.base)) {
    let z = info.base;
    if (info.isCollection) z = `z.array(${z})`;
    if (info.isNullable || optional) z = `${z}.nullish()`;
    return z;
  }
  return zodForResponse(t, optional);
}

/** True iff `name` is a declared `response` payload in the context — i.e. a
 *  containment field's already-wire type, which must not be re-suffixed. */
function isResponsePayloadName(ctx: BoundedContextIR, name: string): boolean {
  return ctx.payloads.some((p) => p.kind === "response" && p.name === name);
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

/** Render a create-input field's default in WIRE form for its zod schema.
 *  An enum field's request schema is `z.enum([<wire strings>])`, so its
 *  `.default(...)` must be the wire STRING — not the runtime enum const
 *  `Enum.Value` that `renderTsExpr` emits for an enum-value expression.
 *  The route file imports the value-object runtime classes but NOT the
 *  enum consts (enums travel as strings on the wire), so a const
 *  reference is undefined at bundle time ("SalesOrderStatus is not
 *  defined").  Emitting the value name as a string literal is both
 *  in-scope and wire-correct.  Every non-enum default renders as its
 *  ordinary TS expression. */
function wireDefaultLiteral(type: TypeIR, d: ExprIR): string {
  const inner = peelNullable(peelCollection(type));
  if (inner.kind === "enum" && d.kind === "ref" && d.refKind === "enum-value") {
    return JSON.stringify(d.name);
  }
  return renderTsExpr(d);
}

function collectUsedValueObjects(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): ValueObjectIR[] {
  const { valueObjects } = collectReachableTypes(aggSchemaSeeds(agg, repo), ctx.valueObjects);
  return ctx.valueObjects.filter((v) => valueObjects.has(v.name));
}

function collectUsedEnums(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): EnumIR[] {
  const { enums } = collectReachableTypes(aggSchemaSeeds(agg, repo), ctx.valueObjects);
  return ctx.enums.filter((e) => enums.has(e.name));
}

/** Every type named on the aggregate's HTTP surface — its own fields,
 *  derived, public-operation + find params, and contained parts.  The
 *  schema collectors take the transitive closure of these through value
 *  objects' own fields (see `collectReachableTypes`). */
function* aggSchemaSeeds(agg: AggregateIR, repo: RepositoryIR | undefined): Generator<TypeIR> {
  for (const f of agg.fields) yield f.type;
  for (const d of agg.derived) yield d.type;
  for (const op of agg.operations) for (const p of op.params) yield p.type;
  for (const f of repo?.finds ?? []) for (const p of f.params) yield p.type;
  for (const part of agg.parts) {
    for (const f of part.fields) yield f.type;
    for (const d of part.derived) yield d.type;
  }
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
  // `default` (when set) is the zod `.default(...)` literal; it is appended
  // AFTER the single-field invariant chain, because `.default(x)` returns a
  // `ZodDefault` that no longer exposes `.min`/`.max` — emitting
  // `.default(3).min(1)` is a type error that poisons the whole object
  // schema's inferred type (every `body.<field>` then becomes `unknown`).
  fields: { name: string; base: string; default?: string }[],
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
    // `.default(...)` last: it wraps the (now constrained) schema in a
    // ZodDefault, so any `.min`/`.max` must already be applied above.
    if (f.default !== undefined) schema = `${schema}.default(${f.default})`;
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
