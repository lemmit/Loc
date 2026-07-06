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

// Vanilla variant — `platform: elixir` (the only elixir
// foundation that hosts pure ES, D-VANILLA-ES-HOME).
const mkVanilla = (eventSourced: boolean): string => mk("elixir", eventSourced);

describe("event-sourced workflow storage gate", () => {
  // The Hono (node) + .NET (dotnet) + Python (FastAPI) + Java (Spring) backends
  // and elixir (vanilla) now emit the event-sourced workflow runtime, so the
  // gate does NOT fire there.
  for (const plat of ["node", "dotnet", "python", "java"]) {
    it(`is supported on ${plat} — no gate error`, async () => {
      const diags = await diagnose(mk(plat, true));
      expect(diags.some((d) => d.code === "loom.event-sourced-workflow-unsupported")).toBe(false);
    });
  }

  it("is supported on elixir + foundation: vanilla — no gate error", async () => {
    const diags = await diagnose(mkVanilla(true));
    expect(diags.some((d) => d.code === "loom.event-sourced-workflow-unsupported")).toBe(false);
  });

  it("does not fire for a state-based saga (non-eventSourced workflow)", async () => {
    const diags = await diagnose(mk("java", false));
    expect(diags.some((d) => d.code === "loom.event-sourced-workflow-unsupported")).toBe(false);
  });
});
