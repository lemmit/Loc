import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — first-boot seeding (plan S16, database-seeding.md).
// `seed { ... }` blocks emit `app/db/seed.py`: the domain path saves
// through `<Agg>.create(...)` so invariants run, the `raw` path emits
// schema-qualified driver-level INSERTs with explicit ids, and every
// dataset is ship-once via the `__loom_seed` marker (`default` always
// runs; others gate on LOOM_SEED).  The lifespan runs seeds right
// after migrations.  Verified live (three datasets applied once,
// re-boot is a no-op).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/seeds.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python seeding", () => {
  it("domain path saves through the create factory with rendered values", async () => {
    const files = await build();
    const seed = files.get("api/app/db/seed.py")!;
    expect(seed).toContain(
      "product_repo = ProductRepository(session, NoopDomainEventDispatcher())",
    );
    expect(seed).toContain(
      'await product_repo.save(Product.create(sku="BASE-1", tier=Tier.Free, price=Price(1.0, "USD"), stock=1))',
    );
  });

  it("datasets are ship-once: marker table + LOOM_SEED gating", async () => {
    const files = await build();
    const seed = files.get("api/app/db/seed.py")!;
    expect(seed).toContain('return dataset == "default" or dataset in requested');
    expect(seed).toContain('if await _already_seeded(session, "demo"):');
    expect(seed).toContain('await _mark_seeded(session, "demo")');
    expect(seed).toContain("CREATE TABLE IF NOT EXISTS __loom_seed");
    expect(seed).toContain('os.environ.get("LOOM_SEED", "")');
  });

  it("raw rows emit schema-qualified driver-level INSERTs with explicit ids", async () => {
    const files = await build();
    const seed = files.get("api/app/db/seed.py")!;
    expect(seed).toContain("exec_driver_sql(");
    expect(seed).toContain(
      'INSERT INTO \\"catalog\\".\\"suppliers\\" (\\"id\\", \\"name\\") VALUES (\'11111111-1111-1111-1111-111111111111\', \'Acme\')',
    );
    expect(seed).toContain('\\"listings\\" (\\"id\\", \\"supplier_id\\", \\"sku\\")');
    // Raw rows never construct the domain class.
    expect(seed).not.toContain("Supplier.create(");
    expect(seed).not.toContain("Listing.create(");
  });

  it("boot order: migrations then seeds in the lifespan", async () => {
    const files = await build();
    const main = files.get("api/app/main.py")!;
    expect(main).toContain("from app.db.seed import run_seeds");
    const migrateAt = main.indexOf("await run_migrations()");
    const seedAt = main.indexOf("await run_seeds()");
    expect(migrateAt).toBeGreaterThan(-1);
    expect(seedAt).toBeGreaterThan(migrateAt);
  });

  it("seed-less projects emit no seed module and no lifespan call", async () => {
    const source = FIXTURE.replace(/ {6}seed[\s\S]*?\n {6}\}\n/g, "");
    expect(source).not.toMatch(/^\s*seed[ \w]*\{/m);
    const { model, errors } = await parseString(source);
    if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
    const files = generateSystems(model).files;
    expect(files.get("api/app/db/seed.py")).toBeUndefined();
    expect(files.get("api/app/main.py")!).not.toContain("run_seeds");
  });
});
