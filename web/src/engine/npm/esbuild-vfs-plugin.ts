// esbuild plugin resolving over the installed in-VFS node_modules.
// Generated project files AND installed packages live in one file
// map; bare specifiers go through the exports-aware node resolver
// (node-resolve.ts), relatives/absolutes probe the map directly.
// Reading each package's own published files (no CDN re-build) is
// what makes the drizzle `extractUsedTable` split-shard bug class
// impossible.

import type { Loader, Plugin } from "esbuild-wasm";
import { resolveBare, type FileSource } from "../node-resolve.js";
import type { TsconfigAliasEntry } from "../../bundle/plugin.js";
import { aliasCandidates } from "../../bundle/plugin.js";

const NS = "vfs";
const EMPTY = "vfs-empty";
const EMPTY_CSS = "vfs-empty-css";

// Node builtins the curated backend may reference in branches the
// browser/PGlite path never takes (the `pg` driver tree etc.).
// Stubbed so the bundle stays self-contained and builds; B4 verifies
// the live browser entry never actually needs one.
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster",
  "console", "constants", "crypto", "dgram", "diagnostics_channel",
  "dns", "domain", "events", "fs", "http", "http2", "https",
  "inspector", "module", "net", "os", "path", "perf_hooks",
  "process", "punycode", "querystring", "readline", "repl",
  "stream", "string_decoder", "sys", "timers", "tls", "trace_events",
  "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/** A node builtin: `node:*`, an exact name, or a subpath like
 *  `fs/promises` / `stream/promises` (head segment is a builtin). */
function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith("node:")) return true;
  return NODE_BUILTINS.has(spec.split("/")[0]);
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function joinPosix(...parts: string[]): string {
  const segs: string[] = [];
  for (const part of parts.join("/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return "/" + segs.join("/");
}

const EXTS = [".ts", ".tsx", ".mjs", ".js", ".cjs", ".json"];
const INDEX = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"];

function probe(base: string, src: FileSource): string | null {
  if (src.exists(base)) return base;
  // Generated TS uses `.js`-suffixed ESM specifiers for `.ts` files.
  if (base.endsWith(".js")) {
    for (const e of [".ts", ".tsx"]) {
      const p = base.slice(0, -3) + e;
      if (src.exists(p)) return p;
    }
  }
  for (const e of EXTS) if (src.exists(base + e)) return base + e;
  for (const i of INDEX) {
    const p = joinPosix(base, i);
    if (src.exists(p)) return p;
  }
  return null;
}

/** Keep react/react-dom (and their subpaths: jsx-runtime,
 *  react-dom/client, …) external so the iframe importmap supplies a
 *  single instance.  Must be done IN the plugin: esbuild's `external`
 *  option is overridden by this catch-all onResolve, so relying on it
 *  alone silently bundles a second React. */
const REACT_RUNTIME_RE = /^(react|react-dom)(\/|$)/;

// shadcn globals.css does `@import "tailwindcss"` (+ optionally
// `@import "tw-animate-css"`).  esbuild's CSS loader would try to
// resolve those into JS (tailwindcss/dist/lib.mjs) and fail; instead
// leave them external so the directive survives into the bundled CSS,
// where the iframe's `@tailwindcss/browser` compiles it at runtime.
const TAILWIND_CSS_RE = /^tailwindcss($|\/)|^tw-animate-css$/;

export function makeVfsNpmPlugin(
  files: Map<string, string | Uint8Array>,
  nmRoot = "/node_modules",
  externalReact = false,
  /** tsconfig `paths` aliases (e.g. shadcn's `@/* → src/*`).  Targets
   *  are absolute VFS paths (harvested against the "/"-keyed map);
   *  matched before bare-package resolution so `@/components/ui/button`
   *  resolves to a real file instead of being treated as a package. */
  aliases: TsconfigAliasEntry[] = [],
  /** C2: externalise the whole vendor (every bare specifier left
   *  after aliases) so esbuild bundles ONLY the generated app —
   *  the prebuilt vendor + iframe importmap supply the rest.  Bare
   *  CSS imports (e.g. `@mantine/core/styles.css`) become empty
   *  stubs since the prebuilt vendor.css covers them. */
  externalizeVendor = false,
): Plugin {
  const td = new TextDecoder();
  const asText = (v: string | Uint8Array): string =>
    typeof v === "string" ? v : td.decode(v);
  const src: FileSource = {
    read: (p) => {
      const v = files.get(p);
      return v == null ? undefined : asText(v);
    },
    exists: (p) => files.has(p),
  };

  return {
    name: "loom-vfs-npm",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path;
        if (TAILWIND_CSS_RE.test(spec)) {
          // Keep `@import "tailwindcss"` in the output CSS for the
          // iframe's Tailwind browser runtime to compile.
          return { path: spec, external: true };
        }
        if (externalReact && REACT_RUNTIME_RE.test(spec)) {
          return { path: spec, external: true };
        }
        if (isNodeBuiltin(spec)) {
          return { path: spec, namespace: EMPTY };
        }
        if (spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../")) {
          const fromDir =
            args.importer && args.importer.startsWith("/")
              ? dirOf(args.importer)
              : args.resolveDir || "/";
          const abs = spec.startsWith("/")
            ? joinPosix(spec)
            : joinPosix(fromDir, spec);
          const r = probe(abs, src);
          return r
            ? { path: r, namespace: NS }
            : { errors: [{ text: `vfs: cannot resolve ${spec} from ${args.importer || "<entry>"}` }] };
        }
        // tsconfig path aliases (`@/...`) before bare resolution.
        for (const a of aliases) {
          const candidates = aliasCandidates(spec, a);
          if (!candidates) continue;
          for (const c of candidates) {
            const hit = probe(c, src);
            if (hit) return { path: hit, namespace: NS };
          }
        }
        const r = resolveBare(spec, src, nmRoot);
        if (r) return { path: r, namespace: NS };
        // Vendor-externalise: a bare specifier with no app-side
        // resolution is vendor — externalise it (JS) or stub it
        // (CSS, covered by the prebuilt vendor.css).  esbuild then
        // bundles only the app; the iframe importmap resolves these.
        if (externalizeVendor) {
          return spec.endsWith(".css")
            ? { path: spec, namespace: EMPTY_CSS }
            : { path: spec, external: true };
        }
        return { errors: [{ text: `vfs: bare "${spec}" not in installed node_modules` }] };
      });

      build.onLoad({ filter: /.*/, namespace: EMPTY_CSS }, () => ({
        contents: "",
        loader: "css",
      }));

      build.onLoad({ filter: /.*/, namespace: EMPTY }, (args) => {
        const name = args.path.replace(/^node:/, "").split("/")[0];
        // crypto is the one builtin the live browser/PGlite backend
        // path actually uses (generated repos call randomUUID for
        // ids).  Back it by Web Crypto.  CJS form so esbuild does
        // runtime property access — no static "no matching export"
        // for arbitrary named imports from the empty stubs.
        if (name === "crypto") {
          return {
            contents: [
              "const c = globalThis.crypto;",
              "const randomUUID = () => c.randomUUID();",
              "const getRandomValues = (a) => c.getRandomValues(a);",
              "const randomBytes = (n) => c.getRandomValues(new Uint8Array(n));",
              "module.exports = { randomUUID, getRandomValues, randomBytes, webcrypto: c, default: c };",
            ].join("\n"),
            loader: "js",
          };
        }
        return { contents: "module.exports = {};", loader: "js" };
      });

      build.onLoad({ filter: /.*/, namespace: NS }, (args) => {
        const v = files.get(args.path);
        if (v == null) return { errors: [{ text: `vfs: missing ${args.path}` }] };
        const ext = args.path.slice(args.path.lastIndexOf("."));
        const loader: Loader =
          ext === ".ts"
            ? "ts"
            : ext === ".tsx"
              ? "tsx"
              : ext === ".json"
                ? "json"
                : ext === ".css"
                  ? "css"
                  : "js";
        return { contents: asText(v), loader, resolveDir: dirOf(args.path) };
      });
    },
  };
}
