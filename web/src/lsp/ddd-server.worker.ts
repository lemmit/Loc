// Web-worker entry: boots the Loom Langium LSP server in the browser.
// `main-browser.ts` self-starts on import (wires BrowserMessageReader/Writer
// to the worker's postMessage channel).
import "../../../src/language/main-browser.js";
