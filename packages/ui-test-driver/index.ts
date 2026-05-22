// @loom/ui-test-driver — public API barrel.
//
// A framework-neutral, in-browser UI test driver that implements a closed
// subset of the Playwright `Page`/`Locator` surface.  The parent-side shim
// (RemotePage/RemoteLocator) holds no DOM — it reifies each locator into a
// serialisable ChainNode[] and ships leaf ops over a DriverTransport; the
// sandbox-side executor (executeDriverOp + DomPage/DomLocator) resolves the
// chain against the live document and acts.  The host injects environment
// accessors (basename, in-flight network state) so this package carries no
// application-specific coupling.

export { RemotePage, RemoteLocator, type DriverTransport } from "./remote-page.js";
export {
  type ChainNode,
  type DriverOp,
  type DriverReply,
  type ExecuteOptions,
  type NetState,
  resolveChain,
  executeDriverOp,
} from "./locator-chain.js";
export { DomPage, DomLocator, type DomPageOptions } from "./dom-page.js";
export {
  makePostMessageTransport,
  type PostMessageTransportOptions,
  type DriverRequest,
  type DriverResponse,
} from "./postmessage-transport.js";
export { serveDriverOps, type ServeDriverOptions } from "./serve-driver.js";
export {
  createLocatorMatchers,
  type LocatorAssertions,
  type AssertableLocator,
  type AssertionOptions,
} from "./locator-assertions.js";
// `captureNode` is intentionally NOT re-exported here: that would make
// importing this barrel eagerly load `html-to-image`. Screenshot capture
// is reached lazily by the "screenshot" driver op, or explicitly via the
// "@loom/ui-test-driver/screenshot" subpath export.
