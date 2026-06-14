import { describe, expect, it } from "vitest";
import { loadPack, resolvePackDir } from "../../web/src/build/loader-vfs.js";
import { seedBuiltinPacks } from "../../web/src/build/template-bundled.js";
import { setWorkerVfs } from "../../web/src/build/worker-vfs.js";
import { MemoryVfs } from "../../web/src/vfs/memory-vfs.js";

// ---------------------------------------------------------------------------
// Playground VFS loader — svelte / vue pack support (next-steps item 5).
//
// The browser-side loader (`loader-vfs.ts`) reads pack templates + shared
// sources from an in-memory VFS the worker seeds via `seedBuiltinPacks`
// (`template-bundled.ts`, `import.meta.glob` over the repo's designs/ +
// shared dirs).  Before this fix the seeder bundled only vite/+api/+
// docker/ and the loader hardcoded that TSX set, so a `format: "svelte"`
// or `format: "vue"` pack crashed in the browser on the missing shared
// dir.  These tests bind a real seeded MemoryVfs and load each format's
// built-in packs end-to-end — the same path the worker runs.
// ---------------------------------------------------------------------------

function seededVfs(): MemoryVfs {
  const vfs = new MemoryVfs();
  seedBuiltinPacks(vfs);
  setWorkerVfs(vfs);
  return vfs;
}

describe("playground VFS loader — pack formats", () => {
  it("loads the TSX packs (react) — unchanged baseline", () => {
    seededVfs();
    const pack = loadPack(resolvePackDir("mantine@v9"));
    expect(pack.manifest.format ?? "tsx").toBe("tsx");
    // A vite/ shared partial is registered (the TSX shared set).
    expect(pack.templates.has("vite-config")).toBe(true);
  });

  it("loads the svelte packs from the sveltekit/ shared dir", () => {
    seededVfs();
    for (const ref of ["shadcnSvelte@v1", "flowbite@v1"]) {
      const pack = loadPack(resolvePackDir(ref));
      expect(pack.manifest.format, ref).toBe("svelte");
      // The SvelteKit shared layer (sveltekit/*.hbs) is now seeded +
      // selected, so its partials resolve (e.g. the root layout).
      expect(pack.templates.has("root-layout"), ref).toBe(true);
      expect(pack.templates.has("svelte-config"), ref).toBe(true);
    }
  });

  it("loads the vue packs from the vue/ + api/ + docker/ shared dirs", () => {
    seededVfs();
    for (const ref of ["vuetify@v3", "shadcnVue@v1"]) {
      const pack = loadPack(resolvePackDir(ref));
      expect(pack.manifest.format, ref).toBe("vue");
      expect(pack.templates.has("vite-config"), ref).toBe(true);
    }
  });
});
