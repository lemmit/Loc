// ---------------------------------------------------------------------------
// Pack required-primitives gate (`src/generator/_packs/required-primitives.ts`).
//
// Every built-in pack must satisfy the per-format minimum template
// surface at LOAD time — a missing primitive used to surface as a
// `pack.render("primitive-modal", ...)` runtime failure deep in the
// React walker.  This file pins two things:
//
//   1. Every built-in pack still loads (forward gate — fail when a
//      primitive lands in `required-primitives.ts` but a pack hasn't
//      caught up).
//   2. A pack missing a required primitive fails to load with a
//      clear message listing the gap (anti-regression).
//
// Why call out the policy at the top of `required-primitives.ts` and
// here together: contributor-facing, this is the gate; consumer-
// facing, the policy file is the source of truth.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { loadPack, resolvePackDir } from "../../src/generator/_packs/loader-fs.js";
import {
  flattenRequired,
  REQUIRED_PRIMITIVES,
} from "../../src/generator/_packs/required-primitives.js";

const BUILTIN_PACKS: ReadonlyArray<{ name: string; format: "tsx" | "heex" | "svelte" }> = [
  { name: "mantine@v7", format: "tsx" },
  { name: "mantine@v9", format: "tsx" },
  { name: "shadcn@v3", format: "tsx" },
  { name: "shadcn@v4", format: "tsx" },
  { name: "mui@v5", format: "tsx" },
  { name: "mui@v7", format: "tsx" },
  { name: "chakra@v2", format: "tsx" },
  { name: "chakra@v3", format: "tsx" },
  { name: "ashPhoenix@v3", format: "heex" },
  { name: "shadcnSvelte@v1", format: "svelte" },
  { name: "flowbite@v1", format: "svelte" },
];

describe("required-primitives gate — built-in packs", () => {
  for (const pack of BUILTIN_PACKS) {
    it(`${pack.name} loads with all required ${pack.format} primitives present`, () => {
      // Real built-in pack — full validation is the production path.
      const dir = resolvePackDir(pack.name);
      const loaded = loadPack(dir);
      expect(loaded.manifest.name).toBeTypeOf("string");
      // Every required primitive surfaces in the templates map; the
      // loader throws otherwise, so this is structural confirmation.
      const required = flattenRequired(REQUIRED_PRIMITIVES[pack.format]);
      for (const name of required) {
        expect(loaded.templates.has(name), `${pack.name}: missing template "${name}"`).toBe(true);
      }
    });
  }
});

describe("required-primitives gate — negative path", () => {
  it("fails to load a TSX pack that omits primitive-button", () => {
    // Build a pack that ships every required template EXCEPT
    // primitive-button.  The loader must surface the gap with the
    // missing-name in the error message — not just "load failed".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-missing-prim-"));
    const required = flattenRequired(REQUIRED_PRIMITIVES.tsx);
    // Manifest emits every required name → its .hbs file, minus
    // `primitive-button`.
    const emits: Record<string, string> = {};
    for (const name of required) {
      if (name === "primitive-button") continue;
      emits[name] = `${name}.hbs`;
      // Empty stub — load-gate doesn't care about template body.
      fs.writeFileSync(path.join(dir, `${name}.hbs`), "");
    }
    fs.writeFileSync(
      path.join(dir, "pack.json"),
      JSON.stringify({
        name: "fixture-no-button",
        version: "0.0.0",
        format: "tsx",
        emits,
      }),
    );

    expect(() => loadPack(dir)).toThrow(/missing required template.*primitive-button/);
  });

  it("opt-out (`validateRequired: false`) lets a minimal fixture load — for narrow-scope tests", () => {
    // The opt-out exists for fixture tests that probe a single
    // manifest feature (shellFiles, helpers, …) and don't want to
    // ship the full 40+ primitive surface just to assert one parse
    // path.  It does NOT flow through pack.json — pack authors can't
    // bypass.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-optout-"));
    fs.writeFileSync(
      path.join(dir, "pack.json"),
      JSON.stringify({
        name: "fixture-optout",
        version: "0.0.0",
        emits: { "primitive-button": "primitive-button.hbs" },
      }),
    );
    fs.writeFileSync(path.join(dir, "primitive-button.hbs"), "<button>OK</button>");
    expect(() => loadPack(dir, { validateRequired: false })).not.toThrow();
  });
});
