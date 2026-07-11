// Provenance runtime on the Java / Spring backend (provenance.md).  Ported from
// the Hono / .NET runtime: a provenanced field gets a co-located
// `<field>_provenance` jsonb column + per-write lineage capture + a
// provenance_records flush in the @Transactional save + wire-DTO exposure.
// This drives the whole `generateSystems` pipeline and asserts the emitted
// Java constructs.  Mirror of test/generator/dotnet/dotnet-provenance-audit.test.ts.

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
        operation cancel() {
          status := "cancelled"
        }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Ordering, kind: state, use: pg }
  deployable api { platform: java, contexts: [Ordering], dataSources: [ordersState], port: 8080 }
}
`;

let cache: Map<string, string> | undefined;
async function files(): Promise<Map<string, string>> {
  if (cache) return cache;
  const model = await build(SOURCE);
  cache = generateSystems(model).files;
  return cache;
}

/** The single emitted Java file whose path ends with `<name>` (the layout
 *  adapter owns the package directory, so match on the leaf). */
async function file(name: string): Promise<string> {
  const f = await files();
  const key = [...f.keys()].find((k) => k.endsWith(name));
  expect(key, `expected an emitted file ending '${name}'`).toBeDefined();
  return f.get(key!)!;
}

describe("java provenance runtime", () => {
  it("emits the shared ProvLineage SDK records", async () => {
    const lineage = await file("/domain/common/ProvLineage.java");
    expect(lineage).toContain("public record ProvLineage(");
    expect(lineage).toContain("String snapshotId,");
    expect(lineage).toContain("ProvTarget target,");
    expect(lineage).toContain("List<ProvInput> inputs,");
    const target = await file("/domain/common/ProvTarget.java");
    expect(target).toContain("public record ProvTarget(String type, String field)");
    const input = await file("/domain/common/ProvInput.java");
    expect(input).toContain("public record ProvInput(String path, Object value)");
  });

  it("emits the provenance_records JPA entity + Spring Data repository", async () => {
    const entity = await file("/infrastructure/persistence/ProvenanceRecord.java");
    expect(entity).toContain("@Entity");
    expect(entity).toContain('@Table(name = "provenance_records")');
    expect(entity).toContain('@Column(name = "trace_id")');
    expect(entity).toContain("@JdbcTypeCode(SqlTypes.JSON)");
    const repo = await file("/infrastructure/persistence/ProvenanceRecordRepository.java");
    expect(repo).toContain(
      "interface ProvenanceRecordRepository extends JpaRepository<ProvenanceRecord, String>",
    );
  });

  it("gives the aggregate a co-located jsonb lineage field + drain buffer", async () => {
    const entity = await file("/Order.java");
    expect(entity).toContain("@JdbcTypeCode(SqlTypes.JSON)");
    expect(entity).toContain('@Column(name = "total_provenance")');
    expect(entity).toContain("ProvLineage totalProvenance;");
    expect(entity).toContain(
      "private final transient List<ProvLineage> _provTraces = new ArrayList<>();",
    );
    expect(entity).toContain("public List<ProvLineage> drainProv() {");
  });

  it("captures lineage at the provenanced write site", async () => {
    const entity = await file("/Order.java");
    // inputs snapshotted before the write, lineage built + dual-sinked after.
    expect(entity).toMatch(/var __prov_\d+ = java\.util\.List\.<ProvInput>of\(/);
    expect(entity).toContain('new ProvInput("qty", qty)');
    expect(entity).toContain('new ProvTarget("Order", "total")');
    expect(entity).toMatch(/this\.totalProvenance = __lin_\d+;/);
    expect(entity).toMatch(/this\._provTraces\.add\(__lin_\d+\);/);
    // The snapshotId is IR-sourced (the content hash), not invented per backend.
    expect(entity).toMatch(/new ProvLineage\("[0-9a-f]+", new ProvTarget/);
  });

  it("flushes the lineage buffer into provenance_records inside the @Transactional save", async () => {
    const repo = await file("/OrderRepositoryImpl.java");
    expect(repo).toContain("@Transactional");
    expect(repo).toContain("var __prov = aggregate.drainProv();");
    expect(repo).toContain("for (var __lin : __prov) {");
    expect(repo).toContain("provenanceRecords.save(new ProvenanceRecord(");
    // provenance_recorded (debug) announced once per non-empty flush
    expect(repo).toContain(
      'CatalogLog.event("provenance_recorded", "debug", "aggregate", "Order", "count", __prov.size());',
    );
    // drained AFTER the jpa.save (same @Transactional method) and stamped with
    // the ambient request-context ids.
    expect(repo).toContain("RequestContext.correlationId()");
    expect(repo).toContain("RequestContext.scopeId()");
    expect(repo).toContain("RequestContext.actorId()");
    expect(repo).toContain("RequestContext.parentId()");
    expect(repo.indexOf("jpa.save(aggregate)")).toBeLessThan(repo.indexOf("drainProv"));
  });

  it("exposes the current lineage on the response DTO", async () => {
    const resp = await file("/OrderResponse.java");
    expect(resp).toContain("import com.loom.api.domain.common.ProvLineage;");
    expect(resp).toContain("ProvLineage totalProvenance)");
    expect(resp).toContain("value.totalProvenance()");
  });

  it("creates the provenance_records table + co-located column in a late migration", async () => {
    const f = await files();
    const key = [...f.keys()].find((k) => /db\/migration\/V\d+\.\d+__Provenance\.sql$/.test(k));
    expect(key).toBeDefined();
    const mig = f.get(key!)!;
    expect(mig).toContain("CREATE TABLE IF NOT EXISTS provenance_records");
    expect(mig).toMatch(
      /provenance_records \([\s\S]*?correlation_id text,[\s\S]*?scope_id text,[\s\S]*?actor_id text,[\s\S]*?parent_id text/,
    );
    // schema-qualified to the resolved dataSource schema (matching the JPA @Table).
    expect(mig).toContain(
      "ALTER TABLE ordering.orders ADD COLUMN IF NOT EXISTS total_provenance jsonb;",
    );
  });
});

describe("java provenance — no-op without a provenanced field", () => {
  const PLAIN = SOURCE.replace("total: int provenanced", "total: int");

  it("keeps the SDK + flush + migration absent", async () => {
    const model = await build(PLAIN);
    const f = generateSystems(model).files;
    expect([...f.keys()].some((k) => k.endsWith("/domain/common/ProvLineage.java"))).toBe(false);
    expect([...f.keys()].some((k) => /V\d+\.\d+__Provenance\.sql$/.test(k))).toBe(false);
    const repo = f.get([...f.keys()].find((k) => k.endsWith("/OrderRepositoryImpl.java"))!)!;
    expect(repo).not.toContain("drainProv");
    expect(repo).not.toContain("provenanceRecords");
  });
});
