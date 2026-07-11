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
      aggregate Order {
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
    expect(repo).toContain("var __prov = aggregate.DrainProv();");
    expect(repo).toContain("foreach (var __lin in __prov)");
    expect(repo).toContain("_db.ProvenanceRecords.Add(new ProvenanceRecord");
    // staged BEFORE SaveChangesAsync → same transaction
    expect(repo.indexOf("DrainProv")).toBeLessThan(repo.indexOf("SaveChangesAsync"));
    // provenance_recorded (debug) announced once per non-empty flush
    expect(repo).toContain('_log.LogDebug("{Event} aggregate={Aggregate} count={Count}"');
  });

  it("stamps the request correlation id + scope id + actor id onto each provenance row (M3)", async () => {
    const f = await files();
    const rec = f.get("api/Infrastructure/Persistence/ProvenanceRecord.cs")!;
    expect(rec).toContain("public string? CorrelationId { get; set; }");
    expect(rec).toContain("public string? ScopeId { get; set; }");
    expect(rec).toContain("public string? ActorId { get; set; }");
    expect(rec).toContain("public string? ParentId { get; set; }");
    const cfg = f.get(
      "api/Infrastructure/Persistence/Configurations/ProvenanceRecordConfiguration.cs",
    )!;
    expect(cfg).toContain('HasColumnName("correlation_id")');
    expect(cfg).toContain('HasColumnName("scope_id")');
    expect(cfg).toContain('HasColumnName("actor_id")');
    expect(cfg).toContain('HasColumnName("parent_id")');
    const repo = f.get("api/Infrastructure/Repositories/OrderRepository.cs")!;
    expect(repo).toContain("CorrelationId = RequestContext.Current?.CorrelationId,");
    expect(repo).toContain("ScopeId = RequestContext.Current?.ScopeId,");
    // The carrier's who-computed slice (provenance.md / request-context.md).
    expect(repo).toContain("ActorId = RequestContext.Current?.ActorId,");
    // The call-structure position — the caller frame's scope id (request-context.md).
    expect(repo).toContain("ParentId = RequestContext.Current?.ParentId,");
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
    expect(mig).toMatch(
      /provenance_records \([\s\S]*?correlation_id text,[\s\S]*?scope_id text,[\s\S]*?actor_id text,[\s\S]*?parent_id text/,
    );
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
    // audit_recorded (debug) announced after the stage; ILogger injected
    expect(handler).toContain("private readonly ILogger<CancelHandler> _log;");
    expect(handler).toContain(
      '_log.LogDebug("{Event} action={Action} target={Target} actor={Actor}", "audit_recorded", "cancel", "Order", RequestContext.Current?.PrincipalJson());',
    );
  });

  it("stamps actor + correlation id + scope id from the ambient RequestContext (M3)", async () => {
    const f = await files();
    const rec = f.get("api/Infrastructure/Persistence/AuditRecord.cs")!;
    expect(rec).toContain("public string? CorrelationId { get; set; }");
    expect(rec).toContain("public string? ScopeId { get; set; }");
    expect(rec).toContain("public string? ParentId { get; set; }");
    const cfg = f.get("api/Infrastructure/Persistence/Configurations/AuditRecordConfiguration.cs")!;
    expect(cfg).toContain('HasColumnName("correlation_id")');
    expect(cfg).toContain('HasColumnName("scope_id")');
    expect(cfg).toContain('HasColumnName("parent_id")');
    const handler = f.get("api/Application/Orders/Commands/CancelHandler.cs")!;
    expect(handler).toContain("Actor = RequestContext.Current?.PrincipalJson(),");
    expect(handler).toContain("CorrelationId = RequestContext.Current?.CorrelationId,");
    expect(handler).toContain("ScopeId = RequestContext.Current?.ScopeId,");
    // The call-structure position — the caller frame's scope id (request-context.md).
    expect(handler).toContain("ParentId = RequestContext.Current?.ParentId,");
    expect(handler).toContain("using Api.Domain.Common;");
  });

  it("forces the ambient carrier to exist even with no auth + no trace (gate widen, M3)", async () => {
    // SOURCE has audited + provenanced but no `auth: required` and no --trace,
    // yet audit/provenance need RequestContext.Current to stamp correlation —
    // so the carrier + boundary middleware are now emitted.
    const f = await files();
    const rc = f.get("api/Domain/Common/RequestContext.cs")!;
    expect(rc).toContain("public sealed class RequestContext");
    expect(f.has("api/Middleware/RequestContextMiddleware.cs")).toBe(true);
    // No auth → no principal slice, so PrincipalJson is the null-returning form.
    expect(rc).toContain("public string? PrincipalJson() => null;");
    expect(rc).not.toContain("public User? CurrentUser");
  });

  it("opens a per-dispatch frame for audit/provenance even with no --trace (parentId enablement)", async () => {
    // The frame opener used to be --trace-only, so without it audit/provenance
    // rows all read the ROOT frame (degenerate scope id, null parent id).  It
    // is now emitted + registered whenever audit/provenance is present, so each
    // dispatch gets its own child frame and parentId chains to the caller.
    const f = await files();
    const behavior = f.get("api/Application/Common/ExecutionContextBehavior.cs");
    expect(behavior).toBeDefined();
    // It opens a child frame under the caller (root when none is active).
    expect(behavior!).toContain("var parent = RequestContext.Current;");
    expect(behavior!).toContain("RequestContext.OpenChild(parent)");
    expect(behavior!).toContain("RequestContext.OpenRoot(");
    expect(behavior!).toContain("using (RequestContext.Enter(frame))");
    // No --trace → the logger-less variant: no ILogger dependency, no logger
    // scope, no DomainLog shim.  Just the frame opener.
    expect(behavior!).not.toContain("ILogger");
    expect(behavior!).not.toContain("frame.Logger");
    expect(behavior!).not.toContain("BeginScope");
    expect(f.has("api/Domain/Common/DomainLog.cs")).toBe(false);
    // Registered in the Mediator pipeline so it actually runs per dispatch.
    const program = f.get("api/Program.cs")!;
    expect(program).toContain("typeof(Api.Application.Common.ExecutionContextBehavior<,>));");
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
    expect(mig).toMatch(
      /audit_records \([\s\S]*?correlation_id text,[\s\S]*?scope_id text,[\s\S]*?parent_id text/,
    );
  });
});

// An audited op invoked inline in a workflow step produced no audit row — only
// the per-operation command handler stages one, and a workflow calls ops
// directly.  The workflow handler now stages it too (the sibling of the Hono
// gap).  Provenance needs nothing here: its flush lives in repo.SaveAsync, so a
// workflow's saves already capture it — unlike audit, which the handler stages.
const WF_SOURCE = `
system Shop {
  subdomain Core {
    context Ordering {
      aggregate Cart {
        label: string
        status: string
        operation close() audited { status := "closed" }
        operation rename(to: string) { label := to }
      }
      repository Carts for Cart { }
      workflow buildCart {
        create(name: string) {
          let cart = Cart.create({ label: name, status: "open" })
          cart.rename(name)
          cart.close()
        }
      }
    }
  }
  storage pg { type: postgres }
  resource cartState { for: Ordering, kind: state, use: pg }
  deployable api { platform: dotnet, contexts: [Ordering], dataSources: [cartState], port: 8080 }
}
`;

describe("dotnet workflow audit", () => {
  async function wfHandler(source = WF_SOURCE): Promise<string> {
    const model = await build(source);
    const files = generateSystems(model).files;
    const key = [...files.keys()].find((k) => /Application\/Workflows\/.*Handler\.cs$/.test(k))!;
    return files.get(key)!;
  }

  it("stages an audit row for an audited op invoked inline in a workflow", async () => {
    const h = await wfHandler();
    // The handler injects the audit writer + stages a record bracketed by
    // before/after wire snapshots, mirroring the per-operation command handler.
    expect(h).toContain("private readonly IAuditWriter _audit;");
    expect(h).toContain(
      "public BuildCartHandler(ICartRepository carts, ILogger<BuildCartHandler> log, IAuditWriter audit)",
    );
    expect(h).toContain("var __wfAuditBefore0 = System.Text.Json.JsonSerializer.Serialize(");
    expect(h).toContain("var __wfAuditAfter0 = System.Text.Json.JsonSerializer.Serialize(");
    expect(h).toContain("_audit.Stage(new AuditRecord");
    expect(h).toContain('Action = "close",');
    expect(h).toContain('TargetType = "Cart",');
    expect(h).toContain("TargetId = cart.Id.Value.ToString(),");
    expect(h).toContain("Actor = RequestContext.Current?.PrincipalJson(),");
    // The carrier already opened a child frame for the workflow dispatch, so
    // the row's scope / parent ids come from it.
    expect(h).toContain("ParentId = RequestContext.Current?.ParentId,");
    // Staged before the save so it commits in the same SaveChangesAsync.
    expect(h.indexOf("_audit.Stage")).toBeLessThan(h.indexOf("SaveAsync"));
    // Only the audited op (close) is instrumented — the plain `rename` is a
    // bare call (one audit Stage total).
    expect(h.match(/_audit\.Stage\(/g)).toHaveLength(1);
    expect(h).toContain("cart.Rename(command.Name);");
  });

  it("no duplicate using directives (CS0105 would fail /warnaserror)", async () => {
    const usings = (await wfHandler()).split("\n").filter((l) => l.startsWith("using "));
    expect(usings).toHaveLength(new Set(usings).size);
  });

  it("leaves audit-free workflows without an audit writer or stage", async () => {
    const src = WF_SOURCE.replace("audited ", "");
    const h = await wfHandler(src);
    expect(h).not.toContain("IAuditWriter");
    expect(h).not.toContain("_audit.Stage");
  });
});
