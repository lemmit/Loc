// Regression: the Hono backend must emit the zod schema for an enum
// reached only THROUGH a value object's field.
//
// A route file emits `const <Vo>Schema = z.object({ <field>: <type>Schema })`
// for every value object on the aggregate's HTTP surface; an enum-typed
// field renders as that enum's `<Enum>Schema`.  The schema collector
// previously walked only the aggregate's own field/param types, so an enum
// referenced solely by a nested value object (e.g. `Address.country:
// Country`) was never collected — the emitted `AddressSchema` then
// referenced an undeclared `CountrySchema`, which the playground bundler
// rejects with "CountrySchema is not defined".  Mirrors the Acme ERP
// `Address`/`Country` shape from shared/geo.ddd.  Sibling of the React-side
// guard in test/generator/react/transitive-vo-enum-schema.test.ts.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  enum Country { US, GB, DE }

  valueobject Address {
    line1: string
    city: string
    country: Country
  }

  system Sys {
    subdomain Sales {
      context Sales {
        aggregate Customer {
          name: string
          shipTo: Address
        }
        repository Customers for Customer {}
      }
    }
    storage primary { type: postgres }
    deployable api {
      platform: node
      contexts: [Sales]
      port: 3000
    }
  }
`;

async function routesFile(): Promise<string> {
  const files = (await generateSystems(await parseValid(SRC))).files;
  // The per-aggregate route module that emits the wire schemas.
  const path = [...files.keys()].find((k) => k.endsWith("/http/customer.routes.ts"));
  expect(path, "customer.routes.ts not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("Hono routes — transitive enum schema through a value object", () => {
  it("declares the enum schema reached only through a value-object field", async () => {
    const routes = await routesFile();
    // The VO schema references CountrySchema …
    expect(routes).toContain("country: CountrySchema");
    // … so CountrySchema itself must be declared, before the VO that uses it.
    expect(routes).toContain(`const CountrySchema = z.enum(["US", "GB", "DE"])`);
    expect(routes.indexOf("const CountrySchema")).toBeLessThan(
      routes.indexOf("const AddressSchema"),
    );
  });
});
