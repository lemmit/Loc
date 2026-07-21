// Domain `test "..."` block — null-safe reads of a nullable field.
//
// A SINGLE (non-collection) containment is `T | null` on the generated domain
// object (unset at create, set later by an op), and an OPTIONAL field's getter
// returns `T | null` too.  A further access on such a read (`o.shipment.carrier`)
// fails the STRICT per-backend gates that the looser behavioral runner misses:
//   - TS `tsc --noEmit`: TS18047 'o.shipment' is possibly 'null'
//   - Python `mypy --strict`: Item "None" of "Shipment | None" has no attribute
// so the test-file emitters wrap the read null-safely: TS `o.shipment!.carrier`,
// Python `cast(Shipment, o.shipment).carrier`.  Java/dotnet reads are already
// null-safe (records/getters return the value type), so they're unchanged.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

// A single containment set through an op, then read; plus an optional scalar.
const FIXTURE = `
system NS {
  subdomain D {
    context Shop {
      aggregate Order with crudish {
        code: string
        note: string?
        contains shipment: Shipment
        entity Shipment { carrier: string  trackingCode: string }
        operation ship(carrier: string, tracking: string) {
          shipment := Shipment { carrier: carrier, trackingCode: tracking }
        }
        test "reads a single containment and an optional field null-safely" {
          let o = Order.create({ code: "SC1" })
          o.ship("UPS", "1Z999")
          expect(o.shipment.carrier).toBe("UPS")
          expect(o.shipment.trackingCode).toBe("1Z999")
        }
      }
      repository Orders for Order { }
    }
  }
  api A from D
  deployable nodeApi { platform: node   contexts: [Shop] serves: A port: 4000 }
  deployable pyApi   { platform: python contexts: [Shop] serves: A port: 8000 }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  throw new Error(`no generated file matched ${pattern}; have:\n${[...files.keys()].join("\n")}`);
}

describe("null-safe nullable-field reads in domain tests", () => {
  it("TS: a single-containment read gets a non-null assertion (`!`)", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const src = findFile(files, /node_api\/.*domain\/order\.test\.ts$/);
    expect(src).toContain('expect(o.shipment!.carrier).toBe("UPS")');
    expect(src).toContain('expect(o.shipment!.trackingCode).toBe("1Z999")');
    // The non-null bang is only on the nullable receiver, not the leaf.
    expect(src).not.toContain("o.shipment.carrier"); // un-asserted read would fail strict tsc
  });

  it("Python: a single-containment read is wrapped in `cast(Shipment, …)`", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const src = findFile(files, /py_api\/.*test_order\.py$/);
    expect(src).toContain("from typing import cast");
    // Shipment is auto-imported alongside Order for the cast target type.
    expect(src).toMatch(/from app\.domain\.order import [^\n]*\bShipment\b/);
    expect(src).toContain('assert cast(Shipment, o.shipment).carrier == "UPS"');
    expect(src).toContain('assert cast(Shipment, o.shipment).tracking_code == "1Z999"');
    expect(src).not.toContain("assert o.shipment.carrier"); // un-cast read would fail mypy --strict
  });
});
