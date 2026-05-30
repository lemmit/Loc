// Phase 4b — hono emits the full verb helper set + imports for queue/api
// and the remaining objectStore verbs.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales { context Sales {
    aggregate Order { name: string }
    workflow Archive(name: string) {
      let url = salesFiles.signedUrl("k/" + name)
      let keys = salesFiles.list("k/")
      salesFiles.delete("k/" + name)
      salesJobs.enqueue(name)
      salesJobs.publish("events", name)
      let rate = salesApi.get("/rate")
      let res = salesApi.post("/charge", name)
    }
  } }
  storage pg { type: postgres }
  storage files { type: s3, config: { bucket: "app-files" } }
  storage bus { type: rabbitmq }
  storage pay { type: restApi, config: { baseUrl: "https://pay.example.com" } }
  resource salesState { for: Sales, kind: state, use: pg }
  resource salesFiles { for: Sales, kind: objectStore, use: files }
  resource salesJobs  { for: Sales, kind: queue, use: bus }
  resource salesApi   { for: Sales, kind: api, use: pay }
  deployable api { platform: hono, contexts: [Sales], dataSources: [salesState, salesFiles, salesJobs, salesApi], port: 3000 }
}`;

describe("hono 4b verb emission", () => {
  it("emits objectStore list/signedUrl/delete helpers + presigner import/dep", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const { files } = generateSystems(model);
    const s3 = files.get("api/resources/s3.ts")!;
    expect(s3).toMatch(/getSignedUrl/);
    expect(s3).toMatch(/ListObjectsV2Command/);
    expect(s3).toMatch(/DeleteObjectCommand/);
    expect(s3).toMatch(/export async function salesFiles\$signedUrl/);
    expect(s3).toMatch(/export async function salesFiles\$list/);
    expect(s3).toMatch(/export async function salesFiles\$delete/);
    expect(files.get("api/package.json")!).toMatch(/@aws-sdk\/s3-request-presigner/);
  });

  it("emits queue enqueue/publish helpers", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const { files } = generateSystems(model);
    const mq = files.get("api/resources/rabbitmq.ts")!;
    expect(mq).toMatch(/export async function salesJobs\$enqueue/);
    expect(mq).toMatch(/export async function salesJobs\$publish/);
    expect(mq).toMatch(/assertQueue\("salesJobs"/);
  });

  it("emits api get/post helpers", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const { files } = generateSystems(model);
    const api = files.get("api/resources/restApi.ts")!;
    expect(api).toMatch(/export async function salesApi\$get/);
    expect(api).toMatch(/export async function salesApi\$post/);
  });

  it("imports every used helper into the workflow file", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const { files } = generateSystems(model);
    const wf = files.get("api/http/workflows.ts")!;
    expect(wf).toMatch(/from "\.\.\/resources\/s3"/);
    expect(wf).toMatch(/from "\.\.\/resources\/rabbitmq"/);
    expect(wf).toMatch(/from "\.\.\/resources\/restApi"/);
    expect(wf).toMatch(/await salesFiles\$signedUrl\(/);
    expect(wf).toMatch(/await salesJobs\$publish\(/);
    expect(wf).toMatch(/await salesApi\$post\(/);
  });
});
