import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Custom validation messages — the `message "..."` clause on
// invariant / check / precondition (M-T1.11 foundation slice, Hono/React
// vertical).  A messaged rule renders through the wire refine carrier (with
// the author text + a stable `loomCode`) and the domain floor; a message-less
// rule keeps its native chain byte-identical.
// ---------------------------------------------------------------------------

const SOURCE = `
  system S {
    subdomain Sales {
      context Cat {
        aggregate Product {
          sku: string check sku.length > 0 message "SKU is required"
          name: string
          invariant name.length >= 2 && name.length <= 120 message "Name must be 2-120 characters"
          invariant sku.length > 0
          create(n: string, s: string) { name := n  sku := s }
          operation restock(amount: int) {
            precondition amount >= 1 message "Amount must be positive"
            name := name
          }
        }
        repository Products for Product { }
      }
    }
    api CatApi from Sales
    ui Web { api Sales: CatApi page P { route: "/" body: CreateForm { of: Product } } }
    storage db { type: postgres }
    resource st { for: Cat, kind: state, use: db }
    deployable api { platform: node contexts: [Cat] dataSources: [st] serves: CatApi port: 8080 }
    deployable web { platform: react targets: api ui: Web { Sales: api } port: 3000 }
  }
`;

async function gen() {
  const all = await generateSystemFiles(SOURCE);
  return {
    reactApi: all.get("web/src/api/product.ts")!,
    domain: all.get("api/domain/product.ts")!,
    problem: all.get("api/http/problem-details.ts")!,
  };
}

describe("message clause — wire refine carrier", () => {
  it("renders a messaged invariant as a refine with the text + a stable loomCode", async () => {
    const { reactApi } = await gen();
    expect(reactApi).toContain(
      `.refine((data) => data.name.length >= 2 && data.name.length <= 120, { path: ["name"], message: "Name must be 2-120 characters" }`,
    );
  });

  it("renders a messaged check as a refine with its text", async () => {
    const { reactApi } = await gen();
    expect(reactApi).toContain('message: "SKU is required"');
  });

  it("renders a messaged precondition as a refine (not the native .min chain)", async () => {
    const { reactApi } = await gen();
    expect(reactApi).toContain(
      `.refine((data) => data.amount >= 1, { path: ["amount"], message: "Amount must be positive"`,
    );
    // The precondition's native `.min(1)` optimisation is bypassed for a
    // messaged rule so the text survives.
    expect(reactApi).not.toContain("amount: z.number().int().min(1)");
  });

  it("keeps a message-LESS invariant as a byte-identical native chain", async () => {
    const { reactApi } = await gen();
    // `invariant sku.length > 0` (no message) stays `z.string().min(1)`.
    expect(reactApi).toContain("sku: z.string().min(1)");
  });
});

describe("message clause — domain floor", () => {
  it("throws the author text (not the derived default) in the domain floor", async () => {
    const { domain } = await gen();
    expect(domain).toContain('throw new DomainError("Name must be 2-120 characters")');
    expect(domain).toContain('throw new DomainError("SKU is required")');
    // message-less invariant keeps the derived default.
    expect(domain).toContain('throw new DomainError("Invariant violated: sku.length > 0")');
  });
});
