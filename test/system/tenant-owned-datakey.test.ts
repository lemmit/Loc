// The `tenantOwned` capability's `dataKey` column (multi-tenancy Phase 2, plan
// P2.3 — docs/plans/multi-tenancy-phase2.md).  Extends the Phase 1a `tenantId`
// shape with a second managed column: the materialized DataKey path, stamped
// from `currentUser.orgPath` on create.  Unlike the `tenantRegistry`
// capability's OWN `dataKey` (test/system/tenant-registry-tree.test.ts —
// managed, stays ON the read wire), this `dataKey` is a **persistence-only**
// column (`authorization.md §2`): it flows through migrations + the create
// factory exactly like `tenantId`, but is dropped from `wireShape` entirely —
// never serialized to any client, not even as a masked/internal field.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const SRC = `
  system Billder {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Organization
    subdomain Platform {
      context Accounts {
        aggregate Invoice with tenantOwned {
          number: string
        }
        aggregate Organization ids guid { name: string }
        repository Invoices for Invoice { }
        repository Organizations for Organization { }
      }
    }
    api PlatformApi from Platform
    storage primary { type: postgres }
    resource accountsState { for: Accounts, kind: state, use: primary }
    deployable api {
      platform: node
      contexts: [Accounts]
      dataSources: [accountsState]
      serves: PlatformApi
      port: 3001
      auth: required
    }
  }
`;

describe("tenantOwned — dataKey column flows through migrations + the create factory", () => {
  it("emits a nullable `data_key` text column + the P2.5 `text_pattern_ops` prefix index", async () => {
    const files = await generateSystemFiles(SRC);
    const sql = [...files.entries()].find(
      ([p]) => p.endsWith(".sql") && p.includes("migrations"),
    )?.[1];
    expect(sql).toBeDefined();
    expect(sql!).toContain(`"tenant_id" TEXT NOT NULL`);
    expect(sql!).toContain(`"data_key" TEXT NULL`);
    // P2.5: the materialized-path prefix index — `text_pattern_ops` opclass so
    // `LIKE 'prefix.%'` (deep/global) is index-usable under any collation.
    expect(sql!).toMatch(
      /CREATE INDEX "?invoices_data_key_idx"? ON \S+ \("?data_key"? text_pattern_ops\)/,
    );
    expect(sql!).not.toMatch(/CREATE UNIQUE INDEX "?invoices_data_key_idx"?/);
  });

  it("drizzle schema carries both columns", async () => {
    const files = await generateSystemFiles(SRC);
    const schema = files.get("api/db/schema.ts")!;
    expect(schema).toContain(`tenantId: text("tenant_id")`);
    expect(schema).toContain(`dataKey: text("data_key")`);
  });

  it("`dataKey` stays off the create factory (internal, like `tenantId`)", async () => {
    const files = await generateSystemFiles(SRC);
    const domain = files.get("api/domain/invoice.ts")!;
    expect(domain).toMatch(/static create\(input: \{ number: string \}\)/);
    expect(domain).not.toMatch(/static create\(input:[^)]*dataKey/);
    expect(domain).not.toMatch(/static create\(input:[^)]*tenantId/);
  });

  it("`dataKey := currentUser.orgPath` stamps at create, beside `tenantId := currentUser.tenantId`", async () => {
    const files = await generateSystemFiles(SRC);
    const helper = files.get("api/db/audit-stamp.ts")!;
    expect(helper).toContain("tenantId: currentUser.tenantId");
    expect(helper).toContain("dataKey: currentUser.orgPath");
  });

  it("`dataKey` is dropped from `.loom/wire-spec.json` entirely; `tenantId` stays present (internal)", async () => {
    const files = await generateSystemFiles(SRC);
    const wireSpec = JSON.parse(files.get(".loom/wire-spec.json")!);
    const invoiceProps = Object.keys(wireSpec.aggregates.Invoice.properties);
    expect(invoiceProps).toContain("tenantId");
    expect(invoiceProps).not.toContain("dataKey");
  });

  it("`dataKey` never reaches the read wire (unlike the registry's own managed `dataKey`)", async () => {
    const files = await generateSystemFiles(SRC);
    const routes = files.get("api/http/invoice.routes.ts")!;
    expect(routes).not.toMatch(/dataKey/);
  });
});
