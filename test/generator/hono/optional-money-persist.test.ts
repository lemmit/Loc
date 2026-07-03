import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// Optional money / decimal fields are `Decimal | null` / `number | null` on
// the domain object, so the repository save row must guard the persist
// conversion: an unguarded `aggregate.cost.toString()` fails `tsc --strict`
// (TS18047) and `String(null)` would persist the literal string "null".
// Caught by the showcase tsc gate (S3 of
// docs/audits/generated-code-ddd-review-2026-07.md).
const FIXTURE = `system Shop {
  subdomain Sales {
    context Billing {
      aggregate Invoice with crudish {
        number: string
        cost: money?
        discount: decimal?
      }
      repository Invoices for Invoice { }
    }
  }
  api SalesApi from Sales
  deployable api {
    platform: node
    contexts: [Billing]
    serves: SalesApi
    port: 3000
  }
}
`;

describe("optional money/decimal persist (Hono repository save)", () => {
  it("null-guards the row projection of optional money and decimal fields", async () => {
    const { model, errors } = await parseString(FIXTURE);
    if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
    const files = generateSystems(model).files;
    let repo: string | undefined;
    for (const [k, v] of files) if (/\/db\/repositories\/invoice-repository\.ts$/.test(k)) repo = v;
    if (!repo) throw new Error("invoice-repository.ts not emitted");

    // money? — guarded Decimal.toString().
    expect(repo).toContain("cost: aggregate.cost === null ? null : aggregate.cost.toString()");
    expect(repo).not.toContain("cost: aggregate.cost.toString()");
    // decimal? — guarded String(...), never String(null).
    expect(repo).toContain(
      "discount: aggregate.discount === null ? null : String(aggregate.discount)",
    );
  });
});
