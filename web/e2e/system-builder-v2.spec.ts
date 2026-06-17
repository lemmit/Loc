// Model builder v2 — drill-down backbone (Phase 1).
//
// The canvas IS the navigator: clicking a drillable construct (a system /
// module / context / aggregate) pushes a breadcrumb step and the view swaps to
// the children of that node. The breadcrumb home (Model) pops back to root.

import { expect, test } from "@playwright/test";
import { selectExample, waitForPlaygroundReady } from "./_helpers";

test("Model v2 drills system → context → aggregate via clicks, and the breadcrumb pops back", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("c4system-v2-crumb-home")).toBeVisible();

  // Root → drill into the system.
  const systemNode = page.locator('.react-flow__node[data-id^="system:"]').first();
  await expect(systemNode).toBeVisible({ timeout: 10_000 });
  await systemNode.click();
  await expect(page.getByTestId("c4system-v2-crumb-0")).toBeVisible({ timeout: 5_000 });

  // System view → drill into the first module.
  const moduleNode = page.locator('.react-flow__node[data-id^="subdomain:"]').first();
  await expect(moduleNode).toBeVisible({ timeout: 5_000 });
  await moduleNode.click();
  await expect(page.getByTestId("c4system-v2-crumb-1")).toBeVisible();

  // Module → context → Order (the aggregate with operations).
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  await expect(page.getByTestId("c4system-v2-crumb-2")).toBeVisible();
  await page.locator('.react-flow__node[data-id="aggregate:Order"]').click();
  await expect(page.getByTestId("c4system-v2-crumb-3")).toBeVisible();

  // Order's aggregate view shows its operations.
  await expect(page.locator('.react-flow__node[data-id^="operation:"]').first()).toBeVisible();

  // Breadcrumb home pops all the way back; the system node is selectable again.
  await page.getByTestId("c4system-v2-crumb-home").click();
  await expect(page.getByTestId("c4system-v2-crumb-0")).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id^="system:"]').first()).toBeVisible();
});

test("Model v2 renders an operation body as a statement flow (read-only)", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);
  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });

  // Drill all the way into Order.confirm — system → module → context → Order →
  // confirm. Use ids so it works regardless of which aggregate sorts first.
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await page.locator('.react-flow__node[data-id^="subdomain:"]').first().click();
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  await page.locator('.react-flow__node[data-id="aggregate:Order"]').click();
  await page.locator('.react-flow__node[data-id="operation:confirm"]').click();

  // The confirm body renders as one stmt node per statement, all visible.
  const stmts = page.getByTestId("c4system-v2-stmt");
  await expect.poll(async () => stmts.count(), { timeout: 5_000 }).toBeGreaterThan(0);
  // Substatement subkinds get their own labels + tint — preconditions read
  // distinctly from a generic "stmt".
  await expect(page.locator('[data-testid="c4system-v2-stmt"][data-stmt-subkind="precondition"]').first()).toBeVisible();

  // Order.confirm has at least one assign and one emit; each renders its v1
  // editor row inside the node (target Autocomplete for assign, field name +
  // value for emit).
  const assign = page.locator('[data-testid="c4system-v2-stmt"][data-stmt-kind="assign"]').first();
  await expect(assign).toBeVisible();
  await expect(assign.getByTestId("c4system-stmt-target")).toBeVisible();
  await expect(assign.getByTestId("c4system-stmt-value")).toBeVisible();

  const emit = page.locator('[data-testid="c4system-v2-stmt"][data-stmt-kind="emit"]').first();
  await expect(emit).toBeVisible();
  await expect(emit.getByTestId("c4system-emit-field-name").first()).toBeVisible();
});

test("Model v2 adds a construct via the per-view palette (system + context)", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);
  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });

  // System view exposes +Module / +Storage / etc; adding a storage bumps the
  // storage node count by one.
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await expect(page.getByTestId("c4system-v2-add-storage")).toBeVisible();
  const storagesBefore = await page.locator('.react-flow__node[data-id^="storage:"]').count();
  await page.getByTestId("c4system-v2-add-storage").click();
  await expect
    .poll(async () => page.locator('.react-flow__node[data-id^="storage:"]').count(), { timeout: 5_000 })
    .toBe(storagesBefore + 1);

  // Drill into module → context; the context palette adds an aggregate.
  await page.locator('.react-flow__node[data-id^="subdomain:"]').first().click();
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  await expect(page.getByTestId("c4system-v2-add-aggregate")).toBeVisible();
  const aggsBefore = await page.locator('.react-flow__node[data-id^="aggregate:"]').count();
  await page.getByTestId("c4system-v2-add-aggregate").click();
  await expect
    .poll(async () => page.locator('.react-flow__node[data-id^="aggregate:"]').count(), { timeout: 5_000 })
    .toBe(aggsBefore + 1);
});

test("Model v2 renames and deletes a construct from the node itself", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);
  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await page.locator('.react-flow__node[data-id^="subdomain:"]').first().click();
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();

  // Rename the Order aggregate to OrderX via the on-node pencil → input.
  const order = page.locator('[data-construct-kind="aggregate"][data-construct-name="Order"]');
  await expect(order).toBeVisible();
  await order.getByTestId("c4system-v2-rename").click();
  const input = page.getByTestId("c4system-v2-rename-input");
  await expect(input).toBeVisible();
  await input.fill("OrderX");
  await input.press("Enter");
  await expect(
    page.locator('[data-construct-kind="aggregate"][data-construct-name="OrderX"]'),
  ).toBeVisible({ timeout: 5_000 });
  await expect(
    page.locator('[data-construct-kind="aggregate"][data-construct-name="Order"]'),
  ).toHaveCount(0);

  // Delete OrderX via the `×`; aggregate node count drops by one.
  const renamed = page.locator('[data-construct-kind="aggregate"][data-construct-name="OrderX"]');
  const before = await page.locator('.react-flow__node[data-id^="aggregate:"]').count();
  await renamed.getByTestId("c4system-v2-delete").click();
  await expect
    .poll(async () => page.locator('.react-flow__node[data-id^="aggregate:"]').count(), { timeout: 5_000 })
    .toBe(before - 1);
});

test("Model v2 — module / aggregate / operation palettes (context / operation / field / stmt)", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);
  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });

  // System → module: + Context bumps the context node count by one.
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await page.locator('.react-flow__node[data-id^="subdomain:"]').first().click();
  await expect(page.getByTestId("c4system-v2-add-context")).toBeVisible();
  const ctxBefore = await page.locator('.react-flow__node[data-id^="context:"]').count();
  await page.getByTestId("c4system-v2-add-context").click();
  await expect
    .poll(async () => page.locator('.react-flow__node[data-id^="context:"]').count(), { timeout: 5_000 })
    .toBe(ctxBefore + 1);

  // Drill into the first context → Order: aggregate view shows + Operation +
  // Field. Each bumps the corresponding node count.
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  await page.locator('.react-flow__node[data-id="aggregate:Order"]').click();
  await expect(page.getByTestId("c4system-v2-add-operation")).toBeVisible();
  const opsBefore = await page.locator('.react-flow__node[data-id^="operation:"]').count();
  await page.getByTestId("c4system-v2-add-operation").click();
  await expect
    .poll(async () => page.locator('.react-flow__node[data-id^="operation:"]').count(), { timeout: 5_000 })
    .toBe(opsBefore + 1);

  const fieldsBefore = await page.locator('.react-flow__node[data-id^="field:"]').count();
  await page.getByTestId("c4system-v2-add-field").click();
  await expect
    .poll(async () => page.locator('.react-flow__node[data-id^="field:"]').count(), { timeout: 5_000 })
    .toBe(fieldsBefore + 1);

  // Drill into Order.confirm → operation flow: + Stmt adds a precondition node.
  await page.locator('.react-flow__node[data-id="operation:confirm"]').click();
  await expect(page.getByTestId("c4system-v2-add-stmt")).toBeVisible();
  const stmtsBefore = await page.getByTestId("c4system-v2-stmt").count();
  await page.getByTestId("c4system-v2-add-stmt").click();
  await expect
    .poll(async () => page.getByTestId("c4system-v2-stmt").count(), { timeout: 5_000 })
    .toBe(stmtsBefore + 1);
});

test("Model v2 renames a context and deletes an operation (v2-only kinds)", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);
  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });

  // Drill in to the module so contexts show as nodes.
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await page.locator('.react-flow__node[data-id^="subdomain:"]').first().click();
  const ctxNode = page.locator('[data-construct-kind="context"]').first();
  const ctxName = (await ctxNode.getAttribute("data-construct-name"))!;
  expect(ctxName).toBeTruthy();
  // Rename the context to Ctx2024 — v2-only because v1's NodeKind doesn't
  // cover BoundedContext rename.
  await ctxNode.getByTestId("c4system-v2-rename").click();
  await page.getByTestId("c4system-v2-rename-input").fill("Ctx2024");
  await page.getByTestId("c4system-v2-rename-input").press("Enter");
  await expect(
    page.locator('[data-construct-kind="context"][data-construct-name="Ctx2024"]'),
  ).toBeVisible({ timeout: 5_000 });

  // Drill in → Order → delete confirm operation.
  await page.locator('[data-construct-kind="context"][data-construct-name="Ctx2024"]').click();
  await page.locator('.react-flow__node[data-id="aggregate:Order"]').click();
  const opsBefore = await page.locator('.react-flow__node[data-id^="operation:"]').count();
  await page
    .locator('[data-construct-kind="operation"][data-construct-name="confirm"]')
    .getByTestId("c4system-v2-delete")
    .click();
  await expect
    .poll(async () => page.locator('.react-flow__node[data-id^="operation:"]').count(), { timeout: 5_000 })
    .toBe(opsBefore - 1);
});

test("Model v2 renames and deletes an aggregate field (renameMember + deleteField)", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);
  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });

  // Drill into Order's aggregate view to see its fields.
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await page.locator('.react-flow__node[data-id^="subdomain:"]').first().click();
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  await page.locator('.react-flow__node[data-id="aggregate:Order"]').click();

  // Pick any field node, rename it, and assert the renamed node appears.
  const field = page.locator('[data-construct-kind="field"]').first();
  await expect(field).toBeVisible();
  const oldName = await field.getAttribute("data-construct-name");
  expect(oldName).toBeTruthy();
  await field.getByTestId("c4system-v2-rename").click();
  await page.getByTestId("c4system-v2-rename-input").fill("fieldRenamed");
  await page.getByTestId("c4system-v2-rename-input").press("Enter");
  await expect(
    page.locator('[data-construct-kind="field"][data-construct-name="fieldRenamed"]'),
  ).toBeVisible({ timeout: 5_000 });

  // Delete it via the on-node × → field count drops.
  const fieldsBefore = await page.locator('[data-construct-kind="field"]').count();
  await page
    .locator('[data-construct-kind="field"][data-construct-name="fieldRenamed"]')
    .getByTestId("c4system-v2-delete")
    .click();
  await expect.poll(async () => page.locator('[data-construct-kind="field"]').count(), { timeout: 5_000 }).toBe(
    fieldsBefore - 1,
  );
});

test("Model v2 shows inline modules / serves multi-selects on a deployable", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  // Banking System has a `deployable api { modules: Banking }` plus `webApp`.
  await selectExample(page, /Banking System/);
  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();

  // The `api` deployable node renders both multi-selects.
  const dep = page.locator('[data-construct-kind="deployable"][data-construct-name="api"]');
  await expect(dep).toBeVisible();
  await expect(dep.getByTestId("c4system-v2-deployable-modules")).toBeVisible();
  await expect(dep.getByTestId("c4system-v2-deployable-serves")).toBeVisible();
});

test("Model v2 surfaces invariants as nodes and edits the condition inline", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Banking System/);
  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });

  // Banking System's Account aggregate declares two invariants.
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await page.locator('.react-flow__node[data-id^="subdomain:"]').first().click();
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  await page.locator('.react-flow__node[data-id="aggregate:Account"]').click();

  const invariants = page.locator('[data-construct-kind="invariant"]');
  await expect.poll(async () => invariants.count(), { timeout: 5_000 }).toBeGreaterThan(0);

  // The first invariant exposes the ƒx toggle → opens the structured editor.
  const first = invariants.first();
  await first.getByTestId("c4system-v2-expr-toggle").click();
  await expect(first.getByTestId("c4system-v2-expression-editor")).toBeVisible({ timeout: 10_000 });
});

test("Model v2 edits a repository find's filter inline", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  // Acme has repositories with finds and filters; storefront-dotnet also.
  await selectExample(page, /Acme/);
  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });

  // Drill to the first repository node (acme has `repository Products` /
  // `repository Orders`) and into its find list.
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await page.locator('.react-flow__node[data-id^="subdomain:"]').first().click();
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  const repo = page.locator('[data-construct-kind="repository"]').first();
  await expect(repo).toBeVisible();
  await repo.click();

  const find = page.locator('[data-construct-kind="find"]').first();
  await expect(find).toBeVisible();
  await find.getByTestId("c4system-v2-expr-toggle").click();
  await expect(find.getByTestId("c4system-v2-expression-editor")).toBeVisible({ timeout: 10_000 });
});

test("Model v2 persists hand-dragged node positions across a reload, and Reset clears them", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);
  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });

  // Drill system → module → context so the aggregate nodes are visible.
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await page.locator('.react-flow__node[data-id^="subdomain:"]').first().click();
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();

  const node = page.locator('[data-testid="rf__node-aggregate:Order"]');
  await expect(node).toBeVisible({ timeout: 5_000 });
  // The node's CSS transform is in flow coordinates (pan/zoom lives on the
  // viewport), so it's a stable identity to compare across reload + fitView.
  const transform = (): Promise<string> => node.evaluate((el) => (el as HTMLElement).style.transform);
  const derived = await transform();

  // Drag the aggregate by a screen delta; its transform should change.
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 80, { steps: 10 });
  await page.mouse.up();
  await expect.poll(transform).not.toBe(derived);
  const dragged = await transform();

  // Reload + re-drill to the same context — the dragged transform survives.
  await page.reload();
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);
  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await page.locator('.react-flow__node[data-id^="subdomain:"]').first().click();
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  await expect(node).toBeVisible({ timeout: 5_000 });
  await expect.poll(transform, { timeout: 10_000 }).toBe(dragged);

  // Reset layout (auto-accept the `confirm` dialog) → back to the derived
  // position and the button disappears once nothing is persisted.
  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("c4system-v2-reset-layout").click();
  await expect.poll(transform).toBe(derived);
  await expect(page.getByTestId("c4system-v2-reset-layout")).toHaveCount(0);
});

test("Model v2 repoints an emit statement's event inline", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  // Banking System declares four sibling events — Account.deposit emits
  // MoneyDeposited; we repoint it to MoneyWithdrawn.
  await selectExample(page, /Banking System/);
  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });

  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await page.locator('.react-flow__node[data-id^="subdomain:"]').first().click();
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  await page.locator('.react-flow__node[data-id="aggregate:Account"]').click();
  await page.locator('.react-flow__node[data-id="operation:deposit"]').click();

  const emit = page.locator('[data-testid="c4system-v2-stmt"][data-stmt-kind="emit"]').first();
  await expect(emit).toBeVisible();
  const eventSelect = emit.getByTestId("c4system-emit-event");
  await expect(eventSelect).toHaveValue("MoneyDeposited");

  await eventSelect.click();
  await page.getByRole("option", { name: "MoneyWithdrawn", exact: true }).click();
  await expect(eventSelect).toHaveValue("MoneyWithdrawn");
});
