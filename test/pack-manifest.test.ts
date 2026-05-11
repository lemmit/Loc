import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadPack, resolvePackDir } from "../src/generator/_packs/loader-fs.js";

// ---------------------------------------------------------------------------
// Manifest-extension tests for `shellFiles` and `shellGlobs` (the
// pack-declared shell-file mappings that replaced the hardcoded
// switchboard in `src/generator/react/index.ts`).  Built-in packs
// are exercised through the snapshot suite; these tests focus on
// the validation surface that snapshots can't assert (typos in
// shellFiles produce a clear error, glob captures expand correctly).
// ---------------------------------------------------------------------------

function makePack(
  manifest: object,
  files: Record<string, string>,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pack-"));
  fs.writeFileSync(path.join(dir, "pack.json"), JSON.stringify(manifest));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

describe("pack manifest: shellFiles + shellGlobs", () => {
  it("loads a pack with both shellFiles and shellGlobs declared", () => {
    const dir = makePack(
      {
        name: "fixture",
        version: "0.0.0",
        emits: {
          "tailwind-config": "tailwind-config.hbs",
          "components-ui-button": "components-ui-button.hbs",
          "components-ui-card": "components-ui-card.hbs",
        },
        shellFiles: { "tailwind-config": "tailwind.config.ts" },
        shellGlobs: { "components-ui-*": "src/components/ui/{1}.tsx" },
      },
      {
        "tailwind-config.hbs": "// tailwind",
        "components-ui-button.hbs": "// button",
        "components-ui-card.hbs": "// card",
      },
    );
    const pack = loadPack(dir);
    expect(pack.manifest.shellFiles).toEqual({
      "tailwind-config": "tailwind.config.ts",
    });
    expect(pack.manifest.shellGlobs).toEqual({
      "components-ui-*": "src/components/ui/{1}.tsx",
    });
  });

  it("treats shellFiles + shellGlobs as optional (mantine-style packs work)", () => {
    const dir = makePack(
      {
        name: "fixture-mantine-style",
        version: "0.0.0",
        emits: { "page-list": "page-list.hbs" },
      },
      { "page-list.hbs": "// list" },
    );
    const pack = loadPack(dir);
    expect(pack.manifest.shellFiles).toBeUndefined();
    expect(pack.manifest.shellGlobs).toBeUndefined();
  });
});

describe("pack manifest: helpers", () => {
  it("registers lookup-table helpers declared in `helpers`", () => {
    const dir = makePack(
      {
        name: "fixture-helpers",
        version: "0.0.0",
        emits: { greet: "greet.hbs" },
        helpers: {
          // Per-pack icon-rename example, mirroring shadcn's `lucide`.
          rename: { Foo: "Bar", Baz: "Qux" },
        },
      },
      { "greet.hbs": "{{rename name}}" },
    );
    const pack = loadPack(dir);
    expect(pack.render("greet", { name: "Foo" })).toBe("Bar");
    // Unknown keys fall through verbatim — matches the lucide helper's
    // contract.  Templates rely on this so an unmapped icon name still
    // produces a valid identifier (TS compile then catches the typo).
    expect(pack.render("greet", { name: "Unknown" })).toBe("Unknown");
  });

  it("treats `helpers` as optional", () => {
    const dir = makePack(
      {
        name: "fixture-no-helpers",
        version: "0.0.0",
        emits: { greet: "greet.hbs" },
      },
      { "greet.hbs": "hi {{name}}" },
    );
    const pack = loadPack(dir);
    expect(pack.manifest.helpers).toBeUndefined();
    expect(pack.render("greet", { name: "world" })).toBe("hi world");
  });
});

describe("resolvePackDir", () => {
  it("resolves the built-in `mantine` and `shadcn` ids to the repo designs/", () => {
    const m = resolvePackDir("mantine");
    const s = resolvePackDir("shadcn");
    expect(fs.existsSync(path.join(m, "pack.json"))).toBe(true);
    expect(fs.existsSync(path.join(s, "pack.json"))).toBe(true);
  });

  it("treats anything else as a path, anchored to referenceDir when relative", () => {
    const ref = "/tmp/some/place";
    expect(resolvePackDir("/abs/pack", ref)).toBe("/abs/pack");
    expect(resolvePackDir("./local-pack", ref)).toBe("/tmp/some/place/local-pack");
  });
});
