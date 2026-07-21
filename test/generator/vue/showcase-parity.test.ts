import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Vue showcase parity pins (vue-frontend-plan.md Slice 5) — the fast-
// suite mirror of the LOOM_VUE_BUILD showcase case.  Generates
// `examples/vue-showcase.ddd` (acme with the frontend on
// `platform: vue`) and pins the workflows surface that the
// scaffold-only tests can't reach.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.resolve(here, "../../../examples/vue-showcase.ddd"), "utf-8");

async function vueFiles(): Promise<Map<string, string>> {
  const all = await generateSystemFiles(SOURCE);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web_app/")) out.set(p.slice("web_app/".length), c);
  }
  return out;
}

describe("vue showcase — workflows parity", () => {
  it("emits the shared workflows api module with vue-query", async () => {
    const files = await vueFiles();
    const wf = files.get("src/api/workflows.ts")!;
    expect(wf).toContain(`from "@tanstack/vue-query"`);
    expect(wf).toContain("export function usePlaceOrderWorkflow()");
    expect(wf).toContain("export const PlaceOrderRequest");
  });

  it("workflow page wires run handle + LoomForm + id-select lookup hook", async () => {
    const files = await vueFiles();
    const page = files.get("src/pages/workflows/place_order.vue")!;
    expect(page).toContain("const run = reactive(usePlaceOrderWorkflow());");
    expect(page).toContain("const form = useLoomForm(PlaceOrderRequest,");
    expect(page).toContain(`import { pushToast } from "../../lib/toast";`);
    // Default submit: run + success toast + redirect to the workflows index.
    expect(page).toContain(
      `@submit.prevent='form.handleSubmit(async (vals) => { await run.mutateAsync(vals); pushToast("Place Order completed"); navigate("/workflows"); })($event)'`,
    );
    // `X id` workflow param renders as a select fed by the
    // idTargetHookVar-named useAll lookup.
    expect(page).toMatch(/const __\w+ = reactive\(useAll\w+\(\)\);/);
  });

  it("money-free project stays lean: no schemas helper, no decimal.js", async () => {
    // The conditional-dep gate mirrors the React orchestrator: acme
    // carries no money fields, so the Decimal machinery must not
    // leak into the Vue project either.
    const files = await vueFiles();
    expect(files.has("src/lib/schemas.ts")).toBe(false);
    const pkg = JSON.parse(files.get("package.json")!) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["decimal.js"]).toBeUndefined();
  });
});
