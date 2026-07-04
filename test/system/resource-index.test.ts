// `resource index: [...]` → derived non-unique performance indexes
// (uniqueness-and-indexes.md §3.2).  Pure infrastructure: each spec names its
// target entity explicitly (`Project.name`, or a contained part `Line.sku`),
// lands on that entity's table, named `<table>_<cols>_idx`, always non-unique
// (uniqueness is the domain `unique (...)` invariant).  Plus the validators.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { LoomDiagnostic } from "../../src/ir/validate/validate.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../_helpers/index.js";
import { parseString } from "../_helpers/parse.js";

const system = (resource: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Customer with crudish {
          email: string  status: string  lastName: string
          contains lines: Line[]
          entity Line { sku: string }
        }
        repository Customers for Customer { }
      }
    }
    api SalesApi from Sales
    storage primarySql { type: postgres }
    ${resource}
    deployable api { platform: node  contexts: [Ordering]  dataSources: [ordState]  serves: SalesApi  port: 3001 }
  }
`;

const sqlOf = (files: Map<string, string>): string =>
  [...files.entries()]
    .filter(([p]) => p.endsWith(".sql"))
    .map(([, c]) => c)
    .join("\n");

async function diags(source: string): Promise<LoomDiagnostic[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).filter((d) =>
    (d.code ?? "").startsWith("loom.resource-index-"),
  );
}

describe("resource index: → Postgres index DDL", () => {
  it("emits a non-unique single-column index on the named entity's table", async () => {
    const files = await generateSystemFiles(
      system(
        `resource ordState { for: Ordering, kind: state, use: primarySql, index: [Customer.status] }`,
      ),
    );
    expect(sqlOf(files)).toMatch(/CREATE INDEX "?customers_status_idx"? ON \S+ \("?status"?\)/);
    expect(sqlOf(files)).not.toMatch(/CREATE UNIQUE INDEX "?customers_status_idx"?/);
  });

  it("emits a composite index over the named columns in order", async () => {
    const files = await generateSystemFiles(
      system(
        `resource ordState { for: Ordering, kind: state, use: primarySql, index: [Customer.(status, lastName)] }`,
      ),
    );
    expect(sqlOf(files)).toMatch(
      /CREATE INDEX "?customers_status_last_name_idx"? ON \S+ \("?status"?, "?last_name"?\)/,
    );
  });

  it("targets a contained part's table (inner entity)", async () => {
    const files = await generateSystemFiles(
      system(
        `resource ordState { for: Ordering, kind: state, use: primarySql, index: [Line.sku] }`,
      ),
    );
    expect(sqlOf(files)).toMatch(/CREATE INDEX "?lines_sku_idx"? ON \S+ \("?sku"?\)/);
  });

  it("emits no manual index when none is declared", async () => {
    const files = await generateSystemFiles(
      system(`resource ordState { for: Ordering, kind: state, use: primarySql }`),
    );
    expect(sqlOf(files)).not.toContain("customers_status_idx");
  });
});

describe("resource index: — validation", () => {
  it("rejects an unknown entity (loom.resource-index-unknown-entity)", async () => {
    const d = await diags(
      system(
        `resource ordState { for: Ordering, kind: state, use: primarySql, index: [Nope.status] }`,
      ),
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "error", code: "loom.resource-index-unknown-entity" });
  });

  it("rejects a column that is no field of the named entity (loom.resource-index-unknown-column)", async () => {
    const d = await diags(
      system(
        `resource ordState { for: Ordering, kind: state, use: primarySql, index: [Customer.nope] }`,
      ),
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "error", code: "loom.resource-index-unknown-column" });
  });

  it("rejects `index:` on a non-state binding (loom.resource-index-non-state)", async () => {
    const d = await diags(
      system(
        `resource ordCache { for: Ordering, kind: cache, use: primarySql, index: [Customer.status] }`,
      ).replace("dataSources: [ordState]", "dataSources: [ordCache]"),
    );
    expect(d.some((x) => x.code === "loom.resource-index-non-state")).toBe(true);
  });

  it("accepts a well-formed single + composite + part index (no diagnostics)", async () => {
    const d = await diags(
      system(
        `resource ordState { for: Ordering, kind: state, use: primarySql, index: [Customer.status, Customer.(status, lastName), Line.sku] }`,
      ),
    );
    expect(d).toEqual([]);
  });
});
