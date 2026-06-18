// Event-sourced *workflow* storage gate (workflow-and-applier.md A2-S5b).
// The surface + emit-only/pure-fold discipline for `workflow X eventSourced`
// have landed, but no backend emits the event-sourced workflow runtime yet
// (per-correlation event stream + fold-on-load + apply dispatch). Without a
// gate an eventSourced workflow silently misgenerates as a state-based saga
// with its appliers dropped — so the IR validator fails fast, mirroring the
// event-sourced *aggregate* storage gate.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/index.js";

const mk = (plat: string, eventSourced: boolean): string => `system S { subdomain O { context O {
  aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
  repository Orders for Order { }
  event OrderPlaced { order: Order id }
  event PaymentReceived { order: Order id, amount: int }
  channel L { carries: OrderPlaced, PaymentReceived  delivery: broadcast  retention: ephemeral }
  workflow Tally ${eventSourced ? "eventSourced" : ""} {
    orderId: Order id
    total: int
    create(p: OrderPlaced) by p.order { ${eventSourced ? "emit PaymentReceived { order: p.order, amount: 0 }" : ""} }
    ${
      eventSourced
        ? "apply(pr: PaymentReceived) { total := total + pr.amount }"
        : "on(pr: PaymentReceived) by pr.order { total := total + pr.amount }"
    }
  }
} } api A from O storage pg { type: postgres } deployable api { platform: ${plat} contexts: [O] serves: A port: 8080 } }`;

async function diagnose(src: string) {
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

describe("event-sourced workflow storage gate", () => {
  // The Hono (node) backend now emits the event-sourced workflow runtime, so
  // the gate does NOT fire there; the others stay gated until they implement it.
  for (const plat of ["dotnet", "java", "python", "elixir"]) {
    it(`errors when an eventSourced workflow is hosted by ${plat}`, async () => {
      const diags = await diagnose(mk(plat, true));
      const gate = diags.find((d) => d.code === "loom.event-sourced-workflow-unsupported");
      expect(gate, `expected the ES-workflow gate to fire on ${plat}`).toBeDefined();
      expect(gate?.severity).toBe("error");
      expect(gate?.message).toContain("Tally");
      expect(gate?.message).toContain("eventSourced");
    });
  }

  it("is supported on Hono (node) — no gate error", async () => {
    const diags = await diagnose(mk("hono", true));
    expect(diags.some((d) => d.code === "loom.event-sourced-workflow-unsupported")).toBe(false);
  });

  it("does not fire for a state-based saga (non-eventSourced workflow)", async () => {
    const diags = await diagnose(mk("java", false));
    expect(diags.some((d) => d.code === "loom.event-sourced-workflow-unsupported")).toBe(false);
  });
});
