import { describe, expect, it } from "vitest";
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
    const subtotal = inv!.wireShape!.find((f) => f.name === "subtotal");
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
    const idRow = note.wireShape!.find((f) => f.name === "id")!;
    expect(jsonPropertyForType(idRow.type)).toEqual({ type: "string", format: "uuid" });
  });
});
