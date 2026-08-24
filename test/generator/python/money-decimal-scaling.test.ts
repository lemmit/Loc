import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// M-T6.45 (numeric-types audit F8) — generator-level witness that the
// money × decimal coercion actually reaches the emitted DOMAIN MODULE, not
// just the expression renderer.  The unit arms in render-expr-kinds.test.ts
// prove `renderBinary` / `collectPyExprImports` in isolation; this test
// proves the wiring through `emit/aggregate.ts` (the operation body carries
// the lift, and the module carries the `Decimal` import).  The runtime +
// `mypy --strict` half lives in the opt-in LOOM_PYTHON_BUILD leg
// (test/e2e/fixtures/python-build/money-scaling.ddd).
// ---------------------------------------------------------------------------

const SRC = `
system Demo {
  subdomain S {
    context C {
      aggregate Ticket with crudish {
        label: string
        basePrice: money
        seats: int
        operation applyRate(rate: decimal) {
          basePrice := basePrice * rate
        }
        operation applyRateReversed(rate: decimal) {
          basePrice := rate * basePrice
        }
        operation divideByRate(rate: decimal) {
          basePrice := basePrice / rate
        }
        operation scaleBySeats() {
          basePrice := basePrice * seats
        }
      }
      repository TicketRepo for Ticket { }
    }
  }
  api TicketApi from S
  storage pg { type: postgres }
  resource cState { for: C, kind: state, use: pg }
  deployable pyApi { platform: python contexts: [C] serves: TicketApi dataSources: [cState] port: 8000 }
}
`;

async function domainModule(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  const found = [...files.entries()].find(([k]) => /domain\/ticket\.py$/i.test(k))?.[1];
  if (!found) throw new Error("domain/ticket.py not emitted");
  return found;
}

describe("python money × decimal scaling reaches the domain module (M-T6.45)", () => {
  it("lifts the decimal operand through Decimal(str(…)) in all three shapes", async () => {
    const d = await domainModule();
    expect(d).toContain("self._base_price = self._base_price * Decimal(str(rate))");
    expect(d).toContain("self._base_price = Decimal(str(rate)) * self._base_price");
    expect(d).toContain("self._base_price = self._base_price / Decimal(str(rate))");
  });

  it("money × int stays a bare native operator", async () => {
    const d = await domainModule();
    expect(d).toContain("self._base_price = self._base_price * self._seats");
  });

  it("the module imports Decimal", async () => {
    const d = await domainModule();
    expect(d).toContain("from decimal import Decimal");
  });
});
