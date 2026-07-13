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
    const resolved = adaptersFor("dotnet")!.persistence.efcore;
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

  // NOTE: the emitConnectionSetup / emitRepository / emitMigrations / emitOutbox
  // adapter methods were removed as never-invoked scaffolding (M-T9.2 / M-T6.10);
  // the underlying emitters (renderRepositoryImpl, emitDotnetMigrations, …) are
  // exercised through the real orchestrator path + emitConfiguration/emitDbContext
  // below.

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

  // Regression: EF column names MUST match the snake_case migration DDL.
  // EF's default is the PascalCase CLR property name, which produced
  // `42703: column "Id"/"CreatedAt" does not exist` on every INSERT/SELECT —
  // invisible to the compile-only dotnet-build gate, caught only by the
  // behavioral conformance run.
  it("maps every column to the migration's snake_case (scalars, PK, enum, containment FK)", async () => {
    const RICH = `
      system S {
        subdomain Cat {
          context Catalog {
            enum Vis { Private, Public }
            aggregate Project {
              displayName: string
              visibility: Vis
              createdAt: datetime
              contains pipelines: Pipeline[]
              entity Pipeline {
                runCount: int
                derived label: string = "p"
              }
              derived display: string = displayName
            }
            repository Projects for Project { }
          }
        }
        storage primary { type: postgres }
        resource catState { for: Catalog, kind: state, use: primary }
        deployable api { platform: dotnet contexts: [Catalog] dataSources: [catState] port: 5000 }
      }`;
    const loom = enrichLoomModel(lowerModel(await parseValid(RICH)));
    const sys = loom.systems[0]!;
    const deployable = sys.deployables.find((d) => d.platform === "dotnet")!;
    const contexts: EnrichedBoundedContextIR[] = sys.subdomains
      .flatMap((s) => s.contexts)
      .filter((c) => deployable.contextNames.includes(c.name));
    const ctx: EmitCtx = { deployable, contexts, sys, migrations: [] };
    const agg = contexts[0]!.aggregates.find((a) => a.name === "Project")!;
    const cfg = emitConfiguration(agg, ctx).join("\n");

    // PK + camelCase scalar + enum all carry an explicit snake column name.
    expect(cfg).toContain('.HasColumnName("id")');
    expect(cfg).toContain('builder.Property(x => x.DisplayName).HasColumnName("display_name")');
    expect(cfg).toContain('.HasConversion<string>().HasColumnName("visibility")');
    expect(cfg).toContain('builder.Property(x => x.CreatedAt).HasColumnName("created_at")');
    // Containment FK maps to the migration's `<owner>_id`, not EF's ParentId.
    expect(cfg).toContain('o.Property("ParentId").HasColumnName("project_id")');
    expect(cfg).toContain('o.Property(x => x.RunCount).HasColumnName("run_count")');
    // No column is left at its PascalCase default.
    expect(cfg).not.toMatch(/HasColumnName\("[A-Z]/);
  });
});
