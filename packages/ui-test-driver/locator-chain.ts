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
  | { k: "getByText"; text: string; exact?: boolean }
  | { k: "getByLabel"; text: string; exact?: boolean }
  | { k: "getByPlaceholder"; text: string; exact?: boolean }
  | { k: "getByTitle"; text: string; exact?: boolean }
  | { k: "getByAltText"; text: string; exact?: boolean }
  | { k: "locator"; selector: string }
  | { k: "filter"; has: ChainNode[] }
  | { k: "first" }
  | { k: "last" }
  | { k: "nth"; index: number };

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
      case "getByText":
        loc = loc.getByText(node.text, { exact: node.exact });
        break;
      case "getByLabel":
        loc = loc.getByLabel(node.text, { exact: node.exact });
        break;
      case "getByPlaceholder":
        loc = loc.getByPlaceholder(node.text, { exact: node.exact });
        break;
      case "getByTitle":
        loc = loc.getByTitle(node.text, { exact: node.exact });
        break;
      case "getByAltText":
        loc = loc.getByAltText(node.text, { exact: node.exact });
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
      case "last":
        loc = loc.last();
        break;
      case "nth":
        loc = loc.nth(node.index);
        break;
    }
  }
  return loc;
}

/** Leaf operations a parent locator/page issues over the bridge.
 *  `timeout` (optional) is the per-call override; when absent the
 *  executor's default (ExecuteOptions.timeout) applies. */
export type DriverOp =
  | {
      kind: "locator";
      op:
        | "click"
        | "innerText"
        | "count"
        | "hover"
        | "dblclick"
        | "clear"
        | "check"
        | "uncheck"
        | "focus"
        | "blur";
      chain: ChainNode[];
      timeout?: number;
    }
  | {
      kind: "locator";
      op: "fill" | "selectOption";
      chain: ChainNode[];
      value: string;
      timeout?: number;
    }
  | {
      kind: "locator";
      op: "press";
      chain: ChainNode[];
      key: string;
      timeout?: number;
    }
  | {
      kind: "locator";
      op: "waitFor";
      chain: ChainNode[];
      state?: "visible" | "attached" | "hidden";
      timeout?: number;
    }
  | { kind: "page"; op: "goto"; arg: string }
  | { kind: "page"; op: "screenshot" }
  | { kind: "page"; op: "waitForIdle"; quietMs?: number }
  | {
      kind: "page";
      op: "waitForURL";
      pattern: string;
      isRegex: boolean;
      flags?: string;
      timeout?: number;
    };

/** In-flight runtime-request tracker the host maintains on the sandbox
 *  `window` (the preview's fetch shim).  Supplied to `executeDriverOp` via
 *  `ExecuteOptions.getNetState` so this package names no host global. */
export interface NetState {
  inflight: number;
  last: number;
}

export type DriverReply =
  | { ok: true; value?: string | number }
  | { ok: false; message: string };

export interface ExecuteOptions {
  timeout?: number;
  /** Host-supplied accessor for in-flight network state, used by the
   *  `waitForIdle` page op to wait for network quiescence after a mutation.
   *  Omit to skip the wait (it then resolves immediately). */
  getNetState?: (doc: Document) => NetState | undefined;
}

/** Execute one driver op against the live document (sandbox side). */
export async function executeDriverOp(
  doc: Document,
  page: DomPage,
  msg: DriverOp,
  opts?: ExecuteOptions,
): Promise<DriverReply> {
  const timeout = opts?.timeout;
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
      if (msg.op === "waitForIdle") {
        // Wait until the preview app has had no in-flight runtime request
        // for `quietMs`, so a post-mutation react-query refetch has landed
        // before the test reads the DOM.  Best-effort: on overall timeout
        // we proceed rather than fail (the following assertion is the real
        // gate).
        const quiet = msg.quietMs ?? 150;
        const deadline = Date.now() + (timeout ?? 5000);
        const sleep = (ms: number): Promise<void> =>
          new Promise((r) => setTimeout(r, ms));
        for (;;) {
          const net = opts?.getNetState?.(doc);
          const inflight = net?.inflight ?? 0;
          const idleFor = net ? Date.now() - net.last : quiet;
          if (inflight <= 0 && idleFor >= quiet) return { ok: true };
          if (Date.now() >= deadline) return { ok: true };
          await sleep(25);
        }
      }
      await page.waitForURL(
        msg.isRegex ? new RegExp(msg.pattern, msg.flags) : msg.pattern,
        { timeout: msg.timeout },
      );
      return { ok: true };
    }
    const loc = resolveChain(doc, msg.chain, timeout);
    switch (msg.op) {
      case "click":
        await loc.click({ timeout: msg.timeout });
        return { ok: true };
      case "fill":
        await loc.fill(msg.value, { timeout: msg.timeout });
        return { ok: true };
      case "selectOption":
        await loc.selectOption(msg.value, { timeout: msg.timeout });
        return { ok: true };
      case "press":
        await loc.press(msg.key, { timeout: msg.timeout });
        return { ok: true };
      case "innerText":
        return { ok: true, value: await loc.innerText({ timeout: msg.timeout }) };
      case "count":
        return { ok: true, value: await loc.count() };
      case "hover":
        await loc.hover({ timeout: msg.timeout });
        return { ok: true };
      case "dblclick":
        await loc.dblclick({ timeout: msg.timeout });
        return { ok: true };
      case "clear":
        await loc.clear({ timeout: msg.timeout });
        return { ok: true };
      case "check":
        await loc.check({ timeout: msg.timeout });
        return { ok: true };
      case "uncheck":
        await loc.uncheck({ timeout: msg.timeout });
        return { ok: true };
      case "focus":
        await loc.focus({ timeout: msg.timeout });
        return { ok: true };
      case "blur":
        await loc.blur({ timeout: msg.timeout });
        return { ok: true };
      case "waitFor":
        await loc.waitFor({ state: msg.state, timeout: msg.timeout });
        return { ok: true };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
