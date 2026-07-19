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
    // No save-path ExecuteAsync may omit the transaction.
    const execCalls = save.slice(0, save.indexOf("PullEvents")).match(/ExecuteAsync\(/g) ?? [];
    const withTx =
      save.slice(0, save.indexOf("PullEvents")).match(/transaction: __tx, cancellationToken/g) ??
      [];
    expect(execCalls.length).toBeGreaterThan(0);
    expect(withTx.length).toBe(execCalls.length);

    // Commit happens before events are dispatched (a rolled-back save must not fire events).
    const commitIdx = save.indexOf("__tx.CommitAsync(cancellationToken)");
    const eventsIdx = save.indexOf("PullEvents");
    expect(commitIdx).toBeGreaterThan(0);
    expect(commitIdx).toBeLessThan(eventsIdx);
  });
});
