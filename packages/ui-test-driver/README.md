# @loom/ui-test-driver

A framework-neutral, **in-browser** UI test driver that implements a closed subset of the
Playwright `Page` / `Locator` API.

The point: the **same** Playwright-style page-object spec can run both under real Playwright
in CI **and** entirely in the browser — no Node, no WebDriver/CDP, no browser-automation
engine — against an app mounted in an iframe.

## How it works

- **Parent side** (`RemotePage` / `RemoteLocator`) holds no DOM. A locator just accumulates a
  serialisable `ChainNode[]`; each leaf op (`click`, `fill`, …) is sent as a `DriverOp` over a
  `DriverTransport` and awaits the reply.
- **Sandbox side** (`executeDriverOp` + `DomPage` / `DomLocator`) rebuilds the locator from the
  chain, resolves it against the live document with Playwright-like actionability/auto-wait, and
  acts.
- **Transport** is pluggable. `makeIframeTransport` runs ops directly against a same-origin
  iframe's document; a postMessage transport can be supplied for a cross-origin sandbox without
  changing the `RemotePage` contract.
- **No host coupling.** Environment specifics (router basename, in-flight network state for
  network-idle waits) are passed in as accessor functions via options — the package names no
  application globals.

## Supported Playwright API (subset)

This is the closed subset needed to drive generated page objects. It is **not** full Playwright.

| Surface | Supported |
|---|---|
| `Page` | `goto`, `getByTestId`, `getByRole`, `locator`, `url`, `waitForURL`, `waitForLoadState("networkidle")`, `screenshot` |
| `Locator` | `getByTestId`, `getByRole({ name, exact })`, `locator`, `filter({ has })`, `first`, `click`, `fill`, `innerText`, `count`, `waitFor({ state })` |

Notable semantics modelled: strict single-match resolution (throws on multiple matches —
use `.first()`), actionability gates (`visible` / `enabled` / `editable`), React-aware `fill`
(native value setter + `input`/`change` events), and poll-loop auto-wait (no layout engine
required, so it runs under happy-dom). Hit-testing / stability checks that need a real layout
engine are intentionally not modelled.

Anything outside the table (e.g. `hover`, `press`, `selectOption`, `getByText`, web-first
`expect(locator).toBeVisible()` assertions) is **not yet implemented** — contributions welcome.

## Status

`0.0.0-experimental`, currently consumed in-repo by the Loom playground. Extracted as a
self-contained package as the first step toward a standalone, permissively-licensed release.
