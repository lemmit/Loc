// Phase 2.4 foundation — hono emits boot-time client modules + deps for
// objectStore / queue / api resources a deployable wires.  No call-sites.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales {
    context Sales { aggregate Order { name: string } }
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

describe("hono resource-client emission", () => {
  it("emits one client module per sourceType with the resource's config", async () => {
    const { files } = generateSystems(await parseValid(SRC));
    const s3 = files.get("api/resources/s3.ts")!;
    expect(s3).toMatch(/S3Client/);
    expect(s3).toMatch(/from "@aws-sdk\/client-s3";/);
    expect(s3).toMatch(/export const salesFiles = new S3Client\(\{/);
    expect(s3).toMatch(/salesFilesBucket = .*"app-files"/);
    expect(s3).toMatch(/"eu-central-1"/);

    const mq = files.get("api/resources/rabbitmq.ts")!;
    expect(mq).toMatch(/import \* as amqp from "amqplib";/);
    expect(mq).toMatch(/export async function salesJobs\$enqueue\(message: unknown\)/);

    const api = files.get("api/resources/restApi.ts")!;
    expect(api).toMatch(/salesApiBaseUrl = .*"https:\/\/pay.example.com"/);
    expect(api).toMatch(/export async function salesApi\$get\(path: string\)/);
  });

  it("adds the client deps to package.json and side-effect-imports the modules at boot", async () => {
    const { files } = generateSystems(await parseValid(SRC));
    const pkg = files.get("api/package.json")!;
    expect(pkg).toMatch(/"@aws-sdk\/client-s3"/);
    expect(pkg).toMatch(/"amqplib"/);

    const index = files.get("api/index.ts")!;
    expect(index).toMatch(/import "\.\/resources\/s3";/);
    expect(index).toMatch(/import "\.\/resources\/rabbitmq";/);
    expect(index).toMatch(/import "\.\/resources\/restApi";/);
  });

  it("emits nothing extra for a postgres-only deployable (byte-identical path)", async () => {
    const postgresOnly = `
system Sys {
  subdomain Sales { context Sales { aggregate Order { name: string } } }
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable api { platform: hono, contexts: [Sales], dataSources: [salesState], port: 3000 }
}
`;
    const { files } = generateSystems(await parseValid(postgresOnly));
    expect([...files.keys()].some((k) => k.startsWith("api/resources/"))).toBe(false);
    expect(files.get("api/package.json")!).not.toMatch(/aws-sdk|amqplib/);
    expect(files.get("api/index.ts")!).not.toMatch(/\.\/resources\//);
  });
});
