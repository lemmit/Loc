// ---------------------------------------------------------------------------
// Java backend — TPH (`sharedTable`, the omitted-modifier default)
// inheritance rides JPA's native SINGLE_TABLE: the abstract base is a
// real @Entity owning the shared table + @DiscriminatorColumn("kind");
// each concrete carries @Entity + @DiscriminatorValue (its name — the
// kind value every backend stamps) and no @Table of its own; the
// hierarchy shares the base's `<Base>Id` (repos / services /
// controllers thread `idClass`).  Boot-verified end-to-end against
// Postgres via test/e2e/fixtures/java-build/tph.ddd (per-concrete
// routes auto-filter on the discriminator; one shared table).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";
import { corpusSourceFor } from "../../fixtures/corpus/harness.js";

// The canonical TPH fixture now lives in the shared corpus (deployable `d`).
const SRC = corpusSourceFor("tph", "java");

const ROOT = "d/src/main/java/com/loom/d";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — TPH (sharedTable) inheritance", () => {
  it("passes validation (java joined TPH_CAPABLE)", async () => {
    const loom = await buildLoomModel(SRC);
    const errors = validateLoomModel(loom).filter((d) => d.code === "loom.tph-backend-unsupported");
    expect(errors).toEqual([]);
  });

  it("base is a SINGLE_TABLE @Entity owning the shared table + kind discriminator", async () => {
    const base = (await files()).get(`${ROOT}/features/vehicles/Vehicle.java`)!;
    expect(base).toContain('@Table(name = "vehicles", schema = "fleet")');
    expect(base).toContain("@Inheritance(strategy = InheritanceType.SINGLE_TABLE)");
    expect(base).toContain('@DiscriminatorColumn(name = "kind")');
    expect(base).toContain("    protected VehicleId id;");
    expect(base).toContain('    @Column(name = "name")');
  });

  it("concretes carry @DiscriminatorValue and no @Table, extending the base", async () => {
    const car = (await files()).get(`${ROOT}/features/cars/Car.java`)!;
    expect(car).toContain('@DiscriminatorValue("Car")');
    expect(car).not.toContain("@Table(");
    expect(car).toContain("public class Car extends Vehicle {");
    // Own field only; inherited fields come from the base.
    expect(car).toContain('    @Column(name = "doors")');
    expect(car).not.toContain("String name;");
  });

  it("repos / service / controller share the base id class", async () => {
    const files_ = await files();
    const jpa = files_.get(`${ROOT}/features/cars/CarJpaRepository.java`)!;
    expect(jpa).toContain("extends JpaRepository<Car, VehicleId>");
    const svc = files_.get(`${ROOT}/features/cars/CarService.java`)!;
    expect(svc).toContain("public VehicleId createCar(CreateCarRequest request) {");
    const c = files_.get(`${ROOT}/features/cars/CarsController.java`)!;
    expect(c).toContain("service.getCarById(new VehicleId(id));");
  });
});
