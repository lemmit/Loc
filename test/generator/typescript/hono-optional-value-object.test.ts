// Optional value-object fields on Hono — the save deref and the read null-probe
// must both target the FLATTENED leaf columns, not a `row.<field>` /
// `aggregate.<field>` that does not exist / may be null.
//
// From `docs/audits/repo-code-review-2026-07.md` C1: an optional VO field
// (`billing: Address?`) was broken end-to-end on the Hono backend —
//   • save projected `aggregate.billing.street` with NO guard on the parent, so
//     persisting an aggregate whose optional VO is null threw a TypeError; and
//   • read guarded on `row.billing == null` (a column that never exists — the VO
//     flattens to `billing_street`/`billing_city`), so `undefined == null` was
//     always true and the VO ALWAYS hydrated to null even when data was present
//     (silent data loss).
// No example exercised an optional singular VO, so the compile gates never saw
// it.  This pins the guarded, correct-column output on both paths.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = `
system PS {
  subdomain D {
    context Shop {
      valueobject Address {
        street: string
        city: string
      }
      aggregate Order with crudish {
        code: string
        billing: Address?
      }
      repository Orders for Order { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable d { platform: node, contexts: [Shop], dataSources: [st], serves: A, port: 3000 }
}`;

describe("Hono optional value-object field", () => {
  it("guards the parent deref on save and probes the leaf column on read", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const repo = files.get("d/db/repositories/order-repository.ts");
    expect(repo).toBeDefined();

    // Read: the null-probe is the first FLATTENED leaf column, and the outer
    // (wrong) `root.billing == null` guard is gone.
    expect(repo).toContain(
      "billing: (root.billing_street == null ? null : new Address(root.billing_street, root.billing_city))",
    );
    // The buggy nested double-guard (outer probe on the nonexistent `root.billing`
    // column) must be gone.  `toWire`, which operates on the DOMAIN object, still
    // legitimately references `root.billing`, so scope the negative to the pattern.
    expect(repo).not.toContain("root.billing == null ? null : (root.billing_street");

    // Save: the parent VO deref is guarded, so a null `billing` persists as null
    // columns instead of throwing on `.street`.
    expect(repo).toContain(
      "billing_street: (aggregate.billing == null ? null : aggregate.billing.street)",
    );
    expect(repo).toContain(
      "billing_city: (aggregate.billing == null ? null : aggregate.billing.city)",
    );
    expect(repo).not.toContain("billing_street: aggregate.billing.street");
  });
});
