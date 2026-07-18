// B8 (docs/audits/behavioral-parity-bugs-2026-07.md): a single (non-collection)
// `contains` is mapped to its OWN table by the migration (same as a collection
// part), so its EF owned-entity config must fully map the strongly-typed
// `<Part>Id` key + `ParentId` back-reference + table/schema — NOT a bare
// `OwnsOne<Part>(x => x.Part)`, which table-splits onto the owner and leaves the
// CLR-typed key/FK unmapped (EF model validation aborts at boot, exit 134).  The
// owned reference is also OPTIONAL (an op fills it after create), so the nav is
// `IsRequired(false)` — otherwise EF inner-joins and throws reading the absent
// dependent's NULL id.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Shop {
    aggregate Order {
      code: string
      contains shipment: Shipment
      operation ship(carrier: string, tracking: string) {
        shipment := Shipment { carrier: carrier, trackingCode: tracking }
      }
      entity Shipment { carrier: string  trackingCode: string }
    }
    repository Orders for Order { }
  }
`;

describe("dotnet generator — single (non-collection) containment", () => {
  it("fully configures the owned entity's own table, key, FK and id conversion", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const cfg = generateDotnet(model).get(
      "Infrastructure/Persistence/Configurations/OrderConfiguration.cs",
    )!;

    // OwnsOne maps the public nav directly (no `Ignore` + private-backing-field
    // indirection the collection path uses).
    expect(cfg).toContain("builder.OwnsOne<Shipment>(x => x.Shipment, o => {");
    expect(cfg).not.toContain("builder.OwnsOne<Shipment>(x => x.Shipment);");
    // Its own table (the migration's `shipments`), the owner FK column, the
    // strongly-typed key + its conversion — everything the bare OwnsOne dropped.
    expect(cfg).toContain('o.ToTable("shipments");');
    expect(cfg).toContain('o.WithOwner().HasForeignKey("ParentId");');
    expect(cfg).toContain('o.Property("ParentId").HasColumnName("order_id");');
    expect(cfg).toContain("o.HasKey(x => x.Id);");
    expect(cfg).toContain(
      'o.Property(x => x.Id).HasConversion(v => v.Value, v => new ShipmentId(v)).HasColumnName("id");',
    );
    expect(cfg).toContain('o.Property(x => x.Carrier).HasColumnName("carrier");');
    // The owned reference is optional — created before the op fills it.
    expect(cfg).toContain("builder.Navigation(x => x.Shipment).IsRequired(false);");
  });
});
