// Phase-⑦ guard: `new <Part> { … }` may not supply the part's own containment
// fields (nested-parts-alignment.md construction follow-up).  The part's id is
// minted inside its `_create` factory, so nested children constructed inline
// have no valid parent id to stamp — the generated code stamps the enclosing
// `this` (the aggregate root), mis-typing the child's `ParentId`.  This turns
// that cryptic generated-project compile error into an honest Loom diagnostic
// (`loom.nested-part-construction-unsupported`).  Deep part-in-part STORAGE
// (reading/writing an already-parented nested tree) is supported on all four
// relational backends — only the in-`new` construction shortcut is gated.

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/ir.js";

const codes = async (source: string): Promise<string[]> =>
  validateLoomModel(await buildLoomModel(source))
    .filter((d) => d.code === "loom.nested-part-construction-unsupported")
    .map((d) => d.message);

const NESTED = (opBody: string): string => `
  system Demo {
    subdomain L { context L {
      aggregate Order {
        code: string
        contains shipments: Shipment[]
        ${opBody}
        entity Shipment { carrier: string  contains labels: Label[] }
        entity Label { zpl: string }
      }
      repository Orders for Order { }
    }}
  }
`;

describe("nested-part-construction gate", () => {
  it("rejects a `new Shipment` that supplies its own `labels` containment", async () => {
    const msgs = await codes(
      NESTED(`operation addFull(carrier: string, zpl: string) {
        shipments += Shipment { carrier: carrier, labels: [Label { zpl: zpl }] }
      }`),
    );
    expect(msgs.length).toBe(1);
    expect(msgs[0]!).toContain("new Shipment");
    expect(msgs[0]!).toContain("labels");
    expect(msgs[0]!).toContain("follow-up operation");
  });

  it("allows constructing the part WITHOUT its containment (the supported path)", async () => {
    const msgs = await codes(
      NESTED(`operation addShipment(carrier: string) {
        shipments += Shipment { carrier: carrier }
      }`),
    );
    expect(msgs).toEqual([]);
  });
});
