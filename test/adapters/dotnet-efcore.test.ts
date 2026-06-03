// efcore — real PersistenceAdapter for dotnet (F5a).  Verifies the
// adapter returns non-empty Lines for every method that wraps an
// existing emit fn.  Today the orchestrator still calls the underlying
// emit fns directly, so the byte-identical gate is the existing dotnet
// fixture suite (test/generator/dotnet/*); this file's job is to prove
// the adapter contract is wired through to real output for the future
// rewire.

import { describe, expect, it } from "vitest";
import type { EmitCtx } from "../../src/generator/_adapters/index.js";
import {
  efcorePersistenceAdapter,
  emitConfiguration,
  emitDbContext,
} from "../../src/generator/dotnet/adapters/efcore-persistence.js";
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
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: dotnet
    contexts: [Orders]
    dataSources: [ordersState]
    port: 5000
  }
}
`;

async function buildCtx(): Promise<EmitCtx> {
  const loom = enrichLoomModel(lowerModel(await parseValid(SRC)));
  const sys = loom.systems[0]!;
  const deployable = sys.deployables.find((d) => d.platform === "dotnet")!;
  // Bounded contexts in system-mode live under each subdomain — same
  // traversal `allContexts()` does in src/ir/types/loom-ir.ts.
  const all: EnrichedBoundedContextIR[] = sys.subdomains.flatMap((s) => s.contexts);
  const contexts = all.filter((c) => deployable.contextNames.includes(c.name));
  return { deployable, contexts, sys, migrations: [] };
}

describe("efcore PersistenceAdapter (real)", () => {
  it("is registered as the dotnet efcore persistence adapter", () => {
    const resolved = resolvePersistence("dotnet", "efcore");
    expect(resolved).toBe(efcorePersistenceAdapter);
    expect(resolved.name).toBe("efcore");
  });

  it("answers capability fields directly (no stub-throw)", () => {
    expect(efcorePersistenceAdapter.supportedStrategies).toEqual(["state", "eventLog"]);
    expect(efcorePersistenceAdapter.supports("postgres", "state", "state")).toBe(true);
    expect(efcorePersistenceAdapter.supports("redis", "state", "state")).toBe(false);
    expect(efcorePersistenceAdapter.supports("postgres", "eventLog", "state")).toBe(false);
    // Event-sourced streams (appliers A2.2b): an `eventLog` aggregate on an
    // `eventLog` binding over a relational store is supported (EF event store).
    expect(efcorePersistenceAdapter.supports("postgres", "eventLog", "eventLog")).toBe(true);
    expect(efcorePersistenceAdapter.supports("redis", "eventLog", "eventLog")).toBe(false);
    expect(efcorePersistenceAdapter.supports("postgres", "state", "eventLog")).toBe(false);
  });

  it("emitProjectDeps returns the EF Core PackageReferences", () => {
    const ctx = {} as EmitCtx; // unused by emitProjectDeps today
    const lines = efcorePersistenceAdapter.emitProjectDeps(ctx);
    const joined = lines.join("\n");
    expect(joined).toContain("Microsoft.EntityFrameworkCore");
    expect(joined).toContain("Npgsql.EntityFrameworkCore.PostgreSQL");
    expect(joined).toMatch(/Microsoft\.EntityFrameworkCore\.Design/);
    expect(joined).toMatch(/Microsoft\.EntityFrameworkCore\.Tools/);
  });

  it("emitConnectionSetup returns AddDbContext+UseNpgsql lines", async () => {
    const ctx = await buildCtx();
    const lines = efcorePersistenceAdapter.emitConnectionSetup([], ctx);
    const joined = lines.join("\n");
    expect(joined).toContain("builder.Services.AddDbContext<AppDbContext>");
    expect(joined).toContain("opts.UseNpgsql");
    expect(joined).toContain('GetConnectionString("Default")');
    // The fixture has no stamping rules → simple form.
    expect(joined).not.toContain("AuditableInterceptor");
  });

  it("emitRepository wraps renderRepositoryImpl byte-identical to today", async () => {
    const ctx = await buildCtx();
    const agg = ctx.contexts[0]!.aggregates.find((a) => a.name === "Order")!;
    const ds = ctx.sys.dataSources[0]!;
    const lines = efcorePersistenceAdapter.emitRepository(agg, ds, ctx);
    const joined = lines.join("\n");
    expect(joined).toContain("public sealed class OrderRepository : IOrderRepository");
    expect(joined).toContain("private readonly AppDbContext _db;");
    // Repository surfaces the user-declared find.
    expect(joined).toContain("ByName(");
    // Namespace derives from the deployable name.
    expect(joined).toContain("namespace Api.Infrastructure.Repositories;");
  });

  it("emitMigrations returns null when ctx has no migrations", async () => {
    const ctx = await buildCtx();
    expect(efcorePersistenceAdapter.emitMigrations([], [], ctx)).toBeNull();
  });

  it("emitOutbox returns null (not yet implemented)", async () => {
    const ctx = await buildCtx();
    const storage = ctx.sys.storages[0]!;
    expect(efcorePersistenceAdapter.emitOutbox(storage, [], ctx)).toBeNull();
  });

  it("emitConfiguration helper wraps renderConfiguration", async () => {
    const ctx = await buildCtx();
    const agg = ctx.contexts[0]!.aggregates.find((a) => a.name === "Order")!;
    const lines = emitConfiguration(agg, ctx);
    const joined = lines.join("\n");
    expect(joined).toContain(
      "public sealed class OrderConfiguration : IEntityTypeConfiguration<Order>",
    );
  });

  it("emitDbContext helper wraps renderDbContext", async () => {
    const ctx = await buildCtx();
    const lines = emitDbContext(ctx);
    const joined = lines.join("\n");
    expect(joined).toContain("public sealed class AppDbContext : DbContext");
    expect(joined).toContain("DbSet<Order>");
  });
});
