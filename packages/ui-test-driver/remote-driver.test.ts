// @vitest-environment happy-dom
//
// Proves the message-driven UI driver end to end (minus the actual
// postMessage hop): the parent `RemotePage`/`RemoteLocator` shim builds
// serialisable chains and issues `DriverOp`s through a transport; the
// sandbox `executeDriverOp` resolves each chain against the live DOM
// and acts.  Here the transport is in-process (calls the executor
// directly) so the whole loop is unit-testable.  Drives the exact
// patterns the generated page objects emit.

import { beforeEach, describe, expect, it } from "vitest";
import {
  DomPage,
  executeDriverOp,
  RemotePage,
  type DriverOp,
  type DriverTransport,
} from "./index.js";

function harness(): RemotePage {
  // Sandbox side: a DomPage bound to the test document.
  const sandboxPage = new DomPage(document, { basename: "/app", timeout: 1000 });
  // In-process transport stands in for the bridge postMessage hop.
  const transport: DriverTransport = {
    currentUrl: () => document.defaultView!.location.href,
    send: (op: DriverOp) =>
      executeDriverOp(document, sandboxPage, op, { timeout: 1000 }),
  };
  // Parent side: the shim the bundled spec drives.
  return new RemotePage(transport);
}

describe("message-driven UI driver (parent shim → wire → sandbox executor)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("click / fill / innerText cross the wire and act on the DOM", async () => {
    document.body.innerHTML = `
      <input data-testid="orders-new-input-customerId" />
      <button data-testid="orders-new-submit">Save</button>
      <div data-testid="orders-detail-status">Confirmed</div>
    `;
    const input = document.querySelector(
      '[data-testid="orders-new-input-customerId"]',
    ) as HTMLInputElement;
    let submitted = false;
    document
      .querySelector('[data-testid="orders-new-submit"]')!
      .addEventListener("click", () => {
        submitted = true;
      });

    const page = harness();
    await page.getByTestId("orders-new-input-customerId").fill("cust-001");
    expect(input.value).toBe("cust-001");
    await page.getByTestId("orders-new-submit").click();
    expect(submitted).toBe(true);
    expect(await page.getByTestId("orders-detail-status").innerText()).toBe(
      "Confirmed",
    );
  });

  it("serialises the listbox filter({has})+getByRole chain and clicks the option", async () => {
    document.body.innerHTML = `
      <div role="listbox"><div role="option">Draft</div></div>
      <div role="listbox"><div role="option">Confirmed</div></div>
    `;
    let clicked = "";
    document.querySelectorAll('[role="option"]').forEach((o) =>
      o.addEventListener("click", () => {
        clicked = o.textContent ?? "";
      }),
    );
    const page = harness();
    const listbox = page
      .locator('[role="listbox"]')
      .filter({ has: page.getByRole("option", { name: "Confirmed", exact: true }) });
    expect(await listbox.count()).toBe(1);
    await listbox.getByRole("option", { name: "Confirmed", exact: true }).click();
    expect(clicked).toBe("Confirmed");
  });

  it("count over a row chain returns the live count", async () => {
    document.body.innerHTML = `
      <table data-testid="orders-detail-lines"><tbody><tr></tr><tr></tr></tbody></table>
    `;
    const page = harness();
    expect(
      await page.getByTestId("orders-detail-lines").locator("tbody tr").count(),
    ).toBe(2);
  });

  it("goto pushes the route, url() reads it back, waitForURL matches a RegExp", async () => {
    const page = harness();
    await page.goto("/orders/new");
    expect(page.url()).toContain("/app/orders/new");
    await page.waitForURL(/\/orders\/new$/);
  });

  it("a failed op surfaces as a thrown error on the parent side", async () => {
    document.body.innerHTML = `<div></div>`;
    const page = harness();
    // Nothing matches → the sandbox times out → the wire reply is an
    // error → the parent shim throws.
    await expect(page.getByTestId("missing").click()).rejects.toThrow(
      /no element matched/,
    );
  });

  it("Scope B getters serialise across the wire (getByLabel + nth)", async () => {
    document.body.innerHTML = `
      <label for="email">Email</label><input id="email" />
      <ul><li>one</li><li>two</li></ul>
    `;
    const page = harness();
    await page.getByLabel("Email").fill("hi@x.com");
    expect((document.getElementById("email") as HTMLInputElement).value).toBe(
      "hi@x.com",
    );
    expect((await page.locator("li").nth(1).innerText()).trim()).toBe("two");
  });

  it("Scope B actions cross the wire (check + selectOption + press)", async () => {
    document.body.innerHTML = `
      <input type="checkbox" data-testid="agree" />
      <select data-testid="status"><option value="a">A</option><option value="b">B</option></select>
      <input data-testid="field" />
    `;
    const cb = document.querySelector('[data-testid="agree"]') as HTMLInputElement;
    const sel = document.querySelector('[data-testid="status"]') as HTMLSelectElement;
    let pressed = "";
    document
      .querySelector('[data-testid="field"]')!
      .addEventListener("keydown", (e) => (pressed = (e as KeyboardEvent).key));

    const page = harness();
    await page.getByTestId("agree").check();
    expect(cb.checked).toBe(true);
    await page.getByTestId("status").selectOption("b");
    expect(sel.value).toBe("b");
    await page.getByTestId("field").press("Escape");
    expect(pressed).toBe("Escape");
  });
});
