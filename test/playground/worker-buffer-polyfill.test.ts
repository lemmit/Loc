import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// A worker has its OWN global scope, so `main.tsx`'s `Buffer` polyfill does
// nothing inside the runtime worker.  The generated bundle the worker imports
// reads `Buffer` while pg-protocol's module bodies evaluate:
//
//   pg-protocol/dist/parser.js:14   const emptyBuffer = Buffer.allocUnsafe(0)
//   pg-protocol/dist/serializer.js:112, b.js:9   — same shape
//
// `pg` is pinned by both Hono backends, so the generated backend bundles it
// even though the playground's live path is PGlite.  Without the polyfill,
// `await import(bundleUrl)` threw before a line of generated code ran:
//
//   Bundle import failed: Can't find variable: Buffer
//
// This is a SOURCE-ORDER contract, not a behavioural one — the polyfill has to
// run before the bundle import, and the only thing that can break it is
// someone reordering or dropping the import.  So the test reads the source.
// ---------------------------------------------------------------------------

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../web/src/${rel}`, import.meta.url)), "utf8");

/** Import specifiers in source order, ignoring comments and `import type`. */
function importOrder(src: string): string[] {
  return [...src.matchAll(/^import\s+(?!type\b)[^;]*?["']([^"']+)["'];/gm)].map((m) => m[1]);
}

describe("runtime worker Buffer polyfill", () => {
  it("imports the polyfill, and imports it FIRST", () => {
    const order = importOrder(read("runtime/runtime.worker.ts"));
    expect(order).toContain("../buffer-polyfill");
    // First is what matters: a later position lets a sibling module's body
    // (or its transitive imports) run before the global exists.
    expect(order[0]).toBe("../buffer-polyfill");
  });

  it("the main thread keeps its own copy — separate realm, separate global", () => {
    expect(importOrder(read("main.tsx"))[0]).toBe("./buffer-polyfill");
  });

  it("the polyfill installs the global without clobbering an existing one", () => {
    const src = read("buffer-polyfill.ts");
    expect(src).toMatch(/import \{ Buffer \} from "buffer"/);
    expect(src).toMatch(/typeof g\.Buffer === "undefined"/);
    expect(src).toMatch(/g\.Buffer = Buffer/);
  });
});
