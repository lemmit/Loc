// Dapper `SaveAsync` writes the whole aggregate as ONE transaction.
//
// From `docs/audits/repo-code-review-2026-07.md` T3: the Dapper repository's
// SaveAsync ran the root upsert, the join-table full-list replace (DELETE then
// per-row INSERT), the containment-tree replace, and the provenance flush as
// SEPARATE autocommit statements on one connection — with no transaction.  A
// crash between a full-list-replace DELETE and its re-INSERT permanently lost
// the aggregate's children/associations.  The EF path is atomic via SaveChanges
// and the Hono path via `db.transaction`; this pins the Dapper path to match.

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
  const diagErrs = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (diagErrs.length) {
    throw new Error(
      `parse errors:\n${diagErrs.map((e) => `${e.range.start.line + 1}:${e.range.start.character + 1} ${e.message}`).join("\n")}`,
    );
  }
  return doc.parseResult?.value as Model;
}

// A Dapper aggregate that BOTH contains parts (a child table) AND carries an
// `X id[]` reference collection (a join table) — the two full-list-replace
// write paths that lose data without a transaction.
const SOURCE = `
system Shop {
  api OrdersApi from Sales
  subdomain Sales {
    context Orders {
      aggregate Tag with crudish { label: string }
      aggregate Order with crudish {
        customer: string
        tags: Tag id[]
        contains lineItems: LineItem[]
        entity LineItem { sku: string qty: int }
      }
      repository Orders for Order { }
      repository Tags for Tag { }
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api {
    platform: dotnet { persistence: dapper }
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 8080
  }
}`;

describe("Dapper SaveAsync is transactional", () => {
  it("begins a transaction, threads it through every write, and commits before events", async () => {
    const files = generateSystems(await build(SOURCE)).files;
    const repo = files.get("api/Infrastructure/Repositories/OrderRepository.cs")!;
    expect(repo).toBeDefined();

    const save = repo.slice(repo.indexOf("public async Task SaveAsync"));

    // A transaction opens right after the connection.
    expect(save).toContain(
      "await using var __tx = await conn.BeginTransactionAsync(cancellationToken);",
    );

    // Every write in the save path is enrolled in it — the root upsert, the
    // join-table DELETE + INSERT, and the containment DELETE + INSERT.
    expect(save).toContain("DELETE FROM order_tags");
    expect(save).toContain("DELETE FROM line_items");
    // No save-path ExecuteAsync may omit the transaction.  The cut is the
    // outbox-capture call (`RecordDurableAsync`), which is the last statement
    // before the commit — `PullEvents` used to mark that boundary, but the
    // transactional-outbox fix moved the drain to just BEFORE the commit so the
    // durable rows can be written on `__tx` (dispatch-delivery-semantics.md §1).
    const cut = save.indexOf("RecordDurableAsync");
    expect(cut).toBeGreaterThan(0);
    const execCalls = save.slice(0, cut).match(/ExecuteAsync\(/g) ?? [];
    const withTx = save.slice(0, cut).match(/transaction: __tx, cancellationToken/g) ?? [];
    expect(execCalls.length).toBeGreaterThan(0);
    expect(withTx.length).toBe(execCalls.length);

    // The durable-outbox capture is handed `__tx` and runs BEFORE the commit, so
    // an owed event's row commits with the aggregate write.
    expect(save).toContain(
      "var __deferred = await _events.RecordDurableAsync(__pending, __tx, cancellationToken);",
    );
    const commitIdx = save.indexOf("__tx.CommitAsync(cancellationToken)");
    expect(cut).toBeLessThan(commitIdx);

    // Commit happens before events are dispatched (a rolled-back save must not fire events).
    const eventsIdx = save.indexOf("_events.DispatchAsync");
    expect(commitIdx).toBeGreaterThan(0);
    expect(commitIdx).toBeLessThan(eventsIdx);
  });

  // T3 fixed the SAVE path and left the DELETE path behind: `DeleteAsync` drops
  // the join table, then the child tables, then the root — three autocommitted
  // statements, so a crash between them left the root alive with its children
  // already gone.  Same data-loss class, same fix.
  it("DeleteAsync is transactional too when it issues more than one statement", async () => {
    const files = generateSystems(await build(SOURCE)).files;
    const repo = files.get("api/Infrastructure/Repositories/OrderRepository.cs")!;
    const del = repo.slice(repo.indexOf("public async Task DeleteAsync"));
    const body = del.slice(0, del.indexOf("\n    }"));

    expect(body).toContain(
      "await using var __tx = await conn.BeginTransactionAsync(cancellationToken);",
    );
    // The join table, the child table and the root all ride the transaction.
    expect(body).toContain("DELETE FROM order_tags");
    expect(body).toContain("DELETE FROM line_items");
    expect(body).toContain("DELETE FROM orders");
    const execs = body.match(/ExecuteAsync\(/g) ?? [];
    const withTx = body.match(/transaction: __tx, cancellationToken/g) ?? [];
    expect(execs.length).toBeGreaterThan(1);
    expect(withTx.length).toBe(execs.length);
    expect(body).toContain("__tx.CommitAsync(cancellationToken)");
  });

  // Strict additivity: an aggregate with no children and no associations still
  // deletes in ONE statement, so it must not grow a transaction it can't use.
  it("a single-statement delete stays transaction-free", async () => {
    const files = generateSystems(await build(SOURCE)).files;
    const repo = files.get("api/Infrastructure/Repositories/TagRepository.cs")!;
    const del = repo.slice(repo.indexOf("public async Task DeleteAsync"));
    const body = del.slice(0, del.indexOf("\n    }"));

    expect(body).toContain("DELETE FROM tags");
    expect(body).not.toContain("BeginTransactionAsync");
    expect(body).not.toContain("transaction: __tx");
  });
});
