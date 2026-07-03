// The `<Agg>Response` Zod schema must decide field visibility exactly like
// `repo.toWire` (both project through `forApiRead`): an `internal` field
// (softDeletable's `isDeleted`) or a `secret` one never reaches a read
// response, so the OpenAPI schema must not declare it either — declaring it
// drifts the spec from the wire AND from the other backends (caught live by
// conformance-parity as `SquadResponse: only-node=[isDeleted]`).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const SRC = `system S {
  subdomain Core {
    context C {
      aggregate Squad with crudish, softDeletable {
        name: string
        apiKey: string secret
      }
      repository Squads for Squad { }
    }
  }
  api A from Core
  deployable api { platform: node contexts: [C] serves: A port: 3000 }
}`;

async function routesFile(): Promise<string> {
  const { model, errors } = await parseString(SRC);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  const files = generateSystems(model).files;
  return files.get("api/http/squad.routes.ts") ?? "";
}

describe("Hono response schema visibility (forApiRead parity with toWire)", () => {
  it("excludes internal + secret fields from the <Agg>Response zod schema", async () => {
    const routes = await routesFile();
    // Scope to the response schema — `apiKey` legitimately appears in
    // CreateSquadRequest (secret = client write-only, accepted on create).
    const m = /export const SquadResponse = z\.object\(\{[\s\S]*?\}\)/.exec(routes);
    expect(m, "SquadResponse schema present").toBeTruthy();
    const schema = m![0];
    // internal (softDeletable's isDeleted) and secret (apiKey) never cross a read.
    expect(schema).not.toContain("isDeleted:");
    expect(schema).not.toContain("apiKey:");
    // managed (deletedAt) and declared fields stay on the wire.
    expect(schema).toContain("deletedAt:");
    expect(schema).toContain("name: z.string(),");
  });
});
