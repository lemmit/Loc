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

/** Text of the `<label>` associated with a form control, via `for=` or
 *  by wrapping. */
function associatedLabelText(el: Element): string {
  const doc = el.ownerDocument;
  const id = el.getAttribute("id");
  if (id && doc) {
    const lbl = doc.querySelector(`label[for=${JSON.stringify(id)}]`);
    const t = lbl?.textContent?.trim();
    if (t) return t;
  }
  const wrapping = el.closest("label");
  const t = wrapping?.textContent?.trim();
  return t ?? "";
}

/** A pragmatic subset of the ARIA accessible-name algorithm — enough to
 *  match `getByRole(role, { name })` against real markup.  Precedence:
 *  aria-labelledby → aria-label → associated <label> → alt → textContent
 *  → title → placeholder.  (Not the full spec — no recursive subtree name
 *  computation — but covers the common cases.) */
function accessibleName(el: Element): string {
  const doc = el.ownerDocument;
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby && doc) {
    const text = labelledby
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();
    if (text) return text;
  }
  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;

  const label = associatedLabelText(el);
  if (label) return label;

  const alt = el.getAttribute("alt")?.trim();
  if (alt) return alt;

  const text = el.textContent?.trim();
  if (text) return text;

  const title = el.getAttribute("title")?.trim();
  if (title) return title;

  const placeholder = el.getAttribute("placeholder")?.trim();
  return placeholder ?? "";
}

/** Native-element → implicit ARIA role selectors.  An element with an
 *  explicit `role=` attribute uses that instead, so implicit matches are
 *  filtered to elements WITHOUT a `role` attribute (see getByRole). */
const IMPLICIT_ROLE_SELECTORS: Record<string, string> = {
  button:
    "button, input[type=button], input[type=submit], input[type=reset], input[type=image]",
  link: "a[href], area[href]",
  heading: "h1, h2, h3, h4, h5, h6",
  textbox:
    "input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], textarea",
  checkbox: "input[type=checkbox]",
  radio: "input[type=radio]",
  combobox: "select",
  img: "img",
  list: "ul, ol",
  listitem: "li",
  table: "table",
  row: "tr",
  cell: "td",
};

function matchesName(el: Element, name: string, exact: boolean): boolean {
  const acc = accessibleName(el);
  return exact ? acc === name : acc.includes(name);
}

/** Collapse runs of whitespace and trim — Playwright normalises text and
 *  accessible names this way before matching. */
function normText(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function textMatches(
  value: string | null | undefined,
  query: string,
  exact: boolean,
): boolean {
  const v = normText(value);
  return exact ? v === query : v.includes(query);
}

/** Set a form-control property through its native prototype setter (which
 *  React overrides to track value), then fire input/change so controlled
 *  components react — the same trick `fill` uses, generalised to `value`
 *  and `checked`. */
function setNativeProp(el: Element, prop: "value" | "checked", value: unknown): void {
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, prop)?.set;
  if (setter) setter.call(el, value);
  else (el as unknown as Record<string, unknown>)[prop] = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Fire a bubbling, cancelable UIEvent of the given constructor/type if the
 *  environment provides the constructor (happy-dom lacks some). */
function fireEvent(
  el: Element,
  Ctor: (new (type: string, init: EventInit) => Event) | undefined,
  type: string,
): void {
  if (typeof Ctor === "function") {
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true }));
  }
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

/** Playwright actionability: an element is disabled when it (or an
 *  enclosing `<fieldset>`) carries the `disabled` property, or it is
 *  marked `aria-disabled`. */
function isEnabled(el: Element): boolean {
  const he = el as HTMLElement & { disabled?: boolean };
  if (he.disabled === true) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  if (el.closest("fieldset[disabled]")) return false;
  return true;
}

/** Editable = enabled and not read-only — the gate `fill()` waits on. */
function isEditable(el: Element): boolean {
  if (!isEnabled(el)) return false;
  const he = el as HTMLElement & { readOnly?: boolean };
  if (he.readOnly === true) return false;
  if (el.getAttribute("aria-readonly") === "true") return false;
  return true;
}

/** The Playwright actionability checks a single-element resolution can
 *  wait on.  (Visibility-independent `stable` and `receives-events`/
 *  hit-testing are intentionally NOT modelled: they need a real layout
 *  engine, which happy-dom — where these run in unit tests — lacks.) */
interface Actionability {
  visible?: boolean;
  enabled?: boolean;
  editable?: boolean;
}

/** First unmet actionability gate for `el`, or null when all hold.
 *  Ordered so the message names the most specific failure. */
function unmetReason(el: Element, checks: Actionability): string | null {
  if (checks.visible && !isVisible(el)) return "element is not visible";
  if ((checks.enabled || checks.editable) && !isEnabled(el)) {
    return "element is not enabled";
  }
  if (checks.editable && !isEditable(el)) return "element is not editable";
  return null;
}

/** Dispatch a Playwright-like click: scroll into view, then the
 *  pointer/mouse event sequence (so components bound to pointerdown/
 *  mousedown react), then `el.click()` to fire the click event and run
 *  the default action (submit/navigate/toggle).  Event constructors that
 *  the environment lacks (e.g. PointerEvent under happy-dom) are skipped;
 *  `el.click()` always runs, so behaviour degrades gracefully. */
function dispatchClick(el: HTMLElement): void {
  try {
    (el as unknown as { scrollIntoView?: (o?: unknown) => void }).scrollIntoView?.(
      { block: "center" },
    );
  } catch {
    /* no layout engine (happy-dom) — ignore */
  }
  const win = el.ownerDocument?.defaultView;
  const init: MouseEventInit = { bubbles: true, cancelable: true, composed: true };
  const fire = (
    Ctor: (new (type: string, init: MouseEventInit) => Event) | undefined,
    type: string,
  ): void => {
    if (typeof Ctor === "function") el.dispatchEvent(new Ctor(type, init));
  };
  const Pointer = win?.PointerEvent as
    | (new (type: string, init: MouseEventInit) => Event)
    | undefined;
  const Mouse = win?.MouseEvent as
    | (new (type: string, init: MouseEventInit) => Event)
    | undefined;
  fire(Pointer, "pointerover");
  fire(Pointer, "pointerdown");
  fire(Mouse, "mousedown");
  fire(Pointer, "pointerup");
  fire(Mouse, "mouseup");
  el.click();
}

export class DomLocator {
  constructor(
    private readonly doc: Document,
    private readonly rootProvider: () => Element[],
    private readonly steps: Step[],
    private readonly timeout: number,
    private readonly descr: string[] = [],
  ) {}

  private add(step: Step, fragment: string): DomLocator {
    return new DomLocator(
      this.doc,
      this.rootProvider,
      [...this.steps, step],
      this.timeout,
      [...this.descr, fragment],
    );
  }

  /** Human-readable rendering of this locator's chain, for error
   *  messages (e.g. `getByTestId("save") » getByRole("button")`). */
  describe(): string {
    return this.descr.length ? this.descr.join(" » ") : "<page>";
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
    return this.add(
      (roots) => dedupe(roots.flatMap((r) => Array.from(r.querySelectorAll(sel)))),
      `getByTestId(${JSON.stringify(id)})`,
    );
  }

  locator(selector: string): DomLocator {
    return this.add(
      (roots) =>
        dedupe(roots.flatMap((r) => Array.from(r.querySelectorAll(selector)))),
      `locator(${JSON.stringify(selector)})`,
    );
  }

  getByRole(
    role: string,
    opts?: { name?: string; exact?: boolean },
  ): DomLocator {
    const explicitSel = `[role=${JSON.stringify(role)}]`;
    const implicitSel = IMPLICIT_ROLE_SELECTORS[role];
    const nameDescr =
      opts?.name == null
        ? ""
        : `, { name: ${JSON.stringify(opts.name)}${opts.exact ? ", exact: true" : ""} }`;
    return this.add((roots) => {
      const explicit = roots.flatMap((r) =>
        Array.from(r.querySelectorAll(explicitSel)),
      );
      // Native elements carry the role implicitly — but only when they
      // don't override it with an explicit `role=` (e.g. <button role="tab">).
      const implicit = implicitSel
        ? roots
            .flatMap((r) => Array.from(r.querySelectorAll(implicitSel)))
            .filter((el) => !el.hasAttribute("role"))
        : [];
      const els = dedupe([...explicit, ...implicit]);
      if (opts?.name == null) return els;
      return els.filter((el) => matchesName(el, opts.name!, opts.exact ?? false));
    }, `getByRole(${JSON.stringify(role)}${nameDescr})`);
  }

  filter(opts: { has: DomLocator }): DomLocator {
    const has = opts.has;
    return this.add(
      (roots) => roots.filter((el) => has.matchesFrom([el]).length > 0),
      `filter({ has: ${has.describe()} })`,
    );
  }

  first(): DomLocator {
    return this.add((roots) => roots.slice(0, 1), "first()");
  }

  last(): DomLocator {
    return this.add((roots) => roots.slice(-1), "last()");
  }

  nth(index: number): DomLocator {
    return this.add(
      (roots) => {
        const i = index < 0 ? roots.length + index : index;
        const el = roots[i];
        return el ? [el] : [];
      },
      `nth(${index})`,
    );
  }

  /** Match by visible text — the innermost element whose normalised text
   *  matches (so a button's text resolves the button, not its ancestors). */
  getByText(text: string, opts?: { exact?: boolean }): DomLocator {
    const exact = opts?.exact ?? false;
    return this.add((roots) => {
      const all = dedupe(
        roots.flatMap((r) => Array.from(r.querySelectorAll("*"))),
      );
      const hits = all.filter((el) => textMatches(el.textContent, text, exact));
      // Keep only the innermost matches (drop a hit that contains another hit).
      return hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    }, `getByText(${JSON.stringify(text)}${exact ? ", { exact: true }" : ""})`);
  }

  /** Match a form control by its associated `<label>` text (`for=` or wrapping). */
  getByLabel(text: string, opts?: { exact?: boolean }): DomLocator {
    const exact = opts?.exact ?? false;
    return this.add((roots) => {
      const out: Element[] = [];
      for (const root of roots) {
        for (const lbl of Array.from(root.querySelectorAll("label"))) {
          if (!textMatches(lbl.textContent, text, exact)) continue;
          const forId = lbl.getAttribute("for");
          const ctrl = forId
            ? lbl.ownerDocument?.getElementById(forId)
            : lbl.querySelector("input, select, textarea");
          if (ctrl) out.push(ctrl);
        }
      }
      return dedupe(out);
    }, `getByLabel(${JSON.stringify(text)}${exact ? ", { exact: true }" : ""})`);
  }

  getByPlaceholder(text: string, opts?: { exact?: boolean }): DomLocator {
    return this.byAttr("placeholder", text, opts, "getByPlaceholder");
  }

  getByTitle(text: string, opts?: { exact?: boolean }): DomLocator {
    return this.byAttr("title", text, opts, "getByTitle");
  }

  getByAltText(text: string, opts?: { exact?: boolean }): DomLocator {
    return this.byAttr("alt", text, opts, "getByAltText");
  }

  /** Shared resolver for the attribute-text getters. */
  private byAttr(
    attr: string,
    text: string,
    opts: { exact?: boolean } | undefined,
    label: string,
  ): DomLocator {
    const exact = opts?.exact ?? false;
    const sel = `[${attr}]`;
    return this.add(
      (roots) =>
        dedupe(
          roots.flatMap((r) => Array.from(r.querySelectorAll(sel))),
        ).filter((el) => textMatches(el.getAttribute(attr), text, exact)),
      `${label}(${JSON.stringify(text)}${exact ? ", { exact: true }" : ""})`,
    );
  }

  /** Resolve to the single matching element, polling until the requested
   *  actionability gates hold.  Strict like real Playwright: throws when
   *  the locator matches more than one element (counting all matches,
   *  regardless of visibility) — use `.first()` or a more specific
   *  locator. */
  private async resolve(
    checks: Actionability,
    timeout = this.timeout,
  ): Promise<HTMLElement> {
    const deadline = Date.now() + timeout;
    let lastReason = "no element matched";
    for (;;) {
      const els = this.matchesNow();
      if (els.length > 1) {
        throw new Error(
          `locator(${this.describe()}): resolved to ${els.length} elements; use .first() or a more specific locator`,
        );
      }
      const el = els[0];
      if (el) {
        const reason = unmetReason(el, checks);
        if (!reason) return el as HTMLElement;
        lastReason = reason;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `locator(${this.describe()}): ${lastReason} within ${timeout}ms`,
        );
      }
      await sleep(POLL_MS);
    }
  }

  async click(opts?: { timeout?: number }): Promise<void> {
    dispatchClick(await this.resolve({ visible: true, enabled: true }, opts?.timeout));
  }

  async fill(value: string, opts?: { timeout?: number }): Promise<void> {
    const el = await this.resolve({ visible: true, editable: true }, opts?.timeout);
    setNativeProp(el, "value", value);
  }

  /** Playwright's `clear()` = `fill("")`. */
  async clear(opts?: { timeout?: number }): Promise<void> {
    await this.fill("", opts);
  }

  async hover(opts?: { timeout?: number }): Promise<void> {
    const el = await this.resolve({ visible: true }, opts?.timeout);
    const win = el.ownerDocument?.defaultView;
    const P = win?.PointerEvent as
      | (new (t: string, i: EventInit) => Event)
      | undefined;
    const M = win?.MouseEvent as
      | (new (t: string, i: EventInit) => Event)
      | undefined;
    fireEvent(el, P, "pointerover");
    fireEvent(el, M, "mouseover");
    fireEvent(el, P, "pointermove");
    fireEvent(el, M, "mousemove");
  }

  async dblclick(opts?: { timeout?: number }): Promise<void> {
    const el = await this.resolve({ visible: true, enabled: true }, opts?.timeout);
    dispatchClick(el);
    dispatchClick(el);
    const M = el.ownerDocument?.defaultView?.MouseEvent as
      | (new (t: string, i: EventInit) => Event)
      | undefined;
    fireEvent(el, M, "dblclick");
  }

  async press(key: string, opts?: { timeout?: number }): Promise<void> {
    const el = await this.resolve({ visible: true }, opts?.timeout);
    el.focus?.();
    const K = el.ownerDocument?.defaultView?.KeyboardEvent;
    if (typeof K === "function") {
      for (const type of ["keydown", "keypress", "keyup"]) {
        el.dispatchEvent(new K(type, { key, bubbles: true, cancelable: true }));
      }
    }
  }

  async check(opts?: { timeout?: number }): Promise<void> {
    const el = (await this.resolve(
      { visible: true, enabled: true },
      opts?.timeout,
    )) as HTMLInputElement;
    if (!el.checked) setNativeProp(el, "checked", true);
  }

  async uncheck(opts?: { timeout?: number }): Promise<void> {
    const el = (await this.resolve(
      { visible: true, enabled: true },
      opts?.timeout,
    )) as HTMLInputElement;
    if (el.checked) setNativeProp(el, "checked", false);
  }

  async selectOption(value: string, opts?: { timeout?: number }): Promise<void> {
    const el = await this.resolve({ visible: true, enabled: true }, opts?.timeout);
    setNativeProp(el, "value", value);
  }

  async focus(opts?: { timeout?: number }): Promise<void> {
    (await this.resolve({ visible: true }, opts?.timeout)).focus?.();
  }

  async blur(opts?: { timeout?: number }): Promise<void> {
    (await this.resolve({}, opts?.timeout)).blur?.();
  }

  async innerText(opts?: { timeout?: number }): Promise<string> {
    const el = await this.resolve({}, opts?.timeout);
    return (el.innerText ?? el.textContent ?? "").trim();
  }

  /** Playwright's `count()` does not auto-wait. */
  count(): Promise<number> {
    return Promise.resolve(this.matchesNow().length);
  }

  async waitFor(opts?: {
    state?: "visible" | "attached" | "hidden";
    timeout?: number;
  }): Promise<void> {
    const state = opts?.state ?? "visible";
    const timeout = opts?.timeout ?? this.timeout;
    if (state === "hidden") {
      const deadline = Date.now() + timeout;
      for (;;) {
        if (!this.matchesNow().some(isVisible)) return;
        if (Date.now() >= deadline) {
          throw new Error(
            `locator(${this.describe()}): still visible after ${timeout}ms`,
          );
        }
        await sleep(POLL_MS);
      }
    }
    await this.resolve(state === "visible" ? { visible: true } : {}, timeout);
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

  getByText(text: string, opts?: { exact?: boolean }): DomLocator {
    return this.root().getByText(text, opts);
  }

  getByLabel(text: string, opts?: { exact?: boolean }): DomLocator {
    return this.root().getByLabel(text, opts);
  }

  getByPlaceholder(text: string, opts?: { exact?: boolean }): DomLocator {
    return this.root().getByPlaceholder(text, opts);
  }

  getByTitle(text: string, opts?: { exact?: boolean }): DomLocator {
    return this.root().getByTitle(text, opts);
  }

  getByAltText(text: string, opts?: { exact?: boolean }): DomLocator {
    return this.root().getByAltText(text, opts);
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

  async waitForURL(
    matcher: RegExp | string,
    opts?: { timeout?: number },
  ): Promise<void> {
    const test = (u: string): boolean =>
      typeof matcher === "string" ? u.includes(matcher) : matcher.test(u);
    const deadline = Date.now() + (opts?.timeout ?? this.timeout);
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
