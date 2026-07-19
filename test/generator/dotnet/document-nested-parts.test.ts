// Part-in-part under the snapshot-fold shapes (`shape(document)` on every
// backend; `shape(embedded)` on Dapper).  The `<Agg>Snapshot` DTOs mirror the
// entity tree, and a NESTED part's `ParentId` must brand to its DIRECT parent's
// id class (a sibling part), NOT the aggregate root's — otherwise the snapshot
// record's `ParentId` type diverges from the entity's own `State.ParentId`
// (branded via `directParentName` in emit/entity.ts) and the `ToSnapshot()` /
// `FromSnapshot(...)` field copies fail to compile under /warnaserror.  Regresses
// the .NET snapshot-seam nested-ParentId mistyping.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Carts {
    valueobject Money { amount: int currency: string }
    aggregate Cart shape: document with crudish {
      customer: string
      contains boxes: Box[]
      entity Box {
        label: string
        contains slip: Slip
        contains items: Item[]
      }
      entity Slip { note: string }
      entity Item { sku: string price: Money }
    }
    repository Carts for Cart {
      find byCustomer(customer: string): Cart[] where this.customer == customer
    }
  }
`;

describe("dotnet generator — snapshot-fold part-in-part ParentId", () => {
  it("brands each nested snapshot ParentId to its DIRECT parent's id class", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const snaps = generateDotnet(model).get("Domain/Carts/CartSnapshots.cs")!;

    // Box is contained by the root Cart → CartId (root-level, unchanged).
    expect(snaps).toContain("public sealed record BoxSnapshot");
    expect(snaps).toMatch(
      /record BoxSnapshot\s*\{\s*public BoxId Id \{ get; init; \}\s*public CartId ParentId/,
    );
    // Slip / Item are contained by Box (part-in-part) → BoxId, NOT CartId.
    expect(snaps).toContain("public sealed record SlipSnapshot");
    expect(snaps).toMatch(
      /record SlipSnapshot\s*\{\s*public SlipId Id \{ get; init; \}\s*public BoxId ParentId/,
    );
    expect(snaps).toContain("public sealed record ItemSnapshot");
    expect(snaps).toMatch(
      /record ItemSnapshot\s*\{\s*public ItemId Id \{ get; init; \}\s*public BoxId ParentId/,
    );
    // The mistyping would have branded these to the root CartId — assert it is gone.
    expect(snaps).not.toMatch(/record SlipSnapshot[\s\S]*?CartId ParentId/);
    expect(snaps).not.toMatch(/record ItemSnapshot[\s\S]*?CartId ParentId/);
  });

  it("keeps the snapshot ParentId type in lockstep with the entity State.ParentId", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateDotnet(model);
    // Entity State + snapshot ParentId must agree so `e.ParentId = s.ParentId;`
    // (and `ParentId = ParentId` in ToSnapshot) compile.
    const item = files.get("Domain/Carts/Item.cs")!;
    expect(item).toContain("public BoxId ParentId { get; init; } = default!;"); // State
    expect(item).toContain("e.ParentId = s.ParentId;"); // FromSnapshot copy
  });
});
