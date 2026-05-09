import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { MemoryVfs } from "../web/src/vfs/memory-vfs.js";
import { setWorkerVfs } from "../web/src/build/worker-vfs.js";
import { loadPack, resolvePackDir } from "../web/src/build/loader-vfs.js";

// ---------------------------------------------------------------------------
// `loader-vfs.ts` is the browser fs-adapter analogue of `loader-fs.ts`.
// In the playground worker it reads from a worker-local VFS that gets
// seeded by `template-bundled.ts`; here we hydrate a plain MemoryVfs
// from disk so the same code paths can be unit-tested without spinning
// up the whole Vite glob.
//
// The Node loader's pack snapshots live in
// `test/__snapshots__/generator-react-pack-snapshots.test.ts.snap`
// and exercise the *same* `compilePack` core that this adapter wraps.
// We don't re-snapshot that surface here — the byte-identity guarantee
// for the VFS adapter follows from compilePack being pure and the
// adapter just feeding it the same source map a fs read would produce.
//
// What this file owns: the VFS adapter's contract — built-in name
// resolution, manifest loading, missing-template error messages, and
// path semantics for relative `design:` paths.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const themesDir = path.join(repoRoot, "themes");

/** Seed a MemoryVfs from the on-disk `themes/` tree, mirroring what
 *  `seedBuiltinPacks` does in the worker via `import.meta.glob`. */
function hydrateBuiltinThemes(vfs: MemoryVfs): void {
  for (const pack of fs.readdirSync(themesDir)) {
    const dir = path.join(themesDir, pack);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      const full = path.join(dir, file);
      if (!fs.statSync(full).isFile()) continue;
      vfs.write(`/themes/${pack}/${file}`, fs.readFileSync(full, "utf-8"));
    }
  }
}

let vfs: MemoryVfs;

beforeAll(() => {
  vfs = new MemoryVfs();
  hydrateBuiltinThemes(vfs);
  setWorkerVfs(vfs);
});

describe("resolvePackDir: built-in names", () => {
  it("resolves `mantine` and `shadcn` to /themes/<name>", () => {
    expect(resolvePackDir("mantine")).toBe("/themes/mantine");
    expect(resolvePackDir("shadcn")).toBe("/themes/shadcn");
  });
});

describe("resolvePackDir: paths", () => {
  it("returns absolute paths verbatim", () => {
    expect(resolvePackDir("/workspace/design/foo")).toBe("/workspace/design/foo");
  });

  it("anchors relative paths to referenceDir", () => {
    expect(resolvePackDir("./design/foo", "/workspace/sub")).toBe(
      "/workspace/sub/design/foo",
    );
  });

  it("defaults referenceDir to /workspace", () => {
    expect(resolvePackDir("./design/foo")).toBe("/workspace/design/foo");
  });

  it("collapses `..` in relative paths", () => {
    expect(resolvePackDir("../packs/foo", "/workspace/sub/sub2")).toBe(
      "/workspace/sub/packs/foo",
    );
  });

  it("rejects user-pack names that collide with built-ins (built-ins win)", () => {
    // Even if the user names their pack "mantine", `resolvePackDir`
    // returns the built-in path — not the workspace path — so the
    // user pack can't shadow the built-in.
    expect(resolvePackDir("mantine", "/workspace/somewhere")).toBe("/themes/mantine");
  });
});

describe("loadPack: built-in pack loading", () => {
  it("loads the mantine pack and exposes its templates", () => {
    const pack = loadPack("/themes/mantine");
    expect(pack.manifest.name).toBe("mantine");
    expect(pack.templates.has("page-list")).toBe(true);
    expect(pack.templates.has("page-detail")).toBe(true);
    expect(pack.templates.has("theme")).toBe(true);
  });

  it("loads the shadcn pack including its declared helpers", () => {
    const pack = loadPack("/themes/shadcn");
    expect(pack.manifest.name).toBe("shadcn");
    // shadcn declares a `lucide` icon-rename helper in its manifest
    // (PR #58).  The VFS loader path must wire the helper-registration
    // step the same way the Node loader does.
    expect(pack.manifest.helpers?.lucide?.IconPlus).toBe("Plus");
  });
});

describe("loadPack: error paths", () => {
  it("throws a clear error when the pack manifest is missing", () => {
    expect(() => loadPack("/themes/does-not-exist")).toThrow(
      /pack manifest not found at \/themes\/does-not-exist\/pack\.json/,
    );
  });

  it("throws a clear error when an emits entry has no template file", () => {
    const stub = new MemoryVfs();
    stub.write(
      "/themes/stub/pack.json",
      JSON.stringify({
        name: "stub",
        version: "0.0.0",
        emits: { "page-list": "page-list.hbs" },
      }),
    );
    // Note: page-list.hbs intentionally not seeded.
    setWorkerVfs(stub);
    try {
      expect(() => loadPack("/themes/stub")).toThrow(
        /pack stub: template "page-list" → "page-list\.hbs" not found at \/themes\/stub\/page-list\.hbs/,
      );
    } finally {
      // Restore the well-formed VFS for any tests that run after.
      setWorkerVfs(vfs);
    }
  });
});
