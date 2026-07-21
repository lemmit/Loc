// menu emitter.
//
// Tests the explicit-menu-block path: when a `ui` declares
// `menu { section "S" { link Page, link "L" -> "url" } }`, the
// derived `NavSectionVM[]` must match the user's exact layout,
// honouring per-link metadata and resolving page references against
// `ui.pages`.  When no menu block is declared, the function returns
// `undefined` and the caller keeps the legacy hardcoded sidebar
// (byte-equivalence guarantee, exercised separately by
// `test/page-emitter-equivalence.test.ts`).

import { describe, expect, it } from "vitest";
import { deriveSidebarFromUi } from "../../../src/generator/react/menu-emitter.js";
import type { LoomModel, UiIR } from "../../../src/ir/types/loom-ir.js";
import { parseString, toLoomModel } from "../../_helpers/index.js";

async function buildLoom(src: string): Promise<LoomModel> {
  return toLoomModel((await parseString(src, { validate: false })).model);
}

function uiOf(loom: LoomModel, name: string): UiIR {
  const ui = loom.systems[0]!.uis.find((u) => u.name === name);
  if (!ui) throw new Error(`ui '${name}' not found`);
  return ui;
}

function nameCtxOf(loom: LoomModel) {
  const sys = loom.systems[0]!;
  return {
    aggregateNames: sys.subdomains.flatMap((m) =>
      m.contexts.flatMap((c) => c.aggregates.map((a) => a.name)),
    ),
    workflowNames: sys.subdomains.flatMap((m) =>
      m.contexts.flatMap((c) => c.workflows.map((w) => w.name)),
    ),
  };
}

describe("menu emitter", () => {
  it("returns undefined when the ui has no explicit menu block", async () => {
    const loom = await buildLoom(`
      system S {
        subdomain M {
          context C {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
        }
        ui WebApp { scaffold aggregates: Order }
      }
    `);
    const sidebar = deriveSidebarFromUi(uiOf(loom, "WebApp"), nameCtxOf(loom));
    expect(sidebar).toBeUndefined();
  });

  it("walks an explicit ui.menu block into NavSectionVM[]", async () => {
    const loom = await buildLoom(`
      system S {
        subdomain M {
          context C {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
        }
        ui WebApp with scaffold(aggregates: [Order]) {
          menu {
            section "Sales" {
              link List,
              link Detail
            }
            section "External" {
              link "Docs" -> "https://example.com"
            }
          }
        }
      }
    `);
    const sidebar = deriveSidebarFromUi(uiOf(loom, "WebApp"), nameCtxOf(loom));
    expect(sidebar).toBeDefined();
    expect(sidebar!.map((s) => s.label)).toEqual(["Sales", "External"]);
    const sales = sidebar![0]!;
    expect(sales.entries).toHaveLength(2);
    expect(sales.entries[0]!.to).toBe("/orders");
    expect(sales.entries[0]!.testId).toBe("nav-orders");
    expect(sales.entries[0]!.activeArgs).toBe('"/orders"');
    expect(sales.entries[1]!.to).toBe("/orders/:id");
    // Aggregate-detail testid suffix matches the menu emitter's
    // contract (`nav-<plural>-detail`).
    expect(sales.entries[1]!.testId).toBe("nav-orders-detail");
  });

  it("honours per-link `label:` overrides", async () => {
    const loom = await buildLoom(`
      system S {
        subdomain M {
          context C { aggregate Order { x: int } repository Orders for Order { } }
        }
        ui WebApp with scaffold(aggregates: [Order]) {
          menu {
            section "Sales" {
              link List { label: "All Orders" }
            }
          }
        }
      }
    `);
    const sidebar = deriveSidebarFromUi(uiOf(loom, "WebApp"), nameCtxOf(loom))!;
    expect(sidebar[0]!.entries[0]!.label).toBe("All Orders");
  });

  it("falls back to the page's string `title:` (not its name) when no label is given", async () => {
    const loom = await buildLoom(`
      system S {
        ui WebApp {
          page ProjectNew { route: "/projects/new", title: "New project", body: f() }
          page Bare { route: "/bare", body: f() }
          menu {
            section "Main" {
              link ProjectNew,
              link Bare
            }
          }
        }
      }
    `);
    const entries = deriveSidebarFromUi(uiOf(loom, "WebApp"), nameCtxOf(loom))![0]!.entries;
    // `link ProjectNew` (no label) → the human title, not the PascalCase name.
    expect(entries[0]!.label).toBe("New project");
    // A page with no `title:` still falls back to its name.
    expect(entries[1]!.label).toBe("Bare");
  });

  it("emits external links with sentinel `__external:<url>` to value", async () => {
    const loom = await buildLoom(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          menu {
            section "External" {
              link "Docs" -> "https://example.com"
            }
          }
        }
      }
    `);
    const sidebar = deriveSidebarFromUi(uiOf(loom, "WebApp"), nameCtxOf(loom))!;
    const link = sidebar[0]!.entries[0]!;
    expect(link.to).toBe("__external:https://example.com");
    expect(link.label).toBe("Docs");
    expect(link.testId).toBe("nav-ext-docs");
  });

  it("derives correct testIds + activeArgs per archetype kind", async () => {
    const loom = await buildLoom(`
      system S {
        subdomain Sales {
          context Orders {
            aggregate Order { x: int }
            repository Orders for Order { }
            workflow placeOrder {
      create() { let o = Order.create({ }) }
    }
          }
        }
        ui WebApp with scaffold(subdomains: [Sales]) {
          menu {
            section "Mixed" {
              link List,
              link PlaceOrderWorkflow,
              link WorkflowsIndex
            }
          }
        }
      }
    `);
    const entries = deriveSidebarFromUi(uiOf(loom, "WebApp"), nameCtxOf(loom))![0]!.entries;
    expect(entries.map((e) => e.testId)).toEqual([
      "nav-orders",
      "nav-workflow-place_order",
      "nav-workflows",
    ]);
    expect(entries.map((e) => e.activeArgs)).toEqual([
      `"/orders"`,
      `"/workflows/place_order"`,
      `"/workflows", { exact: true }`,
    ]);
  });

  it("silently drops links to pages that aren't in the ui", async () => {
    // Validator already errors on this with "resolves to a
    // page declared outside ui 'X'"; the menu emitter is defensive
    // — it returns no entry rather than crashing if a stale/unknown
    // ref makes it through.
    const loom = await buildLoom(`
      system S {
        ui A { page Home { route: "/", body: f() } }
        ui B {
          menu { section "Main" { link Home } }
        }
      }
    `);
    const sidebar = deriveSidebarFromUi(uiOf(loom, "B"), nameCtxOf(loom))!;
    expect(sidebar[0]!.entries).toEqual([]);
  });

  it("byte-equivalence: when ui has no menu block, AppShell falls back to hardcoded grouping", async () => {
    // This is the negative side of the byte-equivalence guarantee:
    // for the bulk-scaffold default, `deriveSidebarFromUi` returns
    // undefined, the AppShell preparer falls back to its hardcoded
    // Aggregates / Workflows / Views grouping, and the sidebar
    // matches the original sidebar output.  The `test/page-emitter-
    // equivalence.test.ts` file pins the actual file content match
    // for `examples/acme.ddd`; this assertion just locks the menu
    // emitter's contract so a future refactor can't accidentally
    // make it return something non-undefined for the no-menu case.
    const loom = await buildLoom(`
      system S {
        subdomain M {
          context C {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
        }
        ui WebApp { scaffold aggregates: Order }
      }
    `);
    expect(deriveSidebarFromUi(uiOf(loom, "WebApp"), nameCtxOf(loom))).toBeUndefined();
  });

  it("disambiguates role-named pages via qualified `Area.Page` links", async () => {
    const loom = await buildLoom(`
      system S {
        subdomain M {
          context C {
            aggregate Order { x: int }
            aggregate Item { x: int }
            repository Orders for Order { }
            repository Items for Item { }
          }
        }
        ui WebApp with scaffold(aggregates: [Order, Item]) {
          menu {
            section "Main" {
              link Items.List,
              link Orders.List
            }
          }
        }
      }
    `);
    const sidebar = deriveSidebarFromUi(uiOf(loom, "WebApp"), nameCtxOf(loom))!;
    const entries = sidebar[0]!.entries;
    // Both links are named `List` (role-scoped); the qualifier must route each
    // to its OWN aggregate page, in link order — not both to the first `List`.
    expect(entries.map((e) => e.to)).toEqual(["/items", "/orders"]);
    expect(entries.map((e) => e.testId)).toEqual(["nav-items", "nav-orders"]);
  });
});
