// Node/Hono read-mask serializer (`mask unless`, authorization.md §5,
// M-T3.2 item 6). The emitter machinery is exercised in isolation (the feature
// is still compile-gated end-to-end via `loom.field-mask-unsupported`, so a full
// generated project can't yet reach it): lower + enrich a `mask unless` model,
// then assert the wire projection carries the predicate and the emitters produce
// the fail-closed `toWireMasked` + a nullable response field.

import { describe, expect, it } from "vitest";
import {
  aggHasFieldMask,
  maskedWireFields,
  toWireMaskedMethod,
} from "../../src/generator/typescript/repository-wire-builder.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { forApiRead, wireFieldsFor } from "../../src/ir/enrich/wire-projection.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { EnrichedAggregateIR } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/parse.js";

const SRC = `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      aggregate P with crudish {
        name: string
        salary: decimal mask unless currentUser.permissions.contains(permissions.unmask)
      }
    }
  }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  port: 8080  auth: required }
}`;

async function maskedAgg(): Promise<EnrichedAggregateIR> {
  const { model } = await parseString(SRC, { validate: false });
  const ir = enrichLoomModel(lowerModel(model));
  for (const s of ir.systems)
    for (const sd of s.subdomains)
      for (const c of sd.contexts) {
        const p = c.aggregates.find((a) => a.name === "P");
        if (p) return p as EnrichedAggregateIR;
      }
  throw new Error("aggregate P not found");
}

describe("mask unless — node wire serializer", () => {
  it("propagates maskUnless onto the wire field", async () => {
    const agg = await maskedAgg();
    const salary = forApiRead(wireFieldsFor(agg)).find((wf) => wf.name === "salary");
    expect(salary?.maskUnless).toBeDefined();
    // A non-masked field carries no predicate.
    const name = forApiRead(wireFieldsFor(agg)).find((wf) => wf.name === "name");
    expect(name?.maskUnless).toBeUndefined();
  });

  it("aggHasFieldMask / maskedWireFields detect the masked field", async () => {
    const agg = await maskedAgg();
    expect(aggHasFieldMask(agg)).toBe(true);
    expect(maskedWireFields(agg).map((wf) => wf.name)).toEqual(["salary"]);
  });

  it("emits a fail-closed toWireMasked that redacts the field unless the predicate holds", async () => {
    const agg = await maskedAgg();
    const method = toWireMaskedMethod(agg);
    expect(method).toContain("toWireMasked(root: P, currentUser: User | null)");
    // fail-closed: null caller OR failed predicate → redact to null.
    expect(method).toContain("currentUser !== null");
    expect(method).toContain('(currentUser.permissions).includes("m.unmask")');
    expect(method).toContain("wire.salary = null");
  });
});
