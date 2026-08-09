// `.loom/messages.en.json` artifact (M-T1.11, i18n.md Phase 1).
//
// The source-language catalog is emitted for every system next to
// `wire-spec.json`.  These assert its presence, shape (flat, key-sorted JSON),
// content, and the empty-system baseline (`{}`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const UI_SYSTEM = `
  system Shop {
    subdomain Sales {
      context Sales {
        aggregate Order with crudish { status: string }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    ui Web with scaffold(aggregates: [Order]) {
      api Sales: SalesApi
      page Home { route: "/" body: Heading { "Storefront" } }
    }
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api {
      platform: node
      contexts: [Sales]
      dataSources: [salesState]
      serves: SalesApi
      port: 3000
    }
    deployable web {
      platform: react
      targets: api
      ui: Web
      port: 3100
    }
  }
`;

const BACKEND_ONLY = `
  system Api {
    subdomain Sales {
      context Sales {
        aggregate Order with crudish { status: string }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api {
      platform: node
      contexts: [Sales]
      dataSources: [salesState]
      serves: SalesApi
      port: 3000
    }
  }
`;

describe(".loom/messages.en.json catalog artifact", () => {
  it("is emitted with the scaffold's user-visible chrome", async () => {
    const files = await generateSystemFiles(UI_SYSTEM);
    const raw = files.get(".loom/messages.en.json");
    expect(raw).toBeDefined();
    const catalog = JSON.parse(raw!) as Record<string, string>;
    expect(Object.values(catalog)).toContain("Storefront");
    // The scaffold synthesises List/New/Detail pages with humanised chrome.
    expect(Object.values(catalog)).toContain("Orders");
    // Keys are page/menu (authored), chrome.* (the always-rendered app-shell
    // chrome merged for an i18n-enabled system, M-T1.11) or pack.* (the active
    // design pack's DECLARED chrome, D-PACK-CHROME).  Exhaustive on purpose —
    // a stray namespace is a key no `ddd i18n sync` consumer knows how to route.
    expect(
      Object.keys(catalog).every(
        (k) =>
          k.startsWith("page.") ||
          k.startsWith("menu.") ||
          k.startsWith("chrome.") ||
          k.startsWith("pack."),
      ),
    ).toBe(true);
    // The app-shell chrome rode in (404 + skip link).
    expect(catalog["chrome.notFound"]).toBe("Not found");
  });

  it("is a flat, key-sorted JSON object with a trailing newline", async () => {
    const files = await generateSystemFiles(UI_SYSTEM);
    const raw = files.get(".loom/messages.en.json")!;
    expect(raw.endsWith("}\n")).toBe(true);
    const keys = Object.keys(JSON.parse(raw) as Record<string, string>);
    expect(keys).toEqual([...keys].sort());
    // Flat map — every value is a string (no nesting).
    const values = Object.values(JSON.parse(raw) as Record<string, string>);
    expect(values.every((v) => typeof v === "string")).toBe(true);
  });

  it("is present and empty for a backend-only system", async () => {
    const files = await generateSystemFiles(BACKEND_ONLY);
    const raw = files.get(".loom/messages.en.json");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({});
  });
});
