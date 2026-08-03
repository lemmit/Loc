// Re-measure the browser worker realm and rewrite `worker-globals.json`.
//
// The realm gate (`worker-realm.mjs`) evaluates the generated bundle in a
// `vm` context whose globals are EXACTLY the ones a real DedicatedWorker
// has.  That list must be MEASURED, never hand-curated: a hand list drifts
// as browsers add APIs, and every name wrongly present turns the gate into
// theatre — it would happily accept a bundle that reads a global the real
// worker lacks, which is the entire failure class the gate exists to catch.
//
// Run after a Playwright/Chromium bump, or whenever the gate rejects a
// global you believe a worker genuinely has:
//
//     npm run measure:worker-globals   (from web/)
//
// then review the diff — names APPEARING is routine browser evolution;
// names DISAPPEARING is a real compatibility signal worth reading.

import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("./worker-globals.json", import.meta.url));

// Node globals with no worker equivalent.  Not used to BUILD the realm —
// the measurement does that — but asserted absent from the result, so a
// mis-measurement (e.g. accidentally enumerating the Node scope) fails
// loudly instead of silently producing a permissive realm.
const MUST_BE_ABSENT = [
  "process", "Buffer", "setImmediate", "clearImmediate",
  "require", "module", "__dirname", "__filename", "global",
];

const browser = await chromium.launch({
  executablePath: process.env.LOOM_CHROMIUM_PATH || undefined,
});
try {
  const page = await browser.newPage();
  // Measure from a SECURE CONTEXT.  The playground is served over https, and
  // several worker APIs (`caches`, `crypto.subtle`, …) only exist in a
  // potentially-trustworthy origin — measuring from `data:` silently omits
  // them and yields a realm stricter than production.  `http://localhost` is
  // trustworthy by definition, so route a blank page there rather than
  // standing up a server.
  await page.route("http://localhost/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }),
  );
  await page.goto("http://localhost/");
  const names = await page.evaluate(async () => {
    // Walk the PROTOTYPE CHAIN, not just own properties.  A worker keeps
    // most of its interesting API surface — performance, fetch, location,
    // navigator, crypto, caches, indexedDB — on
    // DedicatedWorkerGlobalScope.prototype / WorkerGlobalScope.prototype,
    // so `getOwnPropertyNames(globalThis)` alone under-reports badly and
    // yields a realm STRICTER than a real worker.  That direction fails
    // loudly (false rejections) rather than silently, but it is still wrong.
    const src = `
      const seen = new Set();
      for (let o = globalThis; o; o = Object.getPrototypeOf(o)) {
        for (const n of Object.getOwnPropertyNames(o)) seen.add(n);
      }
      self.postMessage([...seen]);
    `;
    const url = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
    const w = new Worker(url);
    try {
      return await new Promise((resolve, reject) => {
        w.onmessage = (e) => resolve(e.data);
        w.onerror = (e) => reject(new Error(e.message));
      });
    } finally {
      w.terminate();
      URL.revokeObjectURL(url);
    }
  });

  const leaked = MUST_BE_ABSENT.filter((n) => names.includes(n));
  if (leaked.length > 0) {
    console.error(
      `measure-worker-globals: refusing to write — Node-only names present in ` +
        `the measurement (${leaked.join(", ")}). This means the worker scope was ` +
        `not what was enumerated; fix the probe rather than the expectation.`,
    );
    process.exit(1);
  }

  const version = browser.version();
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        _comment:
          "MEASURED from a real DedicatedWorker — do not hand-edit. " +
          "Regenerate with `npm run measure:worker-globals`.",
        chromium: version,
        count: names.length,
        names: [...names].sort(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${names.length} globals (chromium ${version}) → ${OUT}`);
} finally {
  await browser.close();
}
