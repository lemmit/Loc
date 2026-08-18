import {
  isServerSourcedDefault,
  serverSourcedDefaultFields,
} from "../../../generator/_frontend/server-default.js";
import { renderHonoLogCall } from "../../../generator/_obs/render-hono.js";
import {
  discriminatedUnionZod,
  findUnionSpec,
  type UnionMemberField,
  unionMemberObjects,
  unionMembers,
} from "../../../generator/_payload/union-wire.js";
import { MONEY_WIRE_SCALE } from "../../../generator/money-scale.js";
import {
  historyMapperArgs,
  historyMapperName,
  historyNeedsPrincipal,
  historySelectStatement,
  renderHistoryEntryMapper,
} from "../../../generator/typescript/emit/audit-history.js";
import { renderTsExpr } from "../../../generator/typescript/render-expr.js";
import { aggHasFieldMask } from "../../../generator/typescript/repository-wire-builder.js";
import {
  chainSingleFieldNative,
  openapiLengthMeta,
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
  PAGED_MAX_PAGE,
  PAGED_MAX_PAGE_SIZE,
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
  findGateUsesCurrentUser,
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
  type ApiOperationIR,
  apiStatusContext,
  deriveAggregateOperations,
  findValidatesRequest,
  isAllFind,
  relativeOpPath,
} from "../../../ir/util/api-surface.js";
import { partsChildrenFirst } from "../../../ir/util/containment-parent.js";
import {
  lifecycleGates,
  lifecycleGatesReadRow,
  lifecycleGatesUseCurrentUser,
  operationBodyUsesCurrentUser,
  operationGates,
  operationGatesUseCurrentUser,
} from "../../../ir/util/op-gates.js";
import { problemTitle, UNPROCESSABLE_ENTITY } from "../../../ir/util/openapi-errors.js";
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

/** Marker line standing in for the `./problem-details` import until the router
 *  body is assembled — the named list depends on what the body references (see
 *  the patch at the bottom of `renderAggregateRoutes`). */
const PROBLEM_IMPORT_PLACEHOLDER = "/* __LOOM_PROBLEM_IMPORT__ */";

/** Transaction wrapper for the audit / provenance history flush.  drizzle:
 *  `db.transaction`; mikroorm: the EntityManager's `db.transactional` (which
 *  opens a real DB transaction and threads its async context to the forked
 *  repo em — see the mikro repos' `keepTransactionContext` fork).  The callback
 *  var stays `tx` on both, so the repo construction + close line are shared. */
function txWrapperCall(usingMikro: boolean): string {
  return usingMikro ? `db.transactional(async (tx) => {` : `db.transaction(async (tx) => {`;
}

// ── Response-boundary read masking (`mask unless`, authorization.md §5) ──
// A masked aggregate routes every RESPONSE serialization through
// `repo.toWireMasked(x, __maskUser)` instead of `repo.toWire(x)`, redacting
// masked fields the caller may not see.  `__maskUser` is a dedicated local
// (never collides with a gate-bound `currentUser`) resolved fail-closed:
// unauthenticated → null → redacted.  A mask-free aggregate keeps `toWire`
// verbatim, so non-mask projects stay byte-identical.

// ── Entity history — `GET /<agg>/{id}/history` (docs/audit.md) ──────────────

/** The per-entity history read.  Three things make it safe, in order:
 *
 *  1. **The gate.** `historyFind.requires` is the aggregate's own list-read
 *     gate, copied at enrichment — so history is never easier to reach than
 *     the entity read it replays.  Fails → 403, before any query runs.
 *
 *  2. **Entity reachability.** `audit_records` is a cross-context machinery
 *     table: it carries `target_type`/`target_id` and NO tenant column, so
 *     there is nothing on it for a capability query-filter to scope.  Scoping
 *     is therefore done on the ENTITY: the handler resolves the row through
 *     `repo.findById`, which already carries every capability predicate
 *     (`tenantOwned`'s tenant floor included) and honours the find's
 *     `ignoring` stance.  A row the caller cannot read yields 404 here — the
 *     same answer the entity read gives, so history discloses nothing about
 *     rows in another tenant, not even their existence.
 *
 *  3. **The mask.** The row → entry mapper drops each `mask unless` field's
 *     change entry for a caller who fails the predicate.
 *
 *  All three are needed: the gate alone leaks across tenants, reachability
 *  alone leaks masked fields to legitimate readers, and the mask alone leaves
 *  the endpoint open. */
function emitHistoryRoute(agg: EnrichedAggregateIR, find: FindIR, usingMikro: boolean): string[] {
  const out: string[] = [];
  const aggSlug = snake(plural(agg.name));
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "/{id}/history",`);
  out.push(`    tags: ["${aggSlug}"],`);
  out.push(`    operationId: "${camelId(opFind(agg.name, "history"))}",`);
  out.push(`    request: { params: z.object({ id: z.string().uuid() }) },`);
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: z.array(AuditEntryResponse) } } },`,
  );
  if (find.requires) {
    out.push(
      `      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemDetails } } },`,
    );
  }
  out.push(
    `      404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  // The `{id}` uuid parse — same wire-validation tier every other `{id}` route
  // declares.  Hand-rolled here (history is `apiSurfaceCoverage.notLifted`),
  // but the SET is `errorStatuses("getById")`, which is literally what the
  // .NET and python history routes render — so it moves with them.
  out.push(
    `      ${UNPROCESSABLE_ENTITY}: { description: ${JSON.stringify(problemTitle(UNPROCESSABLE_ENTITY))}, content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (c) => {`);
  out.push(`    const { id } = c.req.valid("param");`);
  if (findGateUsesCurrentUser(find)) {
    out.push(
      `    const currentUser = (c as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
    );
  }
  if (find.requires) {
    // Audit-history's 403 `detail` stays bare `Forbidden` for now: unlike the
    // plain read gates below, the descriptive backends disagree on its LABEL
    // (java/python `find history` vs elixir `history <Agg>`), so unifying it is
    // #2540's audit-history mission, not this read-gate fix.
    out.push(`    if (!(${renderTsExpr(find.requires)})) throw new ForbiddenError("Forbidden");`);
  }
  // (2) above — capability scoping rides the entity read, because the audit
  // table has no tenant column of its own to filter on.
  out.push(`    const __target = await repo.findById(Ids.${agg.name}Id(id));`);
  // RS-27, same site class as the getById route above: history is a by-id read,
  // so its 404 carries the same sentence.  python's history route reaches the
  // message by CALLING `repo.get_by_id` for exactly this reachability probe
  // (`python/routes-builder.ts` historyRoute); Hono probes with `findById`, so
  // it has to spell the message itself.
  out.push(
    `    if (!__target) throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`,
  );
  // Fail-closed principal for the mask pass: unauthenticated → null → every
  // masked field's change entry is dropped.  Bound only when there is a mask;
  // otherwise the mapper takes no principal (and the project need not carry an
  // `auth/user-types` module at all).
  if (historyNeedsPrincipal(agg)) {
    out.push(
      `    const __histUser = (c as unknown as { get(k: "currentUser"): import("../auth/user-types").User | undefined }).get("currentUser") ?? null;`,
    );
  }
  out.push(...historySelectStatement(agg, usingMikro).map((l) => `    ${l}`));
  out.push(
    `    return c.json(__rows.map((r) => ${historyMapperName(agg)}(${historyMapperArgs(agg)})), 200);`,
  );
  out.push(`  },`);
  out.push(`);`);
  return out;
}

/** The `__maskUser` binding line(s) for a masked-aggregate response route. */
function maskUserBind(agg: AggregateIR, pad: string): string[] {
  return aggHasFieldMask(agg)
    ? [
        `${pad}const __maskUser = (c as unknown as { get(k: "currentUser"): import("../auth/user-types").User | undefined }).get("currentUser") ?? null;`,
      ]
    : [];
}

/** The response serializer call for one entity var — masked or plain. */
function wireResp(agg: AggregateIR, repoVar: string, varExpr: string): string {
  return aggHasFieldMask(agg)
    ? `${repoVar}.toWireMasked(${varExpr}, __maskUser)`
    : `${repoVar}.toWire(${varExpr})`;
}

/** History-row insert opener.  drizzle: `tx.insert(schema.<table>).values({`;
 *  mikroorm: `tx.insert(<Row>, {` (the EntityManager insert takes the entity
 *  class + a plain data object).  The row-value entries + `});` close are
 *  identical between backends. */
function historyInsertCall(
  usingMikro: boolean,
  table: "auditRecords" | "provenanceRecords",
): string {
  if (!usingMikro) return `tx.insert(schema.${table}).values({`;
  const row = table === "auditRecords" ? "AuditRecordRow" : "ProvenanceRecordRow";
  return `tx.insert(${row}, {`;
}

/** A derived operation's router-relative path in Hono's spelling — the
 *  collection root is `"/"`, params keep their `{id}` braces. */
function honoPath(entry: ApiOperationIR): string {
  const rel = relativeOpPath(entry);
  return rel === "" ? "/" : rel;
}

/** The declared non-2xx `responses:` lines of a derived operation —
 *  `entry.errorStatuses` is already httpStatus-resolved, sorted, deduped
 *  (base matrix + when/versioned conflicts + union error arms + the gated
 *  403s), so the route renders it verbatim.  THE UNIFICATION SEAM: the
 *  numbers come from `deriveAggregateOperations`; only the line idiom
 *  (description text via `httpStatusText`, ProblemDetails content) is
 *  Hono's. */
function problemResponseLines(entry: ApiOperationIR, pad: string): string[] {
  return entry.errorStatuses.map(
    (s) =>
      `${pad}${s}: { description: ${JSON.stringify(httpStatusText(s))}, content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
}

/** The STATIC one-segment sub-paths an aggregate router mounts, each mapped to
 *  the methods it actually serves — `{ by_email: ["GET"], prepare: ["GET"] }`.
 *
 *  These are exactly the paths the sibling `/{id}` route can swallow: hono keys
 *  its router on (method, path), so `DELETE /api/customers/by_email` finds no
 *  `delete /by_email` and matches `delete /{id}` with `id = "by_email"`.  The
 *  `{id}` param validator then answers `422 Invalid UUID` for a path that has
 *  no DELETE at all (schemathesis F8).  Registration order already fixes the
 *  same-verb case (a static find is registered BEFORE `/{id}`, see the comment
 *  at that loop); the WRONG-verb case needs the guard below.
 *
 *  Only one-segment statics are affected: `/{id}/history` and `/{id}/can_<op>`
 *  are two segments, so nothing shadows them and a wrong verb there already
 *  falls through to the root router's `app.notFound` 405 arm. */
function staticSubpathMethods(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  emitCreate: boolean,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (segment: string, method: string): void => {
    const methods = out[segment] ?? [];
    methods.push(method);
    out[segment] = methods;
  };
  // `GET /prepare` — emitted on the same condition its route arm below is.
  if (emitCreate && serverSourcedDefaultFields(createInputFields(agg)).length > 0) {
    add("prepare", "GET");
  }
  // `GET /<snake(find)>` — every named (non-`all`, non-synthesized) find.
  for (const find of repo?.finds ?? []) {
    if (find.name === "all" || find.synthesized) continue;
    add(snake(find.name), "GET");
  }
  return out;
}

/** The router-level guard that turns a wrong verb on a static sub-path into the
 *  honest 405 + `Allow` instead of the `/{id}` validator's 422.
 *
 *  It has to be a MIDDLEWARE, and it has to sit at the top of the router: the
 *  `@hono/zod-openapi` param validator runs as part of the matched route's own
 *  handler chain, so any check inside the `/{id}` handlers is already too late
 *  — the 422 has been answered.  `app.use` registers under method `ALL`, which
 *  the root router's `allowedFor` probe skips by construction, so `app.notFound`
 *  keeps answering exactly what it answered before for every other path. */
function emitStaticSubpathMethodGuard(statics: Record<string, string[]>): string[] {
  if (Object.keys(statics).length === 0) return [];
  // `snake(...)` segments are identifier-safe, and Biome's formatter strips a
  // redundant quote from an object key — so emit the bare form it would.
  const entries = Object.entries(statics)
    .map(
      ([segment, methods]) =>
        `${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment) ? segment : JSON.stringify(segment)}: ${JSON.stringify(methods)}`,
    )
    .join(", ");
  return [
    "  // A STATIC sub-path is captured by the sibling `/{id}` route under any",
    "  // verb it does not itself serve, and the param validator then answers 422",
    "  // for a path that has no such method at all.  405 is the honest answer and",
    "  // the only one that can carry an `Allow` the caller can act on (RFC 9110",
    "  // §15.5.6).  Runs BEFORE the param validator, which is why it is a",
    "  // middleware; registered under method ALL, so the root router's",
    "  // method probe (http/index.ts) is unaffected.",
    `  const staticSubpathMethods: Record<string, string[]> = { ${entries} };`,
    '  app.use("/:__seg", async (c, next) => {',
    '    const allow = staticSubpathMethods[c.req.path.slice(c.req.path.lastIndexOf("/") + 1)];',
    "    if (allow && !allow.includes(c.req.method)) {",
    "      return c.body(",
    "        frameworkProblemBody(405, `method ${c.req.method} is not supported for ${c.req.path}`, c.req.path),",
    "        405,",
    '        { "content-type": "application/problem+json", allow: allow.join(", ") },',
    "      );",
    "    }",
    "    await next();",
    "  });",
    "",
  ];
}

export function buildRoutesFile(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  emitAudit = false,
  emitProvenance = false,
  emitTrace = false,
  // `persistence: mikroorm` — the audited / provenanced history flush runs on
  // the MikroORM EntityManager (`db.transactional` + `em.insert(<Row>, …)`)
  // instead of drizzle's `db.transaction` + `tx.insert(schema.<table>)`.  The
  // drizzle default keeps `usingMikro = false`, so its output is byte-identical.
  usingMikro = false,
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
  // Entity history (docs/audit.md) — the read side of the trail those inserts
  // write.  Driven by the enrichment-derived `historyFind` rather than by
  // re-deriving "is this audited" here, so the read surface can never disagree
  // with the gate/`ignoring` stance enrichment resolved.  `emitAudit` gates it
  // too: a deployable with auditing off writes no rows, and a route serving an
  // always-empty timeline reads as authoritative while saying nothing.
  const historyFind = emitAudit ? repo?.historyFind : undefined;
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
  // Deferred: `requireJsonContentType` joins the named imports only when this
  // router actually emits a body-carrying route (an aggregate with neither a
  // canonical create nor a public operation emits none, and an unused import
  // trips Biome's `noUnusedImports` on the emitted project).  Patched from the
  // assembled body at the bottom of this function, like the VO import.
  lines.push(PROBLEM_IMPORT_PLACEHOLDER);
  lines.push(`import { HTTPException } from "hono/http-exception";`);
  // Domain metrics (M-T7.1): per-operation + per-fault counters, recorded at
  // the same seams as the operation_invoked / fault log lines below.
  lines.push(`import { recordDomainFault, recordDomainOperation } from "../obs/metrics";`);
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
    if (usingMikro) {
      // MikroORM edition: `db` is the EntityManager and the history rows are
      // its Row entities (`em.insert(<Row>, …)`), so pull the entity classes +
      // the EntityManager type in place of the drizzle schema module.
      const histRows = [
        ...(fileHasAudit ? ["AuditRecordRow"] : []),
        ...(fileHasProv || fileHasProvField ? ["ProvenanceRecordRow"] : []),
      ];
      lines.push(`import { ${histRows.join(", ")} } from "../db/entities";`);
      lines.push(`import { requestContext } from "../obs/als";`);
      lines.push(`import { type DomainEventDispatcher } from "../domain/events";`);
      lines.push(`import type { EntityManager } from "@mikro-orm/postgresql";`);
    } else {
      lines.push(`import * as schema from "../db/schema";`);
      lines.push(`import { requestContext } from "../obs/als";`);
      lines.push(`import { type DomainEventDispatcher } from "../domain/events";`);
      lines.push(`import type { NodePgDatabase } from "drizzle-orm/node-postgres";`);
      // The history read filters `audit_records` by (target_type, target_id) —
      // the pair the write side indexes.  Only the read needs these operators;
      // the inserts above take a plain values object.
      if (historyFind) lines.push(`import { and, eq } from "drizzle-orm";`);
    }
  }
  if (historyFind) {
    lines.push(
      `import { type AuditEntry, type AuditFieldChange, type AuditHistoryRow, AuditEntryResponse, auditSnapshotValue, auditValueChanged } from "../audit/history";`,
    );
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
  // THE UNIFICATION SEAM (api-surface.ts): which routes exist, at which path,
  // declaring which error statuses — from the shared derivation the other four
  // backends already render.  Hono unified LAST on purpose: it is the
  // reference implementation `test/ir/api-surface.test.ts` pinned the
  // derivation against, and that gate stayed non-tautological until four
  // independent implementations had agreed.  Kept local: schemas, handler
  // bodies, history + prepare (`apiSurfaceCoverage.notLifted`).
  const derivedOps = deriveAggregateOperations(agg, repo, apiStatusContext(ctx));
  const derivedCreate = derivedOps.find((o) => o.kind === "create");
  const derivedGetById = derivedOps.find((o) => o.kind === "getById")!;
  const derivedDestroy = derivedOps.find((o) => o.kind === "destroy");
  const derivedFindByIR = new Map(
    derivedOps.filter((o) => o.kind === "find").map((o) => [o.find, o]),
  );
  const derivedOpByIR = new Map(
    derivedOps.filter((o) => o.kind === "operation").map((o) => [o.operation, o]),
  );
  const derivedProbeByIR = new Map(
    derivedOps.filter((o) => o.kind === "gateProbe").map((o) => [o.operation, o]),
  );
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
          // A SERVER-SOURCED default (`now()` / `currentUser.*`) cannot be a
          // wire `.default(...)`: a Zod default literal is evaluated ONCE at
          // schema-build (module load), so `.default(new Date())` freezes every
          // omitted row to the server's boot time.  Instead the field is
          // wire-OPTIONAL and the create handler coalesces the per-request
          // value (`body.X ?? <now()/currentUser.*>`) — see the factory call.
          const serverSourced = d !== undefined && isServerSourcedDefault(d);
          // A non-nullable bool's `.default(false)` normally comes from
          // `zodFor` (the implicit bool rule).  When the field carries an
          // EXPLICIT default we drop that baked-in `.default(false)` and let
          // the declared literal drive the `.default(...)` below — otherwise a
          // `bool = true` would emit `z.boolean().default(false).default(true)`.
          const info = wireTypeInfo(f.type, "request");
          const plainBool =
            info.refKind === "primitive" &&
            info.primitive === "bool" &&
            !info.isNullable &&
            !info.isCollection;
          return {
            name: f.name,
            base:
              plainBool && d !== undefined && !serverSourced
                ? "z.boolean()"
                : zodFor(f.type, "create-body"),
            default: d && !serverSourced ? wireDefaultLiteral(f.type, d) : undefined,
            optional: serverSourced || undefined,
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
    // Prepare-response schema: the server-sourced-default fields (`now()` /
    // `currentUser.*`) the create form fetches from `GET /prepare` to overlay
    // its type-zero seed.  Emitted only when such a field exists — keyed by the
    // shared `serverSourcedDefaultFields`, so the schema and the route handler
    // below (and the frontend consumer) can never drift.
    const prepareFields = serverSourcedDefaultFields(createInputFields(agg));
    if (prepareFields.length > 0) {
      const props = prepareFields
        .map((f) => `${f.name}: ${zodForResponseField(f.type, false, ctx)}`)
        .join(", ");
      lines.push(
        `const Prepare${agg.name}Response = z.object({ ${props} }).partial().openapi("Prepare${agg.name}Response");`,
      );
    }
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
        //
        // Both carry a DECLARED upper bound (`PAGED_MAX_PAGE` /
        // `PAGED_MAX_PAGE_SIZE`).  With only `.min(1)` the published contract
        // permitted a `page × pageSize` product that overflows the SQL
        // `OFFSET` — a 500 the caller reached by obeying the spec
        // (schemathesis F4).  The bound is part of the contract, so the same
        // numbers are declared by all five backends.
        lines.push(
          `  page: z.coerce.number().int().min(1).max(${PAGED_MAX_PAGE}).default(${PAGED_DEFAULT_PAGE}),`,
          `  pageSize: z.coerce.number().int().min(1).max(${PAGED_MAX_PAGE_SIZE}).default(${PAGED_DEFAULT_PAGE_SIZE}),`,
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
  // the projection query routes can reuse them
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
  // The per-aggregate history mapper — module scope, beside the schemas, so the
  // route handler stays a few lines.  It is where `mask unless` composes into
  // the trail (see `renderHistoryEntryMapper`).
  if (historyFind) {
    lines.push(renderHistoryEntryMapper(agg));
    lines.push("");
  }

  const routerParams = needsTx
    ? `repo: ${agg.name}Repository, db: ${usingMikro ? "EntityManager" : "NodePgDatabase<typeof schema>"}, events: DomainEventDispatcher`
    : `repo: ${agg.name}Repository`;
  lines.push(`export function ${lowerFirst(agg.name)}Routes(${routerParams}): OpenAPIHono {`);
  // `newApp()` from `./problem-details` constructs OpenAPIHono with the
  // shared validation `defaultHook` pre-wired — Zod parse failures emit
  // 422 ProblemDetails with `errors[]` for the frontend ACL.
  lines.push(`  const app = newApp();`);
  lines.push("");
  lines.push(...emitStaticSubpathMethodGuard(staticSubpathMethods(agg, repo, emitCreate)));

  // Create — gated on `hasCreate` (no canonical create ⇒ no POST route).
  if (emitCreate && derivedCreate) {
    lines.push(`  app.openapi(`);
    lines.push(`    createRoute({`);
    lines.push(`      method: "${derivedCreate.method}",`);
    lines.push(`      path: "${honoPath(derivedCreate)}",`);
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
    // create → the derived set (400 DomainError + 422 validation, plus a
    // guarded 403 when the lifecycle gate lands).  The §3.2 `errors[]`
    // extension rides the shared defaultHook.
    lines.push(...problemResponseLines(derivedCreate, "        "));
    lines.push(`      },`);
    lines.push(`    }),`);
    lines.push(`    async (c) => {`);
    // Media-type gate FIRST — hono skips (rather than fails) the zod body
    // validator on a foreign Content-Type, so without this `body` is
    // `undefined` and the wrapping below 500s (schemathesis F1).
    lines.push(`      requireJsonContentType(c);`);
    lines.push(`      const body = c.req.valid("json");`);
    // A server-sourced default (`now()` / `currentUser.*`) is applied
    // per-request HERE, not as a frozen wire `.default(...)`: the field is
    // wire-optional, so the factory arg coalesces the client's value with the
    // freshly-evaluated default (`body.X ?? new Date()`, `?? currentUser.*`).
    // This makes the default authoritative server-side (a raw client that omits
    // it still gets the real value) and fixes the boot-time-frozen `now()`.
    const serverDefaulted = requiredFields.filter(
      (f) => f.default !== undefined && isServerSourcedDefault(f.default),
    );
    // A `currentUser.*` default needs the ambient principal bound (a bare
    // `now()` does not) — the same accessor the `/prepare` route uses; so does
    // the canonical create's `requires` gate, and ONE binding serves both.
    if (
      serverDefaulted.some((f) => !(f.default!.kind === "literal" && f.default!.lit === "now")) ||
      lifecycleGatesUseCurrentUser(agg.canonicalCreate)
    ) {
      lines.push(currentUserBindLine("      "));
    }
    // The gate runs BEFORE the factory — a create guard has no `this` to read,
    // and denying after construction would already have run the invariants and
    // (on an audited create) staged a row.
    lines.push(...lifecycleGateLines(agg.canonicalCreate, "      "));
    // Wrap each wire-shape field into the typed factory argument (brand
    // ids, instantiate value objects).  Avoids `as never` and lets
    // strict tsc catch shape drift between Zod and the domain class.
    const createArgs = requiredFields
      .map((f) => {
        const wire = wireToDomainExpr(`body.${f.name}`, f.type, ctx);
        if (f.default !== undefined && isServerSourcedDefault(f.default)) {
          // `renderTsExpr` yields the DOMAIN-typed value (`new Date()`, not the
          // wire ISO string), matching the factory's expected type.
          return `${f.name}: body.${f.name} !== undefined ? ${wire} : ${renderTsExpr(f.default)}`;
        }
        return `${f.name}: ${wire}`;
      })
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
      lines.push(`      await ${txWrapperCall(usingMikro)}`);
      lines.push(`        const repoTx = new ${agg.name}Repository(tx, events);`);
      lines.push(`        await repoTx.save(created);`);
      lines.push(`        await ${historyInsertCall(usingMikro, "auditRecords")}`);
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
    lines.push(`      recordDomainOperation("${agg.name}", "create");`);
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

  // Prepare — `GET /prepare` returns the server-sourced create defaults
  // (`now()` / `currentUser.*`) the create form fetches to overlay its
  // type-zero seed.  A static segment, so it registers BEFORE `GET /{id}`
  // (same shadowing rule as the named finds below).  Emitted only when the
  // aggregate has a server-sourced-default field.
  if (emitCreate) {
    const prepareFields = serverSourcedDefaultFields(createInputFields(agg));
    if (prepareFields.length > 0) {
      const needsPrincipal = prepareFields.some(
        (f) => !(f.default.kind === "literal" && f.default.lit === "now"),
      );
      const entries = prepareFields
        .map((f) => {
          const value =
            f.default.kind === "literal" && f.default.lit === "now"
              ? "new Date().toISOString()"
              : renderTsExpr(f.default);
          return `${f.name}: ${value}`;
        })
        .join(", ");
      lines.push(`  app.openapi(`);
      lines.push(`    createRoute({`);
      lines.push(`      method: "get",`);
      lines.push(`      path: "/prepare",`);
      lines.push(`      tags: ["${snake(plural(agg.name))}"],`);
      lines.push(`      operationId: "prepare${agg.name}",`);
      lines.push(`      responses: {`);
      lines.push(`        200: {`);
      lines.push(`          description: "Server-sourced create defaults",`);
      lines.push(
        `          content: { "application/json": { schema: Prepare${agg.name}Response } },`,
      );
      lines.push(`        },`);
      lines.push(`      },`);
      lines.push(`    }),`);
      lines.push(`    async (c) => {`);
      if (needsPrincipal) {
        lines.push(
          `      const currentUser = (c as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
        );
      }
      lines.push(`      return c.json({ ${entries} }, 200);`);
      lines.push(`    },`);
      lines.push(`  );`);
      lines.push("");
    }
  }

  // Named find queries with STATIC paths (`find byHolder(...)` → GET
  // /by_holder) must register BEFORE the `GET /{id}` param route: Hono
  // matches in registration order, and `@hono/zod-openapi` validates the
  // `/{id}` param as `z.string().uuid()`, so a static segment registered
  // after `/{id}` is shadowed — `GET /by_holder` would match `/{id}` first
  // and 422 on the non-UUID segment.  The auto-`all` find stays at the root
  // (`GET /`, no conflict) and is emitted with the rest below.
  for (const [findIR, entry] of derivedFindByIR) {
    if (isAllFind(entry)) continue;
    lines.push(...emitFindRoute(agg, findIR!, ctx, entry, emitTrace).map((l) => `  ${l}`));
    lines.push("");
  }

  // Entity history — `GET /{id}/history` (docs/audit.md).  Two segments, so it
  // cannot be shadowed by the `/{id}` param route below the way a static
  // one-segment find can; registered here anyway to keep the reads together.
  if (historyFind) {
    lines.push(...emitHistoryRoute(agg, historyFind, usingMikro).map((l) => `  ${l}`));
    lines.push("");
  }

  // Get by id.
  lines.push(`  app.openapi(`);
  lines.push(`    createRoute({`);
  lines.push(`      method: "${derivedGetById.method}",`);
  lines.push(`      path: "${honoPath(derivedGetById)}",`);
  lines.push(`      tags: ["${snake(plural(agg.name))}"],`);
  lines.push(`      operationId: "${camelId(opGetById(agg.name))}",`);
  lines.push(`      request: { params: z.object({ id: z.string().uuid() }) },`);
  lines.push(`      responses: {`);
  lines.push(
    `        200: { description: "OK", content: { "application/json": { schema: ${agg.name}Response } } },`,
  );
  lines.push(...problemResponseLines(derivedGetById, "        "));
  lines.push(`      },`);
  lines.push(`    }),`);
  lines.push(`    async (c) => {`);
  lines.push(`      const { id } = c.req.valid("param");`);
  lines.push(`      const found = await repo.findById(Ids.${agg.name}Id(id));`);
  // RS-27 — the 404-BY-ID `detail` is the sentence `"<Agg> <id> not found"` on
  // every backend, and this route was the one place Hono answered a machine
  // token instead.  The cause is structural, not cosmetic: the route reads
  // through `repo.findById` (returns null) and raises its OWN error, bypassing
  // `repo.getById`, whose throw already carries exactly this message
  // (`typescript/repository-builder.ts`).  So the message is spelled to match
  // what the bypassed producer would have said, which is also what
  // python/java/elixir/.NET emit.  (An OPTIONAL FIND's 404 keeps the
  // `"not_found"` token — that class agrees across backends already.)
  lines.push(
    `      if (!found) throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`,
  );
  lines.push(...maskUserBind(agg, "      "));
  if (emitTrace) {
    // toWire isn't trivial — bind once so it's not run twice between
    // Object.keys and c.json.
    lines.push(`      const out = ${wireResp(agg, "repo", "found")};`);
    lines.push(
      `      ${renderHonoLogCall("wireOut", "keys: Object.keys(out as Record<string, unknown>)")}`,
    );
    lines.push(`      return c.json(out as z.infer<typeof ${agg.name}Response>, 200);`);
  } else {
    lines.push(
      `      return c.json(${wireResp(agg, "repo", "found")} as z.infer<typeof ${agg.name}Response>, 200);`,
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
  if (derivedDestroy) {
    // FK-restrict conflict status resolved through the `httpStatus` mapper
    // (M-T3.4a) — `ReferencedInUse`, 409 by default; the RUNTIME arm below
    // still resolves it locally, the DECLARED set is the derived one (which
    // resolved the same map), so they can't drift.
    const referencedInUseStatus = resolveErrorStatus(
      "ReferencedInUse",
      ctx.structuralErrorStatuses,
    );
    lines.push(`  app.openapi(`);
    lines.push(`    createRoute({`);
    lines.push(`      method: "${derivedDestroy.method}",`);
    lines.push(`      path: "${honoPath(derivedDestroy)}",`);
    lines.push(`      tags: ["${snake(plural(agg.name))}"],`);
    lines.push(`      operationId: "${camelId(opDestroy(agg.name))}",`);
    lines.push(`      request: { params: z.object({ id: z.string().uuid() }) },`);
    lines.push(`      responses: {`);
    lines.push(`        204: { description: "No Content" },`);
    lines.push(...problemResponseLines(derivedDestroy, "        "));
    lines.push(`      },`);
    lines.push(`    }),`);
    lines.push(`    async (c) => {`);
    lines.push(`      const { id } = c.req.valid("param");`);
    const destroyGates = lifecycleGates(agg.canonicalDestroy);
    if (destroyGates.length > 0) {
      // GUARDED destroy — the row loads FIRST (a destroy guard may read `this`,
      // and the route loads anyway for the 404 probe), then the gate, then the
      // delete.  The order is the security property: 404 (unreachable) wins
      // over 403 (unauthorized), and the deny precedes both the delete and —
      // on an audited destroy — the audit row it would otherwise have staged.
      // The load is BOUND here even on the audited path, which re-loads inside
      // its transaction: the gate must not run inside the audit tx, or a denial
      // rolls back work it should never have started.
      // A principal-only gate reads no field of the row, so the load is not
      // BOUND there — it still runs (it is the 404 probe), it just has no
      // receiver to name.
      const readsRow = lifecycleGatesReadRow(agg.canonicalDestroy);
      lines.push(
        readsRow
          ? `      const __loaded = await repo.getById(Ids.${agg.name}Id(id));`
          : `      await repo.getById(Ids.${agg.name}Id(id));`,
      );
      if (lifecycleGatesUseCurrentUser(agg.canonicalDestroy)) {
        lines.push(currentUserBindLine("      "));
      }
      lines.push(
        ...lifecycleGateLines(agg.canonicalDestroy, "      ", readsRow ? "__loaded" : undefined),
      );
    } else if (!auditDestroy) {
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
      lines.push(`        await ${txWrapperCall(usingMikro)}`);
      lines.push(`          const repoTx = new ${agg.name}Repository(tx, events);`);
      // getById throws AggregateNotFoundError (→ 404) when absent.
      lines.push(`          const loaded = await repoTx.getById(Ids.${agg.name}Id(id));`);
      lines.push(`          const before = repoTx.toWire(loaded);`);
      lines.push(`          await ${historyInsertCall(usingMikro, "auditRecords")}`);
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

  // Operations — the derived entries (public, non-canonical, in declaration
  // order), each carrying its path + resolved status set.
  for (const [op, entry] of derivedOpByIR) {
    lines.push(
      ...emitOperationRoute(
        agg,
        op!,
        ctx,
        entry,
        auditOps.includes(op!),
        provOps.includes(op!),
        emitTrace,
        usingMikro,
      ).map((l) => `  ${l}`),
    );
    const probe = derivedProbeByIR.get(op);
    if (probe) {
      lines.push("");
      lines.push(...emitCanOpRoute(agg, op!, probe, emitTrace).map((l) => `  ${l}`));
    }
    lines.push("");
  }

  // The auto-included `all` find (`GET /`, root path — no conflict with
  // `/{id}`).  Named static-path finds were emitted ABOVE, before the
  // `GET /{id}` param route, so they win Hono's registration-order match.
  for (const [findIR, entry] of derivedFindByIR) {
    if (!isAllFind(entry)) continue;
    lines.push(...emitFindRoute(agg, findIR!, ctx, entry, emitTrace).map((l) => `  ${l}`));
    lines.push("");
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
  // M-T5.20 — the domain floor and the `requires` denial resolve through the
  // api's `httpStatus` map exactly like the structural conflicts above,
  // instead of the hardcoded 422 / 403 literals they used to be. Defaults
  // collapse to those same literals, so output is byte-identical with no
  // override. `denialOverridesFor`-equivalent merge: neither rung has a
  // per-context tag (both surface in this app-global handler), so both maps
  // are read — `errorStatusOverrides` for a directly-declared name,
  // `structuralErrorStatuses` for the app-wide fold M-T5.20 widened to carry
  // every mapped name, not just the four structural conflicts.
  const domainStatus = resolveErrorStatus("DomainError", ctx.structuralErrorStatuses);
  const forbiddenStatus = resolveErrorStatus("Forbidden", ctx.structuralErrorStatuses);
  // The status literals this router's `problem()` helper is actually called
  // with — the always-present base set plus each structural-conflict status
  // whose arm is emitted (gated exactly as the arms below). With no override
  // every conflict is 409, so the union stays `403 | 404 | 409 | 422 | 500`.
  const emittedProblemStatuses = new Set<number>([
    forbiddenStatus,
    404,
    domainStatus,
    500,
    disallowedStatus,
  ]);
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
    `      ${renderHonoLogCall("forbidden", `aggregate: "${agg.name}", message: err.message, status: ${forbiddenStatus}`)}`,
  );
  lines.push(`      recordDomainFault("forbidden");`);
  lines.push(
    `      return problem(${forbiddenStatus}, ${JSON.stringify(problemTitle(forbiddenStatus))}, err.message);`,
  );
  lines.push(`    }`);
  lines.push(`    if (err instanceof DisallowedError) {`);
  lines.push(
    `      ${renderHonoLogCall("disallowed", `aggregate: "${agg.name}", message: err.message, status: ${disallowedStatus}`)}`,
  );
  lines.push(`      recordDomainFault("disallowed");`);
  lines.push(`      return problem(${disallowedStatus}, "Disallowed", err.message);`);
  lines.push(`    }`);
  lines.push(`    if (err instanceof DomainError) {`);
  lines.push(
    `      ${renderHonoLogCall("domainError", `aggregate: "${agg.name}", message: err.message, status: ${domainStatus}`)}`,
  );
  lines.push(`      recordDomainFault("domain_error");`);
  lines.push(
    `      return problem(${domainStatus}, ${JSON.stringify(problemTitle(domainStatus))}, err.message);`,
  );
  lines.push(`    }`);
  lines.push(`    if (err instanceof AggregateNotFoundError) {`);
  lines.push(`      ${renderHonoLogCall("notFound", `aggregate: "${agg.name}", status: 404`)}`);
  lines.push(`      recordDomainFault("not_found");`);
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
    lines.push(`      recordDomainFault("disallowed");`);
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
    lines.push(`      recordDomainFault("conflict");`);
    lines.push(`      return problem(${concurrencyStatus}, "Conflict", err.message);`);
    lines.push(`    }`);
  }
  lines.push(`    if (err instanceof ExternHandlerError) {`);
  lines.push(
    `      ${renderHonoLogCall("externHandlerThrew", "aggregate: err.aggName, op: err.opName, error: err.message")}`,
  );
  // RS-28 — sanitized.  The log call above already carries aggregate + op +
  // the inner message for the operator; the wire gets the same "internal" every
  // other 500 arm sends, on every backend.
  lines.push(`      return problem(500, "Internal Server Error", "internal");`);
  lines.push(`    }`);
  // FRAMEWORK fault, not a domain one — hono raises `HTTPException` for the
  // faults it detects itself (a malformed JSON body is the common one, at
  // 400).  Without this arm it falls past every domain check into the generic
  // 500 below, reporting a CLIENT fault as a server fault: java answers 400
  // for the same request.  Placed LAST among the typed arms so no domain
  // class it might subclass loses its own mapping.
  lines.push(`    if (err instanceof HTTPException) {`);
  lines.push(`      ${renderHonoLogCall("clientError", "error: err.message, status: err.status")}`);
  lines.push(
    `      return c.body(frameworkProblemBody(err.status, err.message, c.req.path), err.status, { "content-type": "application/problem+json", "x-request-id": trace_id });`,
  );
  lines.push(`    }`);
  lines.push(
    `    ${renderHonoLogCall("internalError", "error: err instanceof Error ? err.message : String(err), status: 500")}`,
  );
  lines.push(`    return problem(500, "Internal Server Error", "internal");`);
  lines.push(`  });`);
  lines.push("");
  lines.push(`  return app;`);
  lines.push(`}`);
  // Patch the deferred `./problem-details` import (see the placeholder push
  // above) — `requireJsonContentType` only when a body-carrying handler calls
  // it.  Names stay in the pre-existing ASCII order Biome's import sorter
  // expects (`ProblemDetails` < `frameworkProblemBody` < `newApp` <
  // `requireJsonContentType`).
  const problemNamed = ["ProblemDetails", "frameworkProblemBody", "newApp"];
  if (/\brequireJsonContentType\(/.test(lines.join("\n")))
    problemNamed.push("requireJsonContentType");
  const assembled = lines
    .join("\n")
    .replace(
      PROBLEM_IMPORT_PLACEHOLDER,
      `import { ${problemNamed.join(", ")} } from "./problem-details";`,
    );
  // Patch the deferred VO import: keep only names the body actually
  // references; tag each as `type` unless the body constructs it via
  // `new <Vo>(`.
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
/** The hoisted authorization gate — the leading run of `requires` statements,
 *  evaluated by the HANDLER rather than the aggregate (`src/ir/util/op-gates.ts`).
 *
 *  Emitted post-load (so `this` resolves against the loaded `aggregate`, exactly
 *  as it did when the check ran inside the method) and BEFORE the `when` state
 *  gate: an unauthorized caller must not learn whether the operation would have
 *  been allowed in the row's current state.  403 precedes 409. */
function requiresGateLines(
  op: OperationIR,
  pad: string,
  ctx: BoundedContextIR,
  argExpr?: (name: string) => string | undefined,
): string[] {
  return operationGates(op).map((g) => {
    const pred = renderTsExpr(g.expr, {
      thisName: "aggregate",
      // Operation params are NOT locals here — the handler holds them at the
      // wire-read expression the call is about to pass (`body.<name>`), so an
      // arg-aware gate (`requires amount <= limit`) must read the same thing.
      paramExpr:
        argExpr ??
        ((name) => {
          const p = op.params.find((q) => q.name === name);
          return p ? wireToDomainExpr(`body.${p.name}`, p.type, ctx) : undefined;
        }),
    });
    return `${pad}if (!(${pred})) throw new ForbiddenError(${JSON.stringify(
      `Forbidden: ${g.source}`,
    )});`;
  });
}

/** The canonical `create` / `destroy` authorization gate, in the ROUTE.
 *
 *  Same shape as `requiresGateLines` above — the same `requires` statements,
 *  the same `ForbiddenError` (→ 403 via this file's `onError`), the same
 *  `Forbidden: <source>` detail — because it IS the same gate; only the
 *  receiver differs:
 *
 *    create  — no receiver.  The gate runs BEFORE the factory (there is no
 *              instance yet), so it reads the principal only, which
 *              `loom.lifecycle-guard-unreadable` enforces.
 *    destroy — `__loaded`.  The gate runs AFTER the by-id load the route
 *              already performs for its 404 probe, so an unreachable id still
 *              answers 404 rather than 403, matching the operation routes. */
function lifecycleGateLines(
  action: OperationIR | null | undefined,
  pad: string,
  thisName?: string,
): string[] {
  return lifecycleGates(action).map((g) => {
    const pred = renderTsExpr(g.expr, thisName ? { thisName } : undefined);
    return `${pad}if (!(${pred})) throw new ForbiddenError(${JSON.stringify(
      `Forbidden: ${g.source}`,
    )});`;
  });
}

/** The `currentUser` binding line the route uses for a lifecycle gate — the
 *  same untyped-key bridge the `currentUser.*` create default and the
 *  `/prepare` route use.  Bound at most ONCE per handler: a second
 *  `const currentUser` is a redeclaration (TS2451) on an aggregate that has
 *  both a principal default and a principal gate. */
function currentUserBindLine(pad: string): string {
  return `${pad}const currentUser = (c as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`;
}

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
function emitCanOpRoute(
  agg: AggregateIR,
  op: OperationIR,
  entry: ApiOperationIR,
  emitTrace: boolean,
): string[] {
  if (!op.when) return [];
  void emitTrace;
  const aggSlug = snake(plural(agg.name));
  const pred = renderTsExpr(op.when, { thisName: "aggregate" });
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "${entry.method}",`);
  out.push(`    path: "${honoPath(entry)}",`);
  out.push(`    tags: ["${aggSlug}"],`);
  out.push(`    operationId: "${camelId(opOperation(agg.name, `can_${op.name}`))}",`);
  out.push(`    request: {`);
  out.push(`      params: z.object({ id: z.string().uuid() }),`);
  out.push(`    },`);
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: z.object({ allowed: z.boolean() }) } } },`,
  );
  out.push(...problemResponseLines(entry, "      "));
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
  entry: ApiOperationIR,
  audit: boolean,
  prov: boolean,
  emitTrace: boolean,
  usingMikro = false,
): string[] {
  // Lifecycle stamps are applied persist-time in the drizzle save()
  // (node-persist-time-auditing); the operation route no longer stamps.
  const aggSlug = snake(plural(agg.name));
  // Exception-less operation (`operation foo(): X or NotFound`): the route
  // captures the tagged-union result and translates an `error`-variant to an
  // RFC-7807 ProblemDetails status, a success to HTTP 200 (exception-less.md).
  // The spike supports the plain repo path only (audit / prov / extern return-
  // typed ops are a later slice); they fall through to the void handler.
  if (op.returnType && !audit && !prov && !op.extern) {
    return emitReturningOperationRoute(agg, op, ctx, entry, emitTrace);
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
  out.push(`    method: "${entry.method}",`);
  out.push(`    path: "${honoPath(entry)}",`);
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
  // The derived non-2xx set: 400 (domain) + 404 + 422 (validation, §3.2
  // `errors[]` via the shared defaultHook) + a guarded 403 + the
  // httpStatus-resolved when/versioned conflicts — sorted numerically.
  out.push(...problemResponseLines(entry, "      "));
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (c) => {`);
  out.push(`    const { id } = c.req.valid("param");`);
  // See the create route: a foreign Content-Type SKIPS the zod body validator,
  // so the refusal has to be explicit (schemathesis F1).
  out.push(`    requireJsonContentType(c);`);
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
  out.push(`    recordDomainOperation("${agg.name}", "${op.name}");`);
  // When the operation body references `currentUser`, the aggregate
  // method's signature picks up a trailing `currentUser: User`
  // parameter (see operationBodyUsesCurrentUser).  The route reads the
  // user from the request scope where the auth middleware stashed it
  // earlier in the pipeline; without `auth: required` on the
  // deployable, the validator already prevents currentUser from
  // appearing in operation bodies, so this branch is dead.
  //
  // The hoisted authorization gate needs the same binding even when the
  // remaining body doesn't — the gate is evaluated HERE now, not inside the
  // method — so the principal is bound for either reason and passed on only
  // when the method still declares the parameter.
  const usesUser = operationBodyUsesCurrentUser(op);
  // The operation body reads the typed `currentUser` only when it references
  // it directly; lifecycle stamps no longer thread the principal through the
  // handler (stamped persist-time in the drizzle save()).
  if (usesUser || operationGatesUseCurrentUser(op)) {
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
    out.push(...requiresGateLines(op, "    ", ctx));
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
    out.push(`    await ${txWrapperCall(usingMikro)}`);
    out.push(`      const repoTx = new ${agg.name}Repository(tx, events);`);
    out.push(`      const aggregate = await repoTx.getById(Ids.${agg.name}Id(id));`);
    if (isVersionedUpdate) {
      out.push(`      const ifMatch = c.req.header("if-match");`);
      out.push(
        `      const expectedVersion = ifMatch !== undefined ? Number(ifMatch) : aggregate.version;`,
      );
    }
    out.push(...requiresGateLines(op, "      ", ctx));
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
      out.push(`      await ${historyInsertCall(usingMikro, "auditRecords")}`);
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
      out.push(`        await ${historyInsertCall(usingMikro, "provenanceRecords")}`);
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

/** RFC reason phrase for the HTTP statuses a route can emit — used for the
 *  OpenAPI response `description`.
 *
 *  This was a SECOND copy of the shared `problemTitle` table (identical entry
 *  for entry, same `"Error"` fallback), so a status added to the shared one
 *  silently described itself as `"Error"` here — which is how the newly
 *  declared 415 first surfaced.  Delegating removes the drift: one table, five
 *  backends, and Hono's own routes agreeing with it. */
const httpStatusText = problemTitle;

/** The exception-less operation route (`operation foo(): X or NotFound`).  Calls
 *  the aggregate method (which now returns its tagged `or`-union), saves, then
 *  translates: an `error`-variant result → an RFC-7807 ProblemDetails (404 in
 *  the spike), a success variant → HTTP 200 with the tagged body. */
function emitReturningOperationRoute(
  agg: AggregateIR,
  op: OperationIR,
  ctx: BoundedContextIR,
  entry: ApiOperationIR,
  emitTrace: boolean,
): string[] {
  // Lifecycle stamps are applied persist-time in the drizzle save()
  // (node-persist-time-auditing); the operation route no longer stamps.
  const aggSlug = snake(plural(agg.name));
  const variants = op.returnType?.kind === "union" ? op.returnType.variants : [];
  const errorVariants = variants.filter((vv) => isErrorVariant(vv, ctx));
  const u = op.returnType ? unionForFind(op.returnType, ctx) : null;
  // Success 200 body schema: a union return declares the whole tagged union; a
  // SCALAR return (BUG-003) declares that scalar's own field-wire schema (via
  // the shared `zodForResponse`, so money/enum/VO scalars stay wire-consistent
  // with a field of the same type); void ops don't reach here.
  const successSchema = u
    ? u.name
    : op.returnType
      ? zodForResponse(op.returnType, false)
      : `${agg.name}Response`;
  // The HTTP status an error variant maps to: the api's `httpStatus` override
  // for this context (exception-less.md A1) if present, else the stdlib default.
  const statusFor = (tag: string): number =>
    ctx.errorStatusOverrides?.[tag] ?? defaultErrorStatus(tag);
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "${entry.method}",`);
  out.push(`    path: "${honoPath(entry)}",`);
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
    `      200: { description: "OK", content: { "application/json": { schema: ${successSchema} } } },`,
  );
  out.push(...problemResponseLines(entry, "      "));
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (c) => {`);
  out.push(`    const { id } = c.req.valid("param");`);
  // See the create route: a foreign Content-Type SKIPS the zod body validator,
  // so the refusal has to be explicit (schemathesis F1).
  out.push(`    requireJsonContentType(c);`);
  out.push(`    const body = c.req.valid("json");`);
  if (emitTrace) {
    out.push(
      `    ${renderHonoLogCall("wireIn", "keys: Object.keys(body as Record<string, unknown>)")}`,
    );
  }
  out.push(
    `    ${renderHonoLogCall("operationInvoked", `aggregate: "${agg.name}", op: "${op.name}", id`)}`,
  );
  out.push(`    recordDomainOperation("${agg.name}", "${op.name}");`);
  const usesUser = operationBodyUsesCurrentUser(op);
  if (usesUser || operationGatesUseCurrentUser(op)) {
    out.push(
      `    const currentUser = (c as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
    );
  }
  const baseCallArgs = op.params.map((p) => wireToDomainExpr(`body.${p.name}`, p.type, ctx));
  const callArgs = (usesUser ? [...baseCallArgs, "currentUser"] : baseCallArgs).join(", ");
  out.push(`    const aggregate = await repo.getById(Ids.${agg.name}Id(id));`);
  out.push(...requiresGateLines(op, "    ", ctx));
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
  // A scalar money RETURN carries the FIXED money wire scale (RS-12), same as a
  // money field: decimal.js `.toJSON()` would normalize trailing zeros, so
  // format to 4 dp for parity with the java/.NET/python scalar-return path.
  const scalarMoneyReturn =
    !u &&
    op.returnType?.kind === "primitive" &&
    (op.returnType as { name?: string }).name === "money";
  const successResult = scalarMoneyReturn
    ? `result === null ? null : result.toFixed(${MONEY_WIRE_SCALE})`
    : "result";
  out.push(`    return c.json(${successResult}, 200);`);
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
  entry: ApiOperationIR,
  emitTrace: boolean,
): string[] {
  const aggSlug = snake(plural(agg.name));
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
  // declared params.  THE SAME predicate the derivation declares 422 with
  // (`findValidatesRequest`), not a local copy: this `if` is what installs the
  // validator that ANSWERS the 422, so the two must move together or the route
  // goes back to answering a status its contract never mentions.
  const hasQuery = findValidatesRequest(find);
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "${entry.method}",`);
  out.push(`    path: "${honoPath(entry)}",`);
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
  // The derived declared set — the gated 403 and the absence status (the
  // union-absent's httpStatus-resolved one included), sorted.  The unionSpec
  // above still drives the RUNTIME translation below; the declaration and the
  // runtime read the same resolved values, so they cannot drift.
  out.push(...problemResponseLines(entry, "      "));
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (c) => {`);
  if (hasQuery) {
    out.push(`    const params = c.req.valid("query");`);
  }
  // When the find's where clause references currentUser,
  // the repository method gains a trailing `currentUser: User`
  // parameter.  Read it from the request scope where the auth
  // middleware stashed it earlier in the pipeline.  A `requires`
  // gate that reads currentUser needs the same principal in scope.
  const usesUser = findUsesCurrentUser(find);
  const needsUser = usesUser || findGateUsesCurrentUser(find);
  if (needsUser) {
    out.push(
      `    const currentUser = (c as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
    );
  }
  // Authorization gate (default-deny): a 403 when the `requires` predicate
  // (evaluated against the in-scope currentUser) fails, BEFORE the query runs.
  // ForbiddenError is mapped to a 403 ProblemDetails by the file's onError
  // filter — the read-side analogue of an operation `requires` gate.  The 403
  // `detail` carries the source label (`Forbidden: find <name>`) exactly as the
  // operation gates and the other four backends do — node's read gates used to
  // drop it, the lone bare-`Forbidden` outlier across all five backends.
  if (find.requires) {
    out.push(
      `    if (!(${renderTsExpr(find.requires)})) throw new ForbiddenError(${JSON.stringify(`Forbidden: find ${find.name}`)});`,
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
    out.push(...maskUserBind(agg, "    "));
    out.push(
      `    return c.json({ ...result, items: result.items.map((r) => ${wireResp(agg, "repo", "r")}) } as z.infer<typeof ${paged.name}>, 200);`,
    );
    out.push(`  },`);
    out.push(`);`);
    return out;
  }
  const argList = (usesUser ? [...baseArgs, "currentUser"] : baseArgs).join(", ");
  out.push(`    const result = await repo.${find.name}(${argList});`);
  out.push(...maskUserBind(agg, "    "));
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
    out.push(
      `    return c.json(${wireResp(agg, "repo", "result")} as z.infer<typeof ${agg.name}Response>, 200);`,
    );
  } else if (isList) {
    // Array responses skip wire_out — `Object.keys` over an array
    // returns positional indices, which aren't a useful shape signal.
    // (The catalog's `wire_out` is a key-set marker, not a length one.)
    out.push(
      `    return c.json(result.map((r) => ${wireResp(agg, "repo", "r")}) as z.infer<typeof ${agg.name}Response>[], 200);`,
    );
  } else if (find.returnType.kind === "optional") {
    out.push(`    if (result == null) throw new AggregateNotFoundError("not_found");`);
    if (emitTrace) {
      out.push(`    const wire = ${wireResp(agg, "repo", "result")};`);
      out.push(
        `    ${renderHonoLogCall("wireOut", "keys: Object.keys(wire as Record<string, unknown>)")}`,
      );
      out.push(`    return c.json(wire as z.infer<typeof ${agg.name}Response>, 200);`);
    } else {
      out.push(
        `    return c.json(${wireResp(agg, "repo", "result")} as z.infer<typeof ${agg.name}Response>, 200);`,
      );
    }
  } else {
    if (emitTrace) {
      out.push(`    const wire = ${wireResp(agg, "repo", "result")};`);
      out.push(
        `    ${renderHonoLogCall("wireOut", "keys: Object.keys(wire as Record<string, unknown>)")}`,
      );
      out.push(`    return c.json(wire as z.infer<typeof ${agg.name}Response>, 200);`);
    } else {
      out.push(
        `    return c.json(${wireResp(agg, "repo", "result")} as z.infer<typeof ${agg.name}Response>, 200);`,
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
        // A `mask unless` field is redacted to `null` for callers who fail the
        // predicate (see `toWireMasked`), so its response schema must admit null.
        const masked = wf.maskUnless !== undefined ? ".nullable()" : "";
        lines.push(`  ${wf.name}: ${zodForResponse(wf.type, wf.optional)}${masked},`);
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
// THREE primitive-to-Zod tables, split by where the value comes from:
//
//   * `QUERY_PRIMITIVE` — a query-string value is ALWAYS a string, so the
//     coercion is the parse: `?qty=3` has to become the number 3.
//   * `BODY_PRIMITIVE` — a JSON body carries REAL types, so there is nothing
//     to coerce and coercing is actively wrong: `z.coerce.number()` is
//     `Number(input)`, which accepts `false` (→ 0) and `"12"` (→ 12) for a
//     field the spec declares `{"type":"number"}`, and `z.coerce.date()`
//     accepts `false` (→ the epoch) for `{"type":"string","format":"date-time"}`.
//     The server then honours its declared BOUNDS while ignoring its declared
//     TYPE (schemathesis F7).  Coercion also leaks into the published spec:
//     zod-to-openapi marks every coerced field `nullable: true`, because a
//     coercing schema does accept `null`.
//   * `RESPONSE_PRIMITIVE` — the strict equivalents; the server serialises
//     into the declared shape.
//
// Money crosses as `moneySchema` on the request side (a parse chain producing
// a decimal.js Decimal) and as `z.string()` on the response side (Decimal's
// canonical JSON form).  Datetime: an ISO-8601 string in BOTH directions —
// inbound it is `.transform`ed to the `Date` the domain layer expects, so the
// handler code is unchanged from the `z.coerce.date()` era.
// ---------------------------------------------------------------------------

/** An ISO-8601 datetime STRING parsed into a `Date`.  Published as
 *  `{"type":"string","format":"date-time"}` — the same declaration
 *  `z.coerce.date()` produced, minus its spurious `nullable: true` — while
 *  rejecting the booleans/numbers the coercion accepted.  It also fixes the
 *  coercion artefact message (`"Invalid input: expected date, received Date"`,
 *  which reached users through the validation catalog); this reads
 *  `"Invalid ISO datetime"`.
 *
 *  BOTH flags are load-bearing, and each names a real caller: `offset` keeps
 *  `+02:00` forms legal, and `local` keeps the UNQUALIFIED form legal because
 *  that is what the generated FRONTENDS send — a datetime field renders as a
 *  native `<input type="datetime-local">`, whose value is `2024-01-01T00:00`
 *  (no seconds, no zone) and crosses the wire as that plain string (see
 *  `_frontend/form-helpers.ts`).  Dropping `local` would 422 every datetime
 *  form submission in the emitted UI. */
const BODY_DATETIME =
  "z.string().datetime({ offset: true, local: true }).transform((s: string) => new Date(s))";

const QUERY_PRIMITIVE: Record<WirePrimitive, string> = {
  int: "z.coerce.number().int()",
  long: "z.coerce.number().int()",
  decimal: "z.coerce.number()",
  money: "moneySchema",
  string: "z.string()",
  bool: "z.coerce.boolean()",
  datetime: "z.coerce.date()",
  guid: "z.string()",
  json: "z.unknown()",
  File: "z.object({ url: z.string(), key: z.string(), contentType: z.string(), size: z.number().int() })",
};

const BODY_PRIMITIVE: Record<WirePrimitive, string> = {
  int: "z.number().int()",
  long: "z.number().int()",
  decimal: "z.number()",
  money: "moneySchema",
  string: "z.string()",
  bool: "z.boolean()",
  datetime: BODY_DATETIME,
  guid: "z.string()",
  json: "z.unknown()",
  File: "z.object({ url: z.string(), key: z.string(), contentType: z.string(), size: z.number().int() })",
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
  File: "z.object({ url: z.string(), key: z.string(), contentType: z.string(), size: z.number().int() })",
};

export function zodFor(t: TypeIR, context: "create-body" | "body" | "query" = "body"): string {
  const info = wireTypeInfo(t, "request");
  if (info.isNullable) return `${zodFor(peelNullable(t), context)}.nullish()`;
  if (info.isCollection) return `z.array(${zodFor(peelCollection(t), context)})`;
  switch (info.refKind) {
    case "primitive":
      // A non-nullable bool in a CREATE body defaults to `false` when omitted —
      // matching .NET model-binding and Phoenix, which both treat an absent
      // create bool as false and drop it from `required`.  Without this Hono
      // alone marks the bool required, tripping the cross-backend parity
      // required-set (`required-only-honoApi=[<bool>]`).
      //
      // Scoped to `create-body` deliberately.  The rule is a CREATE-INPUT rule
      // — `hasImplicitDefault` in `wire-projection.ts` defines it as "an
      // omitted create input is well-defined without an explicit `= default`"
      // — and applying it to every request body silently corrupted the others:
      // an operation (`update` included) whose bool param the client omits had
      // it set to FALSE rather than rejected, so a PUT that left out
      // `active: bool = true` flipped a stored `true` to `false`, using a value
      // that is not even the declared default.  That is the proto3 lesson
      // (a wire-level default makes "absent" indistinguishable from "the
      // default value", which breaks partial and full-replacement updates
      // alike).  An operation parameter has no default to fall back on, so an
      // omitted one is a client error, not a `false`.
      //
      // Query params keep the plain coercion (Phoenix doesn't special-case
      // query bools).
      //
      // A body bool must NOT be coerced.  `z.coerce.boolean()` is
      // `Boolean(input)`, and `Boolean(undefined) === false` — so a coerced
      // bool ACCEPTS an absent key and yields `false`.  That is the same
      // silent wire-default the paragraph above rejects, just spelled
      // implicitly: dropping the `.default(false)` from the update slot did
      // nothing while the coercion stayed, because the coercion IS the
      // default.  It is also why the field vanished from the served spec's
      // `required` — zod-to-openapi derives requiredness from
      // `schema.isOptional()`, i.e. "does it accept `undefined`", and a
      // coerced bool does (`required-only-dotnet=[onCall]` in the 5-way
      // parity diff).  JSON carries real booleans, so there is nothing to
      // coerce in a body anyway — which is the argument `BODY_PRIMITIVE` now
      // generalises to every other primitive (F7); this arm survives only for
      // the create-body `.default(false)` half.
      if (info.primitive === "bool" && context === "create-body") {
        return "z.boolean().default(false)";
      }
      return context === "query"
        ? QUERY_PRIMITIVE[info.primitive!]
        : BODY_PRIMITIVE[info.primitive!];
    case "id":
      // A REFERENCE (`Customer id`) is a uuid on the wire and a `UUID` column
      // in Postgres, so the wire validator says so: a bare `z.string()` let a
      // non-uuid through to the driver, whose `invalid input syntax for type
      // uuid` escaped as a 500 — while the SAME id in a PATH parameter was
      // already `z.string().uuid()`, so the backend disagreed with itself
      // (schemathesis F2/F3).  `.uuid()` answers the standard 422 instead and
      // publishes `format: uuid` through zod-openapi, matching .NET's `Guid`,
      // Java's `UUID` and Phoenix's `format: :uuid`.
      //
      // `context` is deliberately ignored: the same rule holds for a body
      // field and for a `?owner=` query parameter (F3 is F2 through the query
      // string), and both funnel through this one arm.
      //
      // Gated on the declared id VALUE type — an `int`/`long`/`string`-keyed
      // aggregate is not a uuid, and the pre-existing wire treatment (every id
      // as a string) stays untouched for those.
      return info.idValueType === "guid" ? "z.string().uuid()" : "z.string()";
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
  // A VALUE-OBJECT default: `.default(...)` feeds a zod schema whose output is
  // the WIRE object, so the literal must be that object — not the domain class
  // `renderTsExpr` would produce.  This one COMPILES either way, because TS is
  // structural and the emitted class happens to carry matching public fields,
  // which is exactly why it went unnoticed while python (`mypy --strict`) and
  // .NET (CS0246) could not build the same source at all.  A value object whose
  // class shape diverges from its wire shape — a private field, a getter, a
  // renamed property — would break here silently.
  if (d.kind === "call" && d.callKind === "value-object-ctor") {
    const entries = d.args
      .map((a, i) => {
        const slot = d.argNames?.[i];
        return slot ? `${slot}: ${renderTsExpr(a)}` : renderTsExpr(a);
      })
      .join(", ");
    return `{ ${entries} }`;
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
  fields: { name: string; base: string; default?: string; optional?: boolean }[],
  invariants: InvariantIR[],
  available: ReadonlySet<string>,
): string[] {
  const ctx: ClassifyContext = { available };
  const chainByField = new Map<string, SingleFieldPattern[]>();
  const remaining: InvariantIR[] = [];
  for (const inv of invariants) {
    const taken = inv.message ? null : takeSingleFieldChain(inv, ctx);
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
      // A `len-*` bound is CHECKED as a code-point refine, which zod cannot
      // describe to the OpenAPI emitter — re-declare it so `/openapi.json`
      // still publishes the `minLength`/`maxLength` it always did (and now
      // publishes a bound the server actually enforces, per code-point.ts).
      const lengths = openapiLengthMeta(patterns);
      if (lengths) {
        const entries = Object.entries(lengths).map(([k, v]) => `${k}: ${v}`);
        schema = `${schema}.openapi({ ${entries.join(", ")} })`;
      }
    }
    // `.default(...)` / `.optional()` last: each wraps the (now constrained)
    // schema in a ZodDefault / ZodOptional, so any `.min`/`.max` must already
    // be applied above.  A server-sourced default (`now()`/`currentUser.*`) is
    // wire-OPTIONAL (the server applies the real value per-request in the
    // create handler) rather than carrying a frozen `.default(...)` literal.
    if (f.default !== undefined) schema = `${schema}.default(${f.default})`;
    else if (f.optional) schema = `${schema}.optional()`;
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
      out.push({ expr: s.expr, source: s.source, message: s.message });
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
    // Explicit `any` — same rationale as zod-refine.ts's `.refine((data: any)
    // => …)`: the request body's zod-inferred element type doesn't always
    // survive TS's contextual-typing chain under the pinned TS/zod versions
    // (TS7006 under `strict`), so an un-annotated `(e) =>` here isn't reliably
    // inferred. The real safety is the zod runtime validation upstream of
    // this conversion, not this expression's static type.
    return `${expr}.map((e: any) => ${wireToDomainExpr("e", peelCollection(t), ctx)})`;
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
