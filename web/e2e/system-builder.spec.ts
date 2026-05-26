// System / Model Builder (React Flow) end-to-end: open a full system, switch to
// the Model tab, confirm the structural graph renders, then add and delete a
// construct and confirm the edits write back to valid `.ddd` source.

import { expect, test } from "@playwright/test";
import { selectExample, waitForPlaygroundReady } from "./_helpers";

test("renders the structural graph and edits write back to source", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });

  // The graph renders one React Flow node per construct (modules, aggregates,
  // deployables, …) — there should be several.  Let the initial render + fitView
  // settle to a stable count before editing (reading mid-settle races the
  // re-seed and the autogenerate the edit kicks off).
  const flowNodes = page.locator(".react-flow__node");
  await expect.poll(async () => flowNodes.count(), { timeout: 10_000 }).toBeGreaterThan(3);
  let stable = -1;
  await expect
    .poll(async () => {
      const n = await flowNodes.count();
      const ok = n === stable;
      stable = n;
      return ok ? n : -1;
    })
    .toBeGreaterThan(3);
  const before = await flowNodes.count();

  // Add an aggregate → a node appears and the source stays valid.
  await page.getByTestId("c4system-add-aggregate").click();
  await expect.poll(async () => flowNodes.count()).toBeGreaterThan(before);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);

  // Select the just-added aggregate (deterministic fresh name) and delete it —
  // deleting a leaf removes exactly one node (deleting a module would cascade
  // its whole subtree).  fitView keeps every node inside the canvas, so it's
  // clickable.
  const added = page.locator('[data-testid="rf__node-aggregate:Aggregate1"]');
  await expect(added).toHaveCount(1);
  await added.click();
  await expect(page.getByTestId("c4system-selected-name")).toBeVisible();

  await page.getByTestId("c4system-delete").click();
  await expect.poll(async () => flowNodes.count()).toBe(before);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("renames a construct (and its references) from the inspector", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });

  const flowNodes = page.locator(".react-flow__node");
  await expect.poll(async () => flowNodes.count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Select a node fully inside the canvas (see note above re transformed pane).
  const canvasBox = (await page.getByTestId("c4system-canvas").boundingBox())!;
  const count = await flowNodes.count();
  for (let i = 0; i < count; i++) {
    const b = await flowNodes.nth(i).boundingBox();
    if (
      b &&
      b.x >= canvasBox.x &&
      b.y >= canvasBox.y &&
      b.x + b.width <= canvasBox.x + canvasBox.width &&
      b.y + b.height <= canvasBox.y + canvasBox.height
    ) {
      await flowNodes.nth(i).click();
      break;
    }
  }
  await expect(page.getByTestId("c4system-selected-name")).toBeVisible();

  // Rename it — relies on a full client-side linked build to follow references.
  const newName = "RenamedNodeXyz";
  await page.getByTestId("c4system-rename-input").fill(newName);
  await page.getByTestId("c4system-rename-apply").click();

  // A node with the new name appears and the source stays valid.
  await expect(page.locator(`[data-testid$=":${newName}"]`)).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("adds, retypes, and deletes an aggregate field from the inspector", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });

  // Select an aggregate node that's fully inside the canvas.
  const canvasBox = (await page.getByTestId("c4system-canvas").boundingBox())!;
  const aggNodes = page.locator('.react-flow__node[data-testid^="rf__node-aggregate:"]');
  await expect.poll(async () => aggNodes.count(), { timeout: 10_000 }).toBeGreaterThan(0);
  const aggCount = await aggNodes.count();
  for (let i = 0; i < aggCount; i++) {
    const b = await aggNodes.nth(i).boundingBox();
    const cx = b ? b.x + b.width / 2 : -1;
    const cy = b ? b.y + b.height / 2 : -1;
    if (
      b &&
      cx >= canvasBox.x &&
      cx <= canvasBox.x + canvasBox.width &&
      cy >= canvasBox.y &&
      cy <= canvasBox.y + canvasBox.height
    ) {
      await aggNodes.nth(i).click();
      break;
    }
  }
  await expect(page.getByTestId("c4system-fields")).toBeVisible();

  const rows = page.getByTestId("c4system-field-row");
  const before = await rows.count();

  // Add a field — a row appears, source stays valid, selection is kept.
  await page.getByTestId("c4system-field-add").click();
  await expect.poll(async () => rows.count()).toBe(before + 1);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);

  // Retype the new (last) field via its Select.
  await rows.last().getByTestId("c4system-field-type").click();
  await page.getByRole("option", { name: "int", exact: true }).first().click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);

  // Delete it — row count returns to the original, source stays valid.
  await rows.last().getByTestId("c4system-field-delete").click();
  await expect.poll(async () => rows.count()).toBe(before);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("renames a field (and its usages) from the inspector", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Order.status — used in an invariant guard, `isMutable`, and `status :=`.
  await page.locator('[data-testid="rf__node-aggregate:Order"]').click();
  const names = page.getByTestId("c4system-field-name");
  await expect(names.nth(1)).toHaveValue("status");
  await names.nth(1).fill("state");
  await names.nth(1).blur();
  // Reference-aware rename runs async (linked build) then re-renders the field.
  await expect(page.getByTestId("c4system-field-name").nth(1)).toHaveValue("state", { timeout: 10_000 });
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(names.nth(0)).toHaveValue("customerId");
});

test("adds every domain + infra construct kind from the palette", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  const nodes = page.locator(".react-flow__node");
  await expect.poll(async () => nodes.count(), { timeout: 10_000 }).toBeGreaterThan(3);
  const before = await nodes.count();

  const kinds = ["valueobject", "event", "workflow", "repository", "view", "storage", "ui", "deployable", "api"];
  for (const kind of kinds) {
    await page.getByTestId(`c4system-add-${kind}`).click();
  }

  // Each add inserts a minimal valid construct → one new graph node each, no errors.
  await expect.poll(async () => nodes.count(), { timeout: 10_000 }).toBe(before + kinds.length);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  for (const id of [
    "valueobject:ValueObject1", "event:Event1", "workflow:Workflow1", "repository:Repository1", "view:View1",
    "storage:Storage1", "ui:Ui1", "deployable:Deployable1", "api:Api1",
  ]) {
    await expect(page.locator(`[data-testid="rf__node-${id}"]`)).toBeVisible();
  }
});

test("edits a bare call statement's argument", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /\.NET backend only/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // placeOrder calls `order.addLine(productId, quantity)` — edit the 2nd arg.
  await page.locator('[data-testid="rf__node-workflow:placeOrder"]').click();
  await page.getByTestId("c4system-expr-pick").click();
  await page.getByRole("option", { name: /order\.addLine\(…\) arg 2: quantity/ }).click();

  const raw = page.getByTestId("c4expr").getByTestId("c4expr-raw");
  await expect(raw).toHaveValue("quantity");
  await raw.fill("productId");
  await raw.blur();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(page.getByTestId("c4expr").getByTestId("c4expr-raw")).toHaveValue("productId");
});

test("repoints an emit statement at a different event", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Banking System \(Hono \+ React\)/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Account.deposit emits MoneyDeposited — repoint it at AccountFrozen.
  await page.locator('[data-testid="rf__node-aggregate:Account"]').click();
  await page.getByTestId("c4system-emit-pick").click();
  await page.getByRole("option", { name: "deposit: emit MoneyDeposited" }).click();

  const event = page.getByTestId("c4system-emit-event");
  await expect(event).toHaveValue("MoneyDeposited");
  await event.click();
  await page.getByRole("option", { name: "AccountFrozen", exact: true }).click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(page.getByTestId("c4system-emit-event")).toHaveValue("AccountFrozen");
});

test("edits a deployable's composition bindings", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Acme/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // catalogWeb: modules Catalog + CustomerMgmt — add Sales via the multi-select.
  await page.locator('[data-testid="rf__node-deployable:catalogWeb"]').click();
  // Mantine's MultiSelect wrapper intercepts the input click — force it open.
  await page.getByTestId("c4system-deployable-modules").click({ force: true });
  await page.getByRole("option", { name: "Sales", exact: true }).click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  // The targets select reads the existing binding (sanity that bindings render).
  await page.locator('[data-testid="rf__node-deployable:webApp"]').click();
  await expect(page.getByTestId("c4system-deployable-targets")).toHaveValue("api");
});

test("edits infra construct properties (deployable platform, storage type)", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Deployable: change webApp's platform react → static.
  await page.locator('[data-testid="rf__node-deployable:webApp"]').click();
  const platform = page.getByTestId("c4system-deployable-platform");
  await expect(platform).toHaveValue("react");
  await platform.click();
  await page.getByRole("option", { name: "static", exact: true }).click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(page.getByTestId("c4system-deployable-platform")).toHaveValue("static");

  // Storage: add one, then change its type.
  await page.getByTestId("c4system-add-storage").click();
  await page.locator('[data-testid="rf__node-storage:Storage1"]').click();
  const stype = page.getByTestId("c4system-storage-type");
  await expect(stype).toHaveValue("postgres");
  await stype.click();
  await page.getByRole("option", { name: "redis", exact: true }).click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(page.getByTestId("c4system-storage-type")).toHaveValue("redis");
});

test("edits a repository find's parameters", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  // Banking System exposes the `repository Accounts` with the multi-param
  // `byHolder(holder: Customer id)` find that this spec edits.
  await selectExample(page, /Banking System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Accounts.byHolder(holder: Id<Customer>) — pick it and edit its params.
  await page.locator('[data-testid="rf__node-repository:Accounts"]').click();
  await page.getByTestId("c4system-find-pick").click();
  await page.getByRole("option", { name: "byHolder", exact: true }).click();

  const rows = page.getByTestId("c4system-param-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByTestId("c4system-field-name")).toHaveValue("holder");

  await page.getByTestId("c4system-param-add").click();
  await expect(page.getByTestId("c4system-param-row")).toHaveCount(2);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);

  await page.getByTestId("c4system-param-row").last().getByTestId("c4system-param-delete").click();
  await expect(page.getByTestId("c4system-param-row")).toHaveCount(1);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("rebinds a repository's target aggregate from the inspector", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // The Customers repository is bound `for Customer`; rebind it to Order.
  await page.locator('[data-testid="rf__node-repository:Customers"]').click();
  const rebind = page.getByTestId("c4system-rebind");
  await expect(rebind).toBeVisible();
  await expect(rebind).toHaveValue("Customer");

  await rebind.click();
  await page.getByRole("option", { name: "Order", exact: true }).click();

  // Selection is kept and the inspector reflects the new target; source valid.
  await expect(page.getByTestId("c4system-rebind")).toHaveValue("Order");
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("edits a workflow body's statements", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  await page.locator('[data-testid="rf__node-workflow:placeOrder"]').click();
  await expect(page.getByTestId("c4system-body")).toBeVisible();
  const rows = page.getByTestId("c4system-stmt-row");
  await expect.poll(async () => rows.count()).toBeGreaterThan(0);
  const before = await rows.count();

  // Add a valid statement → row appears, source stays valid.
  await page.getByTestId("c4system-stmt-add-input").fill("let extra = customer");
  await page.getByTestId("c4system-stmt-add").click();
  await expect.poll(async () => rows.count()).toBe(before + 1);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);

  // Delete it again.
  await rows.last().getByTestId("c4system-stmt-delete").click();
  await expect.poll(async () => rows.count()).toBe(before);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("nests constructs into module / context groups when Group is on", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // No group containers in the default flat layout; toggling Group adds them.
  const groupNodes = page.locator('.react-flow__node[data-id^="group:"]');
  await expect(groupNodes).toHaveCount(0);
  await page.getByTestId("c4system-group-toggle").click();
  await expect.poll(async () => groupNodes.count(), { timeout: 10_000 }).toBeGreaterThan(0);
  // Toggling off restores the flat layout.
  await page.getByTestId("c4system-group-toggle").click();
  await expect(groupNodes).toHaveCount(0);
});

test("adds a construct into the chosen target context", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  // Acme is a multi-context system, so the add-target picker shows.
  await selectExample(page, /Acme/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  const picker = page.getByTestId("c4system-add-context");
  await expect(picker).toBeVisible();
  await picker.click();
  await page.getByRole("option", { name: "Orders", exact: true }).click();

  const before = await page.locator(".react-flow__node").count();
  await page.getByTestId("c4system-add-aggregate").click();
  await expect.poll(async () => page.locator(".react-flow__node").count()).toBe(before + 1);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("structures a bare-call workflow statement into head + args", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  await page.locator('[data-testid="rf__node-workflow:placeOrder"]').click();
  await expect(page.getByTestId("c4system-body")).toBeVisible();
  // `order.addLine(productId, qty)` is a bare call → head + per-arg controls.
  const head = page.getByTestId("c4system-call-head").first();
  await expect(head).toBeVisible();
  await expect(head).toHaveValue("order.addLine");
  await expect(page.getByTestId("c4system-call-arg")).not.toHaveCount(0);

  // The head is an Autocomplete over in-scope names: clearing it offers the
  // receiver `order` (a let-bound earlier in the workflow) as a suggestion.
  await head.fill("");
  await expect(page.getByRole("option", { name: "order", exact: true })).toBeVisible({ timeout: 5_000 });
});

test("edits an operation body via the aggregate inspector", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Select the Order aggregate, pick the `confirm` operation → its body shows.
  await page.locator('[data-testid="rf__node-aggregate:Order"]').click();
  await page.getByTestId("c4system-op-pick").click();
  await page.getByRole("option", { name: "confirm", exact: true }).click();
  await expect(page.getByTestId("c4system-body")).toBeVisible();

  const rows = page.getByTestId("c4system-stmt-row");
  const stmts = page.getByTestId("c4system-stmt");
  await expect.poll(async () => rows.count()).toBe(4);

  // Reorder: move the first statement down → first two swap.
  const r0 = await stmts.nth(0).inputValue();
  const r1 = await stmts.nth(1).inputValue();
  await rows.nth(0).getByTestId("c4system-stmt-down").click();
  await expect.poll(async () => stmts.nth(0).inputValue()).toBe(r1);
  await expect(stmts.nth(1)).toHaveValue(r0);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);

  // Add a statement.
  await page.getByTestId("c4system-stmt-add-input").fill("precondition true");
  await page.getByTestId("c4system-stmt-add").click();
  await expect.poll(async () => rows.count()).toBe(5);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);

  // The `status := Confirmed` assignment is structured into a dedicated target /
  // op / value (not a single text row). Edit the target → it splices, re-parses,
  // and the row re-seeds from source under the new target.
  const target = page.getByTestId("c4system-stmt-target");
  await expect(target).toHaveValue("status");
  await expect(page.getByTestId("c4system-stmt-value")).toHaveValue("Confirmed");
  await target.fill("placedAt");
  await target.blur();
  await expect(page.getByTestId("c4system-stmt-target")).toHaveValue("placedAt");
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("edits an expression structurally (operator dropdown + leaf)", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Money's `amount >= 0` invariant decomposes into a structured operator tree.
  await page.locator('[data-testid="rf__node-valueobject:Money"]').click();
  await page.getByTestId("c4system-expr-pick").click();
  await page.getByRole("option", { name: "invariant: amount >= 0" }).click();
  await expect(page.getByTestId("c4expr")).toBeVisible();

  // Change the operator via the dropdown → committed, re-seeded from source.
  const op = () => page.getByTestId("c4expr").getByTestId("c4expr-op");
  await expect(op()).toHaveValue(">=");
  await op().click();
  await page.getByRole("option", { name: ">", exact: true }).click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(op()).toHaveValue(">");

  // Advanced escape hatch: drop to text mode and edit the whole expression.
  await page.getByTestId("c4expr-mode").getByText("Text").click();
  const text = page.getByTestId("c4expr-text");
  await expect(text).toBeVisible();
  await text.fill("amount >= 1");
  await text.blur();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(page.getByTestId("c4expr-text")).toHaveValue("amount >= 1");
});

test("edits a view's where filter through the expression editor", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Fullstack \.NET \(Banking\)/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // `view OpenAccounts = Account where status == Open` → editable where filter.
  await page.locator('[data-testid="rf__node-view:OpenAccounts"]').click();
  await page.getByTestId("c4system-expr-pick").click();
  await page.getByRole("option", { name: "where: status == Open" }).click();

  const op = () => page.getByTestId("c4expr").getByTestId("c4expr-op");
  await expect(op()).toHaveValue("==");
  await op().click();
  await page.getByRole("option", { name: "!=", exact: true }).click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(op()).toHaveValue("!=");
});

test("structures a member call and edits its arguments", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Banking System \(Hono \+ React\)/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Account has `invariant transactions.all(t => t.amount.amount > 0)` — a
  // member call (`transactions.all(…)`) whose lambda arg stays a raw leaf.
  await page.locator('[data-testid="rf__node-aggregate:Account"]').click();
  await page.getByTestId("c4system-expr-pick").click();
  await page.getByRole("option", { name: "invariant: transactions.all(t => t.amount.amount > 0)" }).click();

  const expr = page.getByTestId("c4expr");
  // The outer `.all` member (the lambda body adds nested `.amount` members).
  await expect(expr.getByTestId("c4expr-member").first()).toHaveValue("all");
  // The lambda arg (`t => …`) structures into a param + body.
  await expect(expr.getByTestId("c4expr-lambda-param")).toHaveValue("t");

  // Append an argument → the call re-parses (a defaulted `null` operand).
  await expr.getByTestId("c4expr-arg-add").click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(page.getByTestId("c4expr").getByTestId("c4expr-arg-del")).toHaveCount(2);

  // Remove it again → back to a single argument, still valid.
  await page.getByTestId("c4expr").getByTestId("c4expr-arg-del").last().click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(page.getByTestId("c4expr").getByTestId("c4expr-arg-del")).toHaveCount(1);
});

test("edits an operation-body statement expression", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Order.addLine has `precondition qty > 0` — a statement expression.
  await page.locator('[data-testid="rf__node-aggregate:Order"]').click();
  await page.getByTestId("c4system-expr-pick").click();
  await page.getByRole("option", { name: "addLine: precondition qty > 0" }).click();

  const op = () => page.getByTestId("c4expr").getByTestId("c4expr-op");
  await expect(op()).toHaveValue(">");
  await op().click();
  await page.getByRole("option", { name: ">=", exact: true }).click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(op()).toHaveValue(">=");
});

test("edits a workflow-body statement expression", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Banking System \(Hono \+ React\)/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // transferFunds workflow has `precondition amount.amount > 0`.
  await page.locator('[data-testid="rf__node-workflow:transferFunds"]').click();
  await page.getByTestId("c4system-expr-pick").click();
  await page.getByRole("option", { name: "precondition amount.amount > 0" }).click();

  const op = () => page.getByTestId("c4expr").getByTestId("c4expr-op");
  await expect(op()).toHaveValue(">");
  await op().click();
  await page.getByRole("option", { name: ">=", exact: true }).click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(op()).toHaveValue(">=");
});

test("structures an object literal and edits its fields", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /\.NET backend only/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // placeOrder: let order = Order.create({ customerId: …, status: Draft, placedAt: now() })
  await page.locator('[data-testid="rf__node-workflow:placeOrder"]').click();
  await page.getByTestId("c4system-expr-pick").click();
  await page.getByRole("option", { name: /let order = Order\.create/ }).click();

  const expr = page.getByTestId("c4expr");
  // The object literal exposes its named fields.
  await expect(expr.getByTestId("c4expr-field-name").first()).toHaveValue("customerId");
  await expect(expr.getByTestId("c4expr-field-name")).toHaveCount(3);

  // Append a field → still parses; then remove it.
  await expr.getByTestId("c4expr-field-add").click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(page.getByTestId("c4expr").getByTestId("c4expr-field-name")).toHaveCount(4);
  await page.getByTestId("c4expr").getByTestId("c4expr-field-del").last().click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(page.getByTestId("c4expr").getByTestId("c4expr-field-name")).toHaveCount(3);
});

test("edits an assignment value inside an operation body", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Fullstack \.NET \(Banking\)/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Account.deposit: `balance := Money(balance.amount + amount.amount, balance.currency)`
  // — the assignment value is editable structurally (a call with a `+` inside).
  await page.locator('[data-testid="rf__node-aggregate:Account"]').click();
  await page.getByTestId("c4system-expr-pick").click();
  await page.getByRole("option", { name: "deposit: balance := Money" }).click();

  // The `Money(…)` call's positional args are labelled with the VO ctor's
  // parameter names (type-resolved, async via the linked build).
  await expect(page.getByTestId("c4expr").getByTestId("c4expr-arg-label").first()).toHaveText("amount:", { timeout: 10_000 });

  const op = () => page.getByTestId("c4expr").getByTestId("c4expr-op");
  await expect(op()).toHaveValue("+");
  await op().click();
  await page.getByRole("option", { name: "-", exact: true }).click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(op()).toHaveValue("-");
});

test("expands an assignment value into the inline structured editor (ƒx)", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Fullstack \.NET \(Banking\)/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Account.deposit's body has `balance := Money(…)`. Open it in the body editor.
  await page.locator('[data-testid="rf__node-aggregate:Account"]').click();
  await page.getByTestId("c4system-op-pick").click();
  await page.getByRole("option", { name: "deposit", exact: true }).click();
  await expect(page.getByTestId("c4system-body")).toBeVisible();

  // The assign row (the one with the target Autocomplete) shows a text value plus
  // the ƒx toggle; expanding it swaps the text field for the structured editor.
  const assignRow = page
    .getByTestId("c4system-stmt-row")
    .filter({ has: page.getByTestId("c4system-stmt-target") })
    .first();
  await expect(page.getByTestId("c4system-stmt-value")).toBeVisible();
  await assignRow.getByTestId("c4system-stmt-structured").click();
  await expect(page.getByTestId("c4expr")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("c4system-stmt-value")).toHaveCount(0);
});

test("expands a precondition's expression into the inline structured editor (ƒx)", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  await page.locator('[data-testid="rf__node-aggregate:Order"]').click();
  await page.getByTestId("c4system-op-pick").click();
  await page.getByRole("option", { name: "confirm", exact: true }).click();
  await expect(page.getByTestId("c4system-body")).toBeVisible();

  // The first statement (`precondition isMutable()`) is a text row with a ƒx
  // toggle that expands its expression into the inline structured editor.
  const row = page.getByTestId("c4system-stmt-row").first();
  await expect(row.getByTestId("c4system-stmt")).toBeVisible();
  await row.getByTestId("c4system-stmt-structured").click();
  await expect(page.getByTestId("c4expr")).toBeVisible({ timeout: 10_000 });
  await expect(row.getByTestId("c4system-stmt")).toHaveCount(0);
});

test("expands a bare-call argument into the inline structured editor (ƒx)", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // placeOrder's `order.addLine(productId, qty)` is a bare call — each argument
  // is a text field with a ƒx toggle to the inline structured editor.
  await page.locator('[data-testid="rf__node-workflow:placeOrder"]').click();
  await expect(page.getByTestId("c4system-body")).toBeVisible();
  const argFx = page.getByTestId("c4system-call-arg-structured").first();
  await expect(argFx).toBeVisible();
  await expect(page.getByTestId("c4system-call-arg").first()).toBeVisible();
  await argFx.click();
  await expect(page.getByTestId("c4expr")).toBeVisible({ timeout: 10_000 });
});

test("expands an emit field value into the inline structured editor (ƒx)", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Order.confirm ends with `emit OrderConfirmed { order: id, at: now() }` — each
  // field is name + value (text) with a ƒx toggle to the structured editor.
  await page.locator('[data-testid="rf__node-aggregate:Order"]').click();
  await page.getByTestId("c4system-op-pick").click();
  await page.getByRole("option", { name: "confirm", exact: true }).click();
  await expect(page.getByTestId("c4system-body")).toBeVisible();
  await expect(page.getByTestId("c4system-emit-field-name").first()).toBeVisible();
  await expect(page.getByTestId("c4system-emit-field-value").first()).toBeVisible();
  await page.getByTestId("c4system-emit-field-structured").first().click();
  await expect(page.getByTestId("c4expr")).toBeVisible({ timeout: 10_000 });
});

test("offers type-directed member-name suggestions", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Order's `invariant lines.count > 0` — `lines` is a collection, so the member
  // input on `lines.‹count›` should suggest the collection ops.
  await page.locator('[data-testid="rf__node-aggregate:Order"]').click();
  await page.getByTestId("c4system-expr-pick").click();
  await page.getByRole("option", { name: "invariant: lines.count > 0" }).click();

  const member = page.getByTestId("c4expr").getByTestId("c4expr-member");
  await expect(member).toHaveValue("count");
  // Clear and open the autocomplete → type-directed candidates (built async).
  await member.fill("");
  await expect(page.getByRole("option", { name: "first", exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("option", { name: "first", exact: true }).click();
  await member.blur();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(page.getByTestId("c4expr").getByTestId("c4expr-member")).toHaveValue("first");
});

test("offers scope-aware name suggestions in a raw leaf", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  await page.locator('[data-testid="rf__node-valueobject:Money"]').click();
  await page.getByTestId("c4system-expr-pick").click();
  await page.getByRole("option", { name: "invariant: amount >= 0" }).click();

  // The `amount` operand is a raw leaf; its autocomplete is fed Money's own
  // properties (`amount`, `currency`) — pick the sibling property.
  const raw = page.getByTestId("c4expr").getByTestId("c4expr-raw");
  await expect(raw).toHaveValue("amount");
  await raw.fill("curr");
  await page.getByRole("option", { name: "currency", exact: true }).click();
  await raw.blur();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(page.getByTestId("c4expr").getByTestId("c4expr-raw")).toHaveValue("currency");
});

test("edits a repository find's where filter through the expression editor", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Fullstack \.NET \(Banking\)/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // `find byHolder(...) where this.holder == holder` on the Accounts repository.
  await page.locator('[data-testid="rf__node-repository:Accounts"]').click();
  await page.getByTestId("c4system-expr-pick").click();
  await page.getByRole("option", { name: "find byHolder where: this.holder == holder" }).click();

  const op = () => page.getByTestId("c4expr").getByTestId("c4expr-op");
  await expect(op()).toHaveValue("==");
  await op().click();
  await page.getByRole("option", { name: "!=", exact: true }).click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect(op()).toHaveValue("!=");
});

// Inject source via the playground's test seam, like builder-page.spec.ts.
async function setSource(page: import("@playwright/test").Page, source: string): Promise<void> {
  await page.waitForFunction(() => typeof (window as unknown as { __loomSetSource?: unknown }).__loomSetSource === "function");
  await page.evaluate((t) => (window as unknown as { __loomSetSource: (s: string) => void }).__loomSetSource(t), source);
}

const EXPR_SOURCE = `system S {
  context C {
    aggregate Order {
      qty: int
      derived tag: string = qty > 0 ? "yes" : "no"
      derived bucket: string = match {
        qty > 0 => "pos"
        else => "neg"
      }
    }
  }
}`;

test("structures ternary and match expressions in the editor", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await setSource(page, EXPR_SOURCE);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-testid="rf__node-aggregate:Order"]').click();

  // Ternary: `qty > 0 ? "yes" : "no"` renders as a ternary with a nested binary
  // cond. Change the cond operator and confirm it commits back to source.
  await page.getByTestId("c4system-expr-pick").click();
  await page.getByRole("option", { name: "derived tag" }).click();
  await expect(page.getByTestId("c4expr-ternary")).toBeVisible();
  const op = page.getByTestId("c4expr").getByTestId("c4expr-op");
  await expect(op).toHaveValue(">");
  await op.click();
  await page.getByRole("option", { name: ">=", exact: true }).click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  const model = () => page.evaluate(() => (window as unknown as { __loomGetSource: () => string }).__loomGetSource());
  await expect.poll(model).toContain('qty >= 0 ? "yes" : "no"');

  // Match: `match { qty > 0 => "pos" else => "neg" }` renders structured; add an
  // arm and confirm the new (parseable) arm lands in source.
  await page.getByTestId("c4system-expr-pick").click();
  await page.getByRole("option", { name: "derived bucket" }).click();
  await expect(page.getByTestId("c4expr-match")).toBeVisible();
  await expect(page.getByTestId("c4expr-arm-del")).toHaveCount(1);
  await page.getByTestId("c4expr-arm-add").click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
  await expect.poll(model).toContain("true => null");
});

test("searches and kind-filters the model graph", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // A name search reveals a match count and enables Focus; clearing it hides them.
  await page.getByTestId("c4system-search").fill("Order");
  await expect(page.getByTestId("c4system-match-count")).toBeVisible();
  await expect(page.getByTestId("c4system-focus")).toBeEnabled();
  await page.getByTestId("c4system-focus").click();
  await page.getByTestId("c4system-search").fill("");
  await expect(page.getByTestId("c4system-match-count")).toHaveCount(0);
});

test("toggles the traceability coverage overlay", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Coverage overlay off by default; toggling it on reveals the tested/untested
  // legend (the linked model is lowered + enriched async to compute coverage).
  await expect(page.getByTestId("c4system-coverage-legend")).toHaveCount(0);
  await page.getByTestId("c4system-coverage-toggle").click();
  await expect(page.getByTestId("c4system-coverage-legend")).toBeVisible();
  await page.getByTestId("c4system-coverage-toggle").click();
  await expect(page.getByTestId("c4system-coverage-legend")).toHaveCount(0);
});

test("previews an edit's source diff before applying when Preview is on", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // With Preview on, an edit (add a module) stages its diff in a modal instead
  // of committing live; Apply commits it and closes the modal.
  await page.getByTestId("c4system-preview-toggle").click();
  await page.getByTestId("c4system-add-module").click();
  // Assert the modal's content (the diff), not the Mantine modal root — the
  // root is a zero-box wrapper Playwright never treats as "visible".
  await expect(page.getByTestId("c4system-preview-diff")).toBeVisible();
  await page.getByTestId("c4system-preview-apply").click();
  await expect(page.getByTestId("c4system-preview-diff")).toHaveCount(0);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("shows the selected aggregate's wire shape (DTO field list)", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Selecting an aggregate computes + shows its canonical wire shape (async
  // lower + enrich); the first field is always the id.
  await page.locator('[data-testid="rf__node-aggregate:Order"]').click();
  await expect(page.getByTestId("c4system-wireshape")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("c4system-wire-field").first()).toContainText("id");
});

test("persists hand-dragged node positions across a reload, and Reset clears them", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);
  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 }).toBeGreaterThan(3);

  const node = page.locator('[data-testid="rf__node-aggregate:Order"]');
  // A node's CSS transform is in flow coordinates (pan/zoom lives on the
  // viewport), so it's a stable identity to compare across reload + fitView.
  const transform = () => node.evaluate((el) => (el as HTMLElement).style.transform);
  const derived = await transform();

  // Drag the node by a screen delta; its transform should change and persist.
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 90, { steps: 10 });
  await page.mouse.up();
  await expect.poll(transform).not.toBe(derived);
  const dragged = await transform();

  await page.reload();
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);
  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(transform, { timeout: 10_000 }).toBe(dragged);

  // Reset layout discards the saved position → back to the derived layout.
  await page.getByTestId("c4system-reset-layout").click();
  await expect.poll(transform).toBe(derived);
});
