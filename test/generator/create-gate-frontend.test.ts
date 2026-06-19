// Create-gate — Phoenix/Ash + frontend scaffold (DEBT-09).
//
// A non-constructible aggregate (`!isConstructible`: no `create` /`crudish`,
// and an invariant the create input can't satisfy) used to keep its create
// surface on Phoenix (Ash defaults to all-CRUD) and on the frontends (the
// scaffold always emitted a `<Agg>New` page + a list "New" button).  Both
// now suppress it, matching the Hono/.NET backends (create-gate.test.ts).
//
// `Product` (crudish) is constructible and keeps its create surface;
// `Ledger` (managed `balance` + `invariant balance >= 0`, built only via its
// `adjust` op) is non-constructible.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const DOMAIN = `
    aggregate Product with crudish { sku: string  price: decimal }
    repository Products for Product { }
    aggregate Ledger {
      balance: decimal managed
      invariant balance >= 0
      operation adjust(delta: decimal) { balance := balance + delta }
    }
    repository Ledgers for Ledger { }`;

const reactSys = `
system Demo {
  subdomain Shop { context Catalog {${DOMAIN}
  } }
  api ShopApi from Shop
  ui Admin with scaffold(subdomains: [Shop]) { }
  deployable api { platform: node, contexts: [Catalog], serves: ShopApi, port: 3000 }
  deployable web { platform: react, targets: api, ui: Admin, port: 3001 }
}`;

const phoenixSys = `
system Demo {
  subdomain Shop { context Catalog {${DOMAIN}
  } }
  api ShopApi from Shop
  ui Admin with scaffold(subdomains: [Shop]) { }
  deployable app { platform: phoenix, contexts: [Catalog], serves: ShopApi, ui: Admin, port: 4000 }
}`;

const has = (files: Map<string, string>, re: RegExp): boolean =>
  [...files.keys()].some((k) => re.test(k));
const file = (files: Map<string, string>, re: RegExp): string =>
  [...files.entries()].find(([p]) => re.test(p))?.[1] ?? "";

describe("create gate — frontend scaffold (DEBT-09)", () => {
  it("React: the constructible aggregate keeps its New page + list button", async () => {
    const files = await generateSystemFiles(reactSys);
    expect(has(files, /products\/new\.tsx$/)).toBe(true);
    expect(file(files, /products\/list\.tsx$/)).toContain("products-list-create");
  });

  it("React: the non-constructible aggregate drops its New page + list button", async () => {
    const files = await generateSystemFiles(reactSys);
    expect(has(files, /ledgers\/new\.tsx$/)).toBe(false);
    const list = file(files, /ledgers\/list\.tsx$/);
    expect(list).not.toContain("ledgers-list-create");
    // The list page itself still exists (read surface is unaffected).
    expect(list).not.toBe("");
  });
});

describe("create gate — Phoenix/Ash (DEBT-09)", () => {
  it("emits a :create action for the constructible aggregate only", async () => {
    const files = await generateSystemFiles(phoenixSys);
    expect(file(files, /product\.ex$/)).toContain("create :create do");
    expect(file(files, /ledger\.ex$/)).not.toContain("create :create do");
    // Ledger's own mutating action survives.
    expect(file(files, /ledger\.ex$/)).toMatch(/:adjust/);
  });
});
