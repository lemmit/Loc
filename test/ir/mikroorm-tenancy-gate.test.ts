// Hierarchical tenancy on `persistence: mikroorm` is REFUSED, not silently
// unscoped.
//
// `emitMikroContextFilters` lowers each capability filter through
// `whereToMikroFilter`, whose FilterQuery subset cannot express the
// descendant-or-self subtree predicate — and it CATCHES that failure and leaves
// the filter unapplied:
//
//     try { out.push(whereToMikroFilter(pred)); }
//     catch { /* unlowerable principal filter — left unapplied */ }
//
// For a `deep`/`global` scope that is not a degraded read.  It is NO tenant
// predicate at all, so every tenant's rows are readable on every read of the
// aggregate.  Verified before the gate existed: generating
// `tenancy-hierarchy.ddd` with `persistence: mikroorm` produced repositories
// whose reads carried no `dataKey` / `tenantId` term whatsoever, while the same
// fixture on the default adapter carries the scope predicate on every read.
//
// The adapter's comment asserted the shape was "not generated on the mikro
// adapter today" — which was a belief about the corpus, not a gate, and the
// combination validated, generated and compiled clean.  This pins the refusal.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";
import { corpusSource } from "../fixtures/corpus/harness.js";

async function errorsFor(platform: string): Promise<string[]> {
  const src = corpusSource("tenancy-hierarchy").replaceAll("__PLATFORM__", platform);
  const { model, errors } = await parseString(src, { validate: true });
  if (errors.length > 0) return errors;
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => `${d.code}`);
}

describe("hierarchical tenancy × the mikroorm adapter", () => {
  it("is refused, naming the dropped predicate", async () => {
    const codes = await errorsFor("node { persistence: mikroorm }");
    // One per tenant-owned aggregate in the fixture; the registry itself is
    // self-scoped by id, which the FilterQuery subset CAN express.
    expect(codes).toContain("loom.mikroorm-unsupported");
    expect(codes.filter((c) => c === "loom.mikroorm-unsupported").length).toBeGreaterThanOrEqual(1);
  });

  it("still generates clean on the default adapter", async () => {
    // The gate is adapter-scoped: it must not reject the shape everywhere.
    expect(await errorsFor("node")).toEqual([]);
  });
});
