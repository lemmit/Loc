// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { generateSystems } from "../../src/system/index.js";
import type { VirtualFile } from "../../web/src/build/protocol.js";
import {
  inlineSourcemapArtifacts,
  overlaySourcemapArtifacts,
  stripSourcemapArtifacts,
} from "../../web/src/build/strip-sourcemap.js";
import { parseString } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Playground DevTools `.ddd` debugging — the ENABLER slice on top of the
// foundation (`test/playground/build-worker-sourcemap.test.ts`).
//
// THE #1 CORRECTNESS PROPERTY: the Files pane / git-backed workspace store
// must stay byte-identical to a `sourcemap`-off generate, even though the
// boot bundle now carries maps.  `App.tsx`'s `runGenerateStep` achieves
// this ARCHITECTURALLY rather than by post-hoc stripping: the view/persist
// path calls `generateFromPath(entryPath)` with NO `sourcemap` option —
// literally the same call it made before this feature existed — so
// byte-identical is true by construction, not an invariant a strip
// function has to keep re-earning.
//
// A single-generate-then-strip design (strip the map-carrying result back
// down to the flag-off shape) was the ORIGINAL plan and was abandoned after
// finding, on fresh `main`, that `--sourcemap` no longer adds just sidecar
// files: `src/generator/typescript/debug-imports.ts` (M18) rewrites every
// relative import specifier in every generated `.ts` file of a `node`
// deployable, adds a `package.json` "debug" script + a `tsconfig.json`
// `allowImportingTsExtensions` flag, and the .NET backend's M26 debug
// wiring inlines `#line (r,c)-(r,c) "<path>.ddd"` / `#line default`
// directives INSIDE generated method bodies.  A single-argument "reverse
// this mutation" strip would have to track that shape (and every future
// backend's own addition) forever — see `strip-sourcemap.ts`'s module doc.
//
// `overlaySourcemapArtifacts` replaces that with a straight diff between
// two REAL generates of the same source (flag off vs flag on) — no
// backend-specific knowledge required, so it can't silently miss a future
// backend's debug wiring the way a guessed reversal could.
// ---------------------------------------------------------------------------

const ACME_DDD = path.resolve(__dirname, "../../web/src/examples/acme.ddd");

/** Mirrors `build.worker.ts`'s `filesFromMap` — the exact shape the worker
 *  hands back over the RPC boundary (`VirtualFile[]`, sorted by path). */
function toVirtualFiles(map: Map<string, string>): VirtualFile[] {
  const out: VirtualFile[] = [];
  for (const [filePath, content] of map) {
    out.push({ path: filePath, content, size: content.length });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function generateAcmeOffAndOn(): Promise<{ off: VirtualFile[]; on: VirtualFile[] }> {
  const source = readFileSync(ACME_DDD, "utf-8");
  const { model, doc, errors } = await parseString(source, { validate: true });
  expect(errors).toEqual([]);
  const sourceTexts = new Map([[doc.uri.path, source]]);
  const off = toVirtualFiles(generateSystems(model).files);
  const on = toVirtualFiles(generateSystems(model, { sourcemap: true, sourceTexts }).files);
  return { off, on };
}

describe("the flag-off generate — the view/persist path's actual byte-identical guarantee", () => {
  it("never carries any sourcemap artifact — acme.ddd (node + dotnet + react deployables)", async () => {
    const { off } = await generateAcmeOffAndOn();
    expect(off.some((f) => f.path.endsWith(".ts.map"))).toBe(false);
    expect(off.some((f) => f.path.endsWith(".java.smap"))).toBe(false);
    expect(off.some((f) => f.path === ".loom/sourcemap.json")).toBe(false);
    expect(off.some((f) => f.path === ".vscode/launch.json")).toBe(false);
    for (const f of off) expect(f.content).not.toContain("//# sourceMappingURL=");
  });

  it("the flag genuinely changes output (sanity — the on/off generates aren't accidentally identical)", async () => {
    const { off, on } = await generateAcmeOffAndOn();
    expect(on.length).toBeGreaterThan(off.length);
  });
});

describe("overlaySourcemapArtifacts — reconstructing the mapped tree from a real off/on diff", () => {
  it("overlaying the on-generate onto the off-generate (no hand edits) exactly reconstructs the on-generate", async () => {
    const { off, on } = await generateAcmeOffAndOn();
    // `merged === off` simulates "nothing hand-edited since the last
    // generate" — the common case.  The overlay should losslessly
    // reconstruct `on`: every path/content pair matches.
    const overlaid = overlaySourcemapArtifacts(off, off, on);
    expect(overlaid).toEqual(on);
  });

  it("a mapped .ts.map sidecar chains to .ddd, and its .ts file carries the sourceMappingURL directive, after overlay", async () => {
    const { off, on } = await generateAcmeOffAndOn();
    const overlaid = overlaySourcemapArtifacts(off, off, on);
    const mapFiles = overlaid.filter((f) => f.path.endsWith(".ts.map"));
    expect(mapFiles.length).toBeGreaterThan(0);
    for (const mapFile of mapFiles) {
      const v3 = JSON.parse(mapFile.content) as {
        sources: string[];
        sourcesContent?: string[];
      };
      expect(v3.sources.some((s) => s.endsWith(".ddd"))).toBe(true);
      expect(v3.sourcesContent?.some((c) => c && c.length > 0)).toBe(true);

      const tsPath = mapFile.path.slice(0, -".map".length);
      const tsFile = overlaid.find((f) => f.path === tsPath);
      expect(tsFile).toBeDefined();
      const basename = mapFile.path.split("/").pop()!;
      expect(tsFile!.content).toContain(`//# sourceMappingURL=${basename}`);
    }
  });

  it("preserves a hand edit to a file the sourcemap flag never touches", () => {
    const off: VirtualFile[] = [
      { path: "hono_api/ids.ts", content: "export type Id = string;\n", size: 26 },
      { path: "docker-compose.yml", content: "services: {}\n", size: 13 },
    ];
    const on: VirtualFile[] = [...off]; // flag has no effect on either path in this synthetic case
    const merged: VirtualFile[] = [
      off[0],
      { path: "docker-compose.yml", content: "services:\n  hand-edited: true\n", size: 30 },
    ];
    const overlaid = overlaySourcemapArtifacts(merged, off, on);
    expect(overlaid.find((f) => f.path === "docker-compose.yml")?.content).toBe(
      "services:\n  hand-edited: true\n",
    );
  });

  it("discards a hand edit to a file the sourcemap flag DOES touch, in favour of the mapped content (documented limitation)", () => {
    const off: VirtualFile[] = [
      { path: "hono_api/domain/build.ts", content: "export const x = 1;\n", size: 21 },
    ];
    const on: VirtualFile[] = [
      {
        path: "hono_api/domain/build.ts",
        content: "export const x = 1;\n//# sourceMappingURL=build.ts.map\n",
        size: 55,
      },
      { path: "hono_api/domain/build.ts.map", content: '{"sources":["a.ddd"]}', size: 21 },
    ];
    const merged: VirtualFile[] = [
      // Hand-edited since the last generate: differs from `off`.
      { path: "hono_api/domain/build.ts", content: "export const x = 999; // mine\n", size: 31 },
    ];
    const overlaid = overlaySourcemapArtifacts(merged, off, on);
    const ts = overlaid.find((f) => f.path === "hono_api/domain/build.ts");
    expect(ts?.content).toBe(on[0].content); // hand edit discarded for this mapped file
    expect(overlaid.find((f) => f.path === "hono_api/domain/build.ts.map")).toBeDefined();
  });

  it("adds a brand-new artifact path (e.g. a new .ts.map) without disturbing unrelated merged entries", () => {
    const off: VirtualFile[] = [{ path: "a.ts", content: "a\n", size: 2 }];
    const on: VirtualFile[] = [
      { path: "a.ts", content: "a\n", size: 2 },
      { path: "a.ts.map", content: "{}", size: 2 },
    ];
    const merged: VirtualFile[] = [
      { path: "a.ts", content: "a\n", size: 2 },
      { path: "b.md", content: "notes\n", size: 6 },
    ];
    const overlaid = overlaySourcemapArtifacts(merged, off, on);
    expect(overlaid.map((f) => f.path).sort()).toEqual(["a.ts", "a.ts.map", "b.md"]);
    expect(overlaid.find((f) => f.path === "b.md")?.content).toBe("notes\n");
  });
});

describe("stripSourcemapArtifacts — narrow defensive filter (not the primary mechanism)", () => {
  it("drops .ts.map / .tsx.map / .java.smap sidecars, .loom/sourcemap.json, and .vscode/launch.json, leaving other files untouched", () => {
    const files: VirtualFile[] = [
      { path: "hono_api/domain/build.ts.map", content: "{}", size: 2 },
      { path: "react_web/src/pages/Home.tsx.map", content: "{}", size: 2 },
      { path: "java_api/domain/Build.java.smap", content: "SMAP", size: 4 },
      { path: ".loom/sourcemap.json", content: "{}", size: 2 },
      { path: ".vscode/launch.json", content: "{}", size: 2 },
      { path: ".loom/mermaid.md", content: "graph TD", size: 8 },
      { path: "docker-compose.yml", content: "services: {}\n", size: 13 },
    ];
    const out = stripSourcemapArtifacts(files);
    expect(out.map((f) => f.path).sort()).toEqual([".loom/mermaid.md", "docker-compose.yml"]);
  });

  it("strips a trailing //# sourceMappingURL directive, leaving the rest of the content untouched", () => {
    const content = "export const x = 1;\n//# sourceMappingURL=build.ts.map\n";
    const files: VirtualFile[] = [
      { path: "hono_api/domain/build.ts", content, size: content.length },
    ];
    const [out] = stripSourcemapArtifacts(files);
    expect(out.content).toBe("export const x = 1;\n");
  });

  it("is a no-op on a real flag-off generate (nothing to strip)", async () => {
    const { off } = await generateAcmeOffAndOn();
    expect(stripSourcemapArtifacts(off)).toEqual(off);
  });
});

describe("inlineSourcemapArtifacts (esbuild-WASM can't read .ts.map sidecars)", () => {
  const MAP = {
    version: 3,
    sources: ["../../examples/showcase.ddd"],
    sourcesContent: ["system Showcase { }\n"],
    mappings: "AAAA",
  };

  it("folds a sidecar .ts.map into an inline data: URI and drops the sidecar", () => {
    const files: VirtualFile[] = [
      {
        path: "hono_api/domain/build.ts",
        content: "export const x = 1;\n//# sourceMappingURL=build.ts.map\n",
        size: 0,
      },
      {
        path: "hono_api/domain/build.ts.map",
        content: JSON.stringify(MAP),
        size: 0,
      },
      { path: "hono_api/index.ts", content: "export {};\n", size: 0 },
    ];
    const out = inlineSourcemapArtifacts(files);

    // Sidecar is gone.
    expect(out.some((f) => f.path.endsWith(".map"))).toBe(false);
    // Untouched file passes through.
    expect(out.find((f) => f.path === "hono_api/index.ts")?.content).toBe("export {};\n");

    // The .ts now carries an INLINE data: map that decodes back to the sidecar.
    const ts = out.find((f) => f.path === "hono_api/domain/build.ts");
    const m = /\/\/# sourceMappingURL=data:application\/json;base64,(\S+)\n?$/.exec(
      ts?.content ?? "",
    );
    expect(m, "inline data: sourceMappingURL present").not.toBeNull();
    const decoded = JSON.parse(Buffer.from(m![1], "base64").toString("utf8"));
    expect(decoded).toEqual(MAP);
    // The .ddd source + its content survived into the inline map (what makes
    // esbuild-wasm chain the bundle back to `.ddd`).
    expect(decoded.sources.some((s: string) => s.endsWith(".ddd"))).toBe(true);
    expect(decoded.sourcesContent[0].length).toBeGreaterThan(0);
  });

  it("leaves a file whose sidecar isn't in the set untouched", () => {
    const files: VirtualFile[] = [
      {
        path: "a/b.ts",
        content: "x;\n//# sourceMappingURL=b.ts.map\n",
        size: 0,
      },
    ];
    expect(inlineSourcemapArtifacts(files)).toEqual(files);
  });

  it("is a no-op on a flag-off generate (no directives, no sidecars)", async () => {
    const { off } = await generateAcmeOffAndOn();
    expect(inlineSourcemapArtifacts(off)).toEqual(off);
  });
});
