// TPH write paths must carry the `kind` discriminator — python/SQLAlchemy
// (review-B D1, the twin of the Hono defect in
// `test/generator/typescript/hono-tph-write-scoping.test.ts`).
//
// A TPH hierarchy shares ONE table, and `python-inheritance.test.ts` already
// pins that every READ a concrete repository emits is `kind`-scoped.  The two
// WRITE paths were not:
//
//   delete(id)  ->  delete(PartyRow).where(PartyRow.id == id)
//   save(x)     ->  … .on_conflict_do_update(where=PartyRow.version == …)
//
// so `customer_repo.delete(id)` deleted a Vendor row outright, and
// `customer_repo.save(x)` on a vendor's id conflicted on the id, took the DO
// UPDATE branch and flipped that row's `kind` to "Customer" — a silently
// corrupted row with no error anywhere.  Foreign-subtype ids DO reach these
// methods: the polymorphic base reader dispatches base ids through the
// concrete repositories.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYSTEM = (body: string): string => `
system PyFleet {
  subdomain D {
    context Fleet {
      ${body}
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Fleet, kind: state, use: primary }
  deployable api {
    platform: python
    contexts: [Fleet]
    dataSources: [st]
    serves: A
    port: 8000
  }
}`;

const TPH = SYSTEM(`
      abstract aggregate Vehicle inheritanceUsing: sharedTable {
        name: string
      }
      aggregate Car extends Vehicle with crudish {
        doors: int
      }
      aggregate Truck extends Vehicle with crudish {
        payloadKg: int
      }
      repository Cars for Car { }
      repository Trucks for Truck { }`);

// A plain (non-TPH) aggregate — the byte-identical control.
const PLAIN = SYSTEM(`
      aggregate Bike with crudish {
        name: string
      }
      repository Bikes for Bike { }`);

const build = (src: string): Promise<Map<string, string>> => generateSystemFiles(src);

describe("python TPH write paths carry the kind discriminator", () => {
  it("delete scopes by kind as well as id", async () => {
    const files = await build(TPH);
    const car = files.get("api/app/db/repositories/car_repository.py") ?? "";
    const truck = files.get("api/app/db/repositories/truck_repository.py") ?? "";
    expect(car, "concrete repository emitted").not.toEqual("");

    const carDelete = car.split("\n").find((l) => l.includes("delete(VehicleRow)")) ?? "";
    expect(carDelete).toContain("VehicleRow.id == id");
    expect(carDelete).toContain('VehicleRow.kind == "Car"');
    expect(carDelete).toContain("and_(");

    // …and the sibling concrete scopes to ITS OWN kind, not the first one.
    const truckDelete = truck.split("\n").find((l) => l.includes("delete(VehicleRow)")) ?? "";
    expect(truckDelete).toContain('VehicleRow.kind == "Truck"');

    // `and_` must actually be imported, or the module fails at import time.
    expect(car).toMatch(/^from sqlalchemy import .*\band_\b/m);
  });

  it("the guarded upsert's DO UPDATE branch scopes by kind", async () => {
    const files = await build(TPH);
    const car = files.get("api/app/db/repositories/car_repository.py") ?? "";
    const guard = car.split("\n").find((l) => l.trim().startsWith("where=")) ?? "";
    expect(guard, "guarded upsert emitted").not.toEqual("");
    expect(guard).toContain("VehicleRow.version == _expected");
    expect(guard).toContain('VehicleRow.kind == "Car"');
    // Zero rows matched -> the same ConcurrencyError a lost race raises, rather
    // than a silent kind flip.
    expect(car).toContain("raise ConcurrencyError(");
  });

  it("the conflict TARGET stays the bare primary key", async () => {
    // The conflict IS the id, across the whole shared table.  Narrowing
    // `index_elements` would make a foreign-subtype id miss the conflict and
    // attempt a duplicate-key INSERT instead.
    const files = await build(TPH);
    const car = files.get("api/app/db/repositories/car_repository.py") ?? "";
    expect(car).toContain('index_elements=["id"]');
  });

  it("a non-TPH aggregate's writes are untouched", async () => {
    const files = await build(PLAIN);
    const bike = files.get("api/app/db/repositories/bike_repository.py") ?? "";
    expect(bike, "repository emitted").not.toEqual("");
    const del = bike.split("\n").find((l) => l.includes("delete(BikeRow)")) ?? "";
    expect(del).toContain("delete(BikeRow).where(BikeRow.id == id)");
    expect(del).not.toContain("and_(");
    const guard = bike.split("\n").find((l) => l.trim().startsWith("where=")) ?? "";
    expect(guard).toContain("BikeRow.version == _expected");
    expect(guard).not.toContain("kind");
  });
});
