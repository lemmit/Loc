import { wireFieldsFor } from "../../src/ir/enrich/wire-projection.js";
// `with versioned` capability → the aggregate's enriched `wireShape` carries a
// synthetic `version` field with `token` access.  Token access is what routes
// it (via the existing wire-projection matrix, wire-projection.test.ts): present
// on API reads, dropped from create/update input bodies, carried into
// `updatePreconditions()` (the client echoes it as the optimistic-lock guard).
// This test pins the INTEGRATION point — that the prelude capability actually
// contributes a `version: int token` field to the wire shape — since the
// projection matrix itself is proven generically elsewhere.

import { describe, expect, it } from "vitest";
import {
  forApiRead,
  forCreateInput,
  forUpdateInput,
  updatePreconditions,
} from "../../src/ir/enrich/wire-projection.js";
import type { AggregateIR, LoomModel } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";

const source = (cap: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Customer ${cap} {
          email: string
          name: string
          operation update(newName: string) { name := newName }
        }
        repository Customers for Customer { }
      }
    }
  }
`;

function customerOf(loom: LoomModel): AggregateIR {
  for (const s of loom.systems) {
    for (const m of s.subdomains) {
      for (const c of m.contexts) {
        const agg = c.aggregates.find((a) => a.name === "Customer");
        if (agg) return agg;
      }
    }
  }
  throw new Error("Customer aggregate not found");
}

describe("versioned capability — wireShape version token", () => {
  it("contributes a `version` field with token access to the wire shape", async () => {
    const agg = customerOf(await buildLoomModel(source("with versioned")));
    const version = wireFieldsFor(agg).find((f) => f.name === "version");
    expect(version, "version wire field").toBeDefined();
    expect(version!.access).toBe("token");
    expect(version!.type).toEqual({ kind: "primitive", name: "int" });
    expect(version!.source).toBe("property");
  });

  it("routes version onto API reads, off create/update bodies, into preconditions", async () => {
    const agg = customerOf(await buildLoomModel(source("with versioned")));
    const wire = wireFieldsFor(agg);
    const has = (fs: { name: string }[]) => fs.some((f) => f.name === "version");

    expect(has(forApiRead(wire)), "read includes version").toBe(true);
    expect(has(forCreateInput(wire)), "create drops version").toBe(false);
    expect(has(forUpdateInput(wire)), "update drops version").toBe(false);
    expect(has(updatePreconditions(wire)), "precondition carries version").toBe(true);
  });

  it("a non-versioned aggregate has no version field", async () => {
    const agg = customerOf(await buildLoomModel(source("")));
    expect(wireFieldsFor(agg).some((f) => f.name === "version")).toBe(false);
    expect(agg.capabilities ?? []).not.toContain("versioned");
  });

  it("marks the aggregate as carrying the `versioned` capability", async () => {
    const agg = customerOf(await buildLoomModel(source("with versioned")));
    expect(agg.capabilities ?? []).toContain("versioned");
  });
});
