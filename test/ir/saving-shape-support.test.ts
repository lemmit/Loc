// Saving-shape capability validator (D-DOCUMENT-AXIS).  An aggregate's
// effective `shape(…)` must be one the hosting backend can emit today:
// .NET / Hono / elixir (vanilla) do all three (relational / embedded /
// document).  The check turns an unsupported combination into a hard error
// instead of silently emitting relational.

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

  it("accepts shape(document) on an elixir (vanilla) deployable (DEBT-07)", async () => {
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
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    expect(await shapeErrors(src)).toEqual([]);
  });

  it("accepts shape(embedded) on an elixir (vanilla) deployable (embeds_many)", async () => {
    expect(await shapeErrors(sys("elixir", "embedded"))).toEqual([]);
  });

  it("accepts the default (relational) shape on every backend, incl. elixir", async () => {
    expect(await shapeErrors(sys("elixir", ""))).toEqual([]);
    expect(await shapeErrors(sys("elixir", "relational"))).toEqual([]);
  });
});

describe("vanilla shape(document) scalar find/op scope (DEBT-07)", () => {
  async function docScopeErrors(source: string): Promise<string[]> {
    const { model } = await parseString(source, { validate: false });
    return validateLoomModel(enrichLoomModel(lowerModel(model)))
      .filter((d) => d.severity === "error" && d.code === "loom.vanilla-document-unsupported")
      .map((d) => d.message);
  }

  it("accepts a scalar custom find on a vanilla document aggregate", async () => {
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
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    expect(await docScopeErrors(src)).toEqual([]);
  });

  it("accepts a scalar named operation on a vanilla document aggregate", async () => {
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
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    expect(await docScopeErrors(src)).toEqual([]);
  });

  it("accepts a RETURNING operation on a vanilla document aggregate", async () => {
    const src = `
system Shop {
  subdomain Sales {
    context Shop {
      error TooMany { message: string }
      aggregate Cart ids guid shape(document) with crudish {
        total: int
        operation bump(): Cart or TooMany {
          precondition total < 10
          total := total + 1
        }
      }
      repository Carts for Cart { }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    expect(await docScopeErrors(src)).toEqual([]);
  });

  it("accepts a value-object-subfield read + function call on a vanilla document aggregate", async () => {
    const src = `
system Shop {
  subdomain Sales {
    context Shop {
      valueobject Money { amount: int  currency: string }
      aggregate Cart ids guid shape(document) with crudish {
        price: Money
        total: int
        function affordable(): bool = price.amount < 100
        operation discount() {
          precondition affordable()
          total := total - price.amount
        }
      }
      repository Carts for Cart {
        find pricey(): Cart[] where this.price.amount > 100
      }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    expect(await docScopeErrors(src)).toEqual([]);
  });

  it("accepts a CONTAINMENT mutation (`lines += Part{…}`) on a vanilla document aggregate (Route A)", async () => {
    const src = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Order ids guid shape(document) with crudish {
        reference: string
        contains lines: OrderLine[]
        entity OrderLine { sku: string  qty: int }
        operation addLine(sku: string, qty: int) {
          lines += OrderLine { sku: sku, qty: qty }
        }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    expect(await docScopeErrors(src)).toEqual([]);
  });

  it("still rejects an AUDITED operation on a vanilla document aggregate", async () => {
    const src = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Cart ids guid shape(document) with crudish {
        total: int
        operation bump() audited { total := total + 1 }
      }
      repository Carts for Cart { }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    const errs = await docScopeErrors(src);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("named operation(s) bump");
  });

  it("still rejects a DERIVED read in a document operation body", async () => {
    const src = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Cart ids guid shape(document) with crudish {
        total: int
        derived doubled: int = total * 2
        operation sync() { total := doubled }
      }
      repository Carts for Cart { }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    const errs = await docScopeErrors(src);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("named operation(s) sync");
  });

  it("accepts a PAGED custom find on a vanilla document aggregate (Route A slice 4c)", async () => {
    const src = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Cart ids guid shape(document) with crudish {
        reference: string
      }
      repository Carts for Cart {
        find recent(): Cart paged
        find byRef(reference: string): Cart paged where this.reference == reference
      }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    expect(await docScopeErrors(src)).toEqual([]);
  });

  it("accepts a UNION-returning custom find on a vanilla document aggregate (Route A slice 4d)", async () => {
    const src = `
system Shop {
  subdomain Sales {
    context Shop {
      error NotFound { }
      aggregate Cart ids guid shape(document) with crudish {
        reference: string
      }
      repository Carts for Cart {
        find byRef(reference: string): Cart or NotFound where this.reference == reference
      }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    expect(await docScopeErrors(src)).toEqual([]);
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
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
    expect(await docScopeErrors(src)).toEqual([]);
  });
});
