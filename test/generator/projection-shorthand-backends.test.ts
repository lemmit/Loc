// Cross-backend emission of a SHORTHAND (`select`-less) query-time projection:
// `projection ActiveOrders { from Order as o where o.status == "active" }`.  With
// no declared fields and no `select`, the row shape IS the source aggregate's
// full wire shape, and the read returns each filtered source row serialized
// through the aggregate's OWN domain→wire mapper (the same one its findAll route
// uses) — the projection replacement for the removed `view X = A where P`.
//
// One generation per backend; asserts the aggregate-wire read marker and the
// ABSENCE of a broken empty projection (`new ActiveOrdersRow()` with no args,
// `{ }`, `%{}`).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseValid } from "../_helpers/parse.js";

const src = (platform: string) => `
  system S {
    subdomain D { context C {
      aggregate Order { total: int  status: string }
      repository Orders for Order { }
      projection ActiveOrders { from Order as o where o.status == "active" }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable api { platform: ${platform}  contexts: [C]  dataSources: [cState] }
  }
`;

async function allFiles(platform: string): Promise<string> {
  const files = (await generateSystems(await parseValid(src(platform)))).files;
  return [...files.values()].join("\n \n");
}

// The aggregate-wire read marker per backend: each row is the source aggregate's
// own wire serialization, populated field-by-field from the domain object.
const CASES: { platform: string; read: RegExp }[] = [
  { platform: "node", read: /const projected = rows\.map\(\(r\) => repo\.toWire\(r\)\);/ },
  { platform: "python", read: /return \[repo\.to_wire\(r\) for r in rows\]/ },
  {
    platform: "java",
    read: /\.map\(a -> new ActiveOrdersRow\(a\.id\(\)\.value\(\), a\.total\(\), a\.status\(\), a\.version\(\)\)\)/,
  },
  {
    platform: "dotnet",
    read: /domain\.Select\(d => new ActiveOrdersRow\(d\.Id\.Value, d\.Total, d\.Status, d\.Version\)\)\.ToList\(\)/,
  },
  { platform: "elixir", read: /Enum\.map\(rows, &serialize\/1\)/ },
];

describe("shorthand (`select`-less) query-time projection cross-backend read", () => {
  for (const { platform, read } of CASES) {
    it(`${platform}: returns the source aggregate's full wire shape (no empty projection)`, async () => {
      const all = await allFiles(platform);
      expect(all).toMatch(read);
      // Never an empty/garbage row projection.
      expect(all).not.toMatch(/new ActiveOrdersRow\(\s*\)/);
      expect(all).not.toMatch(/ActiveOrdersRow\([^)]*default!/);
    });
  }
});
