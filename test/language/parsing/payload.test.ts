// Payload foundation (payload-transport-layer.md, P1 + P2).
// Covers the grammar (`payload` + the command/query/response/error sugar
// keywords), IR threading onto `BoundedContextIR.payloads` (including the
// `event` projection with `kind: "event"`), the P2 synthesized `<Agg>Wire`
// payloads, and the P1 validator rules (name conflict, duplicate field).

import type { Diagnostic } from "langium";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { parseString, parseValid } from "../../_helpers/parse.js";

const errorCodes = (diags: Diagnostic[]): (string | number | undefined)[] =>
  diags.filter((d) => d.severity === 1).map((d) => d.code);

describe("payload — grammar (P1)", () => {
  it("parses payload + all four sugar keywords", async () => {
    const { errors } = await parseString(`
      context Sales {
        payload  Envelope     { ref: string }
        command  PlaceOrder   { qty: int }
        query    OrderSummary { ref: string }
        response OrderResult  { ok: bool }
        error    NotFound     { what: string }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("rejects an unknown payload kind keyword", async () => {
    const { errors } = await parseString(`context T { widget Foo { id: string } }`);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("payload — IR threading (P1)", () => {
  const SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      event   OrderPlaced { ref: string }
      command PlaceOrder  { qty: int }
      error   NotFound    { what: string }
    }
  }
}
`;

  it("threads declared payloads + projects events into the unified view", async () => {
    const loom = lowerModel(await parseValid(SRC));
    const ctx = loom.systems[0]!.subdomains[0]!.contexts.find((c) => c.name === "Orders")!;
    const byName = new Map(ctx.payloads.map((p) => [p.name, p.kind] as const));
    // event projected with kind "event"; the others keep their kinds.
    expect(byName.get("OrderPlaced")).toBe("event");
    expect(byName.get("PlaceOrder")).toBe("command");
    expect(byName.get("NotFound")).toBe("error");
    // `events` stays populated independently (emission path untouched).
    expect(ctx.events.map((e) => e.name)).toEqual(["OrderPlaced"]);
  });
});

describe("payload — <Agg>Wire synthesis (P2)", () => {
  const SRC = `
system Sys {
  subdomain Sales {
    context Catalog {
      aggregate Product { name: string price: int }
    }
  }
}
`;

  it("synthesizes a named <Agg>Wire payload from the aggregate wire shape", async () => {
    const enriched = enrichLoomModel(lowerModel(await parseValid(SRC)));
    const ctx = enriched.systems[0]!.subdomains[0]!.contexts.find((c) => c.name === "Catalog")!;
    const wire = ctx.payloads.find((p) => p.name === "ProductWire")!;
    expect(wire).toBeDefined();
    expect(wire.synthesized).toBe(true);
    expect(wire.kind).toBe("payload");
    // id first, then declared fields, then the default-on version token (M-T3.4).
    expect(wire.fields.map((f) => f.name)).toEqual(["id", "name", "price", "version"]);
  });
});

describe("payload — validator (P1)", () => {
  it("rejects two payloads with the same name (loom.payload-name-conflict)", async () => {
    const { diagnostics } = await parseString(`
      context T {
        command Foo { a: int }
        query   Foo { b: int }
      }
    `);
    expect(errorCodes(diagnostics)).toContain("loom.payload-name-conflict");
  });

  it("rejects a payload colliding with a value object (loom.payload-name-conflict)", async () => {
    const { diagnostics } = await parseString(`
      context T {
        valueobject Money { amount: int }
        payload     Money { amount: int }
      }
    `);
    expect(errorCodes(diagnostics)).toContain("loom.payload-name-conflict");
  });

  it("rejects duplicate field names within a payload (loom.payload-duplicate-field)", async () => {
    const { diagnostics } = await parseString(`
      context T { command Foo { a: int a: string } }
    `);
    expect(errorCodes(diagnostics)).toContain("loom.payload-duplicate-field");
  });
});
