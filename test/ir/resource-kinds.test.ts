// Phase 2 — new infrastructure kinds (objectStore / queue / api) and the
// generic `config` map + its registry-driven validation.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const valid = `
system Sys {
  subdomain Sales {
    context Sales {
      aggregate Order { name: string }
    }
  }
  storage pg    { type: postgres }
  storage files { type: s3,    config: { region: "eu-central-1", bucket: "app-files" } }
  storage bus   { type: rabbitmq, config: { vhost: "/" } }
  storage pay   { type: restApi,  config: { baseUrl: "https://pay.example.com" } }

  resource salesState { for: Sales, kind: state,       use: pg }
  resource salesFiles { for: Sales, kind: objectStore, use: files }
  resource salesJobs  { for: Sales, kind: queue,       use: bus }
  resource salesApi   { for: Sales, kind: api,         use: pay }

  deployable api {
    platform: hono
    contexts: [Sales]
    dataSources: [salesState, salesFiles, salesJobs, salesApi]
    port: 3000
  }
}
`;

async function irDiagnostics(source: string) {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

describe("new infrastructure kinds", () => {
  it("accepts objectStore / queue / api resources on their matching sourceTypes", async () => {
    const { errors } = await parseString(valid);
    expect(errors).toEqual([]);
  });

  it("rejects a kind on an incompatible sourceType (objectStore on postgres)", async () => {
    const { errors } = await parseString(
      valid.replace(
        "resource salesFiles { for: Sales, kind: objectStore, use: files }",
        "resource salesFiles { for: Sales, kind: objectStore, use: pg }",
      ),
    );
    expect(errors.some((e) => /kind 'objectStore' is incompatible with storage 'pg'/.test(e))).toBe(
      true,
    );
  });

  it("lowers the config map into typed IR entries", async () => {
    const { model } = await parseString(valid, { validate: false });
    const sys = lowerModel(model).systems[0]!;
    const files = sys.storages.find((s) => s.name === "files")!;
    expect(files.config).toEqual([
      { key: "region", value: { kind: "string", value: "eu-central-1" } },
      { key: "bucket", value: { kind: "string", value: "app-files" } },
    ]);
  });
});

describe("config-map validation", () => {
  it("is clean for a valid model", async () => {
    const diags = await irDiagnostics(valid);
    expect(diags.filter((d) => /config key|required config/.test(d.message))).toEqual([]);
  });

  it("errors when a required config key is missing (s3 needs bucket)", async () => {
    const diags = await irDiagnostics(
      valid.replace(
        `config: { region: "eu-central-1", bucket: "app-files" }`,
        `config: { region: "eu-central-1" }`,
      ),
    );
    expect(
      diags.some((d) => d.severity === "error" && /required config key 'bucket'/.test(d.message)),
    ).toBe(true);
  });

  it("warns on an unrecognised config key", async () => {
    const diags = await irDiagnostics(
      valid.replace(`config: { vhost: "/" }`, `config: { vhost: "/", bogus: "x" }`),
    );
    expect(
      diags.some(
        (d) => d.severity === "warning" && /config key 'bogus' is not recognised/.test(d.message),
      ),
    ).toBe(true);
  });

  it("errors on a wrong-typed config value", async () => {
    const diags = await irDiagnostics(
      valid.replace(`config: { baseUrl: "https://pay.example.com" }`, `config: { baseUrl: 8080 }`),
    );
    expect(
      diags.some(
        (d) => d.severity === "error" && /config key 'baseUrl' expects string/.test(d.message),
      ),
    ).toBe(true);
  });
});
