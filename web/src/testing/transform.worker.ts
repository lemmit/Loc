// esbuild-wasm worker for the test runner.  Two jobs:
//   - `transform`: type-strip a single self-contained file (API runner).
//   - `build`: bundle the generated UI spec + its page objects from an
//     in-memory file map, aliasing `@playwright/test` to a shim that
//     reads `globalThis.__loomPw` (UI runner).  `import type` of the
//     generated api types is dropped by the ts loader, so those need no
//     resolution; the only value import is `@playwright/test`.
//
// Decoupled, tiny worker; esbuild is initialised once per thread (the
// wasm bytes are already browser-cached from the project bundler).

import * as esbuild from "esbuild-wasm";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";

export type TransformRequest =
  | { id: number; ts: string }
  | { id: number; build: { entry: string; files: Record<string, string> } };

export interface TransformResponse {
  id: number;
  ok: boolean;
  code?: string;
  message?: string;
}

let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const res = await fetch(wasmURL);
      if (!res.ok) {
        throw new Error(
          `transform.worker: failed to fetch esbuild wasm (${res.status} ${res.statusText})`,
        );
      }
      const wasmModule = await WebAssembly.compile(await res.arrayBuffer());
      await esbuild.initialize({ wasmModule, worker: false });
    })();
  }
  return initPromise;
}

const PW = "@playwright/test";
const PW_SHIM =
  "export const test = globalThis.__loomPw.test; export const expect = globalThis.__loomPw.expect;";

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function resolveRelative(
  importer: string,
  rel: string,
  files: Record<string, string>,
): string | null {
  const base = normalize(dirOf(importer) + rel);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (cand in files) return cand;
  }
  return null;
}

function vfsPlugin(files: Record<string, string>): esbuild.Plugin {
  return {
    name: "loom-ui-vfs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === PW) return { path: PW, namespace: "pw" };
        if (args.kind === "entry-point") {
          return { path: normalize(args.path), namespace: "vfs" };
        }
        if (args.path.startsWith(".")) {
          const resolved = resolveRelative(args.importer, args.path, files);
          if (resolved) return { path: resolved, namespace: "vfs" };
        }
        // Bare/value imports we don't bundle (none expected — api types
        // are `import type` and dropped) — mark external defensively.
        return { path: args.path, external: true };
      });
      build.onLoad({ filter: /.*/, namespace: "pw" }, () => ({
        contents: PW_SHIM,
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: "vfs" }, (args) => ({
        contents: files[args.path] ?? "",
        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
      }));
    },
  };
}

self.onmessage = async (ev: MessageEvent<TransformRequest>): Promise<void> => {
  const data = ev.data;
  try {
    await ensureInit();
    if ("build" in data) {
      const out = await esbuild.build({
        entryPoints: [data.build.entry],
        bundle: true,
        format: "esm",
        write: false,
        plugins: [vfsPlugin(data.build.files)],
      });
      self.postMessage({
        id: data.id,
        ok: true,
        code: out.outputFiles[0].text,
      } satisfies TransformResponse);
      return;
    }
    const out = await esbuild.transform(data.ts, { loader: "ts", format: "esm" });
    self.postMessage({ id: data.id, ok: true, code: out.code } satisfies TransformResponse);
  } catch (e) {
    self.postMessage({
      id: data.id,
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    } satisfies TransformResponse);
  }
};
