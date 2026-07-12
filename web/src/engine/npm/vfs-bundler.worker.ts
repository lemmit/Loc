/// <reference lib="webworker" />
// esbuild-wasm worker for the npm-in-browser engine (Phase B4).
//
// Fills NpmInstallBundleEngine's `EsbuildRun` seam in the browser:
// runs esbuild-wasm with makeVfsNpmPlugin over the install-populated
// VFS — no CDN fetches at bundle time.  The build options + plugin are
// byte-identical to what the B3b/B4 node spikes verified — only the
// host (esbuild-wasm in a Worker vs. node esbuild) differs.
//
// We pre-fetch + compile the wasm ourselves to dodge CDN
// content-encoding / streaming-API pitfalls, so the init is robust
// across browsers.

import * as esbuild from "esbuild-wasm";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";
import { makeVfsNpmPlugin } from "./esbuild-vfs-plugin.js";
import { harvestTsconfigPaths } from "../../bundle/plugin.js";
import { install } from "./install.js";
import { IdbInstallCache } from "./install-cache-idb.js";

declare const self: DedicatedWorkerGlobalScope;

export interface VfsBundleRequest {
  id: number;
  stdinContents?: string;
  entry?: string;
  /** Generated project files only — the worker installs rootDeps
   *  into its own copy, so node_modules never crosses postMessage. */
  generatedFiles: Map<string, string | Uint8Array>;
  rootDeps: Record<string, string>;
  externalReactRuntime?: boolean;
  /** Absolute deploy base (origin + base path, trailing slash) the
   *  main thread resolves from its document url — used for the
   *  vendor/ and npm-mirror/ fetches (see `deployBase`). */
  deployBase?: string;
  /** Opt-in: bundle with an inline Source Map v3 (`sourcemap: "inline"`
   *  instead of esbuild's default `false`).  Off by default so the
   *  bundle stays byte-identical; esbuild composes it from the
   *  generated `.ts`'s `//# sourceMappingURL` + the `.ts.map` sidecars
   *  in `generatedFiles` (present only when the caller generated with
   *  `sourcemap: true` — see `EsbuildRunInput.sourcemap`), chaining the
   *  bundle's own map straight back to `.ddd`. */
  sourcemap?: boolean;
}

export interface VfsBundleResponse {
  id: number;
  ok: boolean;
  code?: string;
  css?: string;
  versions?: Record<string, string>;
  /** C2: set on the react bundle when a prebuilt design-pack vendor was
   *  externalised — the iframe importmap (bare spec → origin-absolute
   *  url) and the optional vendor.css url. */
  vendorImportmap?: Record<string, string>;
  vendorCssUrl?: string;
  /** C0 perf instrumentation — install vs esbuild-wasm bundle split. */
  installMs?: number;
  bundleMs?: number;
  message?: string;
}

// C2: detect the design pack from the frontend deps by a signature
// package, so we can look up its prebuilt vendor.  Each pack has a
// unique anchor dependency.
function detectPack(deps: Record<string, string>): string | null {
  if ("@mantine/core" in deps) return "mantine";
  if ("@mui/material" in deps) return "mui";
  if ("@chakra-ui/react" in deps) return "chakra";
  if ("tailwind-merge" in deps || "class-variance-authority" in deps) return "shadcn";
  return null;
}

interface VendorManifest {
  imports: Record<string, string>;
  css: string | null;
}

// Absolute deploy base (e.g. https://host/Loc/playground/), passed in
// by the main thread on every request.  We cannot derive it here:
// `import.meta.env.BASE_URL` is the configured relative base ("./"), so
// a relative fetch in this worker resolves against the worker's OWN url
// (under assets/) and misses the deployed `vendor/` and `npm-mirror/`
// dirs.  The main thread knows the real document url, so it resolves
// the base to an absolute url and hands it over.
let deployBase = "/";

// C2: fetched prebuilt vendor manifest per pack (importmap + css url),
// with relative urls rewritten absolute (against deployBase) so the
// iframe importmap (whose document lives on the sandbox origin)
// resolves them.  Missing/404 (dev, or build:vendor not run) → null →
// the react bundle falls back to the self-contained install path.
const vendorPromises = new Map<string, Promise<VendorManifest | null>>();
function getVendor(pack: string): Promise<VendorManifest | null> {
  let p = vendorPromises.get(pack);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(`${deployBase}vendor/${pack}/importmap.json`);
        if (!res.ok) return null;
        const raw = (await res.json()) as VendorManifest;
        const imports: Record<string, string> = {};
        // urls in the manifest are web-root-relative (`vendor/<pack>/
        // x.js`); resolve against the deploy base to absolute urls.
        for (const [spec, url] of Object.entries(raw.imports)) {
          imports[spec] = new URL(url, deployBase).href;
        }
        return {
          imports,
          css: raw.css ? new URL(raw.css, deployBase).href : null,
        };
      } catch {
        return null;
      }
    })();
    vendorPromises.set(pack, p);
  }
  return p;
}

// IDB-backed install cache, worker-scoped (IndexedDB is available in
// DedicatedWorkerGlobalScope).  Opened once; memory-only no-op when
// IDB is unavailable.  This is why a dep set installs once and
// replays across prepares/reloads.
let cachePromise: Promise<IdbInstallCache> | null = null;
function getCache(): Promise<IdbInstallCache> {
  if (!cachePromise) {
    cachePromise = (async () => {
      const c = new IdbInstallCache();
      await c.open();
      return c;
    })();
  }
  return cachePromise;
}

// C1 local tarball mirror: name@version → same-origin asset URL,
// loaded once from the manifest the build step ships under
// <base>/npm-mirror/.  Missing/404 (dev, or no mirror built) → empty
// map → install falls back to the registry.
let mirrorPromise: Promise<Map<string, string>> | null = null;
function getMirror(): Promise<Map<string, string>> {
  if (!mirrorPromise) {
    mirrorPromise = (async () => {
      const map = new Map<string, string>();
      try {
        const base = deployBase + "npm-mirror/";
        const res = await fetch(base + "manifest.json");
        if (res.ok) {
          const manifest = (await res.json()) as Record<string, string>;
          for (const [k, file] of Object.entries(manifest)) {
            map.set(k, base + file);
          }
        }
      } catch {
        /* no mirror → registry fallback */
      }
      return map;
    })();
  }
  return mirrorPromise;
}

let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const res = await fetch(wasmURL);
      if (!res.ok) {
        throw new Error(
          `vfs-bundler.worker: failed to fetch esbuild wasm (${res.status} ${res.statusText})`,
        );
      }
      const wasmModule = await WebAssembly.compile(await res.arrayBuffer());
      await esbuild.initialize({ wasmModule, worker: false });
    })();
  }
  return initPromise;
}

// Bare specifiers the iframe handles itself (Tailwind runtime) — never
// part of the vendor importmap, so excluded from the coverage check.
const TAILWIND_RE = /^tailwindcss($|\/)|^tw-animate-css$/;

const BUILD_COMMON = {
  bundle: true,
  format: "esm" as const,
  platform: "browser" as const,
  target: "es2022",
  logLevel: "silent" as const,
  write: false as const,
  // Generated components use the automatic JSX runtime (no
  // `import React`).  Without this esbuild defaults to the classic
  // transform (React.createElement) → "React is not defined" at
  // runtime once React is bundled.
  jsx: "automatic" as const,
  // outdir gives JS-imported CSS (Mantine `*.css`) an output path so
  // esbuild bundles it into a sibling .css output file instead of
  // erroring "without an output path configured".  write:false → it
  // comes back in outputFiles, collected below.
  outdir: "/" as const,
  loader: { ".wasm": "binary" as const },
  // The preview is a *development* build, so define `import.meta.env`
  // the way `vite dev` would.  Without this the generated app's logger
  // (api/logger.hbs reads `import.meta.env.DEV`) falls to its production
  // default of `warn`, hiding the per-request `debug` lines it emits on
  // every API call — so the playground's "App logs" tab looked empty.
  // We don't invent logs: the app's own logger now emits its normal
  // dev-level stream, identical to running `vite dev` locally.  The
  // generated app reads no other `import.meta.env` key.
  define: {
    "import.meta.env": JSON.stringify({
      DEV: true,
      PROD: false,
      MODE: "development",
      SSR: false,
      BASE_URL: "/",
    }),
  },
};

// Persistent esbuild contexts, one per build "slot" (hono / react-vendor
// / react-self).  Reusing a context across edits lets esbuild skip
// re-parsing inputs whose onLoad content is unchanged (the heavy
// node_modules tree especially) — that's the incremental-rebuild win
// over a cold `esbuild.build()` each edit.  The VFS plugin closes over
// the slot's `files` map; we mutate it in place between rebuilds so
// `rebuild()` re-reads the freshly generated source.
type FileMap = Map<string, string | Uint8Array>;

interface CtxSlot {
  ctx: esbuild.BuildContext;
  files: FileMap;
  signature: string;
  /** Vendor path only: externals collected by the recorder plugin on
   *  the latest rebuild (reset each `onStart`). */
  externals?: { current: Set<string> };
}

const ctxCache = new Map<string, CtxSlot>();

/** Replace `target`'s entries with `source`'s, keeping the SAME map
 *  instance the live esbuild context's plugin closes over. */
function syncFiles(target: FileMap, source: FileMap): void {
  target.clear();
  for (const [k, v] of source) target.set(k, v);
}

/** Get (or lazily (re)create) the context for `key`.  A changed
 *  `signature` (entry path, react-external flag, aliases, stdin) means
 *  the build options baked into the context are stale, so we dispose
 *  and rebuild it; otherwise the cached context is reused. */
async function getSlot(
  key: string,
  signature: string,
  makeOptions: (files: FileMap) => {
    options: esbuild.BuildOptions;
    externals?: { current: Set<string> };
  },
): Promise<CtxSlot> {
  const existing = ctxCache.get(key);
  if (existing && existing.signature === signature) return existing;
  if (existing) {
    try {
      await existing.ctx.dispose();
    } catch {
      /* disposing a dead context can throw; ignore */
    }
    ctxCache.delete(key);
  }
  const files: FileMap = new Map();
  const { options, externals } = makeOptions(files);
  const ctx = await esbuild.context(options);
  const slot: CtxSlot = { ctx, files, signature, externals };
  ctxCache.set(key, slot);
  return slot;
}

self.onmessage = async (ev: MessageEvent<VfsBundleRequest>): Promise<void> => {
  const { id, stdinContents, entry, generatedFiles, rootDeps, externalReactRuntime, sourcemap } =
    ev.data;
  if (ev.data.deployBase) deployBase = ev.data.deployBase;
  // "inline" so the map travels inside the bundle's own text (no second
  // fetch) — the blob-URL `import()` in `runtime.worker.ts` and DevTools
  // both read a trailing `//# sourceMappingURL=data:...` directly.  `false`
  // (esbuild's own default) reproduces today's bundle byte-for-byte.
  const sourcemapOption: esbuild.BuildOptions["sourcemap"] = sourcemap ? "inline" : false;
  try {
    await ensureInit();
    const isReact = !stdinContents && !!entry;
    // C2: react bundle with a prebuilt design-pack vendor → externalise
    // the whole vendor and skip install entirely (the iframe importmap
    // supplies react/@mantine/… at load).  The app-only bundle is the
    // ~15-26s → ~1-2s win.  Falls back to the self-contained install
    // path when no vendor is prebuilt OR the app imports a specifier
    // the prebuilt importmap doesn't cover (a clean fallback beats a
    // runtime "Failed to resolve module specifier" in the iframe).
    const pack = isReact ? detectPack(rootDeps) : null;
    const vendor = pack ? await getVendor(pack) : null;

    const aliases = entry
      ? harvestTsconfigPaths(generatedFiles as unknown as Map<string, string>, entry)
      : [];

    if (vendor && entry) {
      const slot = await getSlot(
        "react-vendor",
        JSON.stringify([entry, aliases, sourcemapOption]),
        (files) => {
          const externals = { current: new Set<string>() };
          const recorder: esbuild.Plugin = {
            name: "record-externals",
            setup(build) {
              build.onStart(() => {
                externals.current = new Set();
              });
              build.onEnd((result) => {
                for (const o of Object.values(result.metafile?.outputs ?? {})) {
                  for (const imp of o.imports ?? []) {
                    if (imp.external && !imp.path.startsWith(".") && !imp.path.startsWith("/")) {
                      externals.current.add(imp.path);
                    }
                  }
                }
              });
            },
          };
          return {
            options: {
              ...BUILD_COMMON,
              sourcemap: sourcemapOption,
              entryPoints: [entry],
              metafile: true,
              plugins: [
                makeVfsNpmPlugin(files, "/node_modules", false, aliases, true),
                recorder,
              ],
            },
            externals,
          };
        },
      );
      syncFiles(slot.files, generatedFiles);
      const tBundle = performance.now();
      const out = await slot.ctx.rebuild();
      const externals = slot.externals?.current ?? new Set<string>();
      const missing = [...externals].filter(
        (s) => !vendor.imports[s] && !TAILWIND_RE.test(s),
      );
      if (missing.length === 0) {
        const bundleMs = Math.round(performance.now() - tBundle);
        // eslint-disable-next-line no-console
        console.info(
          `[npm-engine] react: install=0ms bundle=${bundleMs}ms ` +
            `(vendor externalised: ${pack}, ${externals.size} specs)`,
        );
        const js = out.outputFiles?.find((f) => f.path.endsWith(".js"));
        const css = out.outputFiles?.find((f) => f.path.endsWith(".css"));
        self.postMessage({
          id,
          ok: true,
          code: js?.text ?? out.outputFiles?.[0]?.text ?? "",
          css: css?.text,
          versions: {},
          vendorImportmap: vendor.imports,
          vendorCssUrl: vendor.css ?? undefined,
          installMs: 0,
          bundleMs,
        } satisfies VfsBundleResponse);
        return;
      }
      // eslint-disable-next-line no-console
      console.info(
        `[npm-engine] react: prebuilt ${pack} vendor missing ${missing.length} ` +
          `spec(s) (${missing.join(", ")}) — falling back to self-contained bundle`,
      );
    }

    // Self-contained path: install into our own copy of the generated
    // tree (off the main thread; node_modules stays here), then bundle.
    // Distinct slot keys (hono vs react-self) so the backend and the
    // fallback frontend each keep their own persistent context.
    const slotKey = stdinContents ? "hono" : "react-self";
    const slot = await getSlot(
      slotKey,
      JSON.stringify([
        entry ?? null,
        !!externalReactRuntime,
        aliases,
        stdinContents ?? null,
        sourcemapOption,
      ]),
      (files) => ({
        options: stdinContents
          ? {
              ...BUILD_COMMON,
              sourcemap: sourcemapOption,
              plugins: [
                makeVfsNpmPlugin(files, "/node_modules", !!externalReactRuntime, aliases),
              ],
              stdin: {
                contents: stdinContents,
                resolveDir: "/",
                sourcefile: "__entry__.ts",
                loader: "ts" as const,
              },
            }
          : {
              ...BUILD_COMMON,
              sourcemap: sourcemapOption,
              plugins: [
                makeVfsNpmPlugin(files, "/node_modules", !!externalReactRuntime, aliases),
              ],
              entryPoints: [entry as string],
            },
      }),
    );
    syncFiles(slot.files, generatedFiles);
    const tInstall = performance.now();
    const { versions, fileCount } = await install(
      rootDeps,
      (p, d) => slot.files.set(p, d),
      { cache: await getCache(), mirror: await getMirror() },
    );
    const installMs = Math.round(performance.now() - tInstall);
    const versionRec = Object.fromEntries(versions);
    const tBundle = performance.now();
    const out = await slot.ctx.rebuild();
    const bundleMs = Math.round(performance.now() - tBundle);
    // C0 — perf instrumentation: the install-vs-bundle split decides
    // whether the npm-default perf work targets install latency (C1)
    // or esbuild-wasm bundling (C2).  `kind` distinguishes the small
    // Hono backend bundle from the heavy React/Mantine frontend one.
    const kind = stdinContents ? "hono" : "react";
    // eslint-disable-next-line no-console
    console.info(
      `[npm-engine] ${kind}: install=${installMs}ms bundle=${bundleMs}ms ` +
        `(${versions.size} pkgs, ${fileCount} files installed)`,
    );
    const js = out.outputFiles?.find((f) => f.path.endsWith(".js"));
    const css = out.outputFiles?.find((f) => f.path.endsWith(".css"));
    let code = js?.text ?? out.outputFiles?.[0]?.text ?? "";
    // Debug polish: a `blob:` module's name in DevTools defaults to the
    // opaque blob URL — a trailing `//# sourceURL=` directive gives it a
    // friendly one instead.  Only on the hono bundle, and only when
    // sourcemaps were actually requested (keeps the default bundle
    // untouched).
    if (kind === "hono" && sourcemap) {
      code += "//# sourceURL=loom://backend.js\n";
    }
    self.postMessage({
      id,
      ok: true,
      code,
      css: css?.text,
      versions: versionRec,
      installMs,
      bundleMs,
    } satisfies VfsBundleResponse);
  } catch (err) {
    const message =
      (err as { errors?: Array<{ text: string }> }).errors?.[0]?.text ??
      (err instanceof Error ? err.message : String(err));
    self.postMessage({ id, ok: false, message } satisfies VfsBundleResponse);
  }
};
