// Live agent chat e2e (M-T8.3) — the BYOK live mode of the Agent dock tab.
// A real provider can't be hit in CI, so we inject a SCRIPTED transport through
// the `window.__loomAgentComplete` automation seam (mirrors `__loomSetSource`).
// The script drives the REAL `loom_*` tool loop — the model asks to validate an
// authored source, gets a genuine `loom_validate` result, then concludes — so
// the run exercises the whole live path (composer → transport → loop → editor
// reflection → generate) deterministically.

import { expect, test } from "@playwright/test";
import { readEditorSource, waitForPlaygroundReady } from "./_helpers";

// A model the STARTER source does not already contain, so "did the write
// land?" is a real question — the starter is a full Sales system, and asserting
// on `aggregate Order` would have been true before the agent ran.
const MODEL = `context Ops {
  aggregate Ticket { subject: string }
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
            { type: "text", text: "Here's a Ticket model — validating it." },
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
  await page.getByTestId("agent-input").fill("Build a Ticket aggregate with a subject.");
  await page.getByTestId("agent-send").click();

  // The user's prompt shows immediately.
  await expect(page.getByTestId("agent-msg-user")).toContainText("Build a Ticket aggregate");

  // The REAL loom_validate ran through the loop and came back clean.
  await expect(
    page.getByTestId("agent-tool-call").filter({ hasText: "loom_validate" }),
  ).toContainText("0 errors", { timeout: 20_000 });

  // The final assistant turn is rendered.
  await expect(page.getByTestId("agent-chat")).toContainText("Validated clean", { timeout: 20_000 });

  // M-T8.19 slice 2: the turn ends at the PLAN, not at the write.  The plan
  // lists the declarations the candidate adds, and the source is untouched
  // until it is approved.
  const plan = page.getByTestId("agent-plan");
  await expect(plan).toBeVisible({ timeout: 20_000 });
  await expect(plan.getByTestId("agent-plan-item").first()).toContainText(
    "aggregate Ops.Ticket",
  );
  expect(await readEditorSource(page)).not.toContain("aggregate Ticket");

  // Approving writes it.
  await page.getByTestId("agent-plan-approve").click();
  await expect(plan).toHaveAttribute("data-plan-state", "approved");
  await expect
    .poll(async () => await readEditorSource(page), { timeout: 20_000 })
    .toContain("aggregate Ticket");
});

test("live chat: rejecting the plan writes nothing", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  const before = await readEditorSource(page);

  await page.evaluate((model) => {
    (window as unknown as { __loomAgentComplete: unknown }).__loomAgentComplete = async () => ({
      stop_reason: "end_turn",
      content: [
        { type: "text", text: "Here is the model." },
        { type: "tool_use", id: "v1", name: "loom_validate", input: { source: model } },
      ],
    });
  }, MODEL);

  await page.getByTestId("devtools-tab-agent").click();
  await page.getByTestId("agent-input").fill("Add a Ticket aggregate.");
  await page.getByTestId("agent-send").click();

  const plan = page.getByTestId("agent-plan");
  await expect(plan).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("agent-plan-reject").click();
  await expect(plan).toHaveAttribute("data-plan-state", "rejected");
  await expect(page.getByTestId("agent-plan-verdict")).toContainText("nothing was written");

  // The composer is free again and the source never moved.
  await expect(page.getByTestId("agent-input")).toBeEnabled();
  expect(await readEditorSource(page)).toBe(before);
});

test("live chat: a line struck off the plan is left out of the write", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Two added aggregates — the user keeps one and strikes the other.
  const two = `context Ops {
  aggregate Ticket { subject: string }
  aggregate Incident { severity: int }
}
`;
  await page.evaluate((model) => {
    (window as unknown as { __loomAgentComplete: unknown }).__loomAgentComplete = async () => ({
      stop_reason: "end_turn",
      content: [
        { type: "text", text: "Two aggregates." },
        { type: "tool_use", id: "v1", name: "loom_validate", input: { source: model } },
      ],
    });
  }, two);

  await page.getByTestId("devtools-tab-agent").click();
  await page.getByTestId("agent-input").fill("Add Ticket and Incident.");
  await page.getByTestId("agent-send").click();

  const plan = page.getByTestId("agent-plan");
  await expect(plan).toBeVisible({ timeout: 20_000 });
  const incidentRow = plan.locator('[data-node="aggregate Ops.Incident"]');
  await incidentRow.getByTestId("agent-plan-exclude").click();
  await expect(incidentRow).toHaveAttribute("data-excluded", "true");

  await page.getByTestId("agent-plan-approve").click();
  await expect
    .poll(async () => await readEditorSource(page), { timeout: 20_000 })
    .toContain("aggregate Ticket");
  expect(await readEditorSource(page)).not.toContain("Incident");
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
