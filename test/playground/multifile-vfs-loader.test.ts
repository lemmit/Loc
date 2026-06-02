import { EmptyFileSystem } from "langium";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel, mergeLoomModels } from "../../src/ir/lower/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { loadProjectFromVfs } from "../../web/src/build/project-loader.js";
import { MemoryVfs } from "../../web/src/vfs/memory-vfs.js";

function makeVfs(files: Record<string, string>): MemoryVfs {
  const vfs = new MemoryVfs();
  vfs.hydrate(Object.entries(files));
  return vfs;
}

describe("playground project loader (VFS-backed)", () => {
  it("loads a single-file project (no imports) just like single-doc parse", async () => {
    const services = createDddServices(EmptyFileSystem);
    const vfs = makeVfs({
      "/workspace/main.ddd": `
        context Sales {
          aggregate Order {
            sku: string
          }
        }
      `,
    });
    const { entry, all } = await loadProjectFromVfs("/workspace/main.ddd", services.shared, vfs);
    expect(all).toHaveLength(1);
    // Langium's URI normalises `inmemory:///x` → `inmemory:/x`; the
    // exact form isn't important, just that it's stable and ends with
    // the VFS path so re-generates land on the same document.
    expect(entry.uri.toString().endsWith("/workspace/main.ddd")).toBe(true);
    expect(entry.uri.toString().startsWith("inmemory:")).toBe(true);
    const errors = (entry.diagnostics ?? []).filter((d) => d.severity === 1);
    expect(errors).toEqual([]);
  });

  it("walks transitive imports through the VFS", async () => {
    const services = createDddServices(EmptyFileSystem);
    const vfs = makeVfs({
      "/workspace/main.ddd": `
        import "./shared/money.ddd"
        import "./orders.ddd"
        system Shop {
          subdomain M { }
          deployable api { platform: hono, contexts: [Orders] }
        }
      `,
      "/workspace/shared/money.ddd": `
        valueobject Money {
          amount: decimal
          currency: string
        }
      `,
      "/workspace/orders.ddd": `
        context Orders {
          aggregate Order {
            total: Money
          }
        }
      `,
    });

    const { all } = await loadProjectFromVfs("/workspace/main.ddd", services.shared, vfs);
    // main, money, orders.
    expect(all).toHaveLength(3);
    // No parse / resolution errors — root-level Money resolves
    // across documents.
    const errors = all.flatMap((d) => (d.diagnostics ?? []).filter((x) => x.severity === 1));
    expect(errors.map((e) => e.message)).toEqual([]);

    // Merge + enrich → root Money present, Order references it.
    const merged = mergeLoomModels(all.map((d) => lowerModel(d.parseResult?.value as Model)));
    const loom = enrichLoomModel(merged);
    expect(loom.rootValueObjects.map((v) => v.name)).toEqual(["Money"]);
    const allCtxs = [
      ...loom.contexts,
      ...loom.systems.flatMap((s) => s.subdomains.flatMap((m) => m.contexts)),
    ];
    expect(allCtxs.map((c) => c.name)).toContain("Orders");
  });

  it("rejects a missing import with the resolved path in the message", async () => {
    const services = createDddServices(EmptyFileSystem);
    const vfs = makeVfs({
      "/workspace/main.ddd": `
        import "./missing.ddd"
        context X { }
      `,
    });
    await expect(loadProjectFromVfs("/workspace/main.ddd", services.shared, vfs)).rejects.toThrow(
      /import not found in VFS:.*missing\.ddd.*\/workspace\/missing\.ddd/,
    );
  });

  it("detects circular imports", async () => {
    const services = createDddServices(EmptyFileSystem);
    const vfs = makeVfs({
      "/workspace/a.ddd": `
        import "./b.ddd"
        context A { }
      `,
      "/workspace/b.ddd": `
        import "./a.ddd"
        context B { }
      `,
    });
    await expect(loadProjectFromVfs("/workspace/a.ddd", services.shared, vfs)).rejects.toThrow(
      /circular \.ddd import/,
    );
  });

  it("deduplicates a file imported by two paths", async () => {
    const services = createDddServices(EmptyFileSystem);
    const vfs = makeVfs({
      "/workspace/main.ddd": `
        import "./a.ddd"
        import "./b.ddd"
        context Z { }
      `,
      "/workspace/a.ddd": `
        import "./shared.ddd"
        context A { }
      `,
      "/workspace/b.ddd": `
        import "./shared.ddd"
        context B { }
      `,
      "/workspace/shared.ddd": `
        valueobject Shared { v: int }
      `,
    });
    const { all } = await loadProjectFromVfs("/workspace/main.ddd", services.shared, vfs);
    expect(all).toHaveLength(4); // not 5 — shared dedup'd
    const merged = mergeLoomModels(all.map((d) => lowerModel(d.parseResult?.value as Model)));
    expect(merged.rootValueObjects.map((v) => v.name)).toEqual(["Shared"]);
  });

  it("resolves `..` segments and rejects root escape", async () => {
    const services = createDddServices(EmptyFileSystem);
    const vfs = makeVfs({
      "/workspace/sub/main.ddd": `
        import "../shared.ddd"
        context X { }
      `,
      "/workspace/shared.ddd": `
        valueobject Money { amount: decimal }
      `,
    });
    const { all } = await loadProjectFromVfs("/workspace/sub/main.ddd", services.shared, vfs);
    expect(all).toHaveLength(2);
    expect(all.some((d) => d.uri.toString().endsWith("/workspace/shared.ddd"))).toBe(true);

    const escVfs = makeVfs({
      "/workspace/main.ddd": `
        import "../../etc/passwd"
        context X { }
      `,
    });
    await expect(
      loadProjectFromVfs("/workspace/main.ddd", services.shared, escVfs),
    ).rejects.toThrow(/escapes root/);
  });

  // Mirrors the worker's full pipeline (`build.worker.ts`
  // handleGenerateFromPath path): load via VFS → lower per doc →
  // merge → enrich → validate → generate.  Proves the playground
  // wiring actually produces a usable file map for a real
  // multi-file source.
  it("end-to-end: VFS multi-file project produces a system file map", async () => {
    const services = createDddServices(EmptyFileSystem);
    const vfs = makeVfs({
      "/workspace/main.ddd": `
        import "./shared/money.ddd"
        system Tiny {
          subdomain M {
            context Catalog {
              aggregate Product {
                sku: string
                price: Money
                create(sku: string, price: Money) { sku := sku  price := price }
              }
              repository Products for Product { }
            }
          }
          deployable api { platform: hono, contexts: [Catalog] }
        }
      `,
      "/workspace/shared/money.ddd": `
        valueobject Money {
          amount: decimal
          currency: string
        }
      `,
    });
    const { all } = await loadProjectFromVfs("/workspace/main.ddd", services.shared, vfs);
    const errors = all.flatMap((d) => (d.diagnostics ?? []).filter((x) => x.severity === 1));
    expect(errors.map((e) => e.message)).toEqual([]);

    const merged = mergeLoomModels(all.map((d) => lowerModel(d.parseResult?.value as Model)));
    const loom = enrichLoomModel(merged);
    const { generateSystemsFromLoom } = await import("../../src/system/index.js");
    const files = generateSystemsFromLoom(loom).files;

    // Money emitted into the deployable's value-objects bundle.
    const vos = files.get("api/domain/value-objects.ts") ?? "";
    expect(vos).toContain("Money");
    // Product's routes reference Money via the shared bundle.
    const routes = files.get("api/http/product.routes.ts") ?? "";
    expect(routes).toContain('import { Money } from "../domain/value-objects"');
  });

  it("re-generate replays through Langium's reset path (same URI, fresh AST)", async () => {
    const services = createDddServices(EmptyFileSystem);
    const vfs = makeVfs({
      "/workspace/main.ddd": `
        context S { aggregate A { x: int } }
      `,
    });
    const first = await loadProjectFromVfs("/workspace/main.ddd", services.shared, vfs);
    // Mutate via VFS — simulates the editor saving an edit.
    vfs.write("/workspace/main.ddd", `context S { aggregate A { x: int, y: int } }`);
    const second = await loadProjectFromVfs("/workspace/main.ddd", services.shared, vfs);
    // Same URI, but fresh document.
    expect(second.entry.uri.toString()).toBe(first.entry.uri.toString());
    const firstCtx = (first.entry.parseResult?.value as Model)
      .members[0] as import("../../src/language/generated/ast.js").BoundedContext;
    const secondCtx = (second.entry.parseResult?.value as Model)
      .members[0] as import("../../src/language/generated/ast.js").BoundedContext;
    const firstAggMembers = (
      firstCtx.members[0] as import("../../src/language/generated/ast.js").Aggregate
    ).members.length;
    const secondAggMembers = (
      secondCtx.members[0] as import("../../src/language/generated/ast.js").Aggregate
    ).members.length;
    expect(secondAggMembers).toBeGreaterThan(firstAggMembers);
  });
});
