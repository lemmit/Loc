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
    // real `process` would get clobbered by the browser placeholder.
    expect(out).toMatch(/if \(typeof process === "undefined"\) \{ globalThis\.process = shim/);
    // Shim appears BEFORE the original code — IIFE-style top-of-file
    // install.  Anything that reads `process.env.LOG_LEVEL` at module
    // init in a worker sees the placeholder, not a ReferenceError.
    const shimAt = out.indexOf("globalThis.process");
    const codeAt = out.indexOf("const u =");
    expect(shimAt).toBeGreaterThan(-1);
    expect(codeAt).toBeGreaterThan(shimAt);
  });

  // Regression: `prom-client` reads these at MODULE-EVALUATION time
  // (`lib/metrics/processStartTime.js` → `process.uptime()`;
  // `lib/metrics/version.js` → `process.version.slice(1)`), so a shim
  // missing them takes the whole boot down with "Bundle import failed:
  // process.uptime is not a function" — before `obs/metrics.ts`'s
  // `try { collectDefaultMetrics() }` can catch anything.
  it("shims the `process` members our dependency tree reads at module init", () => {
    const shim = evalShim(postProcessNpmBundle(VALID_INPUT));
    expect(typeof shim.uptime()).toBe("number");
    // `.slice(1)` must not throw, and must not read as a real Node version.
    expect(typeof shim.version).toBe("string");
    expect(shim.version.slice(1).split(".").map(Number)).toHaveLength(1);
    expect(typeof shim.hrtime()[0]).toBe("number");
    expect(typeof shim.hrtime.bigint()).toBe("bigint");
    expect(shim.memoryUsage().heapUsed).toBe(0);
    expect(shim.cpuUsage().user).toBe(0);
    expect(shim.getActiveResourcesInfo()).toEqual([]);
    // `.on()` chains (our emitted shutdown hook, pino's exit handlers).
    expect(shim.on("SIGTERM", () => {})).toBe(shim);
    expect(shim.stdout.write("x")).toBe(true);
  });

  // `process.versions.node` is how libraries pick their Node branch —
  // and how PGlite's rewritten detection would have picked it. The shim
  // must never make the browser look like Node.
  it("leaves `versions` empty so libraries take their browser branch", () => {
    const shim = evalShim(postProcessNpmBundle(VALID_INPUT));
    expect(shim.versions.node).toBeUndefined();
    expect(shim.browser).toBe(true);
  });

  it("fills the gaps in a PARTIAL pre-existing process instead of bailing", () => {
    // The old guard bailed whenever `process` merely existed, so a
    // foreign `{ env: {} }` shim left every hole open.
    const partial: Record<string, unknown> = { env: { A: "1" }, versions: {} };
    runShim(postProcessNpmBundle(VALID_INPUT), partial);
    expect(partial.env).toEqual({ A: "1" }); // pre-existing member kept
    expect(typeof partial.uptime).toBe("function"); // hole filled
  });

  it("leaves a real Node `process` completely untouched", () => {
    const real: Record<string, unknown> = { versions: { node: "24.0.0" }, env: {} };
    runShim(postProcessNpmBundle(VALID_INPUT), real);
    expect(real.uptime).toBeUndefined();
    expect(Object.keys(real).sort()).toEqual(["env", "versions"]);
  });
  // Reached on the SERVE path, not at import: prom-client's event-loop-lag
  // gauge calls `setImmediate` from its `collect()` hook, so `GET /metrics`
  // threw "setImmediate is not defined" once the process shim let the
  // default collectors register at all.
  it("polyfills `setImmediate` for the browser", () => {
    const out = postProcessNpmBundle(VALID_INPUT);
    expect(out).toMatch(/if \(typeof setImmediate === "undefined"\)/);
    expect(out).toMatch(/globalThis\.setImmediate = /);
    expect(out.indexOf("setImmediate")).toBeLessThan(out.indexOf("const u ="));
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

/** Run just the prepended shim IIFE against a supplied `process` (or
 *  none), returning whatever `globalThis.process` ends up as.  The shim
 *  is the bundle's first statement, so slicing to the `})();` that
 *  closes it isolates it from the PGlite-rewritten body. */
function runShim(out: string, existing?: Record<string, unknown>): Record<string, unknown> {
  const close = "})();";
  const shimSrc = out.slice(0, out.indexOf(close) + close.length);
  const sandbox: Record<string, unknown> = { performance, console, queueMicrotask, BigInt };
  if (existing) sandbox.process = existing;
  new Function("globalThis", `const process = globalThis.process; ${shimSrc}`)(sandbox);
  return (existing ?? sandbox.process) as Record<string, unknown>;
}

// biome-ignore lint/suspicious/noExplicitAny: the test reads arbitrary shim members
function evalShim(out: string): any {
  return runShim(out);
}
