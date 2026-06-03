// Tier-0 honest-gate guard.  The provenance runtime (domain/provenance.ts +
// per-write recordTrace) is emitted on the Hono (node) backend only; on dotnet
// / phoenix a `provenanced` field used to silently behave like a plain field,
// dropping the trail it promises.  The validator now rejects that mismatch with
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
      aggregate Order ids guid {
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
    expect(await provErrors(sys("hono"))).toEqual([]);
  });

  it("rejects a provenanced field on a .NET deployable (no provenance runtime)", async () => {
    const errs = await provErrors(sys("dotnet"));
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("Order");
    expect(errs[0]).toContain("total");
    expect(errs[0]).toContain("dotnet");
  });

  it("rejects a provenanced field on a Phoenix deployable (no provenance runtime)", async () => {
    const errs = await provErrors(sys("phoenixLiveView"));
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("provenance runtime");
  });

  it("rejects when a provenanced context is co-hosted on hono + dotnet (mismatch)", async () => {
    const src = `
system Shop {
  subdomain Core {
    context Ordering {
      aggregate Order ids guid {
        total: int provenanced
        operation bump() { total := total + 1 }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Ordering, kind: state, use: pg }
  deployable honoApi { platform: hono, contexts: [Ordering], dataSources: [ordersState], port: 3000 }
  deployable dotnetApi { platform: dotnet, contexts: [Ordering], dataSources: [ordersState], port: 8080 }
}
`;
    const errs = await provErrors(src);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("dotnet");
  });
});
