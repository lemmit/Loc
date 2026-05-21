// Serializable locator chains — the wire form of a Playwright locator.
//
// The page-object spec runs in the parent, where locators must NOT
// touch the DOM (the DOM lives in the sandbox).  So a parent-side
// locator just accumulates a JSON-serialisable chain of steps; the
// chain crosses the bridge with each leaf op, and the sandbox rebuilds
// a `DomLocator` from it to resolve + act.  This keeps the resolver
// (web/src/testing/dom-page.ts) as the single source of truth for
// matching semantics, shared by both ends.

import { DomLocator, DomPage } from "./dom-page.js";

export type ChainNode =
  | { k: "getByTestId"; id: string }
  | { k: "getByRole"; role: string; name?: string; exact?: boolean }
  | { k: "locator"; selector: string }
  | { k: "filter"; has: ChainNode[] }
  | { k: "first" };

/** Rebuild a live `DomLocator` from a serialised chain (sandbox side). */
export function resolveChain(
  doc: Document,
  chain: ChainNode[],
  timeout?: number,
): DomLocator {
  // Start from the bare page root (rooted at `body`), then fold the
  // chain — the first step (e.g. getByTestId) queries the whole doc.
  let loc = new DomPage(doc, { timeout }).root();
  for (const node of chain) {
    switch (node.k) {
      case "getByTestId":
        loc = loc.getByTestId(node.id);
        break;
      case "getByRole":
        loc = loc.getByRole(node.role, { name: node.name, exact: node.exact });
        break;
      case "locator":
        loc = loc.locator(node.selector);
        break;
      case "filter":
        loc = loc.filter({ has: resolveChain(doc, node.has, timeout) });
        break;
      case "first":
        loc = loc.first();
        break;
    }
  }
  return loc;
}

/** Leaf operations a parent locator/page issues over the bridge. */
export type DriverOp =
  | { kind: "locator"; op: "click" | "innerText" | "count"; chain: ChainNode[] }
  | { kind: "locator"; op: "fill"; chain: ChainNode[]; value: string }
  | {
      kind: "locator";
      op: "waitFor";
      chain: ChainNode[];
      state?: "visible" | "attached" | "hidden";
    }
  | { kind: "page"; op: "goto"; arg: string }
  | { kind: "page"; op: "screenshot" }
  | {
      kind: "page";
      op: "waitForURL";
      pattern: string;
      isRegex: boolean;
      flags?: string;
    };

export type DriverReply =
  | { ok: true; value?: string | number }
  | { ok: false; message: string };

/** Execute one driver op against the live document (sandbox side). */
export async function executeDriverOp(
  doc: Document,
  page: DomPage,
  msg: DriverOp,
  timeout?: number,
): Promise<DriverReply> {
  try {
    if (msg.kind === "page") {
      if (msg.op === "goto") {
        await page.goto(msg.arg);
        return { ok: true };
      }
      if (msg.op === "screenshot") {
        // Lazy import so node test contexts that only exercise other ops
        // don't pull in html-to-image's browser dependencies.
        const { captureNode } = await import("./screenshot.js");
        const root = doc.documentElement;
        const value =
          (await captureNode(root, {
            width: root.clientWidth || undefined,
            height: root.clientHeight || undefined,
          })) ?? "";
        return { ok: true, value };
      }
      await page.waitForURL(
        msg.isRegex ? new RegExp(msg.pattern, msg.flags) : msg.pattern,
      );
      return { ok: true };
    }
    const loc = resolveChain(doc, msg.chain, timeout);
    switch (msg.op) {
      case "click":
        await loc.click();
        return { ok: true };
      case "fill":
        await loc.fill(msg.value);
        return { ok: true };
      case "innerText":
        return { ok: true, value: await loc.innerText() };
      case "count":
        return { ok: true, value: await loc.count() };
      case "waitFor":
        await loc.waitFor({ state: msg.state });
        return { ok: true };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
