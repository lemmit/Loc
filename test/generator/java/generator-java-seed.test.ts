// ---------------------------------------------------------------------------
// Java backend — first-boot seeding (database-seeding.md): the
// `<Ctx>SeedRunner` ApplicationRunner, the domain path through
// `<Agg>.create(...)` (positional create-input order, omitted → null),
// the raw explicit-id INSERT path (schema-qualified — java tables live
// in per-module schemas), and the ship-once `__loom_seed` marker.
// Boot-verified end-to-end against Postgres via
// test/e2e/fixtures/java-build/seeding.ddd (incl. idempotent re-boot).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/e2e/fixtures/java-build/seeding.ddd", "utf8");

const ROOT = "seed_api/src/main/java/com/loom/seedapi";

async function runner(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  return files.get(`${ROOT}/infrastructure/persistence/CatalogSeedRunner.java`)!;
}

describe("java generator — seed runner", () => {
  it("emits an ApplicationRunner per seeded context with one method per dataset", async () => {
    const s = await runner();
    expect(s).toContain("public class CatalogSeedRunner implements ApplicationRunner {");
    expect(s).toContain("    private void seedDefault(Set<String> requested) {");
    expect(s).toContain("    private void seedDemo(Set<String> requested) {");
    expect(s).toContain("    private void seedWired(Set<String> requested) {");
  });

  it("domain rows go through the create factory (invariants run) and the port save", async () => {
    const s = await runner();
    expect(s).toContain('widgetsRepository.save(Widget.create("Alpha", 1, Tier.Free));');
    expect(s).toContain('widgetsRepository.save(Widget.create("Gamma", 3, Tier.Pro));');
  });

  it("raw rows emit the shared INSERT, schema-qualified for the per-module schema", async () => {
    const s = await runner();
    expect(s).toContain(
      'jdbc.execute("INSERT INTO \\"catalog\\".\\"widgets\\" (\\"id\\", \\"name\\", \\"size\\", \\"tier\\") VALUES (\'11111111-1111-1111-1111-111111111111\', \'Anchor\', 4, \'Free\')");',
    );
    expect(s).toContain('\\"gadgets\\" (\\"id\\", \\"widget_id\\", \\"label\\")');
  });

  it("ships once per dataset via the __loom_seed marker; default always runs, others gate on LOOM_SEED", async () => {
    const s = await runner();
    expect(s).toContain('jdbc.execute("CREATE TABLE IF NOT EXISTS \\"__loom_seed\\"');
    expect(s).toContain('return "default".equals(dataset) || requested.contains(dataset);');
    expect(s).toContain('if (alreadySeeded("demo")) return;');
    expect(s).toContain('markSeeded("wired");');
    expect(s).toContain('System.getenv().getOrDefault("LOOM_SEED", "")');
  });

  it("emits no runner when a context declares no seeds", async () => {
    const files = await generateSystemFiles(
      SRC.replace(/seed (default|demo|wired raw) \{[^}]*\}/g, ""),
    );
    const paths = [...files.keys()].filter((k) => k.includes("SeedRunner"));
    expect(paths).toEqual([]);
  });

  it("datetime seed literals parse to Instant at the create boundary", async () => {
    const src = `
      system Clock {
        subdomain Core {
          context Catalog {
            aggregate Stamp {
              label: string
              at: datetime
            }
            repository Stamps for Stamp { }
            seed default {
              Stamp { label: "first", at: "2024-01-01T00:00:00Z" }
            }
          }
        }
        storage primary { type: postgres }
        resource catalogState { for: Catalog, kind: state, use: primary }
        deployable api {
          platform: java
          contexts: [Catalog]
          dataSources: [catalogState]
          port: 8080
        }
      }
    `;
    const files = await generateSystemFiles(src);
    const s = files.get(
      "api/src/main/java/com/loom/api/infrastructure/persistence/CatalogSeedRunner.java",
    )!;
    expect(s).toContain(
      'stampsRepository.save(Stamp.create("first", Instant.parse("2024-01-01T00:00:00Z")));',
    );
    expect(s).toContain("import java.time.Instant;");
  });
});
