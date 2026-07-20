// Context-scoped INTEGRATION test emission (test-placement.md, Phase 3a) — the
// node/Hono backend.  A `test … for <Context>` (or a `context`-nested `test`)
// runs cross-aggregate behaviour IN-PROCESS against live repositories, no HTTP:
// a create persists via `repo.save(...)`, an operation mutates-then-saves, a
// repository find reads back.  The emitted file is provisioning-agnostic — it
// reads a `PG_URL` (a Loom app already ships a compose Postgres), applies the
// generated drizzle migrations, wires the context's repositories, and runs the
// body.
//
// v1 constraint (`loom.integration-find-must-bind`): a repository find must be
// LET-BOUND (`let inv = Inventory.forSku(x)`), not written inline inside an
// `expect(...)`, so the `await` stays a statement-level concern and the assertion
// expressions render synchronously.  v1 also uses the no-fan-out
// `NoopDomainEventDispatcher`; the synchronous workflow-cascade edition
// (`createInProcessDispatcher`) is the 3a-cascade follow-up.

import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  FindIR,
  TestIR,
  TestStmtIR,
} from "../../../ir/types/loom-ir.js";
import { lowerFirst } from "../../../util/naming.js";
import { renderTsExpr } from "../render-expr.js";
import { renderCreateInput, renderExplicitMatcher } from "./tests.js";

/** A repository find on `agg` named `name`, or undefined. */
function findRepoQuery(name: string, aggName: string, ctx: BoundedContextIR): FindIR | undefined {
  for (const r of ctx.repositories) {
    if (r.aggregateName !== aggName) continue;
    const f = r.finds.find((q) => q.name === name);
    if (f) return f;
  }
  return undefined;
}

/** A `<Agg>.create(...)` / named create-action call → the owning aggregate + the
 *  create method name; undefined when the call is not a create. */
function createCallOf(
  e: ExprIR,
  ctx: BoundedContextIR,
): { agg: AggregateIR; method: string } | undefined {
  if (e.kind !== "method-call" || e.receiver.kind !== "ref") return undefined;
  const agg = ctx.aggregates.find((a) => a.name === (e.receiver as { name: string }).name);
  if (!agg) return undefined;
  if (e.member === "create" || (agg.creates ?? []).some((c) => c.name === e.member)) {
    return { agg, method: e.member };
  }
  return undefined;
}

// Built-in repository reads every aggregate's repo emits (findById / getById /
// findAll), in addition to the context's declared custom finds.
const BUILTIN_READS = new Set(["findById", "getById", "findAll"]);

/** A `<Agg>.<find>(...)` repository read → the aggregate + method + args, whether
 *  a declared custom find or a built-in (findById / getById / findAll);
 *  undefined otherwise.  `nullable` marks reads whose emitted method returns
 *  `<Agg> | null` (findById + an optional/union custom find) — those get a
 *  non-null assertion so a strict-null test body typechecks (a genuinely-null
 *  read then fails the test at the `.field` access). */
function findCallOf(
  e: ExprIR,
  ctx: BoundedContextIR,
): { aggName: string; method: string; args: ExprIR[]; nullable: boolean } | undefined {
  if (e.kind !== "method-call" || e.receiver.kind !== "ref") return undefined;
  const aggName = (e.receiver as { name: string }).name;
  const hasRepo = ctx.repositories.some((r) => r.aggregateName === aggName);
  if (!hasRepo) return undefined;
  const custom = findRepoQuery(e.member, aggName, ctx);
  if (!BUILTIN_READS.has(e.member) && !custom) return undefined;
  const nullable =
    e.member === "findById" ||
    custom?.returnType.kind === "optional" ||
    custom?.returnType.kind === "union";
  return { aggName, method: e.member, args: e.args, nullable };
}

const repoHandle = (aggName: string): string => `repos.${lowerFirst(aggName)}`;

/** Render one integration-test statement.  Creates and mutating ops persist via
 *  the repository; let-bound finds await a repository read; everything else
 *  defers to the shared expression / matcher renderers. */
function renderStmt(s: TestStmtIR, ctx: BoundedContextIR): string[] {
  switch (s.kind) {
    case "let": {
      const create = createCallOf(s.expr, ctx);
      if (create && s.expr.kind === "method-call" && s.expr.args[0]?.kind === "object") {
        const input = renderCreateInput(s.expr.args[0], create.agg, ctx);
        return [
          `const ${s.name} = ${create.agg.name}.${create.method}(${input});`,
          `await ${repoHandle(create.agg.name)}.save(${s.name});`,
        ];
      }
      const find = findCallOf(s.expr, ctx);
      if (find) {
        const args = find.args.map((a) => renderTsExpr(a)).join(", ");
        const call = `await ${repoHandle(find.aggName)}.${find.method}(${args})`;
        return [`const ${s.name} = ${find.nullable ? `(${call})!` : call};`];
      }
      return [`const ${s.name} = ${renderTsExpr(s.expr)};`];
    }
    case "expression": {
      // A mutating operation on a let-bound aggregate instance → mutate in place,
      // then persist (mirrors the route handler's load → mutate → save).
      if (
        s.expr.kind === "method-call" &&
        s.expr.receiverType.kind === "entity" &&
        !s.expr.isCollectionOp
      ) {
        const aggName = s.expr.receiverType.name;
        const recv = renderTsExpr(s.expr.receiver);
        const args = s.expr.args.map((a) => renderTsExpr(a)).join(", ");
        return [
          `${recv}.${s.expr.member}(${args});`,
          `await ${repoHandle(aggName)}.save(${recv});`,
        ];
      }
      return [`${renderTsExpr(s.expr)};`];
    }
    case "expect": {
      const explicit = renderExplicitMatcher(s.expr, ctx);
      if (explicit) return [explicit.trimStart()];
      throw new Error("expect requires a matcher (e.g. expect(x).toBe(y)).");
    }
    case "expect-throws": {
      const inner = renderTsExpr(s.expr);
      return [`await expect(async () => { ${inner}; }).rejects.toThrow();`];
    }
    default:
      // let / expression / expect(-throws) are the surviving integration shapes;
      // anything else is an IR-validator gap.
      throw new Error(`unsupported integration-test statement '${s.kind}'`);
  }
}

function renderTest(t: TestIR, ctx: BoundedContextIR): string[] {
  const out: string[] = [`  it(${JSON.stringify(t.name)}, async () => {`];
  for (const s of t.statements) out.push(...renderStmt(s, ctx).map((l) => `    ${l}`));
  out.push("  });");
  return out;
}

/** Emit `test/<ctx>.integration.test.ts` for a context that declares integration
 *  tests, or null when it declares none. */
export function renderContextIntegrationTest(ctx: BoundedContextIR): string | null {
  if (ctx.tests.length === 0) return null;

  const body: string[] = [`describe(${JSON.stringify(`${ctx.name} (integration)`)}, () => {`];
  for (const t of ctx.tests) {
    body.push(...renderTest(t, ctx));
    body.push("");
  }
  body.push("});");
  const bodyStr = body.join("\n");

  // Repositories referenced by the body (a create/op/find on the aggregate) →
  // the ones to import + wire.  Narrow so an unused import doesn't trip tsc/biome.
  const refs = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(bodyStr);
  const usedAggs = ctx.aggregates.filter(
    (a) => ctx.repositories.some((r) => r.aggregateName === a.name) && refs(a.name),
  );
  const usesIds = /\bIds\./.test(bodyStr);

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { describe, it, expect, beforeAll } from "vitest";`);
  lines.push(`import { Pool } from "pg";`);
  lines.push(`import { drizzle } from "drizzle-orm/node-postgres";`);
  lines.push(`import { migrate } from "drizzle-orm/node-postgres/migrator";`);
  lines.push(`import * as schema from "../db/schema";`);
  lines.push(`import { NoopDomainEventDispatcher } from "../domain/events";`);
  if (usesIds) lines.push(`import * as Ids from "../domain/ids";`);
  for (const a of usedAggs) {
    lines.push(`import { ${a.name} } from "../domain/${lowerFirst(a.name)}";`);
    lines.push(
      `import { ${a.name}Repository } from "../db/repositories/${lowerFirst(a.name)}-repository";`,
    );
  }
  lines.push("");
  lines.push(
    `let repos: { ${usedAggs.map((a) => `${lowerFirst(a.name)}: ${a.name}Repository`).join("; ")} };`,
  );
  lines.push("");
  lines.push(`beforeAll(async () => {`);
  lines.push(
    `  const pool = new Pool({ connectionString: process.env.LOOM_PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres" });`,
  );
  lines.push(`  const db = drizzle(pool, { schema });`);
  lines.push(`  await migrate(db, { migrationsFolder: "./db/migrations" });`);
  lines.push(`  const events = NoopDomainEventDispatcher;`);
  lines.push(
    `  repos = { ${usedAggs
      .map((a) => `${lowerFirst(a.name)}: new ${a.name}Repository(db, events)`)
      .join(", ")} };`,
  );
  lines.push(`});`);
  lines.push("");
  lines.push(...body);
  return `${lines.join("\n")}\n`;
}
