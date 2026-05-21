// A DOM-backed implementation of the closed Playwright `Page` / `Locator`
// subset the Loom generator's page objects use
// (`src/generator/react/page-objects-builder.ts`):
//
//   page:    goto, getByTestId, getByRole, locator, url, waitForURL
//   locator: getByTestId, getByRole, locator, filter({has}), first,
//            click, fill, innerText, count, waitFor({state})
//
// It runs where the DOM is (inside the preview sandbox, against the
// running generated app) so locators resolve locally rather than over
// RPC.  Locators are lazy and re-rootable so `filter({has})` can replay
// a sub-locator's steps relative to each candidate, exactly like
// Playwright.  Auto-wait is a poll loop (no layout dependency) so it's
// unit-testable under happy-dom.

const DEFAULT_TIMEOUT_MS = 5_000;
const POLL_MS = 25;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** A step narrows/expands the current element set.  Steps query
 *  *within* their input roots (descendants), which is what makes them
 *  re-rootable for `filter({has})`. */
type Step = (roots: Element[]) => Element[];

function dedupe(els: Element[]): Element[] {
  const seen = new Set<Element>();
  const out: Element[] = [];
  for (const el of els) {
    if (!seen.has(el)) {
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

function accessibleName(el: Element): string {
  return (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
}

function matchesName(el: Element, name: string, exact: boolean): boolean {
  const acc = accessibleName(el);
  return exact ? acc === name : acc.includes(name);
}

function isVisible(el: Element): boolean {
  const he = el as HTMLElement;
  if (he.hidden) return false;
  const win = el.ownerDocument?.defaultView;
  const style = win?.getComputedStyle(he);
  if (style && (style.display === "none" || style.visibility === "hidden")) {
    return false;
  }
  return true;
}

export class DomLocator {
  constructor(
    private readonly doc: Document,
    private readonly rootProvider: () => Element[],
    private readonly steps: Step[],
    private readonly timeout: number,
  ) {}

  private add(step: Step): DomLocator {
    return new DomLocator(
      this.doc,
      this.rootProvider,
      [...this.steps, step],
      this.timeout,
    );
  }

  /** Apply this locator's steps starting from arbitrary roots — used
   *  by `filter({has})` to evaluate a sub-locator relative to each
   *  candidate. */
  matchesFrom(roots: Element[]): Element[] {
    let cur = roots;
    for (const step of this.steps) cur = step(cur);
    return cur;
  }

  /** Current matches (no waiting). */
  matchesNow(): Element[] {
    return this.matchesFrom(this.rootProvider());
  }

  getByTestId(id: string): DomLocator {
    const sel = `[data-testid=${JSON.stringify(id)}]`;
    return this.add((roots) =>
      dedupe(roots.flatMap((r) => Array.from(r.querySelectorAll(sel)))),
    );
  }

  locator(selector: string): DomLocator {
    return this.add((roots) =>
      dedupe(roots.flatMap((r) => Array.from(r.querySelectorAll(selector)))),
    );
  }

  getByRole(
    role: string,
    opts?: { name?: string; exact?: boolean },
  ): DomLocator {
    const sel = `[role=${JSON.stringify(role)}]`;
    return this.add((roots) => {
      const els = dedupe(
        roots.flatMap((r) => Array.from(r.querySelectorAll(sel))),
      );
      if (opts?.name == null) return els;
      return els.filter((el) => matchesName(el, opts.name!, opts.exact ?? false));
    });
  }

  filter(opts: { has: DomLocator }): DomLocator {
    const has = opts.has;
    return this.add((roots) =>
      roots.filter((el) => has.matchesFrom([el]).length > 0),
    );
  }

  first(): DomLocator {
    return this.add((roots) => roots.slice(0, 1));
  }

  /** Poll until at least one (optionally visible) match, then return it. */
  private async resolveOne(requireVisible: boolean): Promise<HTMLElement> {
    const deadline = Date.now() + this.timeout;
    for (;;) {
      const els = this.matchesNow();
      const el = requireVisible ? els.find(isVisible) : els[0];
      if (el) return el as HTMLElement;
      if (Date.now() >= deadline) {
        throw new Error(
          `locator: no ${requireVisible ? "visible " : ""}element matched within ${this.timeout}ms`,
        );
      }
      await sleep(POLL_MS);
    }
  }

  async click(): Promise<void> {
    (await this.resolveOne(true)).click();
  }

  async fill(value: string): Promise<void> {
    const el = (await this.resolveOne(true)) as
      | HTMLInputElement
      | HTMLTextAreaElement;
    // React tracks the value via an overridden setter; setting `.value`
    // directly bypasses its change detection.  Call the native setter
    // on the prototype, then fire input/change so controlled components
    // update.
    const proto = Object.getPrototypeOf(el) as object;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async innerText(): Promise<string> {
    const el = await this.resolveOne(false);
    return (el.innerText ?? el.textContent ?? "").trim();
  }

  /** Playwright's `count()` does not auto-wait. */
  count(): Promise<number> {
    return Promise.resolve(this.matchesNow().length);
  }

  async waitFor(opts?: { state?: "visible" | "attached" | "hidden" }): Promise<void> {
    const state = opts?.state ?? "visible";
    if (state === "hidden") {
      const deadline = Date.now() + this.timeout;
      for (;;) {
        if (!this.matchesNow().some(isVisible)) return;
        if (Date.now() >= deadline) {
          throw new Error(`locator: still visible after ${this.timeout}ms`);
        }
        await sleep(POLL_MS);
      }
    }
    await this.resolveOne(state === "visible");
  }
}

export interface DomPageOptions {
  /** BrowserRouter basename, so `goto("/x")` pushes `<basename>/x`. */
  basename?: string;
  timeout?: number;
}

export class DomPage {
  private readonly basename: string;
  private readonly timeout: number;

  constructor(
    private readonly doc: Document,
    opts: DomPageOptions = {},
  ) {
    this.basename = (opts.basename ?? "").replace(/\/$/, "");
    this.timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  /** Bare page-level locator (rooted at `body`), the start of a chain. */
  root(): DomLocator {
    return new DomLocator(this.doc, () => [this.doc.body], [], this.timeout);
  }

  getByTestId(id: string): DomLocator {
    return this.root().getByTestId(id);
  }

  getByRole(role: string, opts?: { name?: string; exact?: boolean }): DomLocator {
    return this.root().getByRole(role, opts);
  }

  locator(selector: string): DomLocator {
    return this.root().locator(selector);
  }

  url(): string {
    return this.doc.defaultView?.location.href ?? "";
  }

  /** Client-side navigation via History — BrowserRouter listens for
   *  `popstate`.  The page object's subsequent `getByTestId(...).waitFor()`
   *  handles render readiness, so this only needs to trigger the route
   *  change (no full load). */
  async goto(path: string): Promise<void> {
    const win = this.doc.defaultView;
    if (!win) return;
    const target = path.startsWith("http")
      ? path
      : this.basename + (path.startsWith("/") ? path : `/${path}`);
    win.history.pushState({}, "", target);
    const PopState = (win as unknown as { PopStateEvent?: typeof PopStateEvent })
      .PopStateEvent;
    win.dispatchEvent(
      typeof PopState === "function"
        ? new PopState("popstate")
        : new win.Event("popstate"),
    );
    await sleep(0);
  }

  async waitForURL(matcher: RegExp | string): Promise<void> {
    const test = (u: string): boolean =>
      typeof matcher === "string" ? u.includes(matcher) : matcher.test(u);
    const deadline = Date.now() + this.timeout;
    for (;;) {
      if (test(this.url())) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `waitForURL: ${this.url()} did not match ${String(matcher)} within ${this.timeout}ms`,
        );
      }
      await sleep(POLL_MS);
    }
  }
}
