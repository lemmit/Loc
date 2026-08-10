import { describe, expect, it } from "vitest";
import {
  collectWireValidationMessages,
  hasWireValidationMessages,
} from "../../../src/generator/_i18n/validation-catalog.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import type { BoundedContextIR } from "../../../src/ir/types/loom-ir.js";
import { messageCode } from "../../../src/util/message-code.js";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// The backend validation-message CATALOG collector (M-T1.11).
//
// The one place that decides which authored `message "…"` strings a backend
// ships and what key each has.  All five backends build their catalog from it,
// so what it includes / excludes IS the cross-backend contract.
// ---------------------------------------------------------------------------

const wrap = (body: string) => `
  system S {
    subdomain Sales {
      context Cat {
        ${body}
      }
    }
    api CatApi from Sales
    storage db { type: postgres }
    resource st { for: Cat, kind: state, use: db }
    deployable api { platform: node contexts: [Cat] dataSources: [st] serves: CatApi port: 8080 }
  }
`;

async function contextsOf(body: string): Promise<BoundedContextIR[]> {
  const { model } = await parseString(wrap(body), { validate: false });
  const enriched = enrichLoomModel(lowerModel(model));
  return enriched.systems[0]!.subdomains.flatMap((s) => s.contexts);
}

async function catalogOf(body: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const m of collectWireValidationMessages(await contextsOf(body))) out[m.code] = m.text;
  return out;
}

describe("validation-message catalog — what it collects", () => {
  it("collects an aggregate invariant, a field check, and an operation precondition", async () => {
    const catalog = await catalogOf(`
      aggregate Product {
        sku: string check sku.length > 0 message "SKU is required"
        name: string
        qty: int
        invariant name.length >= 2 message "Name must be at least 2 characters"
        create(n: string, s: string, q: int) { name := n  sku := s  qty := q }
        operation restock(amount: int) {
          precondition amount >= 1 message "Amount must be positive"
          qty := qty + amount
        }
      }
      repository Products for Product { }
    `);
    expect(catalog).toEqual({
      [messageCode("SKU is required")]: "SKU is required",
      [messageCode("Name must be at least 2 characters")]: "Name must be at least 2 characters",
      [messageCode("Amount must be positive")]: "Amount must be positive",
    });
  });

  it("collects a value-object invariant (the `<Vo>Request` validator shape)", async () => {
    const catalog = await catalogOf(`
      valueobject Sku {
        code: string
        invariant code.length >= 3 message "SKU code needs at least 3 characters"
      }
      aggregate Product {
        sku: Sku
        create(s: Sku) { sku := s }
      }
      repository Products for Product { }
    `);
    expect(catalog).toEqual({
      [messageCode("SKU code needs at least 3 characters")]: "SKU code needs at least 3 characters",
    });
  });

  it("keys by messageCode, so the catalog key IS the wire `errors[].code`", async () => {
    const catalog = await catalogOf(`
      aggregate Product {
        name: string
        invariant name.length >= 2 message "Name must be at least 2 characters"
        create(n: string) { name := n }
      }
      repository Products for Product { }
    `);
    // Not just "some hash" — the SAME function the five validator emitters call.
    expect(Object.keys(catalog)).toEqual([messageCode("Name must be at least 2 characters")]);
    expect(Object.keys(catalog)[0]).toMatch(/^msg\./);
  });

  it("collapses one message authored on several rules into a single entry", async () => {
    const catalog = await catalogOf(`
      aggregate Product {
        a: int
        b: int
        invariant a >= 0 message "Must not be negative"
        invariant b >= 0 message "Must not be negative"
        create(x: int, y: int) { a := x  b := y }
      }
      repository Products for Product { }
    `);
    expect(Object.keys(catalog)).toHaveLength(1);
  });

  it("excludes a message-LESS rule — the native validator chain has no message slot", async () => {
    const catalog = await catalogOf(`
      aggregate Product {
        qty: int
        invariant qty >= 0
        create(q: int) { qty := q }
      }
      repository Products for Product { }
    `);
    expect(catalog).toEqual({});
    expect(hasWireValidationMessages(await contextsOf("aggregate P { n: int }"))).toBe(false);
  });

  it("excludes a `private` (server-only) messaged rule — no wire validator sees it", async () => {
    const catalog = await catalogOf(`
      aggregate Product {
        name: string
        private invariant name.length >= 2 message "Name must be at least 2 characters"
        create(n: string) { name := n }
      }
      repository Products for Product { }
    `);
    // The rule still enforces at the domain floor with its authored text; it just
    // has no wire `code` for the 422 handler to resolve, so no catalog entry.
    expect(catalog).toEqual({});
  });

  it("sorts by key, so the emitted catalog is byte-stable across runs", async () => {
    const messages = collectWireValidationMessages(
      await contextsOf(`
        aggregate Product {
          a: int
          b: int
          c: int
          invariant a >= 0 message "zzz first alphabetically last"
          invariant b >= 0 message "aaa"
          invariant c >= 0 message "mmm"
          create(x: int, y: int, z: int) { a := x  b := y  c := z }
        }
        repository Products for Product { }
      `),
    );
    const codes = messages.map((m) => m.code);
    expect(codes).toEqual([...codes].sort());
  });
});
