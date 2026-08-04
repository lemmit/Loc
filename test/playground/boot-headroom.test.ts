import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Boot headroom on mobile.
//
// A field report (`died-in-phase`, `pane: boot:ddl`) put the kill inside the
// first SQL statement of the boot — which is where PGlite actually starts
// Postgres, because `new PGlite(...)` is lazy:
//
//   constructor 0.7 ms | FIRST exec 5469 ms | second exec 5.9 ms   (0.4.5)
//
// The generated DDL for that exact source is 9 statements / 1 KB, so the SQL
// is not the cost — the WASM startup is.  Meanwhile the bundler worker is
// still holding an esbuild context per build key, each pinning the entire
// installed npm VFS (~8.8k files) for fast rebuilds.  Releasing it before
// boot hands that memory back at the peak.
//
// The wiring is what matters and it is easy to break silently (drop the call,
// or "simplify" away the desktop guard and regress rebuild speed there), so
// these read the source.  There is no behavioural assertion available here:
// the payoff is memory on a device we cannot instrument from CI.
// ---------------------------------------------------------------------------

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../web/src/${rel}`, import.meta.url)), "utf8");

describe("mobile boot headroom", () => {
  it("releases the bundler between bundle and boot, on mobile only", () => {
    const src = read("App.tsx");
    const call = /if \(!isDesktop\) engineRef\.current\?\.releaseBundler\?\.\(\);/;
    expect(src).toMatch(call);

    // Order is the whole point: after the bundle result is in hand, before
    // the boot that needs the headroom.  Releasing earlier would fight the
    // bundle; later would be useless.
    const bundleAt = src.indexOf("if (!bundleRes?.hono.ok) return;");
    const releaseAt = src.search(call);
    const bootAt = src.indexOf("const booted = await runBootStep(bundleRes.hono);");
    expect(bundleAt).toBeGreaterThan(-1);
    expect(bootAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(bundleAt);
    expect(releaseAt).toBeLessThan(bootAt);
  });

  it("clears the field so the next bundle lazily respawns a worker", () => {
    // `dispose()` latches the client dead — without nulling the field the
    // engine would keep handing out a disposed bundler and every later
    // bundle would fail with "Bundler disposed".
    const src = read("engine/npm-install-bundle-engine.ts");
    const body = src.slice(src.indexOf("releaseBundler()"));
    expect(body).toMatch(/this\.vfsBundler\?\.dispose\(\);/);
    expect(body).toMatch(/this\.vfsBundler = null;/);
    // The lazy re-create it relies on.
    expect(src).toMatch(/this\.vfsBundler \?\?= new VfsBundlerClient\(\);/);
  });

  it("keeps `releaseBundler` optional on the engine contract", () => {
    // Not every engine bundles in-browser; the call site uses `?.` so an
    // engine without one is simply unaffected.
    expect(read("engine/runtime-engine.ts")).toMatch(/releaseBundler\?\(\): void;/);
  });
});
