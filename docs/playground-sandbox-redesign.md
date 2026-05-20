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

**Recommendation: build A now.** It delivers the security boundary the user
asked for without a second host and collapses two channels into one. Keep B in
the back pocket for if/when we need a shareable preview URL or persistent
sandbox storage.

> Note on the uploaded "Comlink + two ports" design: its *technique* is right
> (MutationObserver `waitForSelector`, dispatch `input`/`change` for
> framework-controlled inputs, `DataTransfer` for file inputs), and its RPC
> bridge is exactly what an isolated frame needs. Two corrections for our case:
> we get isolation from an **opaque origin on one host**, not two real ports;
> and its `trustedOrigin === "http://localhost:3000"` check is wrong for a
> no-`allow-same-origin` frame (origin is `"null"`) — authenticate by the
> transferred port instead.

## Target architecture (Option A)

```
┌─ Playground (trusted origin) ──────────────────────────────────────┐
│  Editor · LSP worker · esbuild bundler worker · PGlite runtime      │
│  worker · Test runner + reporter UI                                 │
│                                                                     │
│  PreviewHost                                                        │
│   • renders <iframe sandbox="allow-scripts" srcdoc=…>               │
│   • on load: postMessage(init, "*", [port])  ← transfer one port    │
│   • owns `port`; routes 3 message kinds to/from workers + driver    │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │  single MessagePort (capability)
┌───────────────────────────────▼─────────────────────────────────────┐
│  Preview sandbox (opaque origin, CSP-locked)                        │
│   • bootstrap grabs the port from the init message                  │
│   • installs window.fetch shim → port (API calls)                   │
│   • mounts the generated app in PREVIEW mode (Hash/Memory router)   │
│   • exposes a DOM driver (click/fill/waitFor/text/setFiles/shot)    │
└─────────────────────────────────────────────────────────────────────┘
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

## Migration phases

1. **Bridge + delivery swap (no behaviour change to user):** sandboxed
   `srcdoc` iframe, transferred port, `runtime` channel, `fetch` shim,
   preview-mode router global. Delete the SW. Rewrite `web/e2e/runtime.spec.ts`
   and retire `preview-sw.spec.ts`. Gate: existing preview demos still work.
2. **CSP + inline-stack default:** lock `connect-src`, default preview to the
   inline runtime stack, allowlist Tailwind CDN where packs need it.
3. **API test runner:** `driver`-less, runs `kind:"api"` tests over the
   `runtime` channel; minimal pass/fail reporter UI.
4. **UI driver + `page` shim:** implement the closed Playwright subset in the
   sandbox; alias `@playwright/test`; run `kind:"ui"` specs. Add a guard test
   asserting the page-object generator only emits the supported `Page` surface.
5. **(Optional) console/error channel + screenshots** for the reporter.

## Risks / open questions

- **Router change touches generated code.** It's behind a global and only
  affects preview, but it is the one non-injected change. Confirm Hash vs Memory
  (Hash survives reload-in-preview; Memory is simpler but loses deep-link feel).
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
