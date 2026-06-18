// Architecture-integration test — exercises every piece of the new
// composition model in one .ddd source: api declarations, storage
// declarations, UI api parameters, body refs through them, walker
// hook injection, backend `serves:`, frontend `ui: WebApp { … }`
// compose-block, per-module storage maps.
//
// Acts as the single end-to-end regression: if any architectural
// slice (11.24 / 11.25 / 11.26 / 11.27) breaks, this file catches
// it.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

const ACME_EXPLICIT = `
system Acme {

  // ── LAYER 1: domain ─────────────────────────────────────────
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string }
      repository Customers for Customer {
        find byEmail(email: string): Customer?
      }
    }
  }
  subdomain Marketing {
    context Campaigns {
      aggregate Campaign { name: string }
    }
  }

  // ── LAYER 2: api contracts ──────────────────────────────────
  api SalesApi      from Sales
  api MarketingApi  from Marketing

  // ── LAYER 3: storage instances ──────────────────────────────
  storage primarySql    { type: postgres   }
  storage marketingSql  { type: postgres   }
  storage hotCache      { type: redis      }
  storage warehouse     { type: clickhouse }

  // ── LAYER 4: UI consumer ────────────────────────────────────
  ui WebApp {
    api Sales: SalesApi
    api Mktg:  MarketingApi

    page Home {
      route: "/"
      body: Stack {
        Heading { "Acme" },
        Text { Sales.Customer.all.isLoading }
      }
    }

    page CustomerNew {
      route: "/customers/new"
      state { name: string = "" }
      body: Stack {
        Field { "Name", bind: name },
        Button {"Save",
          disabled: Sales.Customer.create.isPending,
          onClick: e => {
            Sales.Customer.create.mutate({ name: name })
          }}
      }
    }

    page Lookup(email: string) {
      route: "/customers/lookup/:email"
      body: Text { Sales.Customer.byEmail(email).isLoading }
    }
  }

  // ── COMPOSITION: deployables ────────────────────────────────
  deployable salesApi {
    platform: node
    contexts: [Orders]
    serves: SalesApi
    port: 3000
  }

  resource campaignsState { for: Campaigns, kind: state, use: marketingSql }
  resource campaignsCache { for: Campaigns, kind: cache, use: hotCache }

  deployable mktgApi {
    platform: node
    contexts: [Campaigns]
    dataSources: [campaignsState, campaignsCache]
    serves: MarketingApi
    port: 3001
  }

  deployable webApp {
    platform: static
    targets: salesApi
    ui: WebApp { Sales: salesApi, Mktg: mktgApi }
    port: 3002
  }
}
`;

async function build(source: string) {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(source, { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
  return {
    errors,
    files:
      errors.length === 0
        ? generateSystems(doc.parseResult.value as Model).files
        : new Map<string, string>(),
  };
}

describe("Architecture integration — full Acme example", () => {
  it("parses and validates the full system without errors", async () => {
    const { errors } = await build(ACME_EXPLICIT);
    expect(errors).toEqual([]);
  });

  it("generates Home page with `useAllCustomers()` hook", async () => {
    const { files } = await build(ACME_EXPLICIT);
    const home = files.get("web_app/src/pages/home.tsx")!;
    expect(home).toBeDefined();
    expect(home).toMatch(/import \{ useAllCustomers \} from "\.\.\/api\/customer";/);
    expect(home).toMatch(/const customerAll = useAllCustomers\(\);/);
    expect(home).toMatch(/<Text>\{customerAll\.isLoading\}<\/Text>/);
  });

  it("generates CustomerNew page with `useCreateCustomer()` mutation", async () => {
    const { files } = await build(ACME_EXPLICIT);
    const newPage = files.get("web_app/src/pages/customer_new.tsx")!;
    expect(newPage).toBeDefined();
    expect(newPage).toMatch(/import \{ useCreateCustomer \} from "\.\.\/api\/customer";/);
    expect(newPage).toMatch(/const customerCreate = useCreateCustomer\(\);/);
    // disabled wired to .isPending
    expect(newPage).toMatch(/disabled=\{customerCreate\.isPending\}/);
    // onClick wired to .mutate (object-literal arg passes through)
    expect(newPage).toMatch(/customerCreate\.mutate\(\{ name: name \}\)/);
  });

  it("generates Lookup page with parameterized `useByEmailCustomer({ email })`", async () => {
    const { files } = await build(ACME_EXPLICIT);
    const lookup = files.get("web_app/src/pages/lookup.tsx")!;
    expect(lookup).toBeDefined();
    expect(lookup).toMatch(/import \{ useByEmailCustomer \} from "\.\.\/api\/customer";/);
    // Object-shaped query arg — the emitted hook signature takes the
    // find's `<Find>Query` object (api-builder.ts), built from the
    // positional DSL args by the walker's find-hook adjustment.
    expect(lookup).toMatch(/const customerByEmail = useByEmailCustomer\(\{ email: email \}\);/);
    // route param destructured from useParams above the hook.
    expect(lookup).toMatch(/const \{ email \} = useParams<\{ email: string \}>\(\);/);
  });

  it("rejects shape if a UI param is unbound at deployable level", async () => {
    const broken = ACME_EXPLICIT.replace(
      "ui: WebApp { Sales: salesApi, Mktg: mktgApi }",
      "ui: WebApp { Sales: salesApi }",
    );
    const { errors } = await build(broken);
    expect(
      errors.some((e) => /missing a binding for ui parameter 'Mktg: MarketingApi'/.test(e)),
    ).toBe(true);
  });

  it("rejects shape if backend doesn't serve a bound UI param's api", async () => {
    const broken = ACME_EXPLICIT.replace("serves: MarketingApi\n    port: 3001", "port: 3001");
    const { errors } = await build(broken);
    expect(errors.some((e) => /'mktgApi' does not 'serves: MarketingApi'/.test(e))).toBe(true);
  });

  // The legacy "primary storage missing" validation is gone — per
  // D-STORAGE-SPLIT, the equivalent check (a state-based aggregate's
  // context needs a `kind: state` dataSource) lives at the IR layer.
});
