// B24 (finding 20): the generated docker-compose.yml publishes each
// deployable's host `port` and keys every service by `serviceSlug(name)`
// (= `naming.snake`); when auth is bundled it also publishes Keycloak on
// `KEYCLOAK_HOST_PORT` (8081).  Two services sharing a host port abort
// `docker compose up`; two deployables whose names slug to the same key merge
// into one output dir + one compose service.  The IR validator catches both.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function codes(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
}

const twoDeployables = (a: string, b: string, auth = ""): string => `
system Shop {
  ${auth ? "user { id: string }\n  auth { provider: keycloak }" : ""}
  subdomain D {
    context A { aggregate X { name: string } repository Xs for X {} }
    context B { aggregate Y { name: string } repository Ys for Y {} }
  }
  api Aapi from D
  storage pg { type: postgres }
  resource stA { for: A, kind: state, use: pg }
  resource stB { for: B, kind: state, use: pg }
  deployable ${a}
  deployable ${b}
}`;

describe("compose uniqueness — host ports (B24)", () => {
  it("rejects two deployables sharing a default host port", async () => {
    const src = twoDeployables(
      "one { platform: node, contexts: [A], dataSources: [stA], serves: Aapi }",
      "two { platform: node, contexts: [B], dataSources: [stB], serves: Aapi }",
    );
    expect(await codes(src)).toContain("loom.duplicate-host-port");
  });

  it("rejects a user port colliding with the bundled Keycloak port 8081", async () => {
    const src = twoDeployables(
      "one { platform: node, contexts: [A], dataSources: [stA], serves: Aapi, auth: required, port: 8081 }",
      "two { platform: node, contexts: [B], dataSources: [stB], serves: Aapi, auth: required, port: 3001 }",
      "auth",
    );
    const errs = await codes(src);
    expect(errs).toContain("loom.duplicate-host-port");
  });

  it("accepts distinct host ports", async () => {
    const src = twoDeployables(
      "one { platform: node, contexts: [A], dataSources: [stA], serves: Aapi, port: 3000 }",
      "two { platform: node, contexts: [B], dataSources: [stB], serves: Aapi, port: 3001 }",
    );
    expect(await codes(src)).not.toContain("loom.duplicate-host-port");
  });
});

describe("compose uniqueness — service slugs (B24)", () => {
  it("rejects case-variant deployable names that slug-collide", async () => {
    const src = twoDeployables(
      "SalesApi2 { platform: node, contexts: [A], dataSources: [stA], serves: Aapi, port: 3000 }",
      "salesApi2 { platform: node, contexts: [B], dataSources: [stB], serves: Aapi, port: 3001 }",
    );
    expect(await codes(src)).toContain("loom.duplicate-service-slug");
  });

  it("accepts distinct slugs", async () => {
    const src = twoDeployables(
      "salesApi { platform: node, contexts: [A], dataSources: [stA], serves: Aapi, port: 3000 }",
      "billingApi { platform: node, contexts: [B], dataSources: [stB], serves: Aapi, port: 3001 }",
    );
    expect(await codes(src)).not.toContain("loom.duplicate-service-slug");
  });
});
