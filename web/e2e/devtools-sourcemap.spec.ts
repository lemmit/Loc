// Tier-1 CDP source-map gate: proves the playground's in-browser Hono
// backend — the module the runtime worker actually `import()`s from a
// `blob:` URL (`src/runtime/runtime.worker.ts`'s `boot()`) — carries an
// inline Source Map v3 that chains back to a `.ddd` source, with real
// `sourcesContent` DevTools could display.  This is the "the debugger can
// see `.ddd`" gate for PR #1845's feature, run in a real Chromium, and it
// de-risks whether esbuild-**wasm** (the in-browser bundler) composes the
// map chain the same way node esbuild did when the feature was built.
//
// ## Why this is the fallback path, not literal `Debugger.scriptParsed`
//
// The original design (see the build brief) was to attach a raw CDP
// session to the runtime worker, enable `Debugger`, and read
// `scriptParsed.sourceMapURL` for the blob-imported module directly.  That
// was attempted for real against this exact Chromium build (Chrome for
// Testing 147/149) and is NOT achievable through Playwright's public Test
// API, for a structural reason (verified empirically, not assumed):
//
//   - `context.newCDPSession(target)` only accepts a `Page` or `Frame` —
//     passing a `Worker` throws ("page: expected Page or Frame"); Playwright
//     never exposes a way to mint a CDPSession bound to a Worker target.
//   - Falling back to `Target.setAutoAttach({flatten: true})` on the page's
//     own CDPSession DOES deliver `Target.attachedToTarget` for the worker
//     (confirmed live — the event carries the worker's `sessionId` and its
//     `blob:` URL).  But every *subsequent* protocol message for that child
//     session — including `Debugger.scriptParsed` — arrives on the
//     underlying connection tagged with the CHILD's `sessionId`, and
//     Playwright's `CDPSession` object is a 1:1 wrapper around exactly ONE
//     server-side session (the page's).  There is no public API to
//     register/demux the child session, so those messages are silently
//     unroutable from test code — confirmed by instrumenting every event on
//     the page session and observing zero worker-tagged `Debugger.*`
//     traffic reach it.
//   - The legacy `Target.sendMessageToTarget` wrapper (which routes replies
//     back through the PARENT session, sidestepping the demux problem) is
//     also a dead end on current Chrome: it rejects auto-attached flat
//     sessions outright ("No session with given id") since flat auto-attach
//     sessions were never registered for the legacy wrapper.
//
// So a literal `Debugger.scriptParsed`-based Tier-1 gate is out of reach
// without either (a) a raw external CDP connection to the browser's
// debugging endpoint (bypassing Playwright's session wrapper entirely —
// heavy, and Playwright launches Chromium over a pipe transport with no
// stable debugging port to dial), or (b) upstream Playwright support for
// CDP sessions on Worker targets (tracked as the Tier-2 follow-up below).
//
// ## What this test does instead
//
// It still runs the full real-browser cascade (Generate → Bundle → Boot)
// and still inspects the EXACT bytes handed to the worker's module import —
// just one layer below "the debugger attached".  `context.addInitScript`
// (well-supported for the page's main-thread realm, unlike worker
// injection) installs a `Worker.prototype.postMessage` interceptor before
// any app code runs.  The runtime worker is a real `Worker` instance
// (`src/runtime/client.ts`'s `LoomRuntimeClient`), and Boot sends it exactly
// one `{ method: "boot", params: { bundleCode, ... } }` message
// (`src/runtime/protocol.ts`'s `BootRequest`) — the interceptor captures
// `bundleCode` verbatim.  That string is byte-identical to what
// `runtime.worker.ts`'s `boot()` wraps in a `Blob` and `import()`s — so
// decoding its trailing inline map is decoding the map of the module that
// actually becomes the running backend, not a proxy for it.
//
// Tier 2 (set a real breakpoint in the worker and assert `Debugger.paused`)
// stays out of scope, per the design brief, and is the natural pickup point
// once either escape hatch above exists.
import { expect, test } from "@playwright/test";
import { browserCanReachNetwork, selectExample, waitForPlaygroundReady } from "./_helpers";

interface DecodedMap {
  version: number;
  sources: string[];
  sourcesContent?: Array<string | null>;
}

// The hono bundle's trailing directives (postProcessNpmBundle leaves them
// untouched, see `src/engine/npm/postprocess.ts`) are, in order:
//   //# sourceMappingURL=data:application/json;base64,<...>
//   //# sourceURL=loom://backend.js
// — i.e. the sourceMappingURL comment is NOT necessarily the last line, so
// search the whole text for the last match rather than anchoring at EOF.
// Handles both esbuild's own base64 form and a plain URL-encoded `data:`
// form defensively (the brief calls out both as possible encodings).
const SOURCE_MAPPING_URL_RE =
  /\/\/#\s*sourceMappingURL=data:application\/json(?:;charset=[^;,]+)?(;base64)?,(\S+)/g;

function decodeTrailingInlineSourceMap(bundleCode: string): DecodedMap {
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  // Reset lastIndex since the regex is `g`-flagged and module-scoped.
  SOURCE_MAPPING_URL_RE.lastIndex = 0;
  while ((match = SOURCE_MAPPING_URL_RE.exec(bundleCode)) !== null) {
    last = match;
  }
  if (!last) {
    throw new Error(
      `No inline "//# sourceMappingURL=data:application/json..." directive found in the ` +
        `captured bundle (length ${bundleCode.length}).  Tail 300 chars:\n` +
        bundleCode.slice(-300),
    );
  }
  const [, isBase64, payload] = last;
  const json = isBase64
    ? Buffer.from(payload, "base64").toString("utf8")
    : decodeURIComponent(payload);
  return JSON.parse(json) as DecodedMap;
}

test("running Hono backend module carries an inline source map reaching .ddd", async ({
  page,
  context,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  // Installed before any app script runs (context-level init script), so it
  // is in place for the runtime worker's construction regardless of exactly
  // when `LoomRuntimeClient`'s lazy `new Worker(...)` fires relative to the
  // React app mounting.  Captures the `bundleCode` argument of the single
  // "boot" RPC the engine posts to the worker (`src/engine/
  // npm-install-bundle-engine.ts`'s `boot()` → `LoomRuntimeClient.boot()` →
  // `worker.postMessage({ id, method: "boot", params: { bundleCode, ... } })`
  // in `src/runtime/client.ts`) — i.e. the literal text `runtime.worker.ts`
  // turns into a `Blob` and `import()`s.
  await context.addInitScript(() => {
    const w = window as unknown as { __capturedBundleCode?: string };
    const OrigWorker = Worker;
    const origPostMessage = OrigWorker.prototype.postMessage;
    OrigWorker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      ...rest: unknown[]
    ) {
      try {
        const req = message as { method?: string; params?: { bundleCode?: unknown } };
        if (
          req &&
          typeof req === "object" &&
          req.method === "boot" &&
          typeof req.params?.bundleCode === "string"
        ) {
          w.__capturedBundleCode = req.params.bundleCode;
        }
      } catch {
        // best-effort — never let the interceptor break the real call
      }
      // eslint-disable-next-line prefer-rest-params
      return origPostMessage.apply(this, [message, ...rest] as Parameters<
        typeof origPostMessage
      >);
    };
  });

  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  if (!(await browserCanReachNetwork(page))) {
    test.skip(true, "browser cannot reach the npm registry from this environment");
  }

  await test.step("Generate", async () => {
    await page.getByTestId("btn-generate").click();
    await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({ timeout: 60_000 });
  });

  await test.step("Bundle", async () => {
    await page.getByTestId("btn-bundle").click();
    await expect(
      page.getByText(/bundled [\d.]+ [KM]?B in \d+ ms \(\d+ deps fetched\)/),
    ).toBeVisible({ timeout: 600_000 });
  });

  const bundleCode = await test.step("Post the boot RPC and capture its bundle bytes", async () => {
    // We deliberately do NOT wait for `backend-status` to reach "booted".
    // Clicking Boot posts exactly one `{ method: "boot", params: {
    // bundleCode } }` to the runtime worker (captured by the init-script
    // interceptor); that `bundleCode` is the literal text the worker wraps
    // in a Blob and `import()`s.  Whether the backend then finishes booting
    // is a SEPARATE concern — it depends on PGlite's WASM/.data fetch from
    // jsdelivr, which is orthogonal to the source-map question this gate
    // asks and unreachable in some sandboxes.  The map is present in the
    // bytes the instant they're posted, so capturing that is sufficient and
    // strictly more focused than gating on a live PGlite boot.
    await page.getByTestId("devtools-tab-backend").click();
    await page.getByTestId("btn-boot").click();
    // Bounded poll: the interceptor writes synchronously inside
    // `postMessage`, so this typically resolves on the first tick.
    let captured: string | undefined;
    for (let i = 0; i < 120; i++) {
      captured = await page.evaluate(
        () => (window as unknown as { __capturedBundleCode?: string }).__capturedBundleCode,
      );
      if (captured) break;
      await page.waitForTimeout(500);
    }
    if (!captured) {
      console.log(
        `[devtools-sourcemap] captured console/page errors:\n` +
          consoleErrors.map((m) => `  ${m.slice(0, 300)}`).join("\n"),
      );
      throw new Error(
        "Worker.postMessage interceptor never captured a boot bundleCode within 60s " +
          "— either clicking Boot didn't post a boot RPC, or the interceptor " +
          "missed the window before the worker was constructed.",
      );
    }
    return captured;
  });

  await test.step("Decode the trailing inline map and assert it reaches .ddd", async () => {
    let map: DecodedMap;
    try {
      map = decodeTrailingInlineSourceMap(bundleCode);
    } catch (e) {
      console.log(
        `[devtools-sourcemap] captured bundle length=${bundleCode.length}; decode failed: ${(e as Error).message}`,
      );
      throw e;
    }

    expect(map.version, "source map version").toBe(3);
    expect(Array.isArray(map.sources), "map.sources is an array").toBe(true);

    const dddIndex = map.sources.findIndex((s) => s.endsWith(".ddd"));
    if (dddIndex === -1) {
      console.log(
        `[devtools-sourcemap] map.sources (${map.sources.length} entries):\n` +
          map.sources.slice(0, 40).join("\n"),
      );
    }
    expect(dddIndex, "a .ddd entry in map.sources").toBeGreaterThanOrEqual(0);

    const dddSource = map.sources[dddIndex];
    const content = map.sourcesContent?.[dddIndex];
    console.log(`[devtools-sourcemap] running backend module maps to: ${dddSource}`);
    console.log(
      `[devtools-sourcemap] sourcesContent snippet (first 200 chars):\n` +
        (content ?? "<missing>").slice(0, 200),
    );

    expect(Array.isArray(map.sourcesContent), "map.sourcesContent is present").toBe(true);
    expect(typeof content, `sourcesContent for ${dddSource} is a string`).toBe("string");
    expect((content ?? "").length, `sourcesContent for ${dddSource} is non-empty`).toBeGreaterThan(
      0,
    );
  });
});
