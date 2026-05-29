// ashPostgres — real PersistenceAdapter for phoenixLiveView (F7a).
// Mirrors dotnet-efcore.test.ts and hono-drizzle.test.ts.  Today the
// orchestrator (`src/generator/phoenix-live-view/index.ts`) still
// calls the underlying emit fns directly, so the byte-identical gate
// is the existing phoenix fixture suite — this file proves the
// adapter contract is wired through to real output.

import { describe, expect, it } from "vitest";
import type { EmitCtx } from "../../src/generator/_adapters/index.js";
import {
  ashPostgresPersistenceAdapter,
  toModulePrefix,
  toSnakeApp,
} from "../../src/generator/phoenix-live-view/adapters/ash-postgres-persistence.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { EnrichedBoundedContextIR } from "../../src/ir/types/loom-ir.js";
import { resolvePersistence } from "../../src/platform/resolve-adapters.js";
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
  dataSource ordersState { for: Orders, kind: state, use: primary }
  ui WebApp {}
  deployable webApp {
    platform: phoenixLiveView
    contexts: [Orders]
    dataSources: [ordersState]
    ui: WebApp
    port: 4000
  }
}
`;

async function buildCtx(): Promise<EmitCtx> {
  const loom = enrichLoomModel(lowerModel(await parseValid(SRC)));
  const sys = loom.systems[0]!;
  const deployable = sys.deployables.find((d) => d.platform === "phoenixLiveView")!;
  const all: EnrichedBoundedContextIR[] = sys.subdomains.flatMap((s) => s.contexts);
  const contexts = all.filter((c) => deployable.contextNames.includes(c.name));
  return { deployable, contexts, sys, migrations: [] };
}

describe("ashPostgres PersistenceAdapter (real)", () => {
  it("is registered as the phoenixLiveView ashPostgres persistence adapter", () => {
    const resolved = resolvePersistence("phoenixLiveView", "ashPostgres");
    expect(resolved).toBe(ashPostgresPersistenceAdapter);
    expect(resolved.name).toBe("ashPostgres");
  });

  it("answers capability fields directly", () => {
    expect(ashPostgresPersistenceAdapter.supportedStrategies).toEqual(["state"]);
    // Ash with the postgres datalayer is postgres-only.
    expect(ashPostgresPersistenceAdapter.supports("postgres", "state", "state")).toBe(true);
    expect(ashPostgresPersistenceAdapter.supports("postgres", "snapshot", "state")).toBe(true);
    expect(ashPostgresPersistenceAdapter.supports("mysql", "state", "state")).toBe(false);
    expect(ashPostgresPersistenceAdapter.supports("postgres", "eventLog", "state")).toBe(false);
    expect(ashPostgresPersistenceAdapter.supports("postgres", "state", "eventLog")).toBe(false);
  });

  it("emitProjectDeps returns the Ash family mix.exs lines", () => {
    const ctx = {} as EmitCtx;
    const lines = ashPostgresPersistenceAdapter.emitProjectDeps(ctx);
    const joined = lines.join("\n");
    expect(joined).toContain("{:ash,");
    expect(joined).toContain("{:ash_postgres,");
    expect(joined).toContain("{:ash_phoenix,");
    // Compile-time optional deps for AshPostgres' ResourceGenerator.
    expect(joined).toContain("{:igniter,");
    expect(joined).toContain("{:owl,");
  });

  it("emitConnectionSetup returns the <App>.Repo module", async () => {
    const ctx = await buildCtx();
    const lines = ashPostgresPersistenceAdapter.emitConnectionSetup([], ctx);
    const joined = lines.join("\n");
    // The fixture's deployable is `webApp` → snake `web_app` → module `WebApp`.
    expect(joined).toContain("defmodule WebApp.Repo do");
    expect(joined).toContain("use AshPostgres.Repo, otp_app: :web_app");
    expect(joined).toContain("installed_extensions");
    expect(joined).toContain("min_pg_version");
  });

  it("emitRepository wraps emitAggregateResources for the single aggregate", async () => {
    const ctx = await buildCtx();
    const agg = ctx.contexts[0]!.aggregates.find((a) => a.name === "Order")!;
    const ds = ctx.sys.dataSources[0]!;
    const lines = ashPostgresPersistenceAdapter.emitRepository(agg, ds, ctx);
    const joined = lines.join("\n");
    // The path marker carries the produced .ex path so consumers know
    // where the Resource module lands.
    expect(joined).toContain("# ---- lib/web_app/orders/order.ex ----");
    // Ash Resource attributes + actions for a stateBased postgres
    // aggregate.
    expect(joined).toContain("use Ash.Resource");
    expect(joined).toContain("data_layer: AshPostgres.DataLayer");
    expect(joined).toContain("attributes do");
  });

  it("emitMigrations returns null when ctx has no migrations", async () => {
    const ctx = await buildCtx();
    expect(ashPostgresPersistenceAdapter.emitMigrations([], [], ctx)).toBeNull();
  });

  it("emitOutbox returns null (not yet implemented)", async () => {
    const ctx = await buildCtx();
    const storage = ctx.sys.storages[0]!;
    expect(ashPostgresPersistenceAdapter.emitOutbox(storage, [], ctx)).toBeNull();
  });

  it("toSnakeApp + toModulePrefix mirror the orchestrator's naming", () => {
    expect(toSnakeApp("webApp")).toBe("web_app");
    expect(toSnakeApp("Storefront")).toBe("storefront");
    expect(toSnakeApp("MyApp123")).toBe("my_app123");
    expect(toModulePrefix("web_app")).toBe("WebApp");
    expect(toModulePrefix("storefront")).toBe("Storefront");
    expect(toModulePrefix("my_app123")).toBe("MyApp123");
  });
});
