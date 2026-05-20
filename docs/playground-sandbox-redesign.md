# Playground preview: sandbox re-platforming

Status: design proposal. No code yet.

## Why this exists

Two things forced a rethink of how the playground runs the generated app:

1. **We will run untrusted user code in the preview.** Frontend pages will
   allow custom expressions. Once arbitrary user-authored code executes inside
   the preview iframe, that iframe is no longer trusted and must not share an
   origin with the playground.
2. **In-browser test execution** (the original ask: run a system's `test e2e`
   blocks in the playground) needs a way to drive the preview's DOM. That
   driver and the runtime bridge want to be the *same* channel.

Both land on the same conclusion: the preview must become a real isolation
boundary, and everything that crosses it (API calls, test driving, console,
screenshots) must go through one explicit, capability-scoped message channel.

## The problem with what we have today

The current preview is **same-origin on purpose**, and three load-bearing
mechanisms depend on that:

| Mechanism | File | Depends on same-origin because… |
|---|---|---|
| Service-Worker serving | `web/public/preview-sw.js` | A SW only controls non-opaque same-origin clients. It serves the bundle HTML at `<base>/__loom_sandbox__/` and the iframe is deliberately rendered **without** a `sandbox` attribute (`Preview.tsx:336`). |
| Client-side routing | generated `main.tsx` + `iframe-html.ts` (`__LOOM_BASENAME__`) | Uses `BrowserRouter` / History API. `pushState` to `/orders` requires a real (non-opaque) origin. |
| API calls | bundler `VITE_API_BASE_URL` → `runtime` → SW intercept | Relative `fetch("<sandbox>/runtime/*")` is caught by the SW and forwarded over a `MessageChannel` to the PGlite runtime worker. |

The SW path also carries real complexity that exists *only* to paper over SW
lifecycle quirks: `loom-sw/awake` revival broadcasts, `swRevision`
re-attach/re-push effects, 502/503/504 fallbacks (`Preview.tsx:174-256`,
`preview-sw.js:43-116,152-160`).

The instant we add `sandbox` without `allow-same-origin` (required to deny user
code access to the playground's `localStorage` / `IndexedDB` / cookies), the
iframe gets an **opaque origin** and:

- **the SW can no longer serve or intercept it** — opaque-origin frames are
  uncontrolled;
- **History routing throws** `SecurityError` on an opaque origin;
- **relative `fetch` has nothing to intercept** — there is no SW in scope.

So you cannot keep the SW design and isolate the frame. They are mutually
exclusive. This is the core finding.

## Threat model (what isolation must buy us)

User code in the preview must not be able to:

1. Read or write the playground's `localStorage` / `IndexedDB` / cookies
   (editor autosave, settings) — defeated by an **opaque origin** (no
   `allow-same-origin`).
2. Reach into the parent DOM or navigate the top frame — defeated by the
   sandbox (no `allow-top-navigation`, no `allow-same-origin`).
3. Exfiltrate to arbitrary network endpoints (`fetch`, `WebSocket`, `img`
   beacons) — **not** covered by origin isolation; needs a **CSP** on the
   sandbox document restricting `connect-src` / `img-src` / `script-src`.
4. Abuse the bridge to attack the parent — the parent must treat every message
   from the sandbox as **untrusted input** and authenticate the channel by
   **capability** (a transferred `MessagePort`), not by origin (opaque frames
   post with origin `"null"`, so origin checks are useless here).

Point 3 is the easy one to forget: an opaque origin still has full outbound
network. Containment = origin isolation **+** CSP.

## Options considered

### A. Opaque-origin sandbox (recommended)

`sandbox="allow-scripts"` iframe, content delivered via `srcdoc` (or a tiny
bootstrap that pulls the bundle over the bridge). No Service Worker.

- **Isolation:** opaque origin → no access to parent storage/cookies; CSP
  `<meta>` in the document → no arbitrary egress.
- **One host:** works identically on `localhost` dev and GitHub Pages. No
  second domain, no extra deploy target.
- **Unifies the bridge:** API calls *and* test driving go over one transferred
  `MessagePort`.
- **Deletes complexity:** the entire SW + its revival machinery goes away.

Costs: rewrite preview delivery, switch the generated app's preview-mode router
off History, and replace SW fetch interception with an injected `fetch` shim.

### B. Separate real origin (distinct host)

Serve the preview from a genuinely different domain (a dedicated sandbox host or
second Pages deployment). This is the "localhost :3000 vs :4000" model from the
uploaded design, generalised to production.

- **Pros:** full browser semantics inside (real History routing, the sandbox
  could even run its *own* SW, persistent per-sandbox storage), and a real
  origin is a stronger boundary than an opaque one.
- **Cons:** needs a second hosted origin + deploy pipeline; cross-origin
  serving can't reuse our main-origin SW (a SW is per-origin), so you'd still
  ship a bootstrap that pulls the bundle over `postMessage`; heavier
  operationally and a worse fit for the static/serverless ethos.

**Decision: build B, staged through same-origin via a `SANDBOX_ORIGIN`
constant.** B is the better target — a real origin keeps `BrowserRouter` and
clean paths, gives stronger isolation, and makes `event.origin` checks valid
(opaque frames post as `"null"`). The "needs a second host" cost is deferred,
not paid up front: see [Staged rollout](#staged-rollout-origin-flip-is-a-config-switch).

We do **not** take A. Its only advantage was zero infra, but the opaque origin
forces HashRouter and a CSP/inline-stack fight; the staged-B approach gets the
same zero-infra-today property without either compromise.

### Staged rollout (origin flip is a config switch)

The preview origin is a single build constant, `SANDBOX_ORIGIN`:

| Phase | `SANDBOX_ORIGIN` | Isolation | Ships on Pages? |
|---|---|---|---|
| Now (dev) | `http://sandbox.localhost:<port>` *(optional)* or same origin | dev-only | n/a |
| Now (prod) | **the playground's own origin** | none yet | **yes** |
| Later | a distinct origin — a free second `*.github.io` site (separate org) or a custom domain | full cross-site | yes |

- The bootstrap is a **single static stub** served from `SANDBOX_ORIGIN`. While
  same-origin it's just an asset in the existing Pages deploy
  (`<base>/sandbox.html`); the iframe loads `new URL("sandbox.html",
  SANDBOX_ORIGIN + base)`.
- The generated **bundle is delivered over `postMessage`**, never written to the
  sandbox host — so the stub is fixed and deployed once, and the same mechanism
  works after the flip (a cross-origin host can't be handed files anyway).
- Fix the iframe attribute now at `sandbox="allow-scripts allow-same-origin
  allow-forms"`. It's a **no-op while same-origin** and becomes a **real
  boundary** the instant `SANDBOX_ORIGIN` differs. The attribute never changes;
  only the constant does. (`allow-same-origin` is safe in both phases — it
  refers to the sandbox's *own* origin, not the playground's.)
- The bridge validates `event.origin === SANDBOX_ORIGIN`, correct in both modes.
- **`BrowserRouter` is retained throughout** (both origins are real/non-opaque).
  No router change, no `main.hbs` edits, no HashRouter — that entire branch of
  the plan is dropped.

**The one caveat:** while `SANDBOX_ORIGIN` equals the playground origin there is
**no isolation**. Everything ships (bridge, bootstrap, in-browser tests) except
the security boundary — so the untrusted user-expression feature must not ship
until `SANDBOX_ORIGIN` points at a distinct origin. That flip is config + a
one-file deploy, no code change.

Keep A's opaque/HashRouter design documented only as the fallback if a second
origin is ever truly impossible.

> Note on the uploaded "Comlink + two ports" design: its *technique* is right
> (MutationObserver `waitForSelector`, dispatch `input`/`change` for
> framework-controlled inputs, `DataTransfer` for file inputs), and its RPC
> bridge is exactly what an isolated frame needs. Two corrections for our case:
> we get isolation from an **opaque origin on one host**, not two real ports;
> and its `trustedOrigin === "http://localhost:3000"` check is wrong for a
> no-`allow-same-origin` frame (origin is `"null"`) — authenticate by the
> transferred port instead.

## Target architecture (Option B, staged)

```
┌─ Playground (trusted origin) ──────────────────────────────────────┐
│  Editor · LSP worker · esbuild bundler worker · PGlite runtime      │
│  worker · Test runner + reporter UI                                 │
│                                                                     │
│  PreviewHost                                                        │
│   • renders <iframe sandbox="allow-scripts allow-same-origin        │
│     allow-forms" src=SANDBOX_ORIGIN/sandbox.html>                   │
│   • on load: postMessage(init, SANDBOX_ORIGIN, [port])  ← one port  │
│   • owns `port`; routes 3 message kinds to/from workers + driver    │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │  single MessagePort (capability)
┌───────────────────────────────▼─────────────────────────────────────┐
│  Preview sandbox @ SANDBOX_ORIGIN (real origin; CSP-locked)         │
│   • static stub grabs the port, requests + boots the bundle         │
│   • installs window.fetch shim → port (API calls)                   │
│   • mounts the generated app unchanged (BrowserRouter)              │
│   • exposes a DOM driver (click/fill/waitFor/text/setFiles/shot)    │
└─────────────────────────────────────────────────────────────────────┘

SANDBOX_ORIGIN = playground origin (now) → distinct origin (later).
Same-origin now = no isolation yet, but ships on Pages; the flip is
config + a one-file deploy, no code change.
```

### The bridge protocol (one port, three concerns)

All framed as `{ kind, id, … }` request/response over the transferred port:

1. `runtime` — `{ method, url, headers, body }` → parent forwards to the PGlite
   runtime worker, replies `{ status, headers, body }`. This *replaces* the SW
   `forwardRuntime` path (`preview-sw.js:186`) verbatim in spirit; the
   `RuntimeRequest` / `RuntimeReply` shapes in `sw-host.ts:97-113` carry over
   unchanged.
2. `driver` — `{ op: "click"|"fill"|"waitForSelector"|"textContent"|
   "setInputFiles"|"screenshot", selector, args }` → executed against the
   sandbox DOM, result returned. This is the in-sandbox driver from the
   uploaded design.
3. `event` — sandbox → parent push: console lines, uncaught errors, navigation.
   Lets the playground show a console and surface user-code crashes.

Comlink is optional sugar over this; raw `postMessage` with an `id`-keyed
pending map (the pattern already in `sw-host.ts:133-148`) is enough.

### Bundle delivery without a SW

Two viable shapes:

- **Inline `srcdoc`** — put the whole `makePreviewHtml(...)` document
  (`iframe-html.ts`) into `srcdoc`. Simplest; watch total size with big bundles.
- **Bootstrap + in-sandbox blob** (preferred if size bites) — a tiny `srcdoc`
  bootstrap grabs the port, requests the bundle, creates a `Blob` URL **inside**
  the sandbox (inherits the opaque origin, so isolation holds) and
  `import()`s it. Keeps `srcdoc` tiny.

Either way, `iframe-html.ts` mostly survives; what changes is *who serves it*
(srcdoc, not SW) and the routing/fetch wiring below.

### Generated app: deploy mode vs preview mode

The generator's output must stay **deploy-faithful** (real `BrowserRouter`,
real `fetch` to `VITE_API_BASE_URL`). Preview adaptation is injected, exactly as
today's `__LOOM_BASENAME__` / `__LOOM_API_BASE__` globals are
(`iframe-html.ts:204-210`). Extend that seam:

- `window.__LOOM_PREVIEW__ = true` selects **HashRouter / MemoryRouter** instead
  of `BrowserRouter` (History API is unavailable on an opaque origin). This is
  the one change that touches generated code — gate router choice on the global
  in the emitted `main.tsx`.
- The injected bootstrap installs the `fetch` shim **before** the bundle runs,
  so the generated API client's calls transparently ride the bridge. No change
  to the generated API client.

### Network containment (CSP)

Add a `<meta http-equiv="Content-Security-Policy">` to the sandbox document:

- `connect-src 'none'` is the goal — all data access is via the bridge, not the
  network. Achievable **only if** runtime deps are inlined (no esm.sh importmap
  at runtime). The React-19 "stack v2" path already inlines React
  (`iframe-html.ts:46-51`); make that the **default for preview** so CSP can be
  tight. The React-18 importmap path and the Tailwind Play CDN /
  `@tailwindcss/browser` scripts (`iframe-html.ts:220-226`) require an explicit
  allowlist of those exact CDN origins — a conscious, bounded relaxation that
  still blocks arbitrary egress.
- `script-src 'unsafe-inline'` (the inlined module) + any allowlisted CDN.
- `base-uri 'none'`, `form-action 'none'`.

This is a real decision point: **tight CSP wants everything inlined**; the
shadcn/Tailwind-CDN packs are the holdouts. Recommend: default preview to the
inline stack; allowlist the specific Tailwind CDN host for the packs that need
it; document the gap.

## How tests slot in (the original ask)

With the bridge in place, both test kinds fall out naturally:

- **`kind: "api"` tests** (`src/system/e2e-render.ts`, vitest+fetch) — run their
  statements against the PGlite runtime worker via the `runtime` channel. No
  iframe needed at all; can run headless. Lowest effort, highest confidence.
- **`kind: "ui"` tests** (`src/system/ui-e2e-render.ts`, Playwright + page
  objects) — the generated page objects use a **small closed slice** of the
  Playwright `Page` API (`goto`, `getByTestId`, `getByRole`, `locator`,
  `.click/.fill/.innerText/.count/.waitFor/.filter`, `url()`, `waitForURL`). The
  in-sandbox **driver** implements that slice against the live DOM; the parent
  exposes a `page` shim that RPCs into it over the `driver` channel.
  Integration trick: bundle the generated spec through esbuild but **alias
  `@playwright/test`** to a playground shim providing `test` / `expect` and the
  bridged `page`. Reuses the bundler and import-map machinery we already have.

The `goto` op must drive the preview-mode router (hash/memory), not browser
navigation — the one place the test driver and the router-mode change meet.

## What gets removed

- `web/public/preview-sw.js` (entire SW).
- SW registration + lifecycle in `sw-host.ts` / `sw-iframe-host.ts`
  (`registerPreviewSw`, `pushBundle`, `attachRuntimePort`, the `awake`/revival
  dance).
- `Preview.tsx` SW state (`swRevision`, `runtimeAttached` gating, `SW_AVAILABLE`
  fallback messaging) — replaced by a load→init→port handshake.

The `RuntimeRequest`/`RuntimeReply` types and the runtime-worker dispatch logic
**stay**; only their transport changes (port instead of SW).

### Lifecycle: no SW means no revival

The SW revival machinery (`swRevision`, `loom-sw/awake`, re-attach/re-push)
exists *only* because a Service Worker is event-driven and the browser spins it
down when idle / kills it under memory pressure. The new transport is a
`MessagePort` between two **live documents** (parent window ↔ sandboxed iframe);
neither is spun down behind our back. The PGlite runtime stays in a dedicated
**Web Worker** owned by the parent — exactly where it is today; the SW was only
relaying to it. A sandboxed `allow-scripts` frame can't host a SW anyway. So
this removes a failure class rather than relocating it. The only lifecycle
events left are parent-driven and deterministic (iframe remount on a new bundle
→ port handshake re-runs).

## Implementation plan

Phases are independently shippable. Each ends at a gate that must stay green.

### Phase 1 — Bridge + sandbox delivery (no user-visible change)

Swap transport and isolation with the *same* preview behaviour.

- **New `web/src/preview/bridge/protocol.ts`** — message envelopes: `init`
  (carries the transferred port), and id-keyed `{ kind: "runtime" | "driver" |
  "event", id, … }`. Move `RuntimeRequest` / `RuntimeReply` here unchanged from
  `sw-host.ts:97-113`.
- **New `web/src/preview/bridge/parent-bridge.ts`** — on iframe `load`, create a
  `MessageChannel` and `iframe.contentWindow.postMessage(init, "*", [port2])`;
  keep `port1`; id-keyed pending map (the pattern in `sw-host.ts:133-148`).
  Routes `runtime` → the existing runtime-worker dispatch
  (`web/src/runtime/client.ts`), surfaces `event` pushes, and (phase 4) issues
  `driver` calls. Authenticate by the port, **not** origin.
- **New sandbox bootstrap** (injected as inline script ahead of the bundle) —
  grabs the port from the first message, installs a `window.fetch` shim that
  serialises `Request` → `runtime` message and rebuilds the `Response`, and
  forwards `console` + `error`/`unhandledrejection` as `event`s.
- **Rewrite `web/src/preview/iframe-html.ts`** — inject the bootstrap before the
  bundle `<script type="module">`; set a sentinel `__LOOM_API_BASE__` the fetch
  shim keys on; add a CSP `<meta>` (loosened now, tightened in phase 2).
  Importmap / Tailwind stay for now. **No `__LOOM_PREVIEW__` / router flag** —
  the app keeps `BrowserRouter` (real origin both phases).
- **New static stub** `web/public/sandbox.html` served from `SANDBOX_ORIGIN`
  (same origin now). Grabs the port, requests the bundle, mounts it. The iframe
  `src` is `new URL("sandbox.html", SANDBOX_ORIGIN + base)`.
- **New `web/src/preview/sandbox-iframe-host.ts`** replacing
  `SwIframePreviewHost` — builds the `srcdoc`, sets the iframe to
  `sandbox="allow-scripts"` + `srcdoc=…`, wires `parent-bridge` to the runtime
  dispatcher. (Keep the `PreviewHost` interface so `Preview.tsx` barely moves.)
- **Rewrite `web/src/preview/Preview.tsx`** — drop `SW_AVAILABLE`, `swRevision`,
  `runtimeAttached` gating; render `<iframe sandbox="allow-scripts"
  srcdoc={html}>`; remount keyed on bundle hash (already done) re-runs the
  handshake.
- **Delete** `web/public/preview-sw.js`, `web/src/preview/sw-host.ts`,
  `web/src/preview/sw-iframe-host.ts`, and the `registerPreviewSw()` call in
  `web/src/App.tsx`.
- **No generated-code change.** `BrowserRouter` is kept; the driver reads/sets
  `location` on a real origin (`pushState` works). The 7-pack `main.hbs` /
  HashRouter work is dropped entirely.
- **Tests:** rewrite `web/e2e/runtime.spec.ts` to the stub+port flow; delete
  `web/e2e/preview-sw.spec.ts`.
- **Gate:** generate → bundle → boot → interact works on localhost **and** a
  non-root deploy-base build; runtime fetches resolve; no SW registered.

### Phase 2 — CSP + inline-stack default

- Default preview to the React-19 **inline** stack (`iframe-html.ts:46-51`,
  `web/src/bundle/stacks.ts`) so runtime deps aren't fetched.
- CSP builder in `iframe-html.ts`: target `connect-src 'none'`,
  `script-src 'unsafe-inline'` + an explicit allowlist for the Tailwind CDN
  hosts the shadcn packs load (`iframe-html.ts:220-226`); `base-uri 'none'`,
  `form-action 'none'`.
- **Gate:** app still loads under the locked CSP; an injected
  `fetch("https://example.com")` from sandbox code is blocked (assert in e2e).

### Phase 3 — API test runner

- **New `web/src/testing/run-api-tests.ts`** — lower the current system (web
  already imports the toolchain from `../src`), take `system.e2eTests` where
  `kind === "api"`, and execute each statement against the runtime worker via
  the `runtime` channel (interpret `TestE2EIR`, or bundle the generated
  `e2e/*.e2e.test.ts` with `vitest`/`fetch` aliased to shims).
- Reporter UI panel (pass/fail per test, error detail).
- **Gate:** `examples/acme.ddd` API tests go green in the playground and match
  the docker `LOOM_E2E` result.

### Phase 4 — UI driver + `page` shim

- **New `web/src/preview/sandbox-driver.ts`** — implements the closed Playwright
  subset the page objects use (`getByTestId`, `getByRole`, `locator`, `.click`,
  `.fill`, `.innerText`, `.count`, `.filter`, `.waitFor`, `goto`, `url`,
  `waitForURL`, `setInputFiles`) against the live DOM, with `MutationObserver`
  auto-wait; `fill` dispatches `input`/`change`; `setInputFiles` uses
  `DataTransfer`; `goto`/`url` go through `location.hash` (HashRouter). Exposed
  over the `driver` channel.
- **Parent `page` shim** mapping the Playwright `Page` subset → `driver` RPC.
- Bundle the generated `*.ui.spec.ts` with **`@playwright/test` aliased** to a
  shim providing `test` / `expect` + the injected bridged `page` (reuses the
  esbuild worker + import-alias machinery).
- **Guard test** asserting `src/generator/react/page-objects-builder.ts` only
  emits the supported `Page` surface (fails loudly if the generator grows a
  method the driver doesn't implement).
- **Gate:** `acme` UI spec passes in the playground.

### Phase 5 — (optional) console + screenshots

- Surface the `event` console/error stream in the reporter; add `screenshot`
  via `html-to-image` for the driver and a visible result thumbnail.

## Risks / open questions

- **Isolation lands only at the origin flip.** The same-origin staging phase
  has no security boundary; the untrusted user-expression feature is gated on
  pointing `SANDBOX_ORIGIN` at a distinct origin first. Track this so the two
  don't ship out of order.
- **CSP vs Tailwind/esm.sh.** Tight `connect-src 'none'` is incompatible with
  the CDN-driven packs as written. Either inline everything (work in the
  bundler) or allowlist specific hosts (weaker, but bounded).
- **`srcdoc` size** with large inlined bundles — fall back to the bootstrap +
  in-sandbox blob pattern if it bites.
- **Driver fidelity.** Auto-wait need only be "good enough" for deterministic
  generated specs, but it must mirror the page objects' assumptions
  (`waitFor` visible, retry-until-present). Keep the supported surface
  explicitly enumerated and guard-tested against the generator.
- **Loss of SW caching.** esm.sh fetches were effectively cached by the SW
  lifetime; without it, lean harder on the bundler worker's
  `persistentFetchCache` (already present) and/or the inline stack.

## Bottom line

Isolating the preview is incompatible with the Service-Worker design; embrace
that and move to an opaque-origin sandbox with a single capability-scoped
`MessagePort`. It is a meaningful rewrite of the preview layer (and one gated
change in the generated app's router selection), but it simultaneously delivers
the security boundary for user code, removes the SW lifecycle complexity, and
gives the in-browser test runner the exact channel it needs.
