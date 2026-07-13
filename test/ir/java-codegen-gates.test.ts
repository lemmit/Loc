// M-T6.4 — Java codegen gates.  Three shapes the Java generator cannot emit
// used to crash codegen with a raw `throw new Error` (they pass every earlier
// validation, then stack-trace `generateJavaForContexts`).  Each is now an
// honest java-scoped `loom.java-*-unsupported` IR validator gate — the "gated
// xor emitted" contract the other four backends already honor for these shapes:
//
//   1. cross-aggregate view `follows`            → loom.java-view-follows-unsupported
//   2. valueobject/entity saga instance field    → loom.java-saga-instance-field-unsupported
//   3. valueobject/entity projection row field   → loom.java-projection-field-unsupported
//
// node / dotnet / python / elixir emit all three, so the gate must NOT fire
// there; only java (or a java+other co-host, since java can't emit) gates.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/index.js";

async function diagnose(src: string) {
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const has = (diags: { code?: string }[], code: string): boolean =>
  diags.some((d) => d.code === code);

// --- 1. cross-aggregate view follows -------------------------------------

const viewFollows = (plat: string): string => `system S { subdomain O { context O {
  aggregate Region { name: string }
  repository Regions for Region { }
  aggregate Customer { name: string  regionId: Region id }
  repository Customers for Customer { }
  view CustomerRegions {
    cid: Customer id
    regionName: string
    from Customer
    bind cid = id, regionName = regionId.name
  }
} } api A from O storage pg { type: postgres }
  resource oState { for: O, kind: state, use: pg }
  deployable api { platform: ${plat} contexts: [O] serves: A dataSources: [oState] port: 8080 } }`;

describe("loom.java-view-follows-unsupported", () => {
  it("fires when a java deployable hosts a cross-aggregate follows view", async () => {
    const diags = await diagnose(viewFollows("java"));
    expect(has(diags, "loom.java-view-follows-unsupported")).toBe(true);
  });

  for (const plat of ["node", "dotnet", "python", "elixir"]) {
    it(`does not fire on ${plat} (it emits the bulk-load join)`, async () => {
      const diags = await diagnose(viewFollows(plat));
      expect(has(diags, "loom.java-view-follows-unsupported")).toBe(false);
    });
  }

  it("does not fire on java for a same-aggregate view with no follows", async () => {
    const src = `system S { subdomain O { context O {
      aggregate Customer { name: string }
      repository Customers for Customer { }
      view CustomerNames {
        cid: Customer id
        nm: string
        from Customer
        bind cid = id, nm = name
      }
    } } api A from O storage pg { type: postgres }
      resource oState { for: O, kind: state, use: pg }
      deployable api { platform: java contexts: [O] serves: A dataSources: [oState] port: 8080 } }`;
    const diags = await diagnose(src);
    expect(has(diags, "loom.java-view-follows-unsupported")).toBe(false);
  });
});

// --- 2. valueobject/entity saga instance field ---------------------------

const sagaField = (
  plat: string,
  vo: boolean,
): string => `system Shop { subdomain Sales { context Orders {
  valueobject Money { amount: int  currency: string }
  aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id, total: Money { amount: 1, currency: "USD" } } } }
  repository Orders for Order { }
  event OrderPlaced { order: Order id, total: Money }
  event PaymentReceived { order: Order id, amount: int }
  channel L { carries: OrderPlaced, PaymentReceived  delivery: broadcast  retention: ephemeral }
  workflow Tally {
    orderId: Order id
    ${vo ? "running: Money" : "running: int"}
    create(p: OrderPlaced) by p.order { ${vo ? "running := p.total" : "running := 0"} }
    on(pr: PaymentReceived) by pr.order { ${vo ? "running := running" : "running := running + pr.amount"} }
  }
} } storage pg { type: postgres }
  resource oState { for: Orders, kind: state, use: pg }
  deployable salesApi { platform: ${plat} contexts: [Orders] dataSources: [oState] port: 8080 } }`;

describe("loom.java-saga-instance-field-unsupported", () => {
  it("fires when a java saga has a valueobject-typed instance field", async () => {
    const diags = await diagnose(sagaField("java", true));
    expect(has(diags, "loom.java-saga-instance-field-unsupported")).toBe(true);
  });

  for (const plat of ["node", "dotnet", "python", "elixir"]) {
    it(`does not fire on ${plat} (it emits the VO instance field)`, async () => {
      const diags = await diagnose(sagaField(plat, true));
      expect(has(diags, "loom.java-saga-instance-field-unsupported")).toBe(false);
    });
  }

  it("does not fire on java for a scalar-only saga", async () => {
    const diags = await diagnose(sagaField("java", false));
    expect(has(diags, "loom.java-saga-instance-field-unsupported")).toBe(false);
  });
});

// --- 3. valueobject/entity projection row field --------------------------

const projField = (
  plat: string,
  vo: boolean,
): string => `system Shop { subdomain Sales { context Orders {
  valueobject Money { amount: int  currency: string }
  event OrderPlaced  { order: Order id, total: Money }
  aggregate Order { status: string  create place(total: Money) {} }
  channel Lifecycle { carries: OrderPlaced  retention: log  key: order }
  projection OrderBook keyed by order {
    order: Order id
    ${vo ? "total: Money" : "count: int"}
    on(e: OrderPlaced)  { order := e.order  ${vo ? "total := e.total" : "count := 1"} }
  }
} } storage pg { type: postgres }
  resource oState { for: Orders, kind: state, use: pg }
  deployable salesApi { platform: ${plat} contexts: [Orders] dataSources: [oState] port: 8080 } }`;

describe("loom.java-projection-field-unsupported", () => {
  it("fires when a java projection has a valueobject-typed row field", async () => {
    const diags = await diagnose(projField("java", true));
    expect(has(diags, "loom.java-projection-field-unsupported")).toBe(true);
  });

  for (const plat of ["node", "dotnet", "python", "elixir"]) {
    it(`does not fire on ${plat} (it emits the VO row field)`, async () => {
      const diags = await diagnose(projField(plat, true));
      expect(has(diags, "loom.java-projection-field-unsupported")).toBe(false);
    });
  }

  it("does not fire on java for a scalar-only projection", async () => {
    const diags = await diagnose(projField("java", false));
    expect(has(diags, "loom.java-projection-field-unsupported")).toBe(false);
  });
});
