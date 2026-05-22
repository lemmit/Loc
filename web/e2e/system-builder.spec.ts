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

test("edits a repository find's parameters", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Fullstack \.NET \(Banking\)/);

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
