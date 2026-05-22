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
import { findUsesCurrentUser, operationUsesCurrentUser } from "../../../ir/loom-ir.js";
import { camel, pascal, plural, snake } from "../../../util/naming.js";

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
): string {
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";`);
  lines.push(`import { ${agg.name} } from "../domain/${camel(agg.name)}";`);
  lines.push(
    `import { ${agg.name}Repository } from "../db/repositories/${camel(agg.name)}-repository";`,
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
    lines.push(`import { externHandlers } from "../domain/${camel(agg.name)}-extern";`);
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
        `const ${pascal(op.name)}Request`,
        `${pascal(op.name)}Request`,
        op.params.map((p) => ({ name: p.name, base: zodFor(p.type) })),
        preconditionsAsInvariants(op),
        new Set(op.params.map((p) => p.name)),
      ),
    );
  }
  lines.push("");

  if (repo) {
    for (const find of repo.finds) {
      lines.push(`const ${pascal(find.name)}Query = z.object({`);
      for (const p of find.params) {
        lines.push(`  ${p.name}: ${zodFor(p.type)},`);
      }
      lines.push(`}).openapi("${pascal(find.name)}Query");`);
    }
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

  // The router.
  lines.push(
    `export function ${camel(agg.name)}Routes(repo: ${agg.name}Repository): OpenAPIHono {`,
  );
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
  lines.push(`      return c.json({ id: created.id as string }, 201);`);
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
  lines.push(
    `      return c.json(repo.toWire(found) as z.infer<typeof ${agg.name}Response>, 200);`,
  );
  lines.push(`    },`);
  lines.push(`  );`);
  lines.push("");

  // Operations.
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    lines.push(...emitOperationRoute(agg, op, ctx).map((l) => `  ${l}`));
    lines.push("");
  }

  // Find queries (including the auto-included `all`).
  if (repo) {
    for (const find of repo.finds) {
      lines.push(...emitFindRoute(agg, find, ctx).map((l) => `  ${l}`));
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
  // OpenAPIHono is constructed without a typed Variables block so
  // strict tsc can't see the key directly; the cast bridges the
  // gap without leaking `any` into the user's surface.
  lines.push(
    `    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";`,
  );
  lines.push(
    `    if (err instanceof ForbiddenError) return c.json({ error: err.message, trace_id }, 403);`,
  );
  lines.push(
    `    if (err instanceof DomainError) return c.json({ error: err.message, trace_id }, 400);`,
  );
  lines.push(
    `    if (err instanceof AggregateNotFoundError) return c.json({ error: err.message, trace_id }, 404);`,
  );
  lines.push(
    `    if (err instanceof ExternHandlerError) { console.error(err); return c.json({ error: err.message, trace_id }, 500); }`,
  );
  lines.push(`    console.error(err);`);
  lines.push(`    return c.json({ error: "internal", trace_id }, 500);`);
  lines.push(`  });`);
  lines.push("");
  lines.push(`  return app;`);
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

function emitOperationRoute(agg: AggregateIR, op: OperationIR, ctx: BoundedContextIR): string[] {
  const aggSlug = snake(plural(agg.name));
  const opSnake = snake(op.name);
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "post",`);
  out.push(`    path: "/{id}/${opSnake}",`);
  out.push(`    tags: ["${aggSlug}"],`);
  out.push(`    operationId: "${camel(op.name)}${agg.name}",`);
  out.push(`    request: {`);
  out.push(`      params: z.object({ id: z.string() }),`);
  out.push(`      body: { content: { "application/json": { schema: ${pascal(op.name)}Request } } },`);
  out.push(`    },`);
  out.push(`    responses: {`);
  out.push(`      204: { description: "No content" },`);
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (c) => {`);
  out.push(`    const { id } = c.req.valid("param");`);
  out.push(`    const body = c.req.valid("json");`);
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
  out.push(`    const aggregate = await repo.getById(Ids.${agg.name}Id(id));`);
  const baseCallArgs = op.params.map((p) => wireToDomainExpr(`body.${p.name}`, p.type, ctx));
  const callArgs = (usesUser ? [...baseCallArgs, "currentUser"] : baseCallArgs).join(", ");
  if (op.extern) {
    // Extern: run preconditions on the aggregate, dispatch to the
    // user-registered handler, then run invariants and save.  The
    // handler call is wrapped so any non-domain throw becomes an
    // ExternHandlerError naming the op + aggregate (see
    // app.onError below for the 500 mapping).  Domain-layer errors
    // (DomainError, ForbiddenError, AggregateNotFoundError) re-throw
    // unchanged so 400 / 403 / 404 still apply when a user handler
    // raises one deliberately.
    const handlerKey = `${camel(op.name)}${agg.name}`;
    out.push(`    aggregate.check${pascal(op.name)}(${callArgs});`);
    out.push(`    const handler = externHandlers.${handlerKey};`);
    out.push(
      `    if (!handler) throw new Error("Missing extern handler for ${handlerKey}. Register one via register${pascal(op.name)}${agg.name}Handler(...) before app.listen().");`,
    );
    out.push(`    try {`);
    out.push(`      await handler(aggregate, body);`);
    out.push(`    } catch (err) {`);
    out.push(`      if (err instanceof DomainError) throw err;`);
    out.push(`      if (err instanceof ForbiddenError) throw err;`);
    out.push(`      if (err instanceof AggregateNotFoundError) throw err;`);
    out.push(`      throw new ExternHandlerError("${op.name}", "${agg.name}", err);`);
    out.push(`    }`);
    out.push(`    aggregate.assertInvariants();`);
  } else {
    out.push(`    aggregate.${camel(op.name)}(${callArgs});`);
  }
  out.push(`    await repo.save(aggregate);`);
  out.push(`    return c.body(null, 204);`);
  out.push(`  },`);
  out.push(`);`);
  return out;
}

function emitFindRoute(agg: AggregateIR, find: FindIR, ctx: BoundedContextIR): string[] {
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
  out.push(`    operationId: "${camel(find.name)}${agg.name}",`);
  if (find.params.length > 0) {
    out.push(`    request: { query: ${pascal(find.name)}Query },`);
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
  // Slice 1C: when the find's where clause references currentUser,
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
    out.push(
      `    return c.json(result.map((r) => repo.toWire(r)) as z.infer<typeof ${agg.name}Response>[], 200);`,
    );
  } else if (find.returnType.kind === "optional") {
    out.push(`    if (result == null) return c.json({ error: "not_found" }, 404);`);
    out.push(`    return c.json(repo.toWire(result) as z.infer<typeof ${agg.name}Response>, 200);`);
  } else {
    out.push(`    return c.json(repo.toWire(result) as z.infer<typeof ${agg.name}Response>, 200);`);
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
// domain factory / operation expects: brand `Id<X>` strings via
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
