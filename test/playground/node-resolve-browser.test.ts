import { describe, expect, it } from "vitest";
import { resolveBare, type FileSource } from "../../web/src/engine/node-resolve.js";

// ---------------------------------------------------------------------------
// Browser-condition resolution in the legacy `main` / `browser` package
// shape — pino, ws, node-fetch, and similar predate the modern `exports`
// map and ship a top-level `browser` field instead.  Without honouring
// it the playground bundle imports the Node entry (pino.js → sonic-boom
// → node:util.inherits), which crashes at module init in the worker.
// ---------------------------------------------------------------------------

function makeSrc(files: Record<string, string>): FileSource {
  return {
    read: (p) => (p in files ? files[p] : undefined),
    exists: (p) => p in files,
  };
}

describe("resolveBare — legacy `browser` field", () => {
  it("prefers `browser` over `main` when conditions include `browser` (pino's shape)", () => {
    // Mirrors pino@9's package.json — `main: "pino.js"` +
    // `browser: "./browser.js"`, no `exports`.  The browser entry must
    // win so the bundle skips sonic-boom entirely.
    const src = makeSrc({
      "/node_modules/pino/package.json": JSON.stringify({
        name: "pino",
        main: "pino.js",
        browser: "./browser.js",
      }),
      "/node_modules/pino/pino.js": "// node entry",
      "/node_modules/pino/browser.js": "// browser entry",
    });
    expect(resolveBare("pino", src, "/node_modules", ["browser", "import", "default"])).toBe(
      "/node_modules/pino/browser.js",
    );
  });

  it("falls back to `main` when the conditions list omits `browser`", () => {
    // Backend-style bundle (no `browser` condition) — the legacy
    // resolver picks `main` so production Node behaviour stays put.
    const src = makeSrc({
      "/node_modules/pino/package.json": JSON.stringify({
        name: "pino",
        main: "pino.js",
        browser: "./browser.js",
      }),
      "/node_modules/pino/pino.js": "// node entry",
      "/node_modules/pino/browser.js": "// browser entry",
    });
    expect(resolveBare("pino", src, "/node_modules", ["import", "default"])).toBe(
      "/node_modules/pino/pino.js",
    );
  });

  it("ignores `browser` when only `main` is declared", () => {
    // Defensive: a package with no browser field still resolves cleanly
    // under browser-conditions — the resolver doesn't manufacture a
    // browser entry that doesn't exist.
    const src = makeSrc({
      "/node_modules/something/package.json": JSON.stringify({
        name: "something",
        main: "index.js",
      }),
      "/node_modules/something/index.js": "// node entry",
    });
    expect(resolveBare("something", src, "/node_modules", ["browser", "import", "default"])).toBe(
      "/node_modules/something/index.js",
    );
  });

  it("`exports` still wins when present (pino's brand-new shape would land here)", () => {
    // Modern packages with `exports` route through the conditions
    // map BEFORE the legacy fallback ever runs — verifying the
    // legacy-`browser` addition doesn't accidentally bypass an
    // explicit `exports` map.
    const src = makeSrc({
      "/node_modules/modern/package.json": JSON.stringify({
        name: "modern",
        main: "node.js",
        browser: "./browser-legacy.js",
        exports: {
          ".": {
            browser: "./browser-exports.js",
            default: "./node.js",
          },
        },
      }),
      "/node_modules/modern/browser-exports.js": "// exports-map browser",
      "/node_modules/modern/browser-legacy.js": "// legacy browser",
      "/node_modules/modern/node.js": "// node",
    });
    expect(resolveBare("modern", src, "/node_modules", ["browser", "import", "default"])).toBe(
      "/node_modules/modern/browser-exports.js",
    );
  });
});
