// Tier-0 honest-gate guard.  The provenance runtime (the lineage SDK +
// co-located `<field>_provenance` column + the provenance_records flush) is
// emitted on the Hono (node), .NET (dotnet) and elixir-**vanilla** backends; on
// the Ash foundation (or react) a `provenanced` field would silently behave
// like a plain field, dropping the trail it promises.  The validator rejects
// that mismatch with loom.provenanced-backend-unsupported rather than emitting
// a footgun.  elixir is foundation-shaped: vanilla un-gates, ash stays gated.

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

// elixir is foundation-shaped — `platform: elixir { foundation: <f> }`.
function elixirSys(foundation: string): string {
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
  deployable api { platform: elixir { foundation: ${foundation} }, contexts: [Ordering], dataSources: [ordersState], port: 4000 }
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

  it("rejects a provenanced field on a Phoenix deployable (defaults to ash — no runtime)", async () => {
    const errs = await provErrors(sys("phoenixLiveView"));
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("provenance runtime");
  });

  it("accepts a provenanced field on an elixir foundation: vanilla deployable (DEBT-06)", async () => {
    expect(await provErrors(elixirSys("vanilla"))).toEqual([]);
  });

  it("rejects a provenanced field on an elixir foundation: ash deployable (no runtime)", async () => {
    const errs = await provErrors(elixirSys("ash"));
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("foundation: vanilla");
  });

  it("accepts a provenanced context co-hosted on hono + dotnet (both capable)", async () => {
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
  deployable honoApi { platform: node, contexts: [Ordering], dataSources: [ordersState], port: 3000 }
  deployable dotnetApi { platform: dotnet, contexts: [Ordering], dataSources: [ordersState], port: 8080 }
}
`;
    expect(await provErrors(src)).toEqual([]);
  });

  it("rejects when a provenanced context is co-hosted on hono + phoenix (mismatch)", async () => {
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
  deployable honoApi { platform: node, contexts: [Ordering], dataSources: [ordersState], port: 3000 }
  deployable phx { platform: phoenixLiveView, contexts: [Ordering], dataSources: [ordersState], port: 8080 }
}
`;
    const errs = await provErrors(src);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("elixir");
  });
});
