import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// BUG-003 (Python/FastAPI): a scalar (non-void, non-union) operation return
// must answer HTTP 200 with the value serialized to wire + declared as
// `response_model` — NOT the 204 that discarded it.  Mirrors the existing
// union-success arm (capture `result = found.<op>(...)`, then serialize),
// minus the error-variant ProblemDetails switch.  Money reuses the same
// `money_str` wire helper the `to_wire` projection uses.
// ---------------------------------------------------------------------------

const SRC = `
system Demo {
  subdomain S {
    context C {
      aggregate Order with crudish {
        code: string
        budget: money
        operation describe(): string {
          return code
        }
        operation currentBudget(): money {
          return budget
        }
        operation touch() {
          budget := budget
        }
      }
      repository OrderRepo for Order { }
    }
  }
  api OrderApi from S
  storage pg { type: postgres }
  resource cState { for: C, kind: state, use: pg }
  deployable pyApi { platform: python contexts: [C] serves: OrderApi dataSources: [cState] port: 8000 }
}
`;

async function routes(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  const found = [...files.entries()].find(([k]) => /order_routes\.py$/i.test(k))?.[1];
  if (!found) throw new Error("order_routes.py not emitted");
  return found;
}

describe("python scalar operation return (BUG-003)", () => {
  it("string return → 200 + response_model=str + returns the value", async () => {
    const r = await routes();
    expect(r).toContain(
      '@router.post("/{id}/describe", response_model=str, operation_id="describeOrder"',
    );
    expect(r).toContain("-> str:");
    // Value is captured exactly as the union-success arm does, then returned.
    expect(r).toContain("    result = found.describe()");
    expect(r).toContain("    return result");
    // Not the discarding 204 path.
    expect(r).not.toContain('@router.post("/{id}/describe", status_code=204');
  });

  it("money return → 200 + response_model=str + money_str(...) wire serialization", async () => {
    const r = await routes();
    expect(r).toContain(
      '@router.post("/{id}/current_budget", response_model=str, operation_id="currentBudgetOrder"',
    );
    expect(r).toContain("    result = found.current_budget()");
    // Money crosses the wire as its canonical decimal string — the same
    // `money_str` helper `to_wire` uses (reused, not reinvented).
    expect(r).toContain("    return money_str(result)");
    expect(r).toContain("from app.db.wire import money_str");
  });

  it("void op stays 204 (unchanged) — no response_model, returns Response", async () => {
    const r = await routes();
    expect(r).toContain('@router.post("/{id}/touch", status_code=204');
    expect(r).toContain("    return Response(status_code=204)");
  });
});
