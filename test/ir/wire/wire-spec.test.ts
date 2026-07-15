import { describe, expect, it } from "vitest";
import { wireFieldsFor } from "../../../src/ir/enrich/wire-projection.js";
import { allAggregates } from "../../../src/ir/types/loom-ir.js";
import {
  buildWireSpec,
  jsonPropertyForType,
  renderWireSpec,
} from "../../../src/system/wire-spec.js";
import { buildLoomModel, loadExampleModel, toLoomModel } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Wire-spec snapshot.  Locks the public format of
// `<outdir>/.loom/wire-spec.json` so future generator changes that
// alter wire shapes show up as a diffable snapshot review rather than
// silently changing the artifact.
// ---------------------------------------------------------------------------

async function build(file: string) {
  return toLoomModel(await loadExampleModel(file));
}

describe("wire-spec.json", () => {
  it("emits the expected document shape for examples/acme.ddd", async () => {
    const loom = await build("examples/acme.ddd");
    const sys = loom.systems[0]!;
    expect(buildWireSpec(sys)).toMatchSnapshot();
  });

  it("renders deterministic JSON with trailing newline", async () => {
    const loom = await build("examples/acme.ddd");
    const sys = loom.systems[0]!;
    const rendered = renderWireSpec(sys);
    expect(rendered.endsWith("\n")).toBe(true);
    // Parse-roundtrip must round-trip to the same shape.
    expect(JSON.parse(rendered)).toEqual(buildWireSpec(sys));
  });

  it("qualifies same-named aggregates in sibling contexts instead of clobbering one", async () => {
    // Two contexts each define `aggregate Order` with a DIFFERENT shape.  Keying
    // by bare name silently dropped one (last write wins); the collision must be
    // resolved by qualifying each key with its context.
    const loom = await buildLoomModel(`
system Coll {
  subdomain S {
    context Sales { aggregate Order { total: int }  repository Orders for Order { } }
    context Billing { aggregate Order { amount: money  note: string }  repository Orders for Order { } }
  }
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg, schema: "sales" }
  resource billingState { for: Billing, kind: state, use: pg, schema: "billing" }
  deployable api { platform: node contexts: [Sales, Billing] dataSources: [salesState, billingState] port: 3000 }
}`);
    const spec = buildWireSpec(loom.systems[0]!);
    // Both survive, context-qualified — neither clobbers the other.
    expect(Object.keys(spec.aggregates).sort()).toEqual(["Billing.Order", "Sales.Order"]);
    expect(Object.keys(spec.aggregates["Sales.Order"]!.properties).sort()).toEqual([
      "id",
      "total",
      "version",
    ]);
    expect(Object.keys(spec.aggregates["Billing.Order"]!.properties).sort()).toEqual([
      "amount",
      "id",
      "note",
      "version",
    ]);
  });

  it("leaves a same-named identical VO (ambient) as a single bare key", async () => {
    // An identical value object in two contexts is NOT a collision — it dedupes
    // to one bare-name entry, so the artifact stays byte-identical.
    const loom = await buildLoomModel(`
system Amb {
  subdomain S {
    context A { valueobject Money { amount: int  currency: string }
      aggregate Wallet { balance: Money }  repository Wallets for Wallet { } }
    context B { valueobject Money { amount: int  currency: string }
      aggregate Purse { held: Money }  repository Purses for Purse { } }
  }
  storage pg { type: postgres }
  resource aState { for: A, kind: state, use: pg, schema: "a" }
  resource bState { for: B, kind: state, use: pg, schema: "b" }
  deployable api { platform: node contexts: [A, B] dataSources: [aState, bState] port: 3000 }
}`);
    const spec = buildWireSpec(loom.systems[0]!);
    expect(Object.keys(spec.valueObjects)).toEqual(["Money"]);
    // The aggregates' `$ref` stays bare — resolves to the single `Money` key.
    expect(spec.aggregates.Wallet!.properties.balance).toEqual({
      $ref: "#/valueObjects/Money",
    });
  });
});

describe("wire-spec — primitive mappings", () => {
  // Existing primitives keep the JS-friendly wire encoding the four
  // current backends were designed against; `money` opts into the
  // precision-preserving string-on-wire encoding documented by OpenAPI
  // (`type: string, format: decimal`) — same shape used by PayPal,
  // Coinbase, ISO 20022.

  it("decimal stays JSON number (lossy, JS-friendly, unchanged)", () => {
    expect(jsonPropertyForType({ kind: "primitive", name: "decimal" })).toEqual({
      type: "number",
    });
  });

  it("money emits string-on-wire with format: decimal", () => {
    expect(jsonPropertyForType({ kind: "primitive", name: "money" })).toEqual({
      type: "string",
      format: "decimal",
    });
  });

  it("array<money> nests the string/decimal property", () => {
    expect(
      jsonPropertyForType({
        kind: "array",
        element: { kind: "primitive", name: "money" },
      }),
    ).toEqual({
      type: "array",
      items: { type: "string", format: "decimal" },
    });
  });

  it("optional<money> unwraps to the same string/decimal property", () => {
    expect(
      jsonPropertyForType({
        kind: "optional",
        inner: { kind: "primitive", name: "money" },
      }),
    ).toEqual({ type: "string", format: "decimal" });
  });

  it("end-to-end: a money field on an aggregate flows through lowering → enrichment → wireShape as money", async () => {
    const loom = await buildLoomModel(`
      context Billing {
        aggregate Invoice {
          subtotal: money
        }
        repository Invoices for Invoice { }
      }
    `);
    const inv = allAggregates(loom).find((a) => a.name === "Invoice");
    expect(inv).toBeDefined();
    const subtotal = wireFieldsFor(inv!).find((f) => f.name === "subtotal");
    expect(subtotal).toBeDefined();
    expect(subtotal!.type).toEqual({ kind: "primitive", name: "money" });
  });

  it("id row is guid → uuid (the only aggregate id kind Loom emits)", async () => {
    const loom = await buildLoomModel(`
      context Support {
        aggregate Note {
          body: string
        }
        repository Notes for Note { }
      }
    `);
    const note = allAggregates(loom).find((a) => a.name === "Note")!;
    const idRow = wireFieldsFor(note).find((f) => f.name === "id")!;
    expect(jsonPropertyForType(idRow.type)).toEqual({ type: "string", format: "uuid" });
  });
});
