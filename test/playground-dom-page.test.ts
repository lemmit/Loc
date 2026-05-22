// @vitest-environment happy-dom
//
// DOM-level unit tests for the Playwright-subset locator engine
// (packages/ui-test-driver/dom-page.ts) — the engine the playground's UI test
// runner uses to drive the generated page objects against the live
// app.  Exercises the exact shapes the generator emits: getByTestId +
// click/fill/innerText, locator("tbody tr").count(), the
// `locator('[role="listbox"]').filter({ has: getByRole("option", …) })`
// dance, getByRole name/exact, auto-wait, and goto/url.

import { beforeEach, describe, expect, it } from "vitest";
import { DomPage } from "../packages/ui-test-driver/index.js";

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe("DomPage / DomLocator", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("getByTestId + click fires a real click", async () => {
    setBody(`<button data-testid="orders-new-submit">Save</button>`);
    let clicked = 0;
    document.querySelector('[data-testid="orders-new-submit"]')!.addEventListener("click", () => {
      clicked += 1;
    });
    const page = new DomPage(document);
    await page.getByTestId("orders-new-submit").click();
    expect(clicked).toBe(1);
  });

  it("fill sets the value via the native setter and fires input/change", async () => {
    setBody(`<input data-testid="orders-new-input-customerId" />`);
    const el = document.querySelector(
      '[data-testid="orders-new-input-customerId"]',
    ) as HTMLInputElement;
    const events: string[] = [];
    el.addEventListener("input", () => events.push("input"));
    el.addEventListener("change", () => events.push("change"));
    const page = new DomPage(document);
    await page.getByTestId("orders-new-input-customerId").fill("cust-001");
    expect(el.value).toBe("cust-001");
    expect(events).toEqual(["input", "change"]);
  });

  it("innerText reads the displayed text; count counts rows", async () => {
    setBody(`
      <div data-testid="orders-detail-status">Confirmed</div>
      <table data-testid="orders-detail-lines">
        <tbody><tr></tr><tr></tr><tr></tr></tbody>
      </table>
    `);
    const page = new DomPage(document);
    expect(await page.getByTestId("orders-detail-status").innerText()).toBe("Confirmed");
    const count = await page.getByTestId("orders-detail-lines").locator("tbody tr").count();
    expect(count).toBe(3);
  });

  it("filter({has: getByRole option}) selects the right listbox, then clicks the option", async () => {
    // Two listboxes; only the second contains the "Confirmed" option.
    setBody(`
      <div role="listbox"><div role="option">Draft</div></div>
      <div role="listbox"><div role="option">Confirmed</div></div>
    `);
    const page = new DomPage(document);
    let clicked = "";
    document.querySelectorAll('[role="option"]').forEach((o) =>
      o.addEventListener("click", () => {
        clicked = o.textContent ?? "";
      }),
    );
    const listbox = page
      .locator('[role="listbox"]')
      .filter({ has: page.getByRole("option", { name: "Confirmed", exact: true }) });
    expect(await listbox.count()).toBe(1);
    await listbox.getByRole("option", { name: "Confirmed", exact: true }).click();
    expect(clicked).toBe("Confirmed");
  });

  it("getByRole name matching honours exact vs substring", async () => {
    setBody(`
      <div role="option">Confirmed</div>
      <div role="option">Confirmed Later</div>
    `);
    const page = new DomPage(document);
    expect(await page.getByRole("option", { name: "Confirmed", exact: false }).count()).toBe(2);
    expect(await page.getByRole("option", { name: "Confirmed", exact: true }).count()).toBe(1);
  });

  it("auto-waits for an element that appears asynchronously", async () => {
    setBody(`<div id="host"></div>`);
    const page = new DomPage(document, { timeout: 1000 });
    setTimeout(() => {
      document.getElementById("host")!.innerHTML = `<div data-testid="orders-detail">ready</div>`;
    }, 80);
    // Resolves once the element shows up — would throw on timeout.
    await page.getByTestId("orders-detail").waitFor();
    expect(await page.getByTestId("orders-detail").innerText()).toBe("ready");
  });

  it("click auto-waits for a hidden element to become visible", async () => {
    setBody(`<button data-testid="orders-op-confirm" style="display:none">Confirm</button>`);
    const btn = document.querySelector('[data-testid="orders-op-confirm"]') as HTMLButtonElement;
    let clicked = 0;
    btn.addEventListener("click", () => {
      clicked += 1;
    });
    const page = new DomPage(document, { timeout: 1000 });
    setTimeout(() => {
      btn.style.display = "";
    }, 80);
    await page.getByTestId("orders-op-confirm").click();
    expect(clicked).toBe(1);
  });

  it("strict mode: a locator matching >1 elements throws", async () => {
    // Real Playwright counts ALL matches (visibility-independent) and
    // refuses to act on an ambiguous locator — no silent first-match.
    setBody(`
      <button data-testid="dup">a</button>
      <button data-testid="dup">b</button>
    `);
    const page = new DomPage(document, { timeout: 150 });
    await expect(page.getByTestId("dup").click()).rejects.toThrow(/resolved to 2 elements/);
  });

  it("click waits for a disabled control to become enabled", async () => {
    setBody(`<button data-testid="orders-op-confirm-submit" disabled>Confirm</button>`);
    const btn = document.querySelector(
      '[data-testid="orders-op-confirm-submit"]',
    ) as HTMLButtonElement;
    let clicked = 0;
    btn.addEventListener("click", () => {
      clicked += 1;
    });
    const page = new DomPage(document, { timeout: 1000 });
    setTimeout(() => {
      btn.disabled = false;
    }, 80);
    await page.getByTestId("orders-op-confirm-submit").click();
    expect(clicked).toBe(1);
  });

  it("times out clicking a permanently disabled control", async () => {
    setBody(`<button data-testid="dis" disabled>X</button>`);
    const page = new DomPage(document, { timeout: 150 });
    await expect(page.getByTestId("dis").click()).rejects.toThrow(/not enabled/);
  });

  it("fill rejects a readonly (non-editable) input", async () => {
    setBody(`<input data-testid="ro" readonly />`);
    const page = new DomPage(document, { timeout: 150 });
    await expect(page.getByTestId("ro").fill("x")).rejects.toThrow(/not editable/);
  });

  it("fill waits for an input to become editable", async () => {
    setBody(`<input data-testid="ed" readonly />`);
    const el = document.querySelector('[data-testid="ed"]') as HTMLInputElement;
    const page = new DomPage(document, { timeout: 1000 });
    setTimeout(() => {
      el.readOnly = false;
    }, 80);
    await page.getByTestId("ed").fill("ready");
    expect(el.value).toBe("ready");
  });

  it("goto pushes the basename-prefixed path and url() reflects it", async () => {
    const page = new DomPage(document, { basename: "/loc/playground/sandbox" });
    await page.goto("/orders/new");
    expect(page.url()).toContain("/loc/playground/sandbox/orders/new");
    await page.waitForURL(/\/orders\/new$/);
  });
});
