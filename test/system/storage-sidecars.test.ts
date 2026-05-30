// Phase 2.3 — docker-compose sidecars for object-store / queue storages.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseValid } from "../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales {
    context Sales { aggregate Order { name: string } }
  }
  storage pg    { type: postgres }
  storage files { type: s3,    config: { bucket: "app-files" } }
  storage bus   { type: rabbitmq, config: { vhost: "/" } }

  resource salesState { for: Sales, kind: state,       use: pg }
  resource salesFiles { for: Sales, kind: objectStore, use: files }
  resource salesJobs  { for: Sales, kind: queue,       use: bus }

  deployable api {
    platform: hono
    contexts: [Sales]
    dataSources: [salesState, salesFiles, salesJobs]
    port: 3000
  }
}
`;

describe("storage sidecars in docker-compose", () => {
  it("emits a minio service + volume for an s3 storage and a rabbitmq service", async () => {
    const { files } = generateSystems(await parseValid(SRC));
    const compose = files.get("docker-compose.yml")!;
    expect(compose).toMatch(/image: minio\/minio:latest/);
    expect(compose).toMatch(/image: rabbitmq:3-management/);
    expect(compose).toMatch(/files:\n {4}image: minio/);
    expect(compose).toMatch(/bus:\n {4}image: rabbitmq/);
    // the postgres db service + its volume are still present
    expect(compose).toMatch(/image: postgres:16-alpine/);
    expect(compose).toMatch(/files-data: \{\}/);
    expect(compose).toMatch(/pgdata: \{\}/);
  });

  it("emits no sidecars for a postgres-only model (byte-identical path)", async () => {
    const postgresOnly = `
system Sys {
  subdomain Sales { context Sales { aggregate Order { name: string } } }
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable api { platform: hono, contexts: [Sales], dataSources: [salesState], port: 3000 }
}
`;
    const { files } = generateSystems(await parseValid(postgresOnly));
    const compose = files.get("docker-compose.yml")!;
    expect(compose).not.toMatch(/minio|rabbitmq/);
  });
});
