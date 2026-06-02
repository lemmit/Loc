// Create-gate regression — non-constructible aggregates emit no create.
//
// After Stage 4 the implicit hard-coded create is gone: a backend emits a
// create surface (route + request DTO + factory/command) only when the
// aggregate declares one — explicit `create(...)` or via `crudish`, which
// lowering records as `canonicalCreate` (`hasCreate`).  An aggregate with
// neither is not constructible over HTTP and emits no create; it is reached
// only through its own operations.  Gated on Hono + .NET (Phoenix models
// all-CRUD via Ash defaults; React's create UI compiles regardless — both
// keep create always-on for now).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

// `Product` is crudish (constructible).  `Ledger` is non-constructible
// under the Stage-4 invariant gate: its invariant (`balance >= 0`)
// references a `managed` field that isn't in the create input, so it can't
// be satisfied by a plain create — Ledger is built only via its `adjust`
// operation.  (A required, undefaulted field alone no longer blocks a
// create; that field would just become a required create param.)
const FIXTURE = `
system Demo {
  subdomain Shop {
    context Catalog {
      aggregate Product with crudish {
        sku: string
        price: decimal
      }
      repository Products for Product { }

      aggregate Ledger {
        balance: decimal managed
        invariant balance >= 0
        operation adjust(delta: decimal) { balance := balance + delta }
      }
      repository Ledgers for Ledger { }
    }
  }
  api ShopApi from Shop
  storage primarySql { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primarySql }
  deployable honoApi   { platform: hono   contexts: [Catalog] dataSources: [catalogState] serves: ShopApi port: 3000 }
  deployable dotnetApi { platform: dotnet contexts: [Catalog] dataSources: [catalogState] serves: ShopApi port: 8080 }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string | undefined {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  return undefined;
}

describe("create gate — non-constructible aggregates emit no create", () => {
  it("Hono: Product has a POST create route; Ledger has none", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const product = findFile(files, /product\.routes\.ts$/i)!;
    const ledger = findFile(files, /ledger\.routes\.ts$/i)!;
    // Product (crudish) carries the create surface.
    expect(product).toMatch(/CreateProductRequest/);
    expect(product).toMatch(/Product\.create\(/);
    // Ledger has no create route, DTO, response or factory call — only its
    // mutating `adjust` op surface remains.
    expect(ledger).not.toMatch(/CreateLedgerRequest/);
    expect(ledger).not.toMatch(/CreateLedgerResponse/);
    expect(ledger).not.toMatch(/Ledger\.create\(/);
    expect(ledger).toMatch(/adjust/i);
  });

  it(".NET: Product emits Create command/DTO/factory; Ledger emits none", async () => {
    const files = await generateSystemFiles(FIXTURE);
    // Product's create CQRS artifacts exist.
    expect(findFile(files, /Commands\/CreateProductCommand\.cs$/)).toBeDefined();
    const productDomain = findFile(files, /Domain\/Products\/Product\.cs$/)!;
    expect(productDomain).toMatch(/public static Product Create\(/);

    // Ledger: no create command/handler, and no public factory.
    expect(findFile(files, /CreateLedgerCommand\.cs$/)).toBeUndefined();
    expect(findFile(files, /CreateLedgerHandler\.cs$/)).toBeUndefined();
    const ledgerDomain = findFile(files, /Domain\/Ledgers\/Ledger\.cs$/)!;
    expect(ledgerDomain).not.toMatch(/public static Ledger Create\(/);

    // Ledger controller has the adjust action but no bare [HttpPost] create.
    const ledgerCtrl = findFile(files, /LedgersController\.cs$/)!;
    expect(ledgerCtrl).not.toMatch(
      /\[HttpPost\]\s*\n\s*\[ProducesResponseType\(typeof\(CreateLedgerResponse\)/,
    );
    expect(ledgerCtrl).not.toMatch(/CreateLedgerResponse/);
    expect(ledgerCtrl).toMatch(/Adjust/);

    // Ledger request DTOs exist (for adjust) but carry no CreateLedgerRequest.
    const ledgerReqs = findFile(files, /Ledgers\/Requests\/LedgerRequests\.cs$/);
    if (ledgerReqs) expect(ledgerReqs).not.toMatch(/CreateLedgerRequest/);
  });
});
