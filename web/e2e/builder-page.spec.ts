// Page-builder MVP (craft.js) end-to-end: open a system with explicit pages,
// switch to the visual Builder, edit a Heading's text, apply, and confirm the
// edit round-trips through the `.ddd` source (the builder re-seeds from the
// rewritten source). Pure client-side — no network.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { selectExample, waitForPlaygroundReady } from "./_helpers";

// Set the editor document in one shot via the editor's automation seam
// (`window.__loomSetSource`), which dispatches onChange like a real edit —
// robust against clipboard/paste + auto-closing-bracket behaviour.
async function setSource(page: Page, source: string): Promise<void> {
  await page.getByTestId("doc-tab-source").click();
  await page.waitForFunction(() => typeof (window as unknown as { __loomSetSource?: unknown }).__loomSetSource === "function");
  await page.evaluate((t) => (window as unknown as { __loomSetSource: (s: string) => void }).__loomSetSource(t), source);
}

// craft drag is pointer-driven, so simulate a real mouse drag (down → stepped
// move → up) rather than Playwright's one-shot dragTo.  `yFrac` picks where in
// the target to drop — near the top (0.15) inserts before it.
async function dragOnto(page: Page, source: Locator, target: Locator, yFrac = 0.5): Promise<void> {
  const s = (await source.boundingBox())!;
  const t = (await target.boundingBox())!;
  const tx = t.x + t.width / 2;
  const ty = t.y + t.height * yFrac;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(tx, ty, { steps: 12 });
  await page.mouse.move(tx, ty + 2, { steps: 4 });
  await page.mouse.up();
}

test("page builder edits a heading and writes it back to source", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Components storybook/);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });

  // Editing the storybook's top heading.
  const heading = page.getByTestId("c4node-Heading").filter({ hasText: "Loom UI Storybook" });
  await heading.first().click();

  const textInput = page.getByTestId("c4builder-prop-text");
  await expect(textInput).toHaveValue("Loom UI Storybook");
  await textInput.fill("Storybook EDITED");

  // Live canvas reflects the edit immediately (craft setProp).
  await expect(page.getByTestId("c4builder-canvas")).toContainText("Storybook EDITED");

  // Apply regenerates the body and splices it into the source; the builder
  // re-seeds from the rewritten source, so the edit persisting proves the
  // round-trip (emit → splice → re-parse) worked and the source stayed valid.
  await page.getByTestId("c4builder-apply").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible();
  await expect(page.getByTestId("c4builder-canvas")).toContainText("Storybook EDITED");
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("palette adds a primitive and writes it back to source", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Components storybook/);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });

  // Click the Button chip → a default Button("Button") is added to the body's
  // top container.  Storybook's own buttons render their own labels, so a node
  // reading exactly "Button" is the newly added one.
  const newButton = page.getByTestId("c4node-Button").filter({ hasText: "Button" });
  await expect(newButton).toHaveCount(0);
  await page.getByTestId("c4palette-Button").click();
  await expect(newButton.first()).toBeVisible();

  await page.getByTestId("c4builder-apply").click();
  await expect(page.getByTestId("c4builder-canvas")).toContainText("Button");
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});




test("builder Apply syncs the edit into the Monaco source tab + LSP", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Components storybook/);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });

  // Edit the top heading to a space-free marker (Monaco tokenises on spaces,
  // so a single contiguous token is reliable to match in `.view-lines`).
  const heading = page.getByTestId("c4node-Heading").filter({ hasText: "Loom UI Storybook" });
  await heading.first().click();
  await page.getByTestId("c4builder-prop-text").fill("EDITEDZZZ");
  await page.getByTestId("c4builder-apply").click();

  // The canonical source updated → the live Monaco model must now contain the
  // edit, even though it never went through the editor's own change path.  Read
  // the whole model directly (Monaco virtualises `.view-lines`).
  await page.getByTestId("doc-tab-source").click();
  const model = () => page.evaluate(() => (window as unknown as { __loomGetSource: () => string }).__loomGetSource());
  await expect.poll(model).toContain("EDITEDZZZ");
  // LSP re-validated the synced source (no errors introduced).
  await expect(page.getByText(/^0 errors$/)).toBeVisible();
});

test("recognises Card containers and exposes their nested children", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Components storybook/);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });

  // Card is now a recognised container-with-title (not an Opaque blob): its
  // header shows the title and its inner Stack/Text are real, selectable nodes.
  const card = page.getByTestId("c4node-Card").filter({ hasText: "Stack — vertical stacking" });
  await expect(card.first()).toBeVisible();
  // The Card's nested Text is editable, not buried in opaque source.
  const innerText = page.getByTestId("c4node-Text").filter({ hasText: "Item one" });
  await expect(innerText.first()).toBeVisible();

  await innerText.first().click();
  const textInput = page.getByTestId("c4builder-prop-text");
  await textInput.fill("Nested edit OK");
  await expect(page.getByTestId("c4builder-canvas")).toContainText("Nested edit OK");

  // Apply round-trips the whole body (Card title + nested tree) and re-seeds.
  await page.getByTestId("c4builder-apply").click();
  await expect(page.getByTestId("c4builder-canvas")).toContainText("Nested edit OK");
  await expect(page.getByTestId("c4node-Card").filter({ hasText: "Stack — vertical stacking" }).first()).toBeVisible();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("palette adds a data primitive with a binding dropdown", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Components storybook/);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });

  // Add a Form and select it; its `of:` binding renders as a dropdown.
  await page.getByTestId("c4palette-Form").click();
  const formNode = page.getByTestId("c4node-Form").first();
  await expect(formNode).toBeVisible();
  await formNode.click();
  await expect(page.getByTestId("c4builder-prop-of")).toBeVisible();

  // Applying a binding primitive keeps the source valid (re-seeds cleanly).
  await page.getByTestId("c4builder-apply").click();
  await expect(page.getByTestId("c4node-Form").first()).toBeVisible();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("renders previously-Opaque primitives (Stat, Tabs) as editable nodes", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Components storybook/);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });

  // These used to collapse into one Opaque source blob; now each is a real,
  // selectable node (Stat/Tabs are recognised; a Tab is editable inside Tabs).
  await expect(page.getByTestId("c4node-Stat").first()).toBeVisible();
  await expect(page.getByTestId("c4node-Tabs").first()).toBeVisible();
  await expect(page.getByTestId("c4node-Tab").first()).toBeVisible();

  // Editing a Stat's label round-trips through the source and re-seeds.
  const stat = page.getByTestId("c4node-Stat").filter({ hasText: "Active users" });
  await stat.first().click();
  const labelInput = page.getByTestId("c4builder-prop-label");
  await expect(labelInput).toHaveValue("Active users");
  await labelInput.fill("Edited Stat");
  await expect(page.getByTestId("c4builder-canvas")).toContainText("Edited Stat");

  await page.getByTestId("c4builder-apply").click();
  await expect(page.getByTestId("c4builder-canvas")).toContainText("Edited Stat");
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

const MATCH_SOURCE = `system S {
  ui U {
    page P {
      body: match {
        1 == 1 => Text("zero")
        2 == 2 => Text("one")
      }
    }
  }
}`;

test("adds a match arm from the canvas and writes it back to source", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Inject a match-bodied page (no playground example ships one) by replacing
  // the editor contents.  Paste via the clipboard rather than typing, so
  // Monaco's auto-closing brackets don't double the braces.
  await setSource(page, MATCH_SOURCE);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });

  // The body seeds as a Match with two editable arms.
  await expect(page.getByTestId("c4node-Match").first()).toBeVisible();
  await expect(page.getByTestId("c4node-MatchArm")).toHaveCount(2);

  // Select the Match itself (click its header area, not an inner arm) and add
  // an arm via the dedicated control (arms aren't palette primitives).
  await page.getByTestId("c4node-Match").first().click({ position: { x: 8, y: 8 } });
  await page.getByTestId("c4builder-add-arm").click();
  await expect(page.getByTestId("c4node-MatchArm")).toHaveCount(3);

  // Apply round-trips the whole match (now three arms) and stays valid.
  await page.getByTestId("c4builder-apply").click();
  await expect(page.getByTestId("c4node-MatchArm")).toHaveCount(3);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

const BUTTON_HANDLER_SOURCE = `system S {
  ui U {
    page P {
      body: Button("Save", onClick: e => {
        save(e)
      })
    }
  }
}`;

test("a Button's onClick handler is an editable nested lambda", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await setSource(page, BUTTON_HANDLER_SOURCE);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });

  // The Button is recognised; its onClick handler renders as a nested Lambda
  // with an editable statement row (not a raw passthrough string).
  await expect(page.getByTestId("c4node-Button").first()).toBeVisible();
  await expect(page.getByTestId("c4node-Lambda").first()).toBeVisible();
  await expect(page.getByTestId("c4node-Stmt").first()).toContainText("save(e)");

  await page.getByTestId("c4builder-apply").click();
  await expect(page.getByTestId("c4node-Stmt").first()).toContainText("save(e)");
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});


const HANDLER_SOURCE = `system S {
  ui U {
    page P {
      body: Table(rows: orders, onRowClick: r => {
        select(r.id)
      }, Column("ID", o => Text(o.id)))
    }
  }
}`;

test("edits a block-handler lambda as statement rows", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await setSource(page, HANDLER_SOURCE);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });

  // The onRowClick block lambda seeds as a Lambda with one editable statement.
  await expect(page.getByTestId("c4node-Lambda").first()).toBeVisible();
  await expect(page.getByTestId("c4node-Stmt")).toHaveCount(1);
  await expect(page.getByTestId("c4node-Stmt").first()).toContainText("select(r.id)");

  // Select the Lambda (its header) and add a statement row.
  await page.getByTestId("c4node-Lambda").first().click({ position: { x: 8, y: 8 } });
  await page.getByTestId("c4builder-add-stmt").click();
  await expect(page.getByTestId("c4node-Stmt")).toHaveCount(2);

  await page.getByTestId("c4builder-apply").click();
  await expect(page.getByTestId("c4node-Stmt")).toHaveCount(2);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("surfaces body LSP diagnostics on the canvas", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // MATCH_SOURCE has no `else` arm → the validator emits an exhaustiveness
  // warning within the page body, which the builder shows as a problems bar.
  await setSource(page, MATCH_SOURCE);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("c4builder-diagnostics")).toBeVisible();
  await expect(page.getByTestId("c4builder-diagnostics")).toContainText("else");
  // The offending node (the match) is also outlined in place.
  await expect(page.locator('[data-testid="c4node-Match"][data-diag="1"]')).toBeVisible();
});

const OP_SOURCE = `system S {
  context C {
    aggregate Account { balance: decimal
      operation deposit(n: decimal) { }
      operation withdraw(n: decimal) { } }
  }
  ui U { page P { body: Form(of: Account) } }
}`;

test("Form op: offers the bound aggregate's operations as a dropdown", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await setSource(page, OP_SOURCE);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });

  // Select the Form; its `op:` dropdown is populated from Account's operations.
  await page.getByTestId("c4node-Form").first().click();
  await page.getByTestId("c4builder-prop-op").click();
  await expect(page.getByRole("option", { name: "deposit" })).toBeVisible();
  await page.getByRole("option", { name: "withdraw" }).click();

  await page.getByTestId("c4builder-apply").click();
  await expect(page.getByTestId("c4builder-canvas")).toContainText("Form");
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

const DRAG_SOURCE = `system S { ui U { page P { body: Stack(Text("a")) } } }`;

test("drags a palette primitive onto the canvas", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await setSource(page, DRAG_SOURCE);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("c4node-Button")).toHaveCount(0);

  // Drag a Button from the palette into the Stack on the canvas.
  await dragOnto(page, page.getByTestId("c4palette-Button"), page.getByTestId("c4node-Stack").first());
  await expect(page.getByTestId("c4node-Button").first()).toBeVisible();

  await page.getByTestId("c4builder-apply").click();
  await expect(page.getByTestId("c4node-Button").first()).toBeVisible();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

const REORDER_SOURCE = `system S { ui U { page P { body: Stack(Text("first"), Text("second")) } } }`;

test("drag-reorders sibling nodes and writes the new order back", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await setSource(page, REORDER_SOURCE);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });
  // Initially "first" precedes "second".
  await expect(page.getByTestId("c4node-Text").first()).toContainText("first");

  // Drag "second" onto the top of "first" → it lands before it.
  await dragOnto(page, page.getByTestId("c4node-Text").filter({ hasText: "second" }), page.getByTestId("c4node-Text").filter({ hasText: "first" }), 0.15);
  await expect(page.getByTestId("c4node-Text").first()).toContainText("second");

  await page.getByTestId("c4builder-apply").click();
  await expect(page.getByTestId("c4node-Text").first()).toContainText("second");
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

const STATE_SOURCE = `system S {
  ui U {
    page P {
      state { step: int = 0 }
      body: Form(of: Order)
    }
  }
}`;

test("edits a page's state fields from the State panel", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await setSource(page, STATE_SOURCE);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });

  // Open the State popover — the page has one field ("step").
  await page.getByTestId("c4state-toggle").click();
  await expect(page.getByTestId("c4state-field")).toHaveCount(1);

  const model = () => page.evaluate(() => (window as unknown as { __loomGetSource: () => string }).__loomGetSource());

  // Add a field → the source gains it (and the panel now shows two).
  await page.getByTestId("c4state-add").click();
  await expect.poll(model).toContain("field1");
  await expect(page.getByTestId("c4state-field")).toHaveCount(2);

  // Delete the original "step" field → gone from the source, page still valid.
  await page.getByTestId("c4state-delete").first().click();
  await expect.poll(model).not.toContain("step");
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});
