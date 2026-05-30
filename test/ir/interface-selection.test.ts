// Phase 3 — interface selection (RFC §3.5).  The registry derives a
// default access interface per (sourceType, kind); enrichment resolves
// one per resource onto EnrichedSystemIR.resourceInterfaces.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { defaultInterfaceFor } from "../../src/ir/source-types.js";
import { parseValid } from "../_helpers/parse.js";

describe("defaultInterfaceFor", () => {
  it("picks the native/operational interface, preferring sdk over rest", () => {
    expect(defaultInterfaceFor("postgres", "state")).toBe("sql");
    expect(defaultInterfaceFor("postgres", "eventLog")).toBe("sql");
    expect(defaultInterfaceFor("rabbitmq", "queue")).toBe("amqp");
    expect(defaultInterfaceFor("s3", "objectStore")).toBe("sdk"); // sdk ranks above rest
    expect(defaultInterfaceFor("restApi", "api")).toBe("rest");
  });

  it("is undefined for an unsupported (sourceType, kind)", () => {
    expect(defaultInterfaceFor("redis", "cache")).toBeUndefined(); // redis cache declares no interface
    expect(defaultInterfaceFor("postgres", "objectStore")).toBeUndefined();
  });
});

const SRC = `
system Sys {
  subdomain Sales { context Sales { aggregate Order { name: string } } }
  storage pg    { type: postgres }
  storage files { type: s3,    config: { bucket: "b" } }
  storage bus   { type: rabbitmq }
  storage pay   { type: restApi,  config: { baseUrl: "https://x" } }
  resource salesState { for: Sales, kind: state,       use: pg }
  resource salesFiles { for: Sales, kind: objectStore, use: files }
  resource salesJobs  { for: Sales, kind: queue,       use: bus }
  resource salesApi   { for: Sales, kind: api,         use: pay }
  deployable api {
    platform: hono, contexts: [Sales]
    dataSources: [salesState, salesFiles, salesJobs, salesApi], port: 3000
  }
}
`;

describe("resolved resourceInterfaces", () => {
  it("threads a default interface per resource onto the enriched system", async () => {
    const sys = enrichLoomModel(lowerModel(await parseValid(SRC))).systems[0]!;
    expect(sys.resourceInterfaces).toEqual({
      salesState: "sql",
      salesFiles: "sdk",
      salesJobs: "amqp",
      salesApi: "rest",
    });
  });

  it("is idempotent across re-enrichment", async () => {
    const once = enrichLoomModel(lowerModel(await parseValid(SRC)));
    const twice = enrichLoomModel(once as never);
    expect(twice.systems[0]!.resourceInterfaces).toEqual(once.systems[0]!.resourceInterfaces);
  });
});
