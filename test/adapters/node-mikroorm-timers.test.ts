// node MikroORM adapter — timerSource scheduling parity (M-T6.23 slice 3).
//
// A `timerSource` fires a plain domain event on a wall-clock cadence: `cron:`
// timers run on pg-boss (durable, retried), `every:` timers in-process
// (setInterval + a transaction-scoped advisory lock).  The deployable that OWNS
// the timer (its subdomain's `migrationsOwner`) emits `scheduler.ts`.
//
// On the MikroORM adapter it emitted NOTHING — `hasTimers` was `&& !usingMikro`
// — so the cadence never fired and the timer's event was never emitted.  That
// was a `loom.mikroorm-unsupported` error (the honest interim); this suite is
// the emitter that replaced it.
//
// Unlike the broker slice, this one is a REAL port: `scheduler.ts` is the one
// emitted module whose database access is not domain persistence — a self-owned
// `loom_timer_runs` watermark and a `pg_try_advisory_xact_lock`, both raw SQL.
// The five diverging call sites live behind the `TimerStore` seam in
// `scheduler-builder.ts`.  Runtime proof: booted against a real Postgres (see
// the PR body); compile proof: `tsc --noEmit` on the generated tree.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

async function emit(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(src, { validation: true });
  const parseErrors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
  const irErrors = validateLoomModel(loom)
    .filter((d) => d.severity === "error")
    .map((d) => d.message);
  expect([...parseErrors, ...irErrors], "validation errors").toEqual([]);
  return generateSystems(doc.parseResult.value as Model).files;
}

/** One owned timer, cadence supplied by the caller (`cron:` → pg-boss +
 *  watermark; `every:` → setInterval + advisory lock). */
const sys = (persistence: string, cadence: string) => `
system M {
  api A from Ops
  subdomain Ops {
    context Orders {
      aggregate Sweep { runId: string firedAt: datetime }
      repository Sweeps for Sweep { }
      event SweepTick { sweep: Sweep id, at: datetime }
      channel Ticks { carries: SweepTick }
      workflow SweepRun {
        sweep: Sweep id
        firedAt: datetime
        create(t: SweepTick) by t.sweep { firedAt := t.at }
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d {
    platform: node { persistence: ${persistence} }
    contexts: [Orders]
    dataSources: [s]
    serves: A
    port: 8080
  }
  timerSource sweep { for: SweepTick, ${cadence} }
}`;

describe("MikroORM timerSource scheduling", () => {
  it("emits scheduler.ts against the EntityManager, with no drizzle imports", async () => {
    const sched = (await emit(sys("mikroorm", 'cron: "*/5 * * * *"'))).get("d/scheduler.ts");
    expect(sched, "scheduler.ts was not emitted on the mikroorm adapter").toBeDefined();
    const src = sched as string;
    expect(src).toContain('import { EntityManager } from "@mikro-orm/postgresql";');
    expect(src).toContain("export async function startTimerScheduler(\n  db: EntityManager,");
    expect(src).not.toContain('from "drizzle-orm"');
    expect(src).not.toContain("./db/schema");
    // pg-boss is adapter-independent (it takes DATABASE_URL directly).
    expect(src).toContain('import { PgBoss } from "pg-boss";');
    expect(src).toContain(
      "const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });",
    );
  });

  it("runs the loom_timer_runs watermark through the mikro connection", async () => {
    const src = (await emit(sys("mikroorm", 'cron: "*/5 * * * *"'))).get(
      "d/scheduler.ts",
    ) as string;
    // create — self-owned, never in the domain MigrationsIR.
    expect(src).toContain("await db.getConnection().execute(");
    expect(src).toContain(
      '"CREATE TABLE IF NOT EXISTS loom_timer_runs (timer text PRIMARY KEY, last_fired_at timestamptz NOT NULL DEFAULT now())",',
    );
    // fire upsert (positional `?` params, the emitMikroSeeds idiom).
    expect(src).toContain(
      '"INSERT INTO loom_timer_runs (timer, last_fired_at) VALUES (?, now()) ON CONFLICT (timer) DO UPDATE SET last_fired_at = now()",',
    );
    // catch-up read — rows come back as a plain array here, not `{ rows }`.
    expect(src).toContain('"SELECT last_fired_at FROM loom_timer_runs WHERE timer = ?",');
    expect(src).toContain("const raw = seen[0]?.last_fired_at;");
    expect(src).not.toContain("seen.rows[0]");
    // first-boot baseline insert.
    expect(src).toContain(
      '"INSERT INTO loom_timer_runs (timer, last_fired_at) VALUES (?, now()) ON CONFLICT (timer) DO NOTHING",',
    );
  });

  it("binds the advisory lock to the transaction's own connection", async () => {
    // THE load-bearing detail of this port: `pg_try_advisory_xact_lock` is
    // released when its transaction ends, so the raw query must run on the
    // transaction's connection.  `em.transactional` opens it; the context has to
    // be threaded explicitly, or the driver takes a pooled connection and the
    // lock is gone before the dispatch.
    const src = (await emit(sys("mikroorm", "every: 30s"))).get("d/scheduler.ts") as string;
    expect(src).toContain("await db.transactional(async (tem) => {");
    expect(src).toContain('"SELECT pg_try_advisory_xact_lock(?) AS locked",');
    expect(src).toContain("tem.getTransactionContext(),");
    expect(src).toContain("const locked = lock[0]?.locked ?? false;");
    expect(src).not.toContain("db.transaction(async (tx)");
    // …and the dispatch + the contention log stay inside the transaction.
    expect(src).toContain('baseLogger.debug({ event: "timer_lock_contended", timer: name });');
    expect(src).toContain("await events.dispatch(build());");
  });

  it("wires the scheduler at boot on the mikro connection", async () => {
    const index = (await emit(sys("mikroorm", "every: 30s"))).get("d/index.ts") as string;
    expect(index).toContain('import { startTimerScheduler } from "./scheduler";');
    expect(index).toContain("const db = orm.em;");
    expect(index).toContain("const stopTimers = await startTimerScheduler(db, inProcessEvents);");
    expect(index).toContain("await stopTimers();");
  });

  it("declares the cron dependencies only for a cron timer", async () => {
    const cronPkg = (await emit(sys("mikroorm", 'cron: "*/5 * * * *"'))).get(
      "d/package.json",
    ) as string;
    expect(cronPkg).toContain('"pg-boss"');
    expect(cronPkg).toContain('"cron-parser"');
    const everyPkg = (await emit(sys("mikroorm", "every: 30s"))).get("d/package.json") as string;
    expect(everyPkg).not.toContain('"pg-boss"');
  });

  it("keeps the watermark alive across boots: entity + safe-mode updateSchema", async () => {
    // The blocker an owner review caught.  `orm.schema.updateSchema()` defaults to
    // `dropTables: true` over an unpruned introspection, so from the SECOND boot
    // onward every table the entity metadata does not describe is diffed as
    // removed.  `loom_timer_runs` is created by raw SQL (it is self-owned
    // infrastructure, deliberately outside the domain MigrationsIR), so it was
    // exactly such a table — and its rows are the ONLY reason it exists (the
    // cron coalesce-once catch-up).  Two independent guards, both pinned:
    const files = await emit(sys("mikroorm", 'cron: "*/5 * * * *"'));
    //  (1) the watermark is a real ENTITY, so `updateSchema()` maintains it
    //      instead of diffing it away…
    const entities = files.get("d/db/entities.ts") as string;
    expect(entities).toContain("export class LoomTimerRunsRow {");
    expect(entities).toContain('tableName: "loom_timer_runs",');
    expect(entities).toContain('timer: { type: "string", primary: true },');
    expect(entities).toContain('lastFiredAt: { type: "Date", columnType: "timestamptz" },');
    expect(entities).toMatch(/export const entities = \[[^\]]*LoomTimerRunsRowSchema[^\]]*\];/);
    //  (2) …and boot runs updateSchema in SAFE mode, which is what protects the
    //      tables no entity could ever cover — pg-boss's own schema and the
    //      first-boot seed marker `__loom_seed` (created the same raw way).
    const index = files.get("d/index.ts") as string;
    expect(index).toContain("await orm.schema.updateSchema({ safe: true });");
    expect(index).not.toContain("await orm.schema.updateSchema();");
  });

  it("emits the watermark entity ONLY for a deployable that owns a timer", async () => {
    // Same condition as `scheduler.ts` (the subdomain's `migrationsOwner`), so a
    // timer-free deployable pays nothing.  `emit.ts` throws if the two rules ever
    // disagree, which is the invariant this case documents.
    const noTimers = await emit(
      sys("mikroorm", 'cron: "*/5 * * * *"').replace(/\n {2}timerSource[^\n]*\n/, "\n"),
    );
    const entities = noTimers.get("d/db/entities.ts") as string;
    expect(entities).not.toContain("LoomTimerRunsRow");
    expect(noTimers.get("d/scheduler.ts")).toBeUndefined();
    // …but safe mode is unconditional: the seed marker and pg-boss are not
    // timer-specific.
    expect(noTimers.get("d/index.ts") as string).toContain(
      "await orm.schema.updateSchema({ safe: true });",
    );
  });

  it("leaves the drizzle scheduler byte-identical", async () => {
    for (const cadence of ['cron: "*/5 * * * *"', "every: 30s"]) {
      const src = (await emit(sys("drizzle", cadence))).get("d/scheduler.ts") as string;
      expect(src).toContain("  db: NodePgDatabase<typeof schema>,");
      expect(src).toContain('import { sql } from "drizzle-orm";');
      expect(src).toContain('import type * as schema from "./db/schema";');
      expect(src).not.toContain("EntityManager");
      expect(src).not.toContain("getConnection()");
    }
    const drz = (await emit(sys("drizzle", "every: 30s"))).get("d/scheduler.ts") as string;
    expect(drz).toContain("await db.transaction(async (tx) => {");
    expect(drz).toContain(
      "const locked = (lock.rows[0] as { locked: boolean } | undefined)?.locked ?? false;",
    );
  });

  it("no longer refuses to generate (the honest gate it replaced)", async () => {
    const services = createDddServices(NodeFileSystem);
    for (const cadence of ['cron: "*/5 * * * *"', "every: 30s"]) {
      const doc = await parseHelper(services.Ddd)(sys("mikroorm", cadence), { validation: true });
      const diags = validateLoomModel(enrichLoomModel(lowerModel(doc.parseResult.value as Model)));
      // ERRORS only: the fixture's default-`broadcast` channel still draws the
      // realtime SSE WARNING (slice 5, not this one), and that must survive —
      // asserting "no mikroorm diagnostic at all" here would silently absorb it.
      expect(
        diags
          .filter((d) => d.severity === "error" && d.code === "loom.mikroorm-unsupported")
          .map((d) => d.message),
      ).toEqual([]);
    }
  });
});

describe("MikroORM event-log stream row (found by slice 3's compile proof)", () => {
  it("declares `seq` OPTIONAL so an append type-checks", async () => {
    // `seq` is a DB-generated bigserial, so every append omits it — but MikroORM
    // derives `RequiredEntityData` from the CLASS, so declaring it required made
    // `em.insert(<Ctx>EventRow, {…})` fail tsc with "Property 'seq' is missing"
    // on EVERY event-sourced aggregate/workflow under `persistence: mikroorm`.
    // No validator gate hid this: the corpus tsc gates run drizzle only, and the
    // mikro behavioural leg builds with esbuild (no typecheck).
    const src = `
system M {
  api A from Ops
  subdomain Ops {
    context Orders {
      aggregate Sweep { runId: string firedAt: datetime }
      repository Sweeps for Sweep { }
      event SweepTick { sweep: Sweep id, at: datetime }
      event SweepRan  { sweep: Sweep id, at: datetime }
      channel Ticks { carries: SweepTick }
      workflow SweepRun eventSourced {
        sweep: Sweep id
        firedAt: datetime
        create(t: SweepTick) by t.sweep { emit SweepRan { sweep: t.sweep, at: t.at } }
        apply(r: SweepRan) { firedAt := r.at }
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d {
    platform: node { persistence: mikroorm }
    contexts: [Orders]
    dataSources: [s]
    serves: A
    port: 8080
  }
}`;
    const entities = (await emit(src)).get("d/db/entities.ts") as string;
    expect(entities).toContain("export class OrdersEventRow {");
    expect(entities).toContain("  seq?: number;");
    expect(entities).not.toContain("  seq!: number;");
    // …still the sequence-backed column MikroORM leaves out of the insert list.
    expect(entities).toContain(
      'seq: { type: "number", columnType: "bigserial", autoincrement: true },',
    );
  });
});
