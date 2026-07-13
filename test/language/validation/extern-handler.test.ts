import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// The `extern` ↔ body pairing on commandHandler / queryHandler
// (extern-handler Phase 1; `checkHandlerBodies`).  The grammar admits BOTH a
// braced `{ … }` body and a bodyless `;` for either prefix, so the validator
// enforces the pairing:
//   - loom.extern-handler-has-body — an `extern` handler must be bodyless.
//   - loom.handler-missing-body    — a non-extern handler must have a body.
// ---------------------------------------------------------------------------

const wrap = (handlers: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Order { code: string }
        repository Orders for Order { }
        ${handlers}
      }
    }
    storage pg { type: postgres }
    resource st { for: Ordering, kind: state, use: pg }
    deployable api { platform: node, contexts: [Ordering], dataSources: [st], port: 4000 }
  }
`;

const codes = async (src: string): Promise<string[]> =>
  (await parseString(src)).diagnostics.map((d) => String(d.code ?? "")).filter(Boolean);

describe("validator: extern handler ↔ body pairing", () => {
  it("accepts a bodyless extern commandHandler / queryHandler", async () => {
    const { errors } = await parseString(
      wrap(`
        extern commandHandler PlaceOrder(code: string): Order id;
        extern queryHandler   GetQuote(orderId: Order id): string;
      `),
    );
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("accepts a normal (bodied) commandHandler / queryHandler", async () => {
    const { errors } = await parseString(
      wrap(`
        commandHandler Touch(orderId: Order id) { let o = Orders.getById(orderId) }
        queryHandler   Get(orderId: Order id): Order { let o = Orders.getById(orderId) }
      `),
    );
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("rejects an extern handler that declares a body (loom.extern-handler-has-body)", async () => {
    const found = await codes(
      wrap(
        `extern commandHandler PlaceOrder(code: string): Order id { let o = Orders.getById(code) }`,
      ),
    );
    expect(found).toContain("loom.extern-handler-has-body");
  });

  it("rejects a non-extern handler that is bodyless (loom.handler-missing-body)", async () => {
    const found = await codes(wrap(`commandHandler PlaceOrder(code: string): Order id;`));
    expect(found).toContain("loom.handler-missing-body");
  });

  it("rejects a bodyless non-extern queryHandler (loom.handler-missing-body)", async () => {
    const found = await codes(wrap(`queryHandler GetQuote(orderId: Order id): string;`));
    expect(found).toContain("loom.handler-missing-body");
  });
});
