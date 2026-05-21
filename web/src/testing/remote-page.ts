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
  locator(selector: string): RemoteLocator {
    return this.extend({ k: "locator", selector });
  }
  filter(opts: { has: RemoteLocator }): RemoteLocator {
    return this.extend({ k: "filter", has: opts.has.nodes() });
  }
  first(): RemoteLocator {
    return this.extend({ k: "first" });
  }

  private async run(op: DriverOp): Promise<string | number | undefined> {
    const r = await this.transport.send(op);
    if (!r.ok) throw new Error(r.message);
    return r.value;
  }

  async click(): Promise<void> {
    await this.run({ kind: "locator", op: "click", chain: this.chain });
  }
  async fill(value: string): Promise<void> {
    await this.run({ kind: "locator", op: "fill", chain: this.chain, value });
  }
  async innerText(): Promise<string> {
    return String((await this.run({ kind: "locator", op: "innerText", chain: this.chain })) ?? "");
  }
  async count(): Promise<number> {
    return Number((await this.run({ kind: "locator", op: "count", chain: this.chain })) ?? 0);
  }
  async waitFor(opts?: {
    state?: "visible" | "attached" | "hidden";
  }): Promise<void> {
    await this.run({
      kind: "locator",
      op: "waitFor",
      chain: this.chain,
      state: opts?.state,
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
  locator(selector: string): RemoteLocator {
    return new RemoteLocator(this.transport, [{ k: "locator", selector }]);
  }

  async goto(path: string): Promise<void> {
    const r = await this.transport.send({ kind: "page", op: "goto", arg: path });
    if (!r.ok) throw new Error(r.message);
  }
  async url(): Promise<string> {
    const r = await this.transport.send({ kind: "page", op: "url" });
    if (!r.ok) throw new Error(r.message);
    return String(r.value ?? "");
  }
  async waitForURL(matcher: string | RegExp): Promise<void> {
    const op: DriverOp =
      matcher instanceof RegExp
        ? {
            kind: "page",
            op: "waitForURL",
            pattern: matcher.source,
            isRegex: true,
            flags: matcher.flags,
          }
        : { kind: "page", op: "waitForURL", pattern: matcher, isRegex: false };
    const r = await this.transport.send(op);
    if (!r.ok) throw new Error(r.message);
  }
}
