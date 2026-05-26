import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrichments.js";
import { lowerModel, mergeLoomModels } from "../../src/ir/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { loadProject } from "../../src/language/project-loader.js";

function writeProject(rootDir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
}

function collectErrors(
  docs: { uri: URI; diagnostics?: { severity?: number; message: string }[] }[],
): string[] {
  const out: string[] = [];
  for (const doc of docs) {
    for (const d of doc.diagnostics ?? []) {
      if (d.severity === 1) out.push(`${doc.uri.fsPath}: ${d.message}`);
    }
  }
  return out;
}

describe("multi-file project loader", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-project-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("loads transitive imports and merges every reachable doc", async () => {
    writeProject(tmp, {
      "main.ddd": `
        import "./orders.ddd"
        import "./shared/money.ddd"
        system Shop {
          module Sales { }
          deployable api { platform: hono, modules: Sales }
        }
      `,
      "orders.ddd": `
        import "./shared/money.ddd"
        context Orders {
          aggregate Order {
            total: Money
          }
        }
      `,
      "shared/money.ddd": `
        valueobject Money {
          amount: decimal
          currency: string
        }
      `,
    });

    const services = createDddServices(NodeFileSystem);
    const entryUri = URI.file(path.join(tmp, "main.ddd"));
    const { entry, all } = await loadProject(entryUri, services.shared);

    // Three reachable documents; shared/money.ddd is reached twice
    // (main + orders) but appears once.
    expect(all).toHaveLength(3);
    expect(entry.uri.fsPath).toBe(path.join(tmp, "main.ddd"));
    expect(collectErrors(all)).toEqual([]);

    // Lower and merge.
    const lowered = all.map((doc) => lowerModel(doc.parseResult.value as Model));
    const merged = mergeLoomModels(lowered);
    const loom = enrichLoomModel(merged);

    expect(loom.systems.map((s) => s.name)).toEqual(["Shop"]);
    expect(loom.rootValueObjects.map((v) => v.name)).toEqual(["Money"]);
    // Orders context lives inside the Shop system's Sales module via
    // composition; the project loader does not move it.  Whether the
    // context is in `system.modules` or `loom.contexts` depends on
    // how Shop was authored — in this fixture Sales is empty and
    // Orders is a loose context (in its own file), so it lands in
    // `loom.contexts`.
    const allContextNames = [
      ...loom.contexts.map((c) => c.name),
      ...loom.systems.flatMap((s) => s.modules.flatMap((m) => m.contexts.map((c) => c.name))),
    ];
    expect(allContextNames).toContain("Orders");
  });

  it("a top-level component declared in one file is visible from another", async () => {
    // Top-level components live alongside root VOs / enums.  They
    // travel through the same import-graph walk + `mergeLoomModels`
    // path, so a `.ddd` becomes a shared component library that
    // every importing system's pages can invoke by bare name.
    writeProject(tmp, {
      "main.ddd": `
        import "./components.ddd"
        system X {
          module M { context C { } }
          ui Web {
            page Home {
              route: "/"
              body: Hero("Welcome")
            }
          }
          deployable api { platform: hono, modules: M }
          deployable web { platform: static, targets: api, ui: Web, port: 3001 }
        }
      `,
      "components.ddd": `
        component Hero(title: string) {
          body: Card { title }
        }
      `,
    });

    const services = createDddServices(NodeFileSystem);
    const { all } = await loadProject(URI.file(path.join(tmp, "main.ddd")), services.shared);
    expect(collectErrors(all)).toEqual([]);

    const merged = mergeLoomModels(all.map((d) => lowerModel(d.parseResult.value as Model)));
    expect(merged.components.map((c) => c.name)).toEqual(["Hero"]);
  });

  it("resolves a root-level VO referenced from another file", async () => {
    writeProject(tmp, {
      "main.ddd": `
        import "./shared.ddd"
        import "./catalog.ddd"
        system X {
          module M { }
          deployable api { platform: hono, modules: M }
        }
      `,
      "shared.ddd": `
        valueobject Money {
          amount: decimal
          currency: string
        }
        enum Currency { USD, EUR }
      `,
      "catalog.ddd": `
        context Catalog {
          aggregate Product {
            price: Money
            currency: Currency
          }
        }
      `,
    });

    const services = createDddServices(NodeFileSystem);
    const { all } = await loadProject(URI.file(path.join(tmp, "main.ddd")), services.shared);
    expect(collectErrors(all)).toEqual([]);

    const merged = mergeLoomModels(all.map((d) => lowerModel(d.parseResult.value as Model)));
    expect(merged.rootValueObjects.map((v) => v.name)).toEqual(["Money"]);
    expect(merged.rootEnums.map((e) => e.name)).toEqual(["Currency"]);
    // The Catalog context has the Product aggregate with two
    // root-level type references; the linker should have resolved
    // them, hence no errors above.
    const ctxs = [
      ...merged.contexts,
      ...merged.systems.flatMap((s) => s.modules.flatMap((m) => m.contexts)),
    ];
    const catalog = ctxs.find((c) => c.name === "Catalog");
    expect(catalog).toBeDefined();
    expect(catalog!.aggregates.map((a) => a.name)).toContain("Product");
  });

  it("detects a circular import", async () => {
    writeProject(tmp, {
      "a.ddd": `
        import "./b.ddd"
        context A { }
      `,
      "b.ddd": `
        import "./a.ddd"
        context B { }
      `,
    });

    const services = createDddServices(NodeFileSystem);
    await expect(loadProject(URI.file(path.join(tmp, "a.ddd")), services.shared)).rejects.toThrow(
      /circular .ddd import/,
    );
  });

  it("errors on a missing import", async () => {
    writeProject(tmp, {
      "main.ddd": `
        import "./missing.ddd"
        context X { }
      `,
    });

    const services = createDddServices(NodeFileSystem);
    await expect(
      loadProject(URI.file(path.join(tmp, "main.ddd")), services.shared),
    ).rejects.toThrow(/import not found/);
  });

  it("deduplicates a file imported by two paths", async () => {
    writeProject(tmp, {
      "main.ddd": `
        import "./a.ddd"
        import "./b.ddd"
        context Z { }
      `,
      "a.ddd": `
        import "./shared.ddd"
        context A { }
      `,
      "b.ddd": `
        import "./shared.ddd"
        context B { }
      `,
      "shared.ddd": `
        valueobject Shared {
          v: int
        }
      `,
    });

    const services = createDddServices(NodeFileSystem);
    const { all } = await loadProject(URI.file(path.join(tmp, "main.ddd")), services.shared);
    // main + a + b + shared = 4, not 5 (shared dedup'd).
    expect(all).toHaveLength(4);

    const merged = mergeLoomModels(all.map((d) => lowerModel(d.parseResult.value as Model)));
    // Critical: shared.ddd lowered once → exactly one Shared VO.
    expect(merged.rootValueObjects.map((v) => v.name)).toEqual(["Shared"]);
  });
});
