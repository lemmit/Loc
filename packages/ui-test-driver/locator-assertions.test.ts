// @vitest-environment happy-dom
//
// Web-first locator assertions: auto-retry semantics, the full matcher set,
// `.not`, and that the underlying read ops (inputValue/isChecked/…) survive
// the serialised wire via RemoteLocator.

import { beforeEach, describe, expect, it } from "vitest";
import {
  createLocatorMatchers,
  DomPage,
  executeDriverOp,
  RemotePage,
  type DriverOp,
  type DriverTransport,
} from "./index.js";

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe("web-first locator assertions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("toBeVisible / toBeHidden", async () => {
    setBody(`
      <div data-testid="a">x</div>
      <div data-testid="b" style="display:none">y</div>
    `);
    const page = new DomPage(document, { timeout: 200 });
    await createLocatorMatchers(page.getByTestId("a"), { timeout: 300 }).toBeVisible();
    await createLocatorMatchers(page.getByTestId("b"), { timeout: 300 }).toBeHidden();
    await expect(
      createLocatorMatchers(page.getByTestId("a"), { timeout: 120 }).toBeHidden(),
    ).rejects.toThrow(/hidden/);
  });

  it("toHaveText / toContainText auto-retry until the DOM catches up", async () => {
    setBody(`<div id="host"></div>`);
    const page = new DomPage(document, { timeout: 500 });
    setTimeout(() => {
      document.getElementById("host")!.innerHTML =
        `<span data-testid="s">Confirmed</span>`;
    }, 80);
    await createLocatorMatchers(page.getByTestId("s"), { timeout: 1000 }).toHaveText(
      "Confirmed",
    );
    await createLocatorMatchers(page.getByTestId("s"), { timeout: 500 }).toContainText(
      "firm",
    );
  });

  it("toHaveValue / toHaveCount / toBeDisabled / toBeChecked", async () => {
    setBody(`
      <input data-testid="v" value="hello" />
      <ul><li class="row"></li><li class="row"></li></ul>
      <button data-testid="btn" disabled>x</button>
      <input type="checkbox" data-testid="cb" checked />
    `);
    const page = new DomPage(document, { timeout: 200 });
    await createLocatorMatchers(page.getByTestId("v")).toHaveValue("hello");
    await createLocatorMatchers(page.locator("li.row")).toHaveCount(2);
    await createLocatorMatchers(page.getByTestId("btn")).toBeDisabled();
    await createLocatorMatchers(page.getByTestId("cb")).toBeChecked();
  });

  it(".not negates a matcher", async () => {
    setBody(`<div data-testid="d">A</div>`);
    const page = new DomPage(document, { timeout: 200 });
    await createLocatorMatchers(page.getByTestId("d"), { timeout: 300 }).not.toHaveText(
      "B",
    );
    await expect(
      createLocatorMatchers(page.getByTestId("d"), { timeout: 120 }).not.toHaveText("A"),
    ).rejects.toThrow();
  });

  it("read ops serialise across the wire (RemoteLocator)", async () => {
    setBody(`
      <input data-testid="v" value="wired" />
      <input type="checkbox" data-testid="c" checked />
    `);
    const sandboxPage = new DomPage(document, { timeout: 500 });
    const transport: DriverTransport = {
      currentUrl: () => "",
      send: (op: DriverOp) =>
        executeDriverOp(document, sandboxPage, op, { timeout: 500 }),
    };
    const page = new RemotePage(transport);
    await createLocatorMatchers(page.getByTestId("v"), { timeout: 500 }).toHaveValue(
      "wired",
    );
    await createLocatorMatchers(page.getByTestId("c"), { timeout: 500 }).toBeChecked();
  });
});
