// dapper — minimal-v1 PersistenceAdapter for dotnet (D-REALIZATION-AXES Phase
// 5c).  `persistence: dapper` emits an Npgsql/Dapper Infrastructure (repository,
// DbSchema, connection wiring, deps) reusing the persistence-agnostic Domain
// layer, and the validator gates the unsupported feature surface.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { dapperPersistenceAdapter } from "../../src/generator/dotnet/adapters/dapper-persistence.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { resolvePersistence } from "../../src/platform/resolve-adapters.js";
import { generateSystems } from "../../src/system/index.js";

/** Lower + enrich + run BOTH the Langium parse diagnostics and the IR-level
 *  validator (where `loom.dapper-unsupported` lives), then emit. */
async function emit(src: string): Promise<{ files: Map<string, string>; errors: string[] }> {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(src, { validation: true });
  const parseErrors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
  const irErrors = validateLoomModel(loom)
    .filter((d) => d.severity === "error")
    .map((d) => d.message);
  const errors = [...parseErrors, ...irErrors];
  if (errors.length > 0) return { files: new Map(), errors };
  return { files: generateSystems(doc.parseResult.value as Model).files, errors };
}

const sys = (deployable: string, body = "") => `
system D {
  api A from S
  subdomain S {
    context O {
      enum Status { Draft, Confirmed }
      valueobject Money { amount: int  currency: string }
      aggregate Order with crudish {
        customer: string
        status:   Status
        total:    Money
        note:     string?
        ${body}
      }
      repository Orders for Order {
        find byCustomer(customer: string): Order[] where this.customer == customer
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: dotnet { persistence: ${deployable} }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

describe("dapper persistence adapter — dotnet (Phase 5c)", () => {
  it("is registered as a real persistence adapter", () => {
    expect(resolvePersistence("dotnet", "dapper")).toBe(dapperPersistenceAdapter);
    expect(dapperPersistenceAdapter.name).toBe("dapper");
    expect(dapperPersistenceAdapter.supportedShapes).toEqual(["relational"]);
    expect(dapperPersistenceAdapter.supportedStrategies).toEqual(["state"]);
  });

  it("emits a Dapper Infrastructure instead of EF Core", async () => {
    const { files, errors } = await emit(sys("dapper"));
    expect(errors).toEqual([]);
    // Dapper schema bootstrap replaces the EF DbContext + migrations.
    expect(files.has("api/Infrastructure/Persistence/DbSchema.cs")).toBe(true);
    expect(files.has("api/Infrastructure/Persistence/AppDbContext.cs")).toBe(false);
    const repo = files.get("api/Infrastructure/Repositories/OrderRepository.cs")!;
    expect(repo).toContain("private readonly NpgsqlDataSource _db;");
    expect(repo).toContain("Order._Create(new Order.State"); // hydration seam
    expect(repo).toContain("ON CONFLICT (id) DO UPDATE SET"); // upsert
    expect(repo).toContain("WHERE (customer = @customer)"); // find → SQL
    expect(repo).not.toContain("AppDbContext"); // no EF
    // schema DDL + Npgsql/Dapper deps + connection wiring.
    expect(files.get("api/Infrastructure/Persistence/DbSchema.cs")).toContain(
      "CREATE TABLE IF NOT EXISTS orders",
    );
    expect(files.get("api/Api.csproj")).toContain('Include="Dapper"');
    expect(files.get("api/Api.csproj")).not.toContain("EntityFrameworkCore");
    expect(files.get("api/Program.cs")).toContain("DbSchema.EnsureAsync");
  });

  it("the efcore default is unchanged (EF DbContext, no DbSchema)", async () => {
    const { files, errors } = await emit(sys("efcore"));
    expect(errors).toEqual([]);
    expect(files.has("api/Infrastructure/Persistence/AppDbContext.cs")).toBe(true);
    expect(files.has("api/Infrastructure/Persistence/DbSchema.cs")).toBe(false);
  });
});

describe("dapper capability gating (loom.dapper-unsupported)", () => {
  const rejects = async (body: string, needle: RegExp) => {
    const { errors } = await emit(sys("dapper", body));
    expect(errors.some((e) => /persistence: dapper/.test(e) && needle.test(e))).toBe(true);
  };

  it("rejects a provenanced field", () => rejects("provenanced score: int", /provenanced/));
  it("rejects a non-relational saving shape (shape(document))", async () => {
    const src = `
      system D {
        api A from S
        subdomain S { context O {
          aggregate Cart shape(document) with crudish { customer: string }
          repository Carts for Cart { }
        } }
        storage pg { type: postgres }  resource s { for: O, kind: state, use: pg }
        deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 } }`;
    const { errors } = await emit(src);
    expect(errors.some((e) => /persistence: dapper/.test(e) && /shape\(document\)/.test(e))).toBe(
      true,
    );
  });

  it("accepts the supported subset (scalar / enum / VO / optional)", async () => {
    const { errors } = await emit(sys("dapper"));
    expect(errors).toEqual([]);
  });
});
