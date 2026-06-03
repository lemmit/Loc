// Phase 4c — .NET emits resource client classes + awaited call sites.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales { context Sales {
    aggregate Order { name: string }
    workflow Archive {
      create(name: string) {
      let prev = salesFiles.get("orders/" + name)
      salesFiles.put("orders/" + name, name)
      let url = salesFiles.signedUrl("orders/" + name)
      salesJobs.enqueue(name)
      let rate = salesApi.get("/rate")
    }
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
  deployable api { platform: dotnet, contexts: [Sales], dataSources: [salesState, salesFiles, salesJobs, salesApi], port: 5000 }
}`;

async function gen() {
  const { model } = await parseString(SRC, { validate: false });
  return generateSystems(model).files;
}

describe(".NET resource client emission", () => {
  it("emits a static helper class per sourceType under Resources/", async () => {
    const files = await gen();
    const s3 = files.get("api/Resources/S3Resources.cs")!;
    expect(s3).toMatch(/using Amazon.S3;/);
    expect(s3).toMatch(/public static class S3Resources/);
    expect(s3).toMatch(/public static async Task SalesFiles_Put\(string key, string body\)/);
    expect(s3).toMatch(/public static async Task<string\?> SalesFiles_Get\(string key\)/);
    expect(s3).toMatch(/GetPreSignedURL/);

    const mq = files.get("api/Resources/RabbitmqResources.cs")!;
    expect(mq).toMatch(/using RabbitMQ.Client;/);
    expect(mq).toMatch(/public static async Task SalesJobs_Enqueue\(string message\)/);
    expect(mq).toMatch(/CreateChannelAsync/);

    const api = files.get("api/Resources/RestApiResources.cs")!;
    expect(api).toMatch(/public static async Task<string> SalesApi_Get\(string path\)/);
  });

  it("adds the NuGet refs to the csproj", async () => {
    const csproj = (await gen()).get("api/Api.csproj")!;
    expect(csproj).toMatch(/<PackageReference Include="AWSSDK.S3"/);
    expect(csproj).toMatch(/<PackageReference Include="RabbitMQ.Client"/);
  });

  it("renders the workflow body calling the awaited helpers with the resource using", async () => {
    const files = await gen();
    const wf = [...files.keys()].find((k) => /Workflows\/ArchiveHandler\.cs$/.test(k));
    expect(wf).toBeDefined();
    const body = files.get(wf!)!;
    expect(body).toMatch(/using Api.Resources;/);
    expect(body).toMatch(/var prev = await S3Resources.SalesFiles_Get\(/);
    expect(body).toMatch(/await S3Resources.SalesFiles_Put\(/);
    expect(body).toMatch(/await RabbitmqResources.SalesJobs_Enqueue\(/);
    expect(body).toMatch(/await RestApiResources.SalesApi_Get\(/);
  });

  it("emits nothing extra for a resource-op-free dotnet deployable", async () => {
    const plain = `
system Sys {
  subdomain Sales { context Sales { aggregate Order { name: string } } }
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable api { platform: dotnet, contexts: [Sales], dataSources: [salesState], port: 5000 }
}`;
    const { model } = await parseString(plain, { validate: false });
    const files = generateSystems(model).files;
    expect([...files.keys()].some((k) => k.includes("/Resources/"))).toBe(false);
    expect(files.get("api/Api.csproj")!).not.toMatch(/AWSSDK|RabbitMQ/);
  });
});
