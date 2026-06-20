// Saving-shape capability validator (D-DOCUMENT-AXIS).  An aggregate's
// effective `shape(…)` must be one the hosting backend can emit today:
// .NET / Hono do all three (relational / embedded / document); Phoenix
// does relational only.  The check turns an unsupported combination into
// a hard error instead of silently emitting relational.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function shapeErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter(
      (d) =>
        d.severity === "error" && d.message.includes("can only") && d.message.includes("shape("),
    )
    .map((d) => d.message);
}

function sys(platform: string, shape: string): string {
  const shapeMod = shape ? ` shape(${shape})` : "";
  return `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Cart ids guid${shapeMod} { total: int }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: ${platform}, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
}

describe("saving-shape capability validation", () => {
  it("accepts shape(document) / shape(embedded) on a dotnet deployable", async () => {
    expect(await shapeErrors(sys("dotnet", "document"))).toEqual([]);
    expect(await shapeErrors(sys("dotnet", "embedded"))).toEqual([]);
  });

  it("accepts shape(document) / shape(embedded) on a hono deployable", async () => {
    expect(await shapeErrors(sys("node", "document"))).toEqual([]);
    expect(await shapeErrors(sys("node", "embedded"))).toEqual([]);
  });

  it("rejects shape(document) on a phoenix deployable (defaults to ash — no document emitter)", async () => {
    const errs = await shapeErrors(sys("phoenixLiveView", "document"));
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("shape(document)");
    expect(errs[0]).toContain("Cart");
  });

  it("accepts shape(document) on an elixir foundation: vanilla deployable (DEBT-07)", async () => {
    const src = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Cart ids guid shape(document) with crudish { total: int }
      repository Carts for Cart { }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir { foundation: vanilla }, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    expect(await shapeErrors(src)).toEqual([]);
  });

  it("rejects shape(document) on an elixir foundation: ash deployable (no document fit)", async () => {
    const src = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Cart ids guid shape(document) { total: int }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir { foundation: ash }, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    const errs = await shapeErrors(src);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("shape(document)");
  });

  it("accepts shape(embedded) on a phoenix deployable (Ash embedded resources)", async () => {
    expect(await shapeErrors(sys("phoenixLiveView", "embedded"))).toEqual([]);
  });

  it("accepts the default (relational) shape on every backend, incl. Phoenix", async () => {
    expect(await shapeErrors(sys("phoenixLiveView", ""))).toEqual([]);
    expect(await shapeErrors(sys("phoenixLiveView", "relational"))).toEqual([]);
  });

  it("honours a per-projection `resource { shape: … }` override against the backend", async () => {
    // Header says relational, the binding flips it to document → still
    // rejected on Phoenix (the effective shape is what's checked).
    const src = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Cart ids guid shape(relational) { total: int }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg, shape: document }
  deployable api { platform: phoenix, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    const errs = await shapeErrors(src);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("shape(document)");
  });
});

describe("vanilla shape(document) v1 CRUD-only scope (DEBT-07)", () => {
  async function docScopeErrors(source: string): Promise<string[]> {
    const { model } = await parseString(source, { validate: false });
    return validateLoomModel(enrichLoomModel(lowerModel(model)))
      .filter((d) => d.severity === "error" && d.code === "loom.vanilla-document-unsupported")
      .map((d) => d.message);
  }

  it("rejects a custom find on a vanilla document aggregate", async () => {
    const src = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Cart ids guid shape(document) with crudish {
        reference: string
      }
      repository Carts for Cart {
        find byReference(reference: string): Cart? where this.reference == reference
      }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir { foundation: vanilla }, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    const errs = await docScopeErrors(src);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("custom find(s) byReference");
  });

  it("rejects a user-defined named operation on a vanilla document aggregate", async () => {
    const src = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Cart ids guid shape(document) with crudish {
        total: int
        operation bump() { total := total + 1 }
      }
      repository Carts for Cart { }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir { foundation: vanilla }, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    const errs = await docScopeErrors(src);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("named operation(s) bump");
  });

  it("accepts a CRUD-only vanilla document aggregate", async () => {
    const src = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Cart ids guid shape(document) with crudish { reference: string }
      repository Carts for Cart { }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir { foundation: vanilla }, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    expect(await docScopeErrors(src)).toEqual([]);
  });
});
