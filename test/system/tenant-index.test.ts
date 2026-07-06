// Derived `tenant_id` read index (docs/tenancy.md, 1b-tail): every
// `tenantOwned` aggregate's generated reads prefix on `tenant_id = <claim>`,
// so the MigrationsIR builder derives a non-unique `<table>_tenant_id_idx` on
// any of the aggregate's tables that physically carries the column.  The
// registry (id-keyed) and document/eventLog shapes (field lives in the
// blob/stream, no column) get none.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const tenancySystem = (aggregates: string) => `
  system Shop {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Organization
    subdomain Sales {
      context Ordering {
        ${aggregates}
        aggregate Organization ids guid { name: string }
      }
    }
    api SalesApi from Sales
    storage primarySql { type: postgres }
    resource ordState { for: Ordering, kind: state, use: primarySql }
    deployable api {
      platform: node
      contexts: [Ordering]
      dataSources: [ordState]
      serves: SalesApi
      port: 3001
      auth: required
    }
  }
`;

const sqlOf = (files: Map<string, string>): string =>
  [...files.entries()]
    .filter(([p]) => p.endsWith(".sql"))
    .map(([, c]) => c)
    .join("\n");

describe("tenantOwned → derived tenant_id index DDL", () => {
  it("derives a non-unique `<table>_tenant_id_idx` on a tenantOwned aggregate", async () => {
    const files = await generateSystemFiles(
      tenancySystem(`aggregate Invoice ids guid with tenantOwned { number: string }`),
    );
    const sql = sqlOf(files);
    expect(sql).toMatch(/CREATE INDEX "?invoices_tenant_id_idx"? ON \S+ \("?tenant_id"?\)/);
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX "?invoices_tenant_id_idx"?/);
  });

  it("derives none for the registry or a crossTenant aggregate (no tenant_id column)", async () => {
    const files = await generateSystemFiles(
      tenancySystem(
        `aggregate Invoice ids guid with tenantOwned { number: string }
         aggregate Plan ids guid crossTenant { code: string }`,
      ),
    );
    const sql = sqlOf(files);
    expect(sql).not.toMatch(/organizations_tenant_id_idx/);
    expect(sql).not.toMatch(/plans_tenant_id_idx/);
  });

  it("rides MigrationsIR into the Ecto migration on the elixir backend", async () => {
    const files = await generateSystemFiles(
      tenancySystem(`aggregate Invoice ids guid with tenantOwned { number: string }`).replace(
        "platform: node",
        "platform: elixir",
      ),
    );
    const exs = [...files.entries()]
      .filter(([p]) => p.endsWith(".exs"))
      .map(([, c]) => c)
      .join("\n");
    expect(exs).toMatch(/create index\(:invoices, \[:tenant_id\]/);
  });

  it("derives a `<table>_data_key_idx` with `text_pattern_ops` on a tenantOwned aggregate (P2.5)", async () => {
    const files = await generateSystemFiles(
      tenancySystem(`aggregate Invoice ids guid with tenantOwned { number: string }`),
    );
    const sql = sqlOf(files);
    // The materialized-path prefix index — `text_pattern_ops` makes a
    // `LIKE 'prefix.%'` (deep/global) scan index-usable under any locale.
    expect(sql).toMatch(
      /CREATE INDEX "?invoices_data_key_idx"? ON \S+ \("?data_key"? text_pattern_ops\)/,
    );
  });

  it("derives no data_key index for the registry / a crossTenant aggregate", async () => {
    const files = await generateSystemFiles(
      tenancySystem(
        `aggregate Invoice ids guid with tenantOwned { number: string }
         aggregate Plan ids guid crossTenant { code: string }`,
      ),
    );
    const sql = sqlOf(files);
    // Only the tenantOwned aggregate carries a data_key column; the id-keyed
    // registry (read by id) and crossTenant shared data get none.
    expect(sql).not.toMatch(/organizations_data_key_idx/);
    expect(sql).not.toMatch(/plans_data_key_idx/);
  });

  it("rides the data_key `text_pattern_ops` index into the Ecto migration (fragment column form)", async () => {
    const files = await generateSystemFiles(
      tenancySystem(`aggregate Invoice ids guid with tenantOwned { number: string }`).replace(
        "platform: node",
        "platform: elixir",
      ),
    );
    const exs = [...files.entries()]
      .filter(([p]) => p.endsWith(".exs"))
      .map(([, c]) => c)
      .join("\n");
    expect(exs).toMatch(/create index\(:invoices, \["data_key text_pattern_ops"\]/);
  });

  it("does not duplicate a hand-declared single-column unique (tenantId) index", async () => {
    const files = await generateSystemFiles(
      tenancySystem(
        `aggregate Invoice ids guid with tenantOwned { number: string  unique (tenantId) }`,
      ),
    );
    const sql = sqlOf(files);
    // The unique index covers the prefix; no extra plain index derived.
    expect(sql).toMatch(/invoices_tenant_id_uq/);
    expect(sql).not.toMatch(/invoices_tenant_id_idx/);
  });
});
