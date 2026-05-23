import { describe, expect, it } from "vitest";
import { postProcessNpmBundle } from "../../web/src/engine/npm/postprocess.js";

// ---------------------------------------------------------------------------
// Guards on the bundle post-processor.  The smoke runs in Node where
// `process` exists; the runtime worker runs in a browser thread where it
// doesn't.  These tests pin the contract:
//   - the function still throws when PGlite-specific markers go missing
//     (its original safety net),
//   - the prepended `process` shim is guarded so the smoke's real
//     `process` survives untouched.
// ---------------------------------------------------------------------------

// Minimal "bundle" that satisfies the PGlite-marker preconditions.  The
// postprocessor expects to see `import.meta.url` at least once and the
// pglite-build node-detection idiom at least once — both fixed regexes
// guard against PGlite changing shape silently underneath us.
const VALID_INPUT = [
  `const u = import.meta.url;`,
  `const isNode = typeof process.versions.node == "string";`,
].join("\n");

describe("postProcessNpmBundle", () => {
  it("prepends a guarded `process` shim so the bundle survives a worker context", () => {
    const out = postProcessNpmBundle(VALID_INPUT);
    // The guard is what makes this safe in Node — without it the smoke's
    // real `process` would get clobbered to an `env: {}` placeholder.
    expect(out).toMatch(/if \(typeof process === 'undefined'\)/);
    expect(out).toMatch(/globalThis\.process = \{ env: \{\}, browser: true, versions: \{\} \}/);
    // Shim appears BEFORE the original code — IIFE-style top-of-file
    // install.  Anything that reads `process.env.LOG_LEVEL` at module
    // init in a worker sees the placeholder, not a ReferenceError.
    const shimAt = out.indexOf("globalThis.process");
    const codeAt = out.indexOf("const u =");
    expect(shimAt).toBeGreaterThan(-1);
    expect(codeAt).toBeGreaterThan(shimAt);
  });

  it("still rewrites the PGlite node-detection to `false`", () => {
    const out = postProcessNpmBundle(VALID_INPUT);
    expect(out).not.toMatch(/typeof process\.versions\.node\s*==\s*"string"/);
    // The exact phrase was the safety net's tripwire — confirm the
    // pglite-aware substitution still wins after the prepended shim.
    expect(out).toMatch(/const isNode = false;/);
  });

  it("still rewrites `import.meta.url` to a real jsdelivr base", () => {
    const out = postProcessNpmBundle(VALID_INPUT);
    expect(out).not.toMatch(/import\.meta\.url/);
    expect(out).toMatch(/jsdelivr\.net/);
  });

  it("throws when PGlite's node-detection marker has gone missing", () => {
    // Defensive guard — if @electric-sql/pglite changes its build
    // shape, the postprocessor must fail loudly so the on-disk pattern
    // gets re-verified before the bundle ships a silent regression.
    const broken = `const u = import.meta.url;`;
    expect(() => postProcessNpmBundle(broken)).toThrow(/node-detection pattern not found/);
  });

  it("throws when the bundle has no `import.meta.url` to rewrite", () => {
    const broken = `const isNode = typeof process.versions.node == "string";`;
    expect(() => postProcessNpmBundle(broken)).toThrow(/no `import\.meta\.url`/);
  });
});
