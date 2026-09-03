// TPH write paths must carry the `kind` discriminator (review-B D1).
//
// A TPH hierarchy shares ONE table.  Every READ a concrete repository emits is
// already `kind`-scoped (`eq(schema.vehicles.kind, "Car")`); the two WRITE
// paths were not:
//
//   delete(id)  ->  DELETE FROM vehicles WHERE id = $1
//   save(x)     ->  UPDATE vehicles SET … WHERE id = $1 AND version = $2
//
// so `carRepo.delete(id)` deleted a Truck row outright, and `carRepo.save(x)`
// on a truck's id took the UPDATE branch and rewrote that row's `kind` to
// "Car" while leaving the truck's own columns populated — a silently corrupted
// row, no error anywhere.  Foreign-subtype ids DO reach these methods: the
// polymorphic base reader hands each concrete repo a base id cast to that
// concrete's branded id, so the brand is laundered, not enforced.
//
// The existence PROBE stays unscoped on purpose — it decides insert-vs-update,
// which is a primary-key question about the whole shared table.  A kind-scoped
// probe would answer "no row" for a foreign id and then INSERT a duplicate id.
// The guard belongs on the write.

import { describe, expect, it } from "vitest";
import { generateHono, parseString } from "../../_helpers/index.js";

async function gen(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(errors.join("; "));
  return generateHono(model);
}

const TPH = `
  context Fleet {
    abstract aggregate Vehicle {
      name: string
    }
    aggregate Car extends Vehicle with crudish {
      doors: int
    }
    aggregate Truck extends Vehicle with crudish {
      payloadKg: int
    }
    repository Cars for Car { }
    repository Trucks for Truck { }
  }
`;

// A plain (non-TPH) aggregate — the byte-identical control.
const PLAIN = `
  context Fleet {
    aggregate Bike with crudish {
      name: string
    }
    repository Bikes for Bike { }
  }
`;

describe("TPH write paths carry the kind discriminator (Hono/Drizzle)", () => {
  it("delete scopes by kind as well as id", async () => {
    const files = await gen(TPH);
    const car = files.get("db/repositories/car-repository.ts") ?? "";
    const truck = files.get("db/repositories/truck-repository.ts") ?? "";
    expect(car, "concrete repository emitted").not.toEqual("");

    const carDelete = car.split("\n").find((l) => l.includes("this.db.delete(")) ?? "";
    expect(carDelete).toContain("eq(schema.vehicles.id, id)");
    expect(carDelete).toContain('eq(schema.vehicles.kind, "Car")');

    // …and the sibling concrete scopes to ITS OWN kind, not the first one.
    const truckDelete = truck.split("\n").find((l) => l.includes("this.db.delete(")) ?? "";
    expect(truckDelete).toContain('eq(schema.vehicles.kind, "Truck")');
  });

  it("the guarded UPDATE in save scopes by kind, so a foreign row is never rewritten", async () => {
    const files = await gen(TPH);
    const car = files.get("db/repositories/car-repository.ts") ?? "";
    const update = car.split("\n").find((l) => l.includes("tx.update(schema.vehicles)")) ?? "";
    expect(update, "guarded update emitted").not.toEqual("");
    expect(update).toContain("eq(schema.vehicles.version, expected)");
    expect(update).toContain('eq(schema.vehicles.kind, "Car")');
    // Zero rows matched -> the same ConcurrencyError a lost race raises, rather
    // than a silent overwrite.
    expect(car).toContain('throw new ConcurrencyError("Car"');
  });

  it("the existence probe stays unscoped — it is a primary-key question", async () => {
    const files = await gen(TPH);
    const car = files.get("db/repositories/car-repository.ts") ?? "";
    const probe = car.split("\n").find((l) => l.includes("const existingRow =")) ?? "";
    expect(probe, "existence probe emitted").not.toEqual("");
    expect(probe).toContain("eq(schema.vehicles.id, aggregate.id)");
    // A kind-scoped probe would answer "no row" for a foreign id and then
    // INSERT a duplicate primary key.
    expect(probe).not.toContain("kind");
  });

  it("a non-TPH aggregate's writes are untouched", async () => {
    const files = await gen(PLAIN);
    const bike = files.get("db/repositories/bike-repository.ts") ?? "";
    expect(bike, "repository emitted").not.toEqual("");
    const del = bike.split("\n").find((l) => l.includes("this.db.delete(")) ?? "";
    expect(del).toContain("where(eq(schema.bikes.id, id))");
    expect(del).not.toContain("and(");
    const update = bike.split("\n").find((l) => l.includes("tx.update(schema.bikes)")) ?? "";
    expect(update).toContain("eq(schema.bikes.version, expected)");
    expect(update).not.toContain("kind");
  });
});
