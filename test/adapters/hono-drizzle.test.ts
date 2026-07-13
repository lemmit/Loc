// drizzle — real PersistenceAdapter for hono (F6a).  Verifies the
// adapter returns non-empty Lines for every method that wraps an
// existing TypeScript/Hono emit fn.  Parallel of dotnet-efcore.test.ts;
// today the orchestrator (`src/platform/hono/v4/emit.ts`) still calls
// the underlying emit fns directly, so the byte-identical gate is the
// existing typescript-generator fixture suite — this file proves the
// adapter contract is wired through to real output.

import { describe, expect, it } from "vitest";
import type { EmitCtx } from "../../src/generator/_adapters/index.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { EnrichedBoundedContextIR } from "../../src/ir/types/loom-ir.js";
import {
  drizzlePersistenceAdapter,
  emitDrizzleSchema,
} from "../../src/platform/hono/v4/adapters/drizzle-persistence.js";
import { adaptersFor } from "../../src/platform/resolve-adapters.js";
import { parseValid } from "../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order {
        name: string
      }
      repository Orders for Order {
        find byName(name: string): Order? where this.name == name
      }
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: node
    contexts: [Orders]
    dataSources: [ordersState]
    port: 3000
  }
}
`;

async function buildCtx(): Promise<EmitCtx> {
  const loom = enrichLoomModel(lowerModel(await parseValid(SRC)));
  const sys = loom.systems[0]!;
  const deployable = sys.deployables.find((d) => d.platform === "node")!;
  const all: EnrichedBoundedContextIR[] = sys.subdomains.flatMap((s) => s.contexts);
  const contexts = all.filter((c) => deployable.contextNames.includes(c.name));
  return { deployable, contexts, sys, migrations: [] };
}

describe("drizzle PersistenceAdapter (real)", () => {
  it("is registered as the hono drizzle persistence adapter", () => {
    const resolved = adaptersFor("node")!.persistence.drizzle;
    expect(resolved).toBe(drizzlePersistenceAdapter);
    expect(resolved.name).toBe("drizzle");
  });

  it("answers capability fields directly (no stub-throw)", () => {
    expect(drizzlePersistenceAdapter.supportedStrategies).toEqual(["state", "eventLog"]);
    expect(drizzlePersistenceAdapter.supports("postgres", "state", "state")).toBe(true);
    expect(drizzlePersistenceAdapter.supports("mysql", "state", "state")).toBe(true);
    expect(drizzlePersistenceAdapter.supports("redis", "state", "state")).toBe(false);
    expect(drizzlePersistenceAdapter.supports("postgres", "eventLog", "state")).toBe(false);
    // Event-sourced streams (appliers A2): an `eventLog` aggregate routed to
    // an `eventLog` binding on a relational store is supported; a `state`
    // binding for an event-sourced aggregate is not.
    expect(drizzlePersistenceAdapter.supports("postgres", "eventLog", "eventLog")).toBe(true);
    expect(drizzlePersistenceAdapter.supports("redis", "eventLog", "eventLog")).toBe(false);
    expect(drizzlePersistenceAdapter.supports("postgres", "state", "eventLog")).toBe(false);
  });

  it("emitProjectDeps returns drizzle + pg deps + devDeps as JSON lines", () => {
    const ctx = {} as EmitCtx;
    const lines = drizzlePersistenceAdapter.emitProjectDeps(ctx);
    const joined = lines.join("\n");
    expect(joined).toContain('"drizzle-orm":');
    expect(joined).toContain('"pg":');
    expect(joined).toContain('"drizzle-kit":');
    expect(joined).toContain('"@types/pg":');
  });

  it("emitConnectionSetup returns the pool + drizzle bootstrap lines", async () => {
    const ctx = await buildCtx();
    const lines = drizzlePersistenceAdapter.emitConnectionSetup([], ctx);
    const joined = lines.join("\n");
    expect(joined).toContain("DATABASE_URL is required");
    expect(joined).toContain("new pg.Pool({");
    expect(joined).toContain("drizzle(pool, { schema })");
    expect(joined).toContain('pool.on("error"');
  });

  it("emitRepository wraps buildRepositoryFile end-to-end", async () => {
    const ctx = await buildCtx();
    const agg = ctx.contexts[0]!.aggregates.find((a) => a.name === "Order")!;
    const ds = ctx.sys.dataSources[0]!;
    const lines = drizzlePersistenceAdapter.emitRepository(agg, ds, ctx);
    const joined = lines.join("\n");
    // Drizzle repository emits a `findById`/`save`/`toWire` surface for
    // the aggregate plus the user-declared find.
    expect(joined).toContain("findById");
    expect(joined).toContain("byName");
    expect(joined).toContain("toWire");
    // The buildRepositoryFile output reaches into drizzle-orm's
    // operator surface (eq / and / inArray are the default trio).
    expect(joined).toContain('from "drizzle-orm"');
  });

  it("emitMigrations returns null when ctx has no migrations", async () => {
    const ctx = await buildCtx();
    expect(drizzlePersistenceAdapter.emitMigrations([], [], ctx)).toBeNull();
  });

  it("emitOutbox returns null (not yet implemented)", async () => {
    const ctx = await buildCtx();
    const storage = ctx.sys.storages[0]!;
    expect(drizzlePersistenceAdapter.emitOutbox(storage, [], ctx)).toBeNull();
  });

  it("emitDrizzleSchema helper wraps renderSchema for the merged contexts", async () => {
    const ctx = await buildCtx();
    const lines = emitDrizzleSchema(ctx);
    const joined = lines.join("\n");
    // Drizzle schema declares one `pgTable` per aggregate.
    expect(joined).toContain('from "drizzle-orm/pg-core"');
    expect(joined).toContain("orders");
  });
});
