// Evaluate a generated bundle in a realm shaped like the runtime worker's.
//
// WHY THIS EXISTS
// ---------------
// `runtime/runtime.worker.ts` boots a generated backend with
// `await import(blobUrl)`.  That import runs every module body in the
// bundle's graph — including our npm dependencies' — inside a
// DedicatedWorker scope, which has NO Node globals.  Two shipped bugs came
// from a dependency reading one at MODULE-EVALUATION time, where no
// try/catch at a call site can help:
//
//   prom-client/lib/metrics/processStartTime.js:4   process.uptime()
//   pg-protocol/dist/parser.js:14                   Buffer.allocUnsafe(0)
//
// Both were invisible to `smoke-runtime.mjs`, which builds the identical
// bundle and then imports it *in Node* — where `process` and `Buffer` are
// real.  That script's header claims it "runs the SAME pipeline the browser
// runtime worker runs"; true of the pipeline, false of the REALM, and the
// realm is the only dimension these bugs live in.
//
// So: same bundle, same pipeline, evaluated against the globals a worker
// actually has (measured — see `measure-worker-globals.mjs`).
//
// WHAT THIS IS NOT
// ----------------
// A vm context is not a worker.  There is no `fetch`, no WASM-backed
// PGlite, no structured clone, no DOM.  This proves ONE property —
// "the module graph evaluates against a browser-shaped global set" —
// and deliberately nothing about runtime behaviour.  It also cannot catch
// a global read LATER (first request, first `/metrics` scrape; that is how
// the `setImmediate` gap behaved).  The real Bundle→Boot→dispatch spec
// (`web/e2e/runtime.spec.ts`) stays the authority for all of that.
// Do not grow this into a claim of parity — that claim is what let the two
// bugs above ship.

import vm from "node:vm";
import { Buffer as BufferPolyfill } from "buffer";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SNAPSHOT = require("./worker-globals.json");

// Globals the WORKER ITSELF installs before `await import(blobUrl)` — the
// realm the bundle actually gets is the browser's PLUS these.  Each entry
// must correspond to a side-effect polyfill import at the top of
// `runtime/runtime.worker.ts`; `worker-realm-model.test.ts` fails if that
// file grows one this doesn't model, which is the anti-drift device.  Model
// them by REUSING the same implementation the polyfill installs, so the two
// can't silently diverge.
export const WORKER_INSTALLED_GLOBALS = {
  // ../buffer-polyfill → `globalThis.Buffer = require("buffer").Buffer`
  Buffer: BufferPolyfill,
};

/** Build a vm context exposing the globals a real worker has (measured) plus
 *  the ones the runtime worker installs for itself.  Everything else simply
 *  doesn't exist, which is the point. */
export function createWorkerRealm() {
  const sandbox = Object.create(null);
  for (const name of SNAPSHOT.names) {
    // `globalThis`/`self` are wired to the sandbox itself below.
    if (name === "globalThis" || name === "self") continue;
    const host = /** @type {Record<string, unknown>} */ (globalThis)[name];
    if (host !== undefined) sandbox[name] = host;
  }
  Object.assign(sandbox, WORKER_INSTALLED_GLOBALS);
  const ctx = vm.createContext(sandbox);
  // A worker's `self` and `globalThis` both point at its own scope; the
  // process shim in `postprocess.ts` assigns through `globalThis`.
  vm.runInContext("globalThis.self = globalThis;", ctx);
  return ctx;
}

/** Which of the Node globals we've been bitten by are absent here.  Used by
 *  callers to report what the realm is actually enforcing, so a regression
 *  that quietly re-admits one is visible rather than assumed. */
export function absentNodeGlobals(ctx) {
  // `Buffer` is deliberately NOT listed: the worker installs it (see
  // WORKER_INSTALLED_GLOBALS), so its presence is correct, not a leak.
  return ["process", "setImmediate", "require", "module", "__dirname"].filter(
    (n) => vm.runInContext(`typeof ${n}`, ctx) === "undefined",
  );
}

/**
 * Evaluate `code` (a post-processed ESM bundle) in a worker-shaped realm.
 * Returns the module namespace on success; throws with the underlying
 * evaluation error otherwise — which is the same error the browser would
 * have surfaced as "Bundle import failed: …".
 */
export async function evaluateInWorkerRealm(code, { filename = "bundle.mjs" } = {}) {
  if (typeof vm.SourceTextModule !== "function") {
    throw new Error(
      "worker-realm: vm.SourceTextModule unavailable — run node with " +
        "--experimental-vm-modules (see the `realm:check` npm script).",
    );
  }
  const context = createWorkerRealm();
  const mod = new vm.SourceTextModule(code, {
    context,
    identifier: filename,
    // `postProcessNpmBundle` rewrites every `import.meta.url` to a literal,
    // but keep this defined so a stray `import.meta` can't crash linking.
    initializeImportMeta: (meta) => {
      meta.url = `file:///${filename}`;
    },
  });
  await mod.link((specifier) => {
    // A backend bundle is fully self-contained (esbuild `bundle: true`, no
    // externalised react/tailwind on this path).  An external import means
    // the bundling contract changed — surface it rather than stubbing it,
    // because the worker's `import()` would have to resolve it for real.
    throw new Error(
      `worker-realm: unexpected external import ${JSON.stringify(specifier)} — ` +
        "a backend bundle is expected to be self-contained.",
    );
  });
  await mod.evaluate();
  return mod.namespace;
}
