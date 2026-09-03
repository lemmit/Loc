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

  // M-T8.19 slice 3: the turn closes with a RECEIPT — the compiler's verdict,
  // the real `.ddd` diff, and what moved in the generated tree.
  const receipt = page.getByTestId("agent-receipt");
  await expect(receipt).toBeVisible({ timeout: 30_000 });
  await expect(receipt.getByTestId("receipt-validator")).toContainText("→");
  await receipt.getByTestId("receipt-toggle-diff").click();
  await expect(receipt.getByTestId("receipt-diff")).toContainText("+  aggregate Ticket");
  await expect(receipt.getByTestId("receipt-filedelta")).toBeVisible();
  // The turn's tool cards folded UNDER the receipt rather than staying loose.
  await receipt.getByTestId("receipt-toggle-tools").click();
  await expect(receipt.getByTestId("receipt-tools")).toContainText("loom_validate");
});

test("live chat: rejecting the plan writes nothing", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  const before = await readEditorSource(page);

  await page.evaluate((model) => {
    // The loop re-calls `complete` after it runs a tool, so the script has to
    // answer the tool-result turn with plain text or it spins to the step cap.
    (window as unknown as { __loomAgentComplete: unknown }).__loomAgentComplete = async ({
      messages,
    }: { messages: { role: string; content: { type: string }[] }[] }) => {
      const last = messages[messages.length - 1];
      if (last?.content.some((b) => b.type === "tool_result")) {
        return { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] };
      }
      return {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Here is the model." },
          { type: "tool_use", id: "v1", name: "loom_validate", input: { source: model } },
        ],
      };
    };
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
    (window as unknown as { __loomAgentComplete: unknown }).__loomAgentComplete = async ({
      messages,
    }: { messages: { role: string; content: { type: string }[] }[] }) => {
      const last = messages[messages.length - 1];
      if (last?.content.some((b) => b.type === "tool_result")) {
        return { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] };
      }
      return {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Two aggregates." },
          { type: "tool_use", id: "v1", name: "loom_validate", input: { source: model } },
        ],
      };
    };
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

test("live chat: the turn is a labelled commit, and Restore is itself undoable", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Two turns: the first adds Ticket, the second adds Incident beside it.
  // Restoring the FIRST turn's checkpoint must undo the second.
  const second = `context Ops {
  aggregate Ticket { subject: string }
  aggregate Incident { severity: int }
}
`;
  await page.evaluate(
    ({ one, two }) => {
      // Script by TURN, not by call: the loop re-calls `complete` with the
      // tool results, and answering that with another tool_use would spend the
      // second turn's script inside the first.
      (window as unknown as { __loomAgentComplete: unknown }).__loomAgentComplete = async ({
        messages,
      }: { messages: { role: string; content: { type: string }[] }[] }) => {
        const last = messages[messages.length - 1];
        if (last?.content.some((b) => b.type === "tool_result")) {
          return { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] };
        }
        const asked = messages.filter(
          (m) => m.role === "user" && m.content.some((b) => b.type === "text"),
        ).length;
        return {
          stop_reason: "tool_use",
          content: [
            { type: "text", text: `Turn ${asked}.` },
            {
              type: "tool_use",
              id: `v${asked}`,
              name: "loom_validate",
              input: { source: asked === 1 ? one : two },
            },
          ],
        };
      };
    },
    { one: MODEL, two: second },
  );

  await page.getByTestId("devtools-tab-agent").click();
  await page.getByTestId("agent-input").fill("Add a Ticket aggregate.");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("agent-plan")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("agent-plan-approve").click();
  await expect
    .poll(async () => await readEditorSource(page), { timeout: 20_000 })
    .toContain("aggregate Ticket");

  // The turn produced a commit, and the message names the point it marks —
  // the ambiguity the Cursor checkpoint threads are full of (research §2.4).
  const firstCheckpoint = page.getByTestId("agent-checkpoint").first();
  await expect(firstCheckpoint).toBeVisible({ timeout: 30_000 });
  await expect(firstCheckpoint).toContainText("the end of turn 1");
  const afterTurnOne = await readEditorSource(page);

  // History shows it under its own label, not as an anonymous autosave.
  await page.getByTestId("devtools-tab-history").click();
  await expect(
    page.getByTestId("history-row").filter({ hasText: "agent: Add a Ticket aggregate." }),
  ).toBeVisible({ timeout: 30_000 });

  // Second turn.
  await page.getByTestId("devtools-tab-agent").click();
  await page.getByTestId("agent-input").fill("Also add an Incident aggregate.");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("agent-plan").nth(1)).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("agent-plan-approve").click();
  await expect
    .poll(async () => await readEditorSource(page), { timeout: 20_000 })
    .toContain("aggregate Incident");
  await expect(page.getByTestId("agent-checkpoint").nth(1)).toContainText("the end of turn 2", {
    timeout: 30_000,
  });

  await page.getByTestId("devtools-tab-history").click();
  const rowsBefore = await page.getByTestId("history-row").count();

  // Restore the FIRST turn: the second turn's work is undone, and the restore
  // is itself a new commit — so it, too, can be walked back.
  await page.getByTestId("devtools-tab-agent").click();
  await firstCheckpoint.getByTestId("agent-restore").click();
  await expect(page.getByTestId("agent-restore-note")).toContainText(
    "Restored to the end of turn 1",
    { timeout: 30_000 },
  );
  await expect
    .poll(async () => await readEditorSource(page), { timeout: 30_000 })
    .toBe(afterTurnOne);

  await page.getByTestId("devtools-tab-history").click();
  await expect
    .poll(async () => await page.getByTestId("history-row").count(), { timeout: 30_000 })
    .toBeGreaterThan(rowsBefore);
  await expect(
    page.getByTestId("history-row").filter({ hasText: "restore to the end of turn 1" }),
  ).toBeVisible({ timeout: 30_000 });
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
