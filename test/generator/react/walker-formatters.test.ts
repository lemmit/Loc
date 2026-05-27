// formatter primitives in walker stdlib.
//
// Money / DateDisplay / EnumBadge / IdLink lower to per-pack
// runtime helpers (`MoneyValue`, `DateTimeValue`, `Badge`, plus
// `IdValue` + react-router `<RouterLink>` for IdLink).  All four accept
// the standard `testid:` named arg and thread it to the rendered
// root element.
//
// What this pins:
//   1. Money { value, currency?, decimals? } — emits <MoneyValue …>
//   2. DateDisplay { value }                  — emits <DateTimeValue …>
//   3. EnumBadge { value, color? }            — emits <Badge …> with
//      mantine `color={…}` / shadcn `variant={…}`
//   4. IdLink { id, of: <Aggregate> }         — emits <RouterLink to=…>
//      <IdValue id=… /></RouterLink> with the path derived from
//      pluralized + snake-cased aggregate name.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

function pageWithBody(body: string): string {
  return `
    system S {
      module M { context C { } }
      ui WebApp {
        page P {
          route: "/p"
          body:  ${body}
        }
      }
      deployable api { platform: hono, modules: M, port: 3000 }
      deployable web {
        platform: static
        targets: api
        ui: WebApp
        port: 3001
      }
    }
  `;
}

async function emit(body: string): Promise<string> {
  const files = await buildAndGenerate(pageWithBody(body));
  const tsx = files.get("web/src/pages/p.tsx");
  if (!tsx) throw new Error(`expected web/src/pages/p.tsx; got: ${[...files.keys()].join(", ")}`);
  return tsx;
}

describe("formatter primitives", () => {
  it("Money { 123.45 } emits <MoneyValue value={123.45} /> with the format helper imported", async () => {
    const tsx = await emit(`Money { 123.45 }`);
    expect(tsx).toMatch(/<MoneyValue value=\{ 123\.45 \}/);
    expect(tsx).toMatch(/import \{[^}]*\bMoneyValue\b[^}]*\} from "\.\.\/lib\/format"/);
  });

  it('Money { value, currency: "EUR", decimals: 0 } threads currency + decimals', async () => {
    const tsx = await emit(`Money { 100, currency: "EUR", decimals: 0 }`);
    expect(tsx).toMatch(/<MoneyValue value=\{ 100 \} currency="EUR" decimals=\{ 0 \}/);
  });

  it("Money testid lands on the root <MoneyValue>", async () => {
    const tsx = await emit(`Money { 0, testid: "balance" }`);
    expect(tsx).toMatch(/<MoneyValue[^>]*\bdata-testid="balance"/);
  });

  it("DateDisplay { value } emits <DateTimeValue iso={…}/>", async () => {
    const tsx = await emit(`DateDisplay { "2026-01-01" }`);
    expect(tsx).toMatch(/<DateTimeValue iso=\{ "2026-01-01" \}/);
    expect(tsx).toMatch(/import \{[^}]*\bDateTimeValue\b[^}]*\} from "\.\.\/lib\/format"/);
  });

  it("DateDisplay testid lands on the root <DateTimeValue>", async () => {
    const tsx = await emit(`DateDisplay { "2026-01-01", testid: "created-at" }`);
    expect(tsx).toMatch(/<DateTimeValue[^>]*\bdata-testid="created-at"/);
  });

  it("EnumBadge { value } emits <Badge>{value}</Badge>", async () => {
    const tsx = await emit(`EnumBadge { "active" }`);
    expect(tsx).toMatch(/<Badge[^>]*>\{ "active" \}<\/Badge>/);
  });

  it("EnumBadge color: lands as a Mantine color={…} prop", async () => {
    const tsx = await emit(`EnumBadge { "active", color: "green" }`);
    expect(tsx).toMatch(/<Badge color="green"[^>]*>\{ "active" \}<\/Badge>/);
  });

  it("EnumBadge testid lands on the root <Badge>", async () => {
    const tsx = await emit(`EnumBadge { "active", testid: "status" }`);
    expect(tsx).toMatch(/<Badge[^>]*\bdata-testid="status"/);
  });

  it("IdLink emits a <RouterLink> to /<plural-snake>/{id} wrapping <IdValue>", async () => {
    // We need the page to have a route param to feed the IdLink id.
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Customer { name: string }
            repository Customers for Customer { }
          }
        }
        ui WebApp {
          page CustomerLink(customerId: string) {
            route: "/customer-link/:customerId"
            body:  IdLink { customerId, of: Customer }
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const tsx = files.get("web/src/pages/customer_link.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/<RouterLink to=\{`\/customers\/\$\{ customerId \}`\}[^>]*>/);
    expect(tsx).toMatch(/<IdValue id=\{ customerId \} \/>/);
    expect(tsx).toMatch(/import \{[^}]*\bLink as RouterLink\b[^}]*\} from "react-router"/);
    expect(tsx).toMatch(/import \{[^}]*\bIdValue\b[^}]*\} from "\.\.\/lib\/format"/);
  });

  it("IdLink testid lands on the root <RouterLink>", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Customer { name: string }
            repository Customers for Customer { }
          }
        }
        ui WebApp {
          page CustomerLink(customerId: string) {
            route: "/customer-link/:customerId"
            body:  IdLink { customerId, of: Customer, testid: "customer-link" }
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const tsx = files.get("web/src/pages/customer_link.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/<RouterLink [^>]*\bdata-testid="customer-link"/);
  });
});
