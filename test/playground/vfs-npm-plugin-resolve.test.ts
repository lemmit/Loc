import { describe, expect, it } from "vitest";
import { makeVfsNpmPlugin } from "../../web/src/engine/npm/esbuild-vfs-plugin.js";

// ---------------------------------------------------------------------------
// Contract tests for the in-VFS npm resolver's catch-all `onResolve`.
//
// The arm is a catch-all (`filter: /.*/`), so EVERY specifier esbuild sees
// lands there — including ones that aren't module specifiers at all.  These
// pin the classes that must not fall through to bare-package resolution.
//
// Driven by invoking the registered callback directly rather than running a
// real bundle: the resolver is pure, and the interesting cases are exactly
// the ones where a wrong answer is an error object rather than a build.
// ---------------------------------------------------------------------------

type ResolveArgs = { path: string; importer?: string; resolveDir?: string };
type ResolveResult = {
  path?: string;
  namespace?: string;
  external?: boolean;
  errors?: { text: string }[];
};

type LoadResult = { contents?: string; loader?: string };

/** Register the plugin against a stub `build` and hand back the catch-all
 *  `onResolve` callback plus the node-builtin-stub `onLoad` callback. */
function pluginFor(files: Map<string, string> = new Map()) {
  let onResolve: ((a: ResolveArgs) => ResolveResult) | undefined;
  let onLoadEmpty: ((a: { path: string }) => LoadResult) | undefined;
  const build = {
    onResolve: (_opts: unknown, cb: (a: ResolveArgs) => ResolveResult) => {
      onResolve ??= cb; // the catch-all is registered first
    },
    onLoad: (opts: { namespace?: string }, cb: (a: { path: string }) => LoadResult) => {
      if (opts.namespace === "vfs-empty") onLoadEmpty ??= cb;
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: stub stands in for esbuild's PluginBuild
  makeVfsNpmPlugin(files).setup(build as any);
  if (!onResolve) throw new Error("plugin registered no onResolve");
  if (!onLoadEmpty) throw new Error("plugin registered no vfs-empty onLoad");
  return { resolve: onResolve, loadBuiltin: onLoadEmpty };
}

function resolverFor(files: Map<string, string> = new Map()) {
  return pluginFor(files).resolve;
}

describe("vfs npm plugin — catch-all onResolve", () => {
  // Regression: esbuild routes CSS `url()` tokens through onResolve, so an
  // inlined icon in a bundled stylesheet reached bare-package resolution and
  // failed the whole React bundle with
  //   vfs: bare "data:image/svg+xml,%3Csvg …" not in installed node_modules
  it("passes a `data:` URL through instead of resolving it as a package", () => {
    const dataUrl =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 15 15'%3E%3C/svg%3E";
    const r = resolverFor()({ path: dataUrl, importer: "/app/src/index.css" });
    expect(r.errors).toBeUndefined();
    expect(r.external).toBe(true);
    // Verbatim — a data URI is already self-contained; rewriting it would
    // corrupt the icon.
    expect(r.path).toBe(dataUrl);
  });

  it("passes remote and protocol-relative asset URLs through", () => {
    const resolve = resolverFor();
    for (const url of [
      "https://cdn.test/logo.png",
      "http://cdn.test/logo.png",
      "//cdn.test/logo.png",
    ]) {
      const r = resolve({ path: url, importer: "/app/src/index.css" });
      expect(r.errors, url).toBeUndefined();
      expect(r.external, url).toBe(true);
      expect(r.path, url).toBe(url);
    }
  });

  // Ordering guard: `node:` also matches the URL-scheme shape, so the
  // builtin check has to win or every `node:fs` import would be emitted as
  // an unresolvable external instead of an empty stub.
  it("still stubs `node:`-prefixed builtins rather than treating them as URLs", () => {
    const r = resolverFor()({ path: "node:fs", importer: "/app/src/db.ts" });
    expect(r.external).toBeFalsy();
    expect(r.namespace).toBe("vfs-empty");
  });

  it("still errors on a genuinely missing bare package", () => {
    const r = resolverFor()({ path: "not-installed", importer: "/app/src/x.ts" });
    expect(r.errors?.[0]?.text).toMatch(/bare "not-installed" not in installed node_modules/);
  });
});

describe("vfs npm plugin — node-builtin stubs", () => {
  // `buffer` and `process` must hand back the LIVE globals the runtime
  // worker installs, not a fresh `{}`.  An empty stub makes an explicit
  // `import { Buffer } from "buffer"` resolve to `undefined`, which kills
  // the module on `Buffer.allocUnsafe` exactly as if the global were
  // missing — silently re-opening the hole the polyfill just closed.
  it("backs `buffer` with the live global rather than an empty object", () => {
    const { loadBuiltin } = pluginFor();
    const out = loadBuiltin({ path: "buffer" }).contents ?? "";
    expect(out).toMatch(/globalThis\.Buffer/);
    expect(out).not.toBe("module.exports = {};");
  });

  it("backs `process` with the live global rather than an empty object", () => {
    const { loadBuiltin } = pluginFor();
    const out = loadBuiltin({ path: "process" }).contents ?? "";
    expect(out).toMatch(/globalThis\.process/);
    expect(out).not.toBe("module.exports = {};");
  });

  it("leaves an unremarkable builtin as an empty stub", () => {
    const { loadBuiltin } = pluginFor();
    expect(loadBuiltin({ path: "tls" }).contents).toBe("module.exports = {};");
  });
});
