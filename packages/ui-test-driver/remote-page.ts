// Parent-side Playwright `Page`/`Locator` shim.
//
// These run in the parent, where the page-object spec executes.  They
// hold NO DOM — a locator just accumulates a serialisable `ChainNode[]`,
// and each leaf op sends a `DriverOp` over the transport (the bridge to
// the sandbox) and awaits the reply.  This is the message-driven driver:
// the parent sends commands, the sandbox runs them on the live app.

import type { ChainNode, DriverOp, DriverReply } from "./locator-chain.js";

export interface DriverTransport {
  send(op: DriverOp): Promise<DriverReply>;
  /** Current frame URL, read synchronously — Playwright's `page.url()`
   *  is sync, and page objects use it that way
   *  (`page.url().split("/")`).  Same-origin transports read the live
   *  iframe location; a future postMessage transport returns a value
   *  cached from navigation events. */
  currentUrl(): string;
}

export class RemoteLocator {
  constructor(
    private readonly transport: DriverTransport,
    private readonly chain: ChainNode[],
  ) {}

  /** Chain accessor for `filter({ has })` composition. */
  nodes(): ChainNode[] {
    return this.chain;
  }

  private extend(node: ChainNode): RemoteLocator {
    return new RemoteLocator(this.transport, [...this.chain, node]);
  }

  getByTestId(id: string): RemoteLocator {
    return this.extend({ k: "getByTestId", id });
  }
  getByRole(
    role: string,
    opts?: { name?: string; exact?: boolean },
  ): RemoteLocator {
    return this.extend({ k: "getByRole", role, name: opts?.name, exact: opts?.exact });
  }
  getByText(text: string, opts?: { exact?: boolean }): RemoteLocator {
    return this.extend({ k: "getByText", text, exact: opts?.exact });
  }
  getByLabel(text: string, opts?: { exact?: boolean }): RemoteLocator {
    return this.extend({ k: "getByLabel", text, exact: opts?.exact });
  }
  getByPlaceholder(text: string, opts?: { exact?: boolean }): RemoteLocator {
    return this.extend({ k: "getByPlaceholder", text, exact: opts?.exact });
  }
  getByTitle(text: string, opts?: { exact?: boolean }): RemoteLocator {
    return this.extend({ k: "getByTitle", text, exact: opts?.exact });
  }
  getByAltText(text: string, opts?: { exact?: boolean }): RemoteLocator {
    return this.extend({ k: "getByAltText", text, exact: opts?.exact });
  }
  locator(selector: string): RemoteLocator {
    return this.extend({ k: "locator", selector });
  }
  filter(opts: { has: RemoteLocator }): RemoteLocator {
    return this.extend({ k: "filter", has: opts.has.nodes() });
  }
  first(): RemoteLocator {
    return this.extend({ k: "first" });
  }
  last(): RemoteLocator {
    return this.extend({ k: "last" });
  }
  nth(index: number): RemoteLocator {
    return this.extend({ k: "nth", index });
  }

  private async run(op: DriverOp): Promise<string | number | undefined> {
    const r = await this.transport.send(op);
    if (!r.ok) throw new Error(r.message);
    return r.value;
  }

  async click(opts?: { timeout?: number }): Promise<void> {
    await this.run({
      kind: "locator",
      op: "click",
      chain: this.chain,
      timeout: opts?.timeout,
    });
  }
  async fill(value: string, opts?: { timeout?: number }): Promise<void> {
    await this.run({
      kind: "locator",
      op: "fill",
      chain: this.chain,
      value,
      timeout: opts?.timeout,
    });
  }
  async innerText(opts?: { timeout?: number }): Promise<string> {
    return String(
      (await this.run({
        kind: "locator",
        op: "innerText",
        chain: this.chain,
        timeout: opts?.timeout,
      })) ?? "",
    );
  }
  async count(): Promise<number> {
    return Number((await this.run({ kind: "locator", op: "count", chain: this.chain })) ?? 0);
  }
  async waitFor(opts?: {
    state?: "visible" | "attached" | "hidden";
    timeout?: number;
  }): Promise<void> {
    await this.run({
      kind: "locator",
      op: "waitFor",
      chain: this.chain,
      state: opts?.state,
      timeout: opts?.timeout,
    });
  }
  private async act(
    op: "hover" | "dblclick" | "clear" | "check" | "uncheck" | "focus" | "blur",
    opts?: { timeout?: number },
  ): Promise<void> {
    await this.run({ kind: "locator", op, chain: this.chain, timeout: opts?.timeout });
  }
  async hover(opts?: { timeout?: number }): Promise<void> {
    await this.act("hover", opts);
  }
  async dblclick(opts?: { timeout?: number }): Promise<void> {
    await this.act("dblclick", opts);
  }
  async clear(opts?: { timeout?: number }): Promise<void> {
    await this.act("clear", opts);
  }
  async check(opts?: { timeout?: number }): Promise<void> {
    await this.act("check", opts);
  }
  async uncheck(opts?: { timeout?: number }): Promise<void> {
    await this.act("uncheck", opts);
  }
  async focus(opts?: { timeout?: number }): Promise<void> {
    await this.act("focus", opts);
  }
  async blur(opts?: { timeout?: number }): Promise<void> {
    await this.act("blur", opts);
  }
  async press(key: string, opts?: { timeout?: number }): Promise<void> {
    await this.run({
      kind: "locator",
      op: "press",
      chain: this.chain,
      key,
      timeout: opts?.timeout,
    });
  }
  async selectOption(value: string, opts?: { timeout?: number }): Promise<void> {
    await this.run({
      kind: "locator",
      op: "selectOption",
      chain: this.chain,
      value,
      timeout: opts?.timeout,
    });
  }
}

export class RemotePage {
  constructor(private readonly transport: DriverTransport) {}

  getByTestId(id: string): RemoteLocator {
    return new RemoteLocator(this.transport, [{ k: "getByTestId", id }]);
  }
  getByRole(role: string, opts?: { name?: string; exact?: boolean }): RemoteLocator {
    return new RemoteLocator(this.transport, [
      { k: "getByRole", role, name: opts?.name, exact: opts?.exact },
    ]);
  }
  getByText(text: string, opts?: { exact?: boolean }): RemoteLocator {
    return new RemoteLocator(this.transport, [
      { k: "getByText", text, exact: opts?.exact },
    ]);
  }
  getByLabel(text: string, opts?: { exact?: boolean }): RemoteLocator {
    return new RemoteLocator(this.transport, [
      { k: "getByLabel", text, exact: opts?.exact },
    ]);
  }
  getByPlaceholder(text: string, opts?: { exact?: boolean }): RemoteLocator {
    return new RemoteLocator(this.transport, [
      { k: "getByPlaceholder", text, exact: opts?.exact },
    ]);
  }
  getByTitle(text: string, opts?: { exact?: boolean }): RemoteLocator {
    return new RemoteLocator(this.transport, [
      { k: "getByTitle", text, exact: opts?.exact },
    ]);
  }
  getByAltText(text: string, opts?: { exact?: boolean }): RemoteLocator {
    return new RemoteLocator(this.transport, [
      { k: "getByAltText", text, exact: opts?.exact },
    ]);
  }
  locator(selector: string): RemoteLocator {
    return new RemoteLocator(this.transport, [{ k: "locator", selector }]);
  }

  async goto(path: string): Promise<void> {
    const r = await this.transport.send({ kind: "page", op: "goto", arg: path });
    if (!r.ok) throw new Error(r.message);
  }
  /** Synchronous, matching Playwright — page objects call it as
   *  `this.page.url().split("/")`. */
  url(): string {
    return this.transport.currentUrl();
  }
  /** Playwright parity: page objects call `waitForLoadState("networkidle")`
   *  after a mutating operation so the read sees the post-refetch UI, not
   *  react-query's stale previous data.  Real Playwright tracks real
   *  network; in the playground the app's fetches go over the bridge port,
   *  so we wait until the iframe's in-flight runtime-request count has been
   *  zero for a short quiet window.  Other load states are no-ops. */
  async waitForLoadState(state?: "load" | "domcontentloaded" | "networkidle"): Promise<void> {
    if (state !== "networkidle") return;
    await this.transport.send({ kind: "page", op: "waitForIdle" });
  }
  /** Best-effort screenshot of the current preview as a JPEG data URL.
   *  Returns "" when capture failed (never throws). */
  async screenshot(): Promise<string> {
    const r = await this.transport.send({ kind: "page", op: "screenshot" });
    if (!r.ok) return "";
    return String(r.value ?? "");
  }
  async waitForURL(
    matcher: string | RegExp,
    opts?: { timeout?: number },
  ): Promise<void> {
    const op: DriverOp =
      matcher instanceof RegExp
        ? {
            kind: "page",
            op: "waitForURL",
            pattern: matcher.source,
            isRegex: true,
            flags: matcher.flags,
            timeout: opts?.timeout,
          }
        : {
            kind: "page",
            op: "waitForURL",
            pattern: matcher,
            isRegex: false,
            timeout: opts?.timeout,
          };
    const r = await this.transport.send(op);
    if (!r.ok) throw new Error(r.message);
  }
}
