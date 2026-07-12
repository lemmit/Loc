// Tier-0 honest-gate guard.  The provenance runtime (the lineage SDK +
// co-located `<field>_provenance` column + the provenance_records flush) is
// emitted on the Hono (node), .NET (dotnet) and elixir (vanilla) backends; on
// react a `provenanced` field would silently behave like a plain field,
// dropping the trail it promises.  The validator rejects that mismatch with
// loom.provenanced-backend-unsupported rather than emitting a footgun.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { parseString } from "../../_helpers/parse.js";

async function provErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.provenanced-backend-unsupported")
    .map((d) => d.message);
}

function sys(platform: string): string {
  return `
system Shop {
  subdomain Core {
    context Ordering {
      aggregate Order {
        total: int provenanced
        operation bump() { total := total + 1 }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Ordering, kind: state, use: pg }
  deployable api { platform: ${platform}, contexts: [Ordering], dataSources: [ordersState], port: 4000 }
}
`;
}

describe("provenanced-field storage capability validation", () => {
  it("accepts a provenanced field on a Hono (node) deployable", async () => {
    expect(await provErrors(sys("node"))).toEqual([]);
  });

  it("accepts a provenanced field on a .NET deployable (provenance runtime ported)", async () => {
    expect(await provErrors(sys("dotnet"))).toEqual([]);
  });

  it("accepts a provenanced field on a Java deployable (provenance runtime ported, W2)", async () => {
    expect(await provErrors(sys("java"))).toEqual([]);
  });

  it("accepts a provenanced field on a Python deployable (provenance runtime ported, W2)", async () => {
    expect(await provErrors(sys("python"))).toEqual([]);
  });

  it("accepts a provenanced field on an elixir (vanilla) deployable (DEBT-06)", async () => {
    expect(await provErrors(sys("elixir"))).toEqual([]);
  });

  it("accepts a provenanced context co-hosted on hono + dotnet (both capable)", async () => {
    const src = `
system Shop {
  subdomain Core {
    context Ordering {
      aggregate Order {
        total: int provenanced
        operation bump() { total := total + 1 }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Ordering, kind: state, use: pg }
  deployable honoApi { platform: node, contexts: [Ordering], dataSources: [ordersState], port: 3000 }
  deployable dotnetApi { platform: dotnet, contexts: [Ordering], dataSources: [ordersState], port: 8080 }
}
`;
    expect(await provErrors(src)).toEqual([]);
  });
});
