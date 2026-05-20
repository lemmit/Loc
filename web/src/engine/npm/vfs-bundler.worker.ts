/// <reference lib="webworker" />
// esbuild-wasm worker for the npm-in-browser engine (Phase B4).
//
// Fills NpmInstallBundleEngine's `EsbuildRun` seam in the browser:
// runs esbuild-wasm with makeVfsNpmPlugin over the install-populated
// VFS (no esm.sh).  The build options + plugin are byte-identical to
// what the B3b/B4 node spikes verified — only the host (esbuild-wasm
// in a Worker vs. node esbuild) differs.
//
// Init mirrors bundler.worker.ts exactly (pre-fetch + compile the
// wasm ourselves to dodge CDN content-encoding / streaming-API
// pitfalls), so behaviour matches the proven esm.sh worker.

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

// C2: fetched prebuilt vendor manifest per pack (importmap + css url),
// with relative urls rewritten origin-absolute so the iframe importmap
// (whose document lives under <base>/__loom_sandbox__/) resolves them.
// Missing/404 (dev, or build:vendor not run) → null → the react bundle
// falls back to the self-contained install+bundle path.
const vendorPromises = new Map<string, Promise<VendorManifest | null>>();
function getVendor(pack: string): Promise<VendorManifest | null> {
  let p = vendorPromises.get(pack);
  if (!p) {
    p = (async () => {
      try {
        const base = (import.meta.env?.BASE_URL ?? "/") + `vendor/${pack}/`;
        const res = await fetch(base + "importmap.json");
        if (!res.ok) return null;
        const raw = (await res.json()) as VendorManifest;
        const root = self.location.origin + (import.meta.env?.BASE_URL ?? "/");
        const imports: Record<string, string> = {};
        // urls in the manifest are root-relative (`vendor/<pack>/x.js`);
        // resolve against the origin, not the pack base, so the leading
        // `vendor/` segment isn't duplicated.
        for (const [spec, url] of Object.entries(raw.imports)) {
          imports[spec] = new URL(url, root).href;
        }
        return { imports, css: raw.css ? new URL(raw.css, root).href : null };
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
        const base = (import.meta.env?.BASE_URL ?? "/") + "npm-mirror/";
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
  sourcemap: false as const,
  // Generated components use the automatic JSX runtime (no
  // `import React`).  Without this esbuild defaults to the classic
  // transform (React.createElement) → "React is not defined" at
  // runtime once React is bundled.  Mirrors the esm.sh bundler.worker.
  jsx: "automatic" as const,
  // outdir gives JS-imported CSS (Mantine `*.css`) an output path so
  // esbuild bundles it into a sibling .css output file instead of
  // erroring "without an output path configured".  write:false → it
  // comes back in outputFiles, collected below.
  outdir: "/" as const,
  loader: { ".wasm": "binary" as const },
};

self.onmessage = async (ev: MessageEvent<VfsBundleRequest>): Promise<void> => {
  const { id, stdinContents, entry, generatedFiles, rootDeps, externalReactRuntime } =
    ev.data;
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
      const appFiles = new Map(generatedFiles);
      const externals = new Set<string>();
      const recorder: esbuild.Plugin = {
        name: "record-externals",
        setup(build) {
          build.onEnd((result) => {
            for (const o of Object.values(result.metafile?.outputs ?? {})) {
              for (const imp of o.imports ?? []) {
                if (imp.external && !imp.path.startsWith(".") && !imp.path.startsWith("/")) {
                  externals.add(imp.path);
                }
              }
            }
          });
        },
      };
      const tBundle = performance.now();
      const out = await esbuild.build({
        ...BUILD_COMMON,
        entryPoints: [entry],
        metafile: true,
        plugins: [
          makeVfsNpmPlugin(appFiles, "/node_modules", false, aliases, true),
          recorder,
        ],
      });
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
        const js = out.outputFiles.find((f) => f.path.endsWith(".js"));
        const css = out.outputFiles.find((f) => f.path.endsWith(".css"));
        self.postMessage({
          id,
          ok: true,
          code: js?.text ?? out.outputFiles[0]?.text ?? "",
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
    const files = new Map(generatedFiles);
    const tInstall = performance.now();
    const { versions, fileCount } = await install(
      rootDeps,
      (p, d) => files.set(p, d),
      { cache: await getCache(), mirror: await getMirror() },
    );
    const installMs = Math.round(performance.now() - tInstall);
    const versionRec = Object.fromEntries(versions);
    const common = {
      ...BUILD_COMMON,
      plugins: [
        makeVfsNpmPlugin(files, "/node_modules", !!externalReactRuntime, aliases),
      ],
    };
    const tBundle = performance.now();
    const out = await esbuild.build(
      stdinContents
        ? {
            ...common,
            stdin: {
              contents: stdinContents,
              resolveDir: "/",
              sourcefile: "__entry__.ts",
              loader: "ts",
            },
          }
        : { ...common, entryPoints: [entry as string] },
    );
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
    const js = out.outputFiles.find((f) => f.path.endsWith(".js"));
    const css = out.outputFiles.find((f) => f.path.endsWith(".css"));
    self.postMessage({
      id,
      ok: true,
      code: js?.text ?? out.outputFiles[0]?.text ?? "",
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
