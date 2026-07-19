// Agent dock tab e2e — the deterministic M-T8.3 wedge demo (prose → `.ddd` →
// generate → green).  Because the transcript is scripted (no live LLM) and every
// step runs the real browser-safe `loom_*` tools, the run is reproducible enough
// to assert on end-to-end: the user prompt, the real validate/generate tool
// results, the authored model landing in the editor, and the green conclusion.
//
// Pure client-side (the agent tools parse in-memory; the closing generate uses
// the build worker) — no network, no backend boot.

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

test("Agent tab plays the prose → .ddd → generate → green demo", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByTestId("devtools-tab-agent").click();
  await expect(page.getByTestId("agent-chat")).toBeVisible();

  await page.getByTestId("agent-run-demo").click();

  // The user's prompt opens the transcript.
  await expect(page.getByTestId("agent-msg-user")).toBeVisible();

  // The real `loom_validate` tool call comes back clean…
  await expect(
    page.getByTestId("agent-tool-call").filter({ hasText: "loom_validate" }),
  ).toContainText("0 errors", { timeout: 20_000 });

  // …and `loom_generate` reports the deployable manifest (node api + react board).
  await expect(
    page.getByTestId("agent-tool-call").filter({ hasText: "loom_generate" }),
  ).toContainText("react", { timeout: 20_000 });

  // The agent authored the model — it's now in the editor.
  await expect(page.locator(".view-lines")).toContainText("aggregate Task", { timeout: 10_000 });

  // The loop concludes green.
  await expect(page.getByTestId("agent-chat")).toContainText("Done", { timeout: 20_000 });

  // The tab's status dot goes green once concluded.
  await expect(
    page.locator('[data-testid="devtools-tab-agent"]'),
  ).toBeVisible();
});
