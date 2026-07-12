// Hono emission for audited LIFECYCLE actions (`create(...) audited` /
// `destroy audited`).  Reuses the per-operation `audit_records` sink, adapting
// the before/after pair to the lifecycle asymmetry:
//   - create → `before: null`, `after = repoTx.toWire(created)`, keyed by the
//     generated id, staged AFTER the insert, in the save transaction.
//   - destroy → `before = repoTx.toWire(loaded)`, `after: null`, written BEFORE
//     `repoTx.delete`, in the same transaction (a failed delete must roll back
//     the spurious audit row).
// Soft-delete is not a fork here: the canonical `destroy` route is always a hard
// delete, so `after` is always null.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Invoicing {
    aggregate Invoice ids guid {
      total: money
      create(total: money) audited { total := total }
      destroy audited { }
    }
    repository Invoices for Invoice { }
  }
`;

async function routes(): Promise<string> {
  return generateHono(await parseValid(SRC)).get("http/invoice.routes.ts")!;
}

describe("hono routes — audited lifecycle actions", () => {
  it("threads db + events into the router (transactional signature)", async () => {
    const r = await routes();
    expect(r).toContain(
      "export function invoiceRoutes(repo: InvoiceRepository, db: NodePgDatabase<typeof schema>, events: DomainEventDispatcher): OpenAPIHono {",
    );
    expect(r).toContain('import * as schema from "../db/schema";');
    expect(r).toContain('import { randomUUID } from "node:crypto";');
  });

  it("audits the create with before:null and after=wire(created) inside the tx", async () => {
    const r = await routes();
    expect(r).toContain("const created = Invoice.create({ total: body.total });");
    expect(r).toContain("await db.transaction(async (tx) => {");
    expect(r).toContain("const repoTx = new InvoiceRepository(tx, events);");
    expect(r).toContain("await repoTx.save(created);");
    expect(r).toContain("await tx.insert(schema.auditRecords).values({");
    expect(r).toContain('action: "create",');
    expect(r).toContain("targetId: created.id as string,");
    expect(r).toContain("before: null,");
    expect(r).toContain("after: repoTx.toWire(created),");
  });

  it("audits the destroy with before=wire(loaded) and after:null before delete", async () => {
    const r = await routes();
    expect(r).toContain("const loaded = await repoTx.getById(Ids.InvoiceId(id));");
    expect(r).toContain("const before = repoTx.toWire(loaded);");
    expect(r).toContain('action: "destroy",');
    expect(r).toContain("before,");
    expect(r).toContain("after: null,");
    // The audit row is written BEFORE the hard delete (last trace).
    const auditIdx = r.indexOf('action: "destroy"');
    const deleteIdx = r.indexOf("await repoTx.delete(Ids.InvoiceId(id));");
    expect(auditIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(auditIdx);
    // 409 FK-violation mapping is preserved on the audited destroy path.
    expect(r).toContain(
      'if (err && typeof err === "object" && (((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code) === "23503")) {',
    );
  });

  it("stamps actor + correlation/scope/parent like the per-op path", async () => {
    const r = await routes();
    expect(r).toContain(
      'const actor = (c as unknown as { get(k: "currentUser"): unknown }).get("currentUser") ?? null;',
    );
    expect(r).toContain("const reqCtx = requestContext();");
    expect(r).toContain("correlationId: reqCtx?.correlationId ?? null,");
    expect(r).toContain("scopeId: reqCtx?.scopeId ?? null,");
    expect(r).toContain("parentId: reqCtx?.parentId ?? null,");
  });

  it("emits the audit_records table when ONLY lifecycle actions are audited", async () => {
    const files = generateHono(await parseValid(SRC));
    const schema = files.get("db/schema.ts")!;
    expect(schema).toContain('pgTable("audit_records"');
  });

  it("announces audit_recorded (debug) after each audit insert", async () => {
    const r = await routes();
    expect(r).toContain(
      '.debug({ event: "audit_recorded", action: "create", target: "Invoice", actor });',
    );
    expect(r).toContain(
      '.debug({ event: "audit_recorded", action: "destroy", target: "Invoice", actor });',
    );
  });
});
