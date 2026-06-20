// Phase 4c (Phoenix) — Elixir resource modules + call sites + Hex deps.

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
  deployable api { platform: elixir, contexts: [Sales], dataSources: [salesState, salesFiles, salesJobs, salesApi], port: 4000 }
}`;

async function gen() {
  const { model } = await parseString(SRC, { validate: false });
  return generateSystems(model).files;
}

describe("Phoenix resource emission", () => {
  it("emits an Elixir module per sourceType under lib/<app>/resources/", async () => {
    const files = await gen();
    const s3 = files.get("api/lib/api/resources/s3.ex")!;
    expect(s3).toMatch(/defmodule Api.Resources.S3 do/);
    expect(s3).toMatch(/def sales_files_put\(key, body\) do/);
    expect(s3).toMatch(/def sales_files_get\(key\) do/);
    expect(s3).toMatch(/ExAws.S3.presigned_url/);

    const mq = files.get("api/lib/api/resources/rabbitmq.ex")!;
    expect(mq).toMatch(/defmodule Api.Resources.Rabbitmq do/);
    expect(mq).toMatch(/def sales_jobs_enqueue\(message\) do/);
    expect(mq).toMatch(/AMQP.Basic.publish/);

    const api = files.get("api/lib/api/resources/rest_api.ex")!;
    expect(api).toMatch(/def sales_api_get\(path\) do/);
    expect(api).toMatch(/Req.get!/);
  });

  it("adds the Hex deps to mix.exs (ex_aws + amqp + req, each once)", async () => {
    const mix = (await gen()).get("api/mix.exs")!;
    expect(mix).toMatch(/\{:ex_aws, "~> 2.5"\}/);
    expect(mix).toMatch(/\{:ex_aws_s3, "~> 2.5"\}/);
    expect(mix).toMatch(/\{:amqp, "~> 4.0"\}/);
    expect((mix.match(/\{:req,/g) ?? []).length).toBe(1);
  });

  it("renders the workflow body calling the resource modules", async () => {
    const files = await gen();
    const wf = files.get("api/lib/api/sales/workflows/archive.ex")!;
    expect(wf).toMatch(/Api.Resources.S3.sales_files_get\(/);
    expect(wf).toMatch(/Api.Resources.S3.sales_files_put\(/);
    expect(wf).toMatch(/Api.Resources.Rabbitmq.sales_jobs_enqueue\(/);
    expect(wf).toMatch(/Api.Resources.RestApi.sales_api_get\(/);
  });

  it("emits nothing extra for a resource-op-free phoenix deployable", async () => {
    const plain = `
system Sys {
  subdomain Sales { context Sales { aggregate Order { name: string } } }
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Sales], dataSources: [salesState], port: 4000 }
}`;
    const { model } = await parseString(plain, { validate: false });
    const files = generateSystems(model).files;
    expect([...files.keys()].some((k) => k.includes("/resources/"))).toBe(false);
    expect(files.get("api/mix.exs")!).not.toMatch(/ex_aws|amqp/);
  });
});
