// Bundle post-process for the npm-in-browser engine.
//
// PGlite computes asset URLs as `new URL("./pglite.wasm",
// import.meta.url)`.  When the bundle is loaded from a `blob:` URL in
// the runtime worker, `import.meta.url` is that blob URL and the URL
// constructor throws ("blob: cannot be a base").  Replacing
// `import.meta.url` with a real jsdelivr base fixes it regardless of
// how PGlite was built.
//
// Node-detection is also neutralised.  In a real browser worker
// `typeof process.versions.node` is falsy so PGlite *would* take the
// browser branch on its own — but forcing it (a) guarantees the
// browser path even under any process-shim, and (b) makes node-side
// verification representative of the browser.  The npm tarball keeps
// the detection un-mangled (`typeof process.versions.node ==
// "string"`), so the pattern is stable and readable.

import { pgliteImportMetaUrl } from "../../bundle/plugin.js";

// Matches `typeof process.versions.node == "string"` with flexible
// spacing around `==`.  npm pglite emits this un-mangled.
const NPM_PGLITE_NODE_DETECTION =
  /typeof process\.versions\.node\s*==\s*"string"/g;

// `process` shim prepended to every bundle.  GUARDED: in real Node
// (the smoke script's host) `process.versions.node` is a string, so
// neither branch fires and Node's real process / stdio / cwd / fs
// handles stay intact.  In a browser worker the shim installs so
// generated code's `process.env.LOG_LEVEL ?? "info"` resolves to
// undefined instead of throwing "Can't find variable: process" at
// module init.
//
// WHY THIS IS MORE THAN `{ env: {} }`: the members below are the ones
// our curated dependency tree touches at MODULE-EVALUATION time, where
// no `try`/`catch` in generated code can help.  `prom-client` is the
// sharp edge — `lib/metrics/processStartTime.js` runs
// `process.uptime()` and `lib/metrics/version.js` runs
// `process.version.slice(1)` as top-level statements, so merely
// `import`ing the package (which `obs/metrics.ts` does) threw
// "process.uptime is not a function" and took the whole boot down with
// "Bundle import failed" — the guarded `collectDefaultMetrics()` call
// site never got to run.  Treat any addition here the same way: a
// member is worth shimming when a dependency reads it while its module
// body evaluates.
//
// `versions` stays EMPTY on purpose.  `process.versions.node` is the
// idiom libraries use to pick their Node branch; leaving it absent
// keeps them on the browser path (and is what the PGlite rewrite below
// assumes).  `version` is `""` for the same reason — enough for
// prom-client's `.slice(1).split(".")` to produce harmless NaNs
// instead of throwing, without ever reading as a real Node version.
const PROCESS_SHIM = `(() => {
  const noop = () => {};
  const now = () => (globalThis.performance ? performance.now() : 0);
  const mkStream = (sink) => {
    const s = {
      write: (chunk) => { try { sink(String(chunk).replace(/\\n$/, "")); } catch {} return true; },
      end: noop, flush: noop, destroy: noop,
      on: () => s, once: () => s, off: () => s, removeListener: () => s, emit: () => false,
      fd: 1, isTTY: false, columns: 80, rows: 40, writable: true,
    };
    return s;
  };
  const shim = {
    env: {},
    browser: true,
    versions: {},
    version: "",
    platform: "browser",
    arch: "",
    title: "browser",
    argv: [],
    argv0: "",
    execPath: "",
    pid: 0,
    ppid: 0,
    exitCode: undefined,
    uptime: () => now() / 1000,
    nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
    cwd: () => "/",
    chdir: noop,
    umask: () => 0,
    exit: noop,
    abort: noop,
    emitWarning: noop,
    cpuUsage: () => ({ user: 0, system: 0 }),
    resourceUsage: () => ({}),
    getActiveResourcesInfo: () => [],
    _getActiveHandles: () => [],
    _getActiveRequests: () => [],
    stdin: { on: noop, once: noop, read: () => null, setEncoding: noop, resume: noop, pause: noop },
  };
  shim.hrtime = Object.assign(
    (prev) => {
      const ns = Math.round(now() * 1e6);
      const t = [Math.floor(ns / 1e9), ns % 1e9];
      return prev ? [t[0] - prev[0], t[1] - prev[1]] : t;
    },
    { bigint: () => BigInt(Math.round(now() * 1e6)) },
  );
  shim.memoryUsage = Object.assign(
    () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
    { rss: () => 0 },
  );
  // EventEmitter surface — our own emitted shutdown hook does
  // \`process.on("SIGTERM", …)\`, and pino/sonic-boom register exit
  // handlers.  Each returns the process object so \`.on().on()\` chains.
  for (const m of ["on","once","off","addListener","removeListener","removeAllListeners","prependListener","prependOnceListener","setMaxListeners"]) shim[m] = () => shim;
  shim.emit = () => false;
  shim.listeners = () => [];
  shim.listenerCount = () => 0;
  // stdout/stderr forward to console instead of swallowing, so a
  // generated backend's structured log lines still reach the
  // playground's console-fed log pane.
  shim.stdout = mkStream((s) => console.log(s));
  shim.stderr = mkStream((s) => console.error(s));

  if (typeof process === "undefined") { globalThis.process = shim; return; }
  // Real Node keeps its own process untouched.  Anything else is a
  // PARTIAL process installed by someone else (another shim, a bundler
  // \`define\`) — the case the old \`typeof process === "undefined"\` guard
  // let through, leaving exactly the holes this shim exists to fill.
  if (typeof process.versions?.node === "string") return;
  for (const k of Object.keys(shim)) { if (process[k] === undefined) { try { process[k] = shim[k]; } catch {} } }
})();
`;

// `setImmediate` is a Node global with no browser equivalent, and it is
// reached on the SERVE path rather than at import: prom-client's
// event-loop-lag gauge calls it from its `collect()` hook, so scraping
// `GET /metrics` in the playground threw "setImmediate is not defined"
// once the process shim above let the default collectors register at
// all.  Same class of defect as the process members, same treatment.
const IMMEDIATE_SHIM = `if (typeof setImmediate === "undefined") {
  globalThis.setImmediate = (fn, ...a) => setTimeout(() => fn(...a), 0);
  globalThis.clearImmediate = (h) => clearTimeout(h);
}
`;

export function postProcessNpmBundle(code: string): string {
  const urlHits = (code.match(/import\.meta\.url/g) ?? []).length;
  if (urlHits === 0) {
    throw new Error(
      "postProcessNpmBundle: no `import.meta.url` in the bundle — " +
        "PGlite's asset-URL mechanism changed; re-verify the WASM/data " +
        "injection path before trusting the npm engine's boot.",
    );
  }
  const nodeHits = (code.match(NPM_PGLITE_NODE_DETECTION) ?? []).length;
  if (nodeHits === 0) {
    throw new Error(
      "postProcessNpmBundle: PGlite node-detection pattern not found — " +
        "@electric-sql/pglite's build shape changed; inspect its dist " +
        "and update NPM_PGLITE_NODE_DETECTION before trusting boot.",
    );
  }
  return (
    PROCESS_SHIM +
    IMMEDIATE_SHIM +
    code
      .replace(NPM_PGLITE_NODE_DETECTION, "false")
      .replaceAll("import.meta.url", JSON.stringify(pgliteImportMetaUrl()))
  );
}
