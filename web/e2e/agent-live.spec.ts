// Live agent chat e2e (M-T8.3) — the BYOK live mode of the Agent dock tab.
// A real provider can't be hit in CI, so we inject a SCRIPTED transport through
// the `window.__loomAgentComplete` automation seam (mirrors `__loomSetSource`).
// The script drives the REAL `loom_*` tool loop — the model asks to validate an
// authored source, gets a genuine `loom_validate` result, then concludes — so
// the run exercises the whole live path (composer → transport → loop → editor
// reflection → generate) deterministically.

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

const MODEL = `context Sales {
  aggregate Order { total: int }
}
`;

test("live chat: injected transport drives the real tool loop and reflects source", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Inject a two-turn scripted transport BEFORE interacting: turn 1 authors +
  // validates the model, turn 2 concludes.  Shapes match the loop's `Complete`.
  await page.evaluate((model) => {
    let turn = 0;
    (window as unknown as { __loomAgentComplete: unknown }).__loomAgentComplete = async () => {
      turn++;
      if (turn === 1) {
        return {
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "Here's an Order model — validating it." },
            {
              type: "tool_use",
              id: "v1",
              name: "loom_validate",
              input: { source: model },
            },
          ],
        };
      }
      return { stop_reason: "end_turn", content: [{ type: "text", text: "Validated clean — 0 errors." }] };
    };
  }, MODEL);

  await page.getByTestId("devtools-tab-agent").click();
  await expect(page.getByTestId("agent-chat")).toBeVisible();

  // Type a prompt and send (the injected seam makes the composer ready).
  await page.getByTestId("agent-input").fill("Build an Order aggregate with a total.");
  await page.getByTestId("agent-send").click();

  // The user's prompt shows immediately.
  await expect(page.getByTestId("agent-msg-user")).toContainText("Build an Order aggregate");

  // The REAL loom_validate ran through the loop and came back clean.
  await expect(
    page.getByTestId("agent-tool-call").filter({ hasText: "loom_validate" }),
  ).toContainText("0 errors", { timeout: 20_000 });

  // The agent's authored model was reflected into the editor.
  await expect(page.locator(".view-lines")).toContainText("aggregate Order", { timeout: 10_000 });

  // The final assistant turn is rendered.
  await expect(page.getByTestId("agent-chat")).toContainText("Validated clean", { timeout: 20_000 });
});

test("live chat: settings gear configures a BYOK provider", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByTestId("devtools-tab-agent").click();
  await page.getByTestId("agent-settings-toggle").click();
  await expect(page.getByTestId("agent-settings")).toBeVisible();

  // Provider presets are offered; the key field persists what we type.
  await expect(page.getByTestId("agent-base-url")).toHaveValue(/openrouter/);
  await page.getByTestId("agent-api-key").fill("sk-test-key");
  await expect(page.getByTestId("agent-api-key")).toHaveValue("sk-test-key");
});
