// @vitest-environment happy-dom
//
// Proves the cross-origin path end to end without a second origin: the
// parent `makePostMessageTransport` and the sandbox `serveDriverOps` are
// wired across a real MessageChannel (port1 ↔ port2), and the page-object
// shim drives the live DOM through that hop.  This is the same loop the
// same-origin transport runs, but over postMessage.

import { beforeEach, describe, expect, it } from "vitest";
import {
  makePostMessageTransport,
  RemotePage,
  serveDriverOps,
} from "./index.js";

describe("postMessage transport ↔ serveDriverOps over a MessageChannel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("drives fill / click / innerText across the channel", async () => {
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

    const channel = new MessageChannel();
    const stop = serveDriverOps(channel.port2, document, { timeout: 1000 });
    const page = new RemotePage(
      makePostMessageTransport(channel.port1, { timeout: 1000 }),
    );

    await page.getByTestId("orders-new-input-customerId").fill("cust-001");
    expect(input.value).toBe("cust-001");
    await page.getByTestId("orders-new-submit").click();
    expect(submitted).toBe(true);
    expect(
      await page.getByTestId("orders-detail-status").innerText(),
    ).toBe("Confirmed");

    stop();
  });

  it("surfaces a sandbox-side failure (with locator description) on the parent", async () => {
    document.body.innerHTML = `<div></div>`;
    const channel = new MessageChannel();
    serveDriverOps(channel.port2, document, { timeout: 200 });
    const page = new RemotePage(
      makePostMessageTransport(channel.port1, { timeout: 5000 }),
    );
    await expect(
      page.getByTestId("missing").click(),
    ).rejects.toThrow(/locator\(getByTestId\("missing"\)\): no element matched/);
  });

  it("reports the sandbox URL through the cached currentUrl()", async () => {
    const channel = new MessageChannel();
    serveDriverOps(channel.port2, document, { timeout: 500 });
    const transport = makePostMessageTransport(channel.port1, { timeout: 500 });
    const page = new RemotePage(transport);
    // url() is empty until the first reply lands, then reflects the sandbox.
    await page.goto("/orders/new");
    expect(page.url()).toContain("/orders/new");
  });
});
