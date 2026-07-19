import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { AggregateIR } from "../../src/ir/types/loom-ir.js";
import { sortableFields } from "../../src/ir/util/sortable-fields.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// Server-side sort whitelist (`sortableFields`).
// The whitelist is the set of `?sort=<field>` keys a paged list endpoint
// accepts.  `secret` (client write-only, never read back) and `internal`
// (server-managed, excluded from API reads) columns must NOT be sortable —
// otherwise a hidden column becomes a controllable ordering oracle.
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem);
const parse = parseHelper<Model>(services.Ddd);

async function aggregateFrom(src: string, name: string): Promise<AggregateIR> {
  const doc = await parse(src, { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
  expect(errors).toEqual([]);
  const enriched = enrichLoomModel(lowerModel(doc.parseResult.value));
  for (const ctx of enriched.contexts) {
    const agg = ctx.aggregates.find((a) => a.name === name);
    if (agg) return agg;
  }
  throw new Error(`Aggregate ${name} not found`);
}

const SRC = `
context Accounts {
  aggregate User {
    email: string
    displayName: string
    passwordHash: string secret
    tenantKey: string internal
  }
}
`;

describe("sortableFields — access-modifier exclusions", () => {
  it("excludes secret and internal columns from the sort whitelist", async () => {
    const agg = await aggregateFrom(SRC, "User");
    const keys = sortableFields(agg);
    // Public scalar properties are sortable, id leads.
    expect(keys).toContain("id");
    expect(keys).toContain("email");
    expect(keys).toContain("displayName");
    // A `secret` column is client write-only and never disclosed in a read;
    // it must never be an accepted `?sort=` key (ordering-oracle leak).
    expect(keys).not.toContain("passwordHash");
    // An `internal` column is excluded from API reads by `forApiRead`; it is
    // likewise not a meaningful (or safe) sort dimension.
    expect(keys).not.toContain("tenantKey");
  });
});
