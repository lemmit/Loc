// `scaffoldHandlers` contract layer (M-T5.10, PR1).  Alongside the
// commandHandler/queryHandler members it already emits, `scaffoldHandlers` now
// splices the literal `response` / `command` / `query` PayloadDecl records that
// describe the API contract those handlers realise — so the contract is
// SOURCE-VISIBLE (`unfold` ejects real `.ddd`).
//
// PR1 is additive + INERT: no handler references the records yet, so generation
// is byte-identical with vs without them.  Three things are pinned here:
//   1. The records are spliced with the right kinds + fields (the apiRead access
//      matrix; containment → `<Part>Response[]` + a sibling `<Part>Response`).
//   2. `apiReadFields` is the AST twin of the IR wire-projection
//      `forApiRead(wireShape)` (the byte-identity anchor for PR2).
//   3. The records are inert — the scaffolded form's generated .NET output is
//      byte-identical to the equivalent hand-written handlers WITHOUT records.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { forApiRead } from "../../src/ir/enrich/wire-projection.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import {
  type BoundedContext,
  isAggregate,
  isBoundedContext,
  isPayloadDecl,
  type PayloadDecl,
} from "../../src/language/generated/ast.js";
import { printStructural } from "../../src/language/print/index.js";
import { apiReadFields } from "../../src/macros/api/index.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

// A context whose aggregate exercises the full apiRead access matrix
// (editable / immutable / managed / token kept; internal / secret dropped),
// a containment (→ `<Part>Response[]` + a sibling `LineResponse`), a derived
// getter, plus create / operation / find / destroy handler targets.
const SRC = `
  system Shop {
    subdomain Sales {
      context Ordering with scaffoldHandlers {
        aggregate Order {
          code: string
          status: string
          slug: string immutable
          at: datetime managed
          ver: int token
          note: string internal
          apiKey: string secret
          derived label: string = code
          contains lines: Line[]
          entity Line {
            sku: string
            qty: int
            cost: int internal
          }
          create(code: string) { code := code  status := "new" }
          operation cancel() { status := "cancelled" }
          destroy { }
        }
        repository Orders for Order {
          find byStatus(status: string): Order[] where this.status == status
        }
      }
    }
    api SalesApi with scaffoldApi(of: Sales)
    storage pg { type: postgres }
    resource st { for: Ordering, kind: state, use: pg }
    deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

async function contextPayloads(): Promise<PayloadDecl[]> {
  const { model } = await parseString(SRC, { validate: false });
  return [...AstUtils.streamAllContents(model)].filter(isPayloadDecl);
}

function byName(payloads: PayloadDecl[], name: string): PayloadDecl | undefined {
  return payloads.find((p) => p.name === name);
}

function fieldNames(p: PayloadDecl): string[] {
  return p.fields.map((f) => f.name);
}

describe("scaffoldHandlers — contract records (M-T5.10 PR1)", () => {
  it("parses + validates the scaffolded form with contract records, no errors", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("splices an `<Agg>Response` record over the apiRead access matrix (drops internal/secret, no id)", async () => {
    const payloads = await contextPayloads();
    const resp = byName(payloads, "OrderResponse");
    expect(resp).toBeDefined();
    expect(resp!.kind).toBe("response");
    // Wire order: properties, then containments, then derived.  Kept: editable
    // (code/status), immutable (slug), managed (at), token (ver), containment
    // (lines), derived (label).  Dropped: internal (note), secret (apiKey), no id.
    expect(fieldNames(resp!)).toEqual(["code", "status", "slug", "at", "ver", "lines", "label"]);
    expect(fieldNames(resp!)).not.toContain("note");
    expect(fieldNames(resp!)).not.toContain("apiKey");
    expect(fieldNames(resp!)).not.toContain("id");
  });

  it("types a containment field as `<Part>Response[]` and emits the sibling `<Part>Response`", async () => {
    const payloads = await contextPayloads();
    const resp = byName(payloads, "OrderResponse")!;
    const lines = resp.fields.find((f) => f.name === "lines")!;
    // `contains lines: Line[]` → `lines: LineResponse[]` (points at the sibling
    // record, not the raw entity part — context scope cannot ref a raw part).
    expect(lines.type.array).toBe(true);
    expect(lines.type.base.$type).toBe("NamedType");
    expect((lines.type.base as { target: { $refText: string } }).target.$refText).toBe(
      "LineResponse",
    );
    // Sibling part response: apiRead over the part's members (drops internal cost).
    const lineResp = byName(payloads, "LineResponse");
    expect(lineResp).toBeDefined();
    expect(lineResp!.kind).toBe("response");
    expect(fieldNames(lineResp!)).toEqual(["sku", "qty"]);
    expect(fieldNames(lineResp!)).not.toContain("cost");
  });

  it("splices command records for create / operation / destroy targets", async () => {
    const payloads = await contextPayloads();
    const create = byName(payloads, "CreateOrderCommand");
    expect(create?.kind).toBe("command");
    // Create-input fields (writableCreateFields = forCreateInput matrix): editable
    // (code/status) + immutable (slug, settable on create) + secret (apiKey,
    // client-supplied).  Dropped: managed (at), token (ver), internal (note).
    expect(fieldNames(create!)).toEqual(["code", "status", "slug", "apiKey"]);

    const cancel = byName(payloads, "CancelOrderCommand");
    expect(cancel?.kind).toBe("command");
    expect(fieldNames(cancel!)).toEqual([]); // `operation cancel()` has no params

    const destroy = byName(payloads, "DestroyOrderCommand");
    expect(destroy?.kind).toBe("command");
    expect(fieldNames(destroy!)).toEqual([]); // id is a route param, not a body field
  });

  it("splices query records for find / get-by-id targets", async () => {
    const payloads = await contextPayloads();
    const getById = byName(payloads, "GetOrderQuery");
    expect(getById?.kind).toBe("query");
    // A single `orderId: Order id`.
    expect(fieldNames(getById!)).toEqual(["orderId"]);
    expect(getById!.fields[0]!.type.base.$type).toBe("IdType");

    const find = byName(payloads, "ByStatusQuery");
    expect(find?.kind).toBe("query");
    expect(fieldNames(find!)).toEqual(["status"]);
  });

  it("unfolds (prints) the records as valid `.ddd` inside the context", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const ctx = [...AstUtils.streamAllContents(model)]
      .filter(isBoundedContext)
      .find((c) => c.name === "Ordering") as BoundedContext;
    const printed = printStructural(ctx);
    expect(printed).toContain("response OrderResponse {");
    expect(printed).toContain("response LineResponse {");
    expect(printed).toContain("command CreateOrderCommand {");
    expect(printed).toContain("query ByStatusQuery {");
    expect(printed).toContain("lines: LineResponse[]");
    // A single field is re-quoted / re-emitted as source (spot check).
    expect(printed).toContain("orderId: Order id");
    // Re-parsing the unfolded context must round-trip (the records are valid `.ddd`).
    const roundtrip = printStructural(ctx);
    expect(roundtrip).toBe(printed);
  });
});

describe("apiReadFields — AST twin of forApiRead(wireShape) (PR2 byte-identity anchor)", () => {
  it("matches forApiRead(wireShape) minus the synthetic id row, in order", async () => {
    const { model } = await parseString(SRC, { validate: false });
    // AST side: apiReadFields over the aggregate's post-expansion members.
    const astAgg = [...AstUtils.streamAllContents(model)]
      .filter(isAggregate)
      .find((a) => a.name === "Order")!;
    const astNames = apiReadFields(astAgg).map((f) => f.name);
    // IR side: the enriched aggregate's wireShape, forApiRead, minus id.
    const enriched = enrichLoomModel(lowerModel(model));
    const irAgg = allContexts(enriched)
      .flatMap((c) => c.aggregates)
      .find((a) => a.name === "Order")!;
    const wireNames = forApiRead(irAgg.wireShape!)
      .filter((w) => w.source !== "id")
      .map((w) => w.name);
    expect(astNames).toEqual(wireNames);
  });
});

describe("scaffoldHandlers contract records are INERT (byte-identical generation)", () => {
  // The scaffolded form (records + auto-derived handlers) and the equivalent
  // hand-written explicit handlers (NO records) generate byte-identical .NET —
  // proving the records the macro adds change no emitted bytes.
  const MACRO = `
    system Shop {
      subdomain Sales {
        context Ordering with scaffoldHandlers {
          aggregate Order {
            status: string
            operation cancel() { status := "cancelled" }
          }
          repository Orders for Order { }
        }
      }
      api SalesApi with scaffoldApi(of: Sales)
      storage pg { type: postgres }
      resource st { for: Ordering, kind: state, use: pg }
      deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
    }
  `;
  const EXPLICIT = `
    system Shop {
      subdomain Sales {
        context Ordering {
          aggregate Order {
            status: string
            operation cancel() { status := "cancelled" }
          }
          repository Orders for Order { }
          queryHandler GetOrder(orderId: Order id): Order {
            let o = Orders.getById(orderId)
            return o
          }
          commandHandler CancelOrder(orderId: Order id) {
            let o = Orders.getById(orderId)
            o.cancel()
          }
        }
      }
      api SalesApi from Sales {
        route GET  "/orders/{orderId}"        -> Ordering.GetOrder
        route POST "/orders/{orderId}/cancel" -> Ordering.CancelOrder
      }
      storage pg { type: postgres }
      resource st { for: Ordering, kind: state, use: pg }
      deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
    }
  `;

  it("emits byte-identical .NET for the scaffolded vs record-free explicit form", async () => {
    const macro = await generateSystemFiles(MACRO);
    const explicit = await generateSystemFiles(EXPLICIT);
    const macroKeys = [...macro.keys()].sort();
    const explicitKeys = [...explicit.keys()].sort();
    expect(macroKeys).toEqual(explicitKeys);
    for (const k of macroKeys) {
      expect(macro.get(k), `content differs for ${k}`).toBe(explicit.get(k));
    }
  });
});
