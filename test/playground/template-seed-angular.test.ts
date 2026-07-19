import { describe, expect, it } from "vitest";
import { seedBuiltinPacks } from "../../web/src/build/template-bundled.js";
import { MemoryVfs } from "../../web/src/vfs/memory-vfs.js";

// The browser playground seeds the pack-agnostic shared templates into an
// in-memory VFS.  The Angular pack loader reads its host layer from
// `/angular/` (loader-vfs.ts `SHARED_SOURCE_DIRS_BY_FORMAT.angular`), so the
// seeder MUST project `angular/*.hbs` into the VFS — otherwise generating an
// `angular` pack in the browser throws `no template registered for
// "index-html"` at render time.  (The CLI/fs loader reads these off disk and
// was never affected.)
describe("playground template seeding — Angular host layer", () => {
  it("seeds the angular/ shared templates into the VFS", () => {
    const vfs = new MemoryVfs();
    seedBuiltinPacks(vfs);
    // The three Angular host-layer templates the ng-build generator renders.
    expect(vfs.exists("/angular/index-html.hbs")).toBe(true);
    expect(vfs.exists("/angular/dockerfile.hbs")).toBe(true);
    expect(vfs.exists("/angular/dockerignore.hbs")).toBe(true);
  });

  it("still seeds the sibling shared dirs (vue/, sveltekit/, api/)", () => {
    const vfs = new MemoryVfs();
    seedBuiltinPacks(vfs);
    expect(vfs.list("/vue").length).toBeGreaterThan(0);
    expect(vfs.list("/sveltekit").length).toBeGreaterThan(0);
    expect(vfs.list("/api").length).toBeGreaterThan(0);
  });
});
