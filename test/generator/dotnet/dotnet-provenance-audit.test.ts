// Provenance + per-operation audit runtimes on the .NET backend (provenance.md,
// audit-and-logging.md).  Ported from the Hono runtime: a provenanced field gets
// a co-located `<field>_provenance` column + per-write lineage capture + a
// provenance_records flush in the save transaction + wire-DTO exposure; an
// audited operation appends a who/what/when + before/after audit_records row in
// the same transaction.  This drives the whole `generateSystems` pipeline and
// asserts the emitted C# constructs.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

async function build(source: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(source, { validation: true });
  const lexErrs = doc.parseResult?.lexerErrors ?? [];
  const parseErrs = doc.parseResult?.parserErrors ?? [];
  const diagErrs = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (lexErrs.length || parseErrs.length || diagErrs.length) {
    const lex = lexErrs.map((e) => `LEX ${e.message}`).join("\n");
    const parse = parseErrs.map((e) => `PARSE ${e.message}`).join("\n");
    const diag = diagErrs
      .map((e) => `DIAG ${e.range.start.line + 1}:${e.range.start.character + 1} ${e.message}`)
      .join("\n");
    throw new Error(`parse errors:\n${[lex, parse, diag].filter(Boolean).join("\n")}`);
  }
  return doc.parseResult?.value as Model;
}

const SOURCE = `
system Shop {
  subdomain Core {
    context Ordering {
      aggregate Order ids guid {
        quantity: int
        unitPrice: int
        discount: int
        total: int provenanced
        status: string

        operation reprice(qty: int, price: int) {
          total := qty * price - discount
        }
        operation cancel() audited {
          status := "cancelled"
        }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Ordering, kind: state, use: pg }
  deployable api { platform: dotnet, contexts: [Ordering], dataSources: [ordersState], port: 8080 }
}
`;

async function files(): Promise<Map<string, string>> {
  const model = await build(SOURCE);
  return generateSystems(model).files;
}

describe("dotnet provenance runtime", () => {
  it("emits the shared ProvLineage SDK + provenance_records POCO/configuration", async () => {
    const f = await files();
    const lineage = f.get("api/Domain/Common/ProvLineage.cs")!;
    expect(lineage).toContain("public sealed record ProvLineage(");
    expect(lineage).toContain("public sealed record ProvTarget(string Type, string Field);");
    expect(lineage).toContain("public static class ProvJson");
    expect(f.has("api/Infrastructure/Persistence/ProvenanceRecord.cs")).toBe(true);
    expect(
      f.has("api/Infrastructure/Persistence/Configurations/ProvenanceRecordConfiguration.cs"),
    ).toBe(true);
  });

  it("maps the provenance_records DbSet on AppDbContext", async () => {
    const ctx = (await files()).get("api/Infrastructure/Persistence/AppDbContext.cs")!;
    expect(ctx).toContain(
      "public DbSet<ProvenanceRecord> ProvenanceRecords => Set<ProvenanceRecord>();",
    );
    expect(ctx).toContain("new Configurations.ProvenanceRecordConfiguration()");
  });

  it("gives the aggregate a co-located lineage property + drain buffer", async () => {
    const entity = (await files()).get("api/Domain/Orders/Order.cs")!;
    expect(entity).toContain("public ProvLineage? TotalProvenance { get; private set; }");
    expect(entity).toContain("private readonly List<ProvLineage> _provTraces = new();");
    expect(entity).toContain("public IReadOnlyList<ProvLineage> DrainProv()");
  });

  it("captures lineage at the provenanced write site", async () => {
    const entity = (await files()).get("api/Domain/Orders/Order.cs")!;
    // inputs snapshotted before the write, lineage built + dual-sinked after.
    expect(entity).toMatch(/var __prov_0 = new List<ProvInput> \{/);
    expect(entity).toContain('new ProvLineage("');
    expect(entity).toContain('new ProvTarget("Order", "total")');
    expect(entity).toContain("this.TotalProvenance = __lin_0;");
    expect(entity).toContain("this._provTraces.Add(__lin_0);");
  });

  it("maps the co-located column with a jsonb value-converter", async () => {
    const cfg = (await files()).get(
      "api/Infrastructure/Persistence/Configurations/OrderConfiguration.cs",
    )!;
    expect(cfg).toContain('HasColumnName("total_provenance")');
    expect(cfg).toContain('HasColumnType("jsonb")');
    expect(cfg).toContain("JsonSerializer.Deserialize<ProvLineage>");
  });

  it("flushes the lineage buffer into provenance_records inside the save transaction", async () => {
    const repo = (await files()).get("api/Infrastructure/Repositories/OrderRepository.cs")!;
    expect(repo).toContain("foreach (var __lin in aggregate.DrainProv())");
    expect(repo).toContain("_db.ProvenanceRecords.Add(new ProvenanceRecord");
    // staged BEFORE SaveChangesAsync → same transaction
    expect(repo.indexOf("DrainProv")).toBeLessThan(repo.indexOf("SaveChangesAsync"));
  });

  it("exposes the current lineage on the response DTO", async () => {
    const resp = (await files()).get("api/Application/Orders/Responses/OrderResponses.cs")!;
    expect(resp).toContain("ProvLineage? TotalProvenance");
    expect(resp).toContain("using Api.Domain.Common;");
  });

  it("creates the provenance_records table + co-located column in a migration", async () => {
    const f = await files();
    const key = [...f.keys()].find((k) => /api\/Migrations\/.*ProvenanceAudit\.cs$/.test(k));
    expect(key).toBeDefined();
    const mig = f.get(key!)!;
    expect(mig).toContain("CREATE TABLE IF NOT EXISTS provenance_records");
    // schema-qualified to the resolved dataSource schema (matching ToTable)
    expect(mig).toContain(
      "ALTER TABLE ordering.orders ADD COLUMN IF NOT EXISTS total_provenance jsonb;",
    );
  });
});

describe("dotnet per-operation audit runtime", () => {
  it("emits the audit_records POCO/configuration + the writer seam", async () => {
    const f = await files();
    expect(f.has("api/Infrastructure/Persistence/AuditRecord.cs")).toBe(true);
    expect(f.has("api/Infrastructure/Persistence/Configurations/AuditRecordConfiguration.cs")).toBe(
      true,
    );
    expect(f.has("api/Application/Common/IAuditWriter.cs")).toBe(true);
    expect(f.has("api/Infrastructure/Persistence/AuditWriter.cs")).toBe(true);
  });

  it("maps the audit_records DbSet on AppDbContext", async () => {
    const ctx = (await files()).get("api/Infrastructure/Persistence/AppDbContext.cs")!;
    expect(ctx).toContain("public DbSet<AuditRecord> AuditRecords => Set<AuditRecord>();");
  });

  it("stages a before/after audit record in the audited command handler", async () => {
    const handler = (await files()).get("api/Application/Orders/Commands/CancelHandler.cs")!;
    expect(handler).toContain("var __before = System.Text.Json.JsonSerializer.Serialize(");
    expect(handler).toContain("var __after = System.Text.Json.JsonSerializer.Serialize(");
    expect(handler).toContain("_audit.Stage(new AuditRecord");
    expect(handler).toContain('Action = "cancel"');
    expect(handler).toContain('TargetType = "Order"');
    // staged BEFORE the save → same transaction
    expect(handler.indexOf("_audit.Stage")).toBeLessThan(handler.indexOf("SaveAsync"));
  });

  it("registers the IAuditWriter in Program.cs", async () => {
    const program = (await files()).get("api/Program.cs")!;
    expect(program).toMatch(
      /AddScoped<Api\.Application\.Common\.IAuditWriter, Api\.Infrastructure\.Persistence\.AuditWriter>/,
    );
  });

  it("creates the audit_records table in a migration", async () => {
    const f = await files();
    const key = [...f.keys()].find((k) => /api\/Migrations\/.*ProvenanceAudit\.cs$/.test(k));
    const mig = f.get(key!)!;
    expect(mig).toContain("CREATE TABLE IF NOT EXISTS audit_records");
  });
});
