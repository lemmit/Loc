// ---------------------------------------------------------------------------
// The soft-delete flag is part of the cross-backend API-read contract.  The
// built-in `softDeletable` capability declares `isDeleted` as `managed` (not
// `internal`), so it rides `forApiRead` onto every backend's `<Agg>Response`
// as a required boolean — matching Hono's canonical shape (which walks the
// full wire shape).  Without this, .NET / Python / Phoenix dropped the flag
// (they filter `internal`), leaving the Squad response divergent under the
// conformance-parity gate.  One assertion per non-node backend.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const src = (platform: string) => `
system S {
  subdomain M {
    context C {
      aggregate Squad ids guid with softDeletable {
        name: string
      }
      repository Squads for Squad {}
    }
  }
  api A from M
  storage pg { type: postgres }
  resource sState { for: C, kind: state, use: pg }
  deployable api {
    platform: ${platform}
    contexts: [C]
    serves: A
    dataSources: [sState]
    port: 8080
  }
}
`;

const file = (files: Map<string, string>, suffix: string): string => {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
};

describe("soft-delete flag on the cross-backend response contract", () => {
  it("java: SquadResponse record carries a boolean isDeleted", async () => {
    const files = await generateSystemFiles(src("java"));
    const resp = file(files, "/SquadResponse.java");
    expect(resp).toMatch(/record SquadResponse\([^)]*boolean isDeleted[^)]*\)/);
  });

  it("java: the OpenAPI customizer marks isDeleted required on SquadResponse", async () => {
    const files = await generateSystemFiles(src("java"));
    const cust = file(files, "/OpenApiContractCustomizer.java");
    const line = cust.split("\n").find((l) => l.includes('new RequiredSet("SquadResponse"'));
    expect(line, "SquadResponse required set not emitted").toBeDefined();
    expect(line!).toContain('"isDeleted"');
  });

  it("python: SquadResponse pydantic model carries a required isDeleted: bool", async () => {
    const files = await generateSystemFiles(src("python"));
    const routes = file(files, "squad_routes.py");
    expect(routes).toMatch(/class SquadResponse\(BaseModel\):[\s\S]*?\n {4}isDeleted: bool\n/);
  });

  it("elixir: the SquadResponse OpenApiSpex schema lists isDeleted as required", async () => {
    const files = await generateSystemFiles(src("elixir { foundation: vanilla }"));
    const schema = file(files, "/api/schemas/squad_response.ex");
    expect(schema).toContain("isDeleted: %OpenApiSpex.Schema{type: :boolean}");
    expect(schema).toMatch(/required: \[[^\]]*:isDeleted[^\]]*\]/);
  });
});
