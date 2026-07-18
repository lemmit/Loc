import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

// Angular and Feliz seed constant/enum `= default`s into their forms (create +
// operation), at parity with React/Svelte — previously both silently dropped
// them to type-zero.  this-relative defaults stay deferred on both (fall back).

const SRC = (platform: string, port: number) => `
system S { subdomain M { context C {
  aggregate Order { customerId: string status: string = "draft" active: bool = true
    operation cancel(reason: string = "customer request") { status := reason } }
  repository Orders for Order { } } }
  api Api from C
  ui Web with scaffold(aggregates: [Order]) { api C: Api
    page NewOrder { route: "/orders/new" body: CreateForm { of: Order } } }
  deployable api { platform: node, contexts: [C], serves: Api, port: ${port} }
  deployable web { platform: ${platform}, targets: api, ui: Web, port: ${port + 1} } }`;

describe("Angular default-seed parity", () => {
  it("seeds constant field + op-param defaults into FormControls", async () => {
    const files = await generateSystemFiles(SRC("angular", 3100));
    const all = [...files.entries()]
      .filter(([k]) => /web.*\.ts$/.test(k))
      .map(([, v]) => v)
      .join("\n");
    // Create form: constant field defaults seed the control init (not type-zero).
    expect(all).toMatch(/status:\s*new FormControl\("draft"/);
    expect(all).toMatch(/active:\s*new FormControl\(true/);
    // Op form: param default seeds the control.
    expect(all).toMatch(/reason:\s*new FormControl\("customer request"/);
  });
});

describe("Feliz default-seed parity", () => {
  it("seeds constant field defaults into the form model", async () => {
    const files = await generateSystemFiles(SRC("feliz", 3200));
    const all = [...files.entries()]
      .filter(([k]) => /\.fs$/.test(k))
      .map(([, v]) => v)
      .join("\n");
    expect(all).toMatch(/status = "draft"/);
    expect(all).toMatch(/active = "true"/);
    // The bool encoder round-trips the seeded string.
    expect(all).toMatch(/Encode\.bool \(form\.active = "true"\)/);
  });
});
