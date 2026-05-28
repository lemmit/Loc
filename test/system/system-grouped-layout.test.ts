import { describe, expect, it } from "vitest";
import { groupedLayout } from "../../web/src/builder/system/grouped-layout.js";
import { buildSystemGraph } from "../../web/src/builder/system/model.js";
import { parseRaw as parse } from "../_helpers/index.js";

const SYSTEM = `system S {
  subdomain Sales {
    context Orders {
      aggregate Order {
      }
      event Placed {
      }
    }
  }
  subdomain Billing {
    context Invoices {
      aggregate Invoice {
      }
    }
  }
  storage Db {
    type: postgres
  }
}`;

describe("System grouped layout — nested module / context groups", () => {
  const layout = groupedLayout(buildSystemGraph(parse(SYSTEM)));
  const group = (id: string) => layout.groups.find((g) => g.id === id);

  it("makes a top-level group per module", () => {
    expect(group("group:module:Sales")?.parentId).toBeNull();
    expect(group("group:module:Billing")?.parentId).toBeNull();
  });

  it("nests each context inside its module", () => {
    expect(group("group:context:Orders")?.parentId).toBe("group:module:Sales");
    expect(group("group:context:Invoices")?.parentId).toBe("group:module:Billing");
  });

  it("places members inside their context, each at a distinct spot", () => {
    const order = layout.placements.get("aggregate:Order")!;
    const placed = layout.placements.get("event:Placed")!;
    expect(order.parentId).toBe("group:context:Orders");
    expect(placed.parentId).toBe("group:context:Orders");
    expect(order.x).toBeGreaterThanOrEqual(0);
    expect(order.y).toBeGreaterThanOrEqual(0);
    expect({ x: placed.x, y: placed.y }).not.toEqual({ x: order.x, y: order.y });
  });

  it("sizes a context to contain its members, and a module to contain its context", () => {
    const ctx = group("group:context:Orders")!;
    const mod = group("group:module:Sales")!;
    expect(ctx.width).toBeGreaterThan(150);
    expect(ctx.height).toBeGreaterThan(54);
    expect(mod.width).toBeGreaterThanOrEqual(ctx.width);
    expect(mod.height).toBeGreaterThanOrEqual(ctx.height);
  });

  it("leaves system-level infra constructs ungrouped", () => {
    expect(layout.placements.get("storage:Db")?.parentId).toBeNull();
  });

  it("modules don't overlap horizontally", () => {
    const sales = group("group:module:Sales")!;
    const billing = group("group:module:Billing")!;
    const [left, right] = sales.x <= billing.x ? [sales, billing] : [billing, sales];
    expect(left.x + left.width).toBeLessThanOrEqual(right.x);
  });
});

describe("System grouped layout — legacy top-level context", () => {
  const LEGACY = `context Sales {
  aggregate Order {
  }
  valueobject Money {
    amount: decimal
  }
}`;
  const layout = groupedLayout(buildSystemGraph(parse(LEGACY)));

  it("renders a module-less context as a top-level group holding its members", () => {
    expect(layout.groups.find((g) => g.id === "group:context:Sales")?.parentId).toBeNull();
    expect(layout.placements.get("aggregate:Order")?.parentId).toBe("group:context:Sales");
    expect(layout.placements.get("valueobject:Money")?.parentId).toBe("group:context:Sales");
  });
});
