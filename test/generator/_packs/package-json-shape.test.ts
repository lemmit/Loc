// ---------------------------------------------------------------------------
// Every pack's generated `package.json` is canonically formatted JSON.
//
// 7 of 13 packs shipped this instead:
//
//     "typescript": "^6.0.0",
//     "vite": "^8.0.0"  }
//   }
//
// Valid JSON, and invisible until the first `npm pkg set` or formatter run
// rewrites the whole file and buries a real change in a whitespace diff.
//
// Two causes, one symptom: `stacks/{v1,v3,vue1,sv1}/stack-package-devdeps.hbs`
// ended mid-line, and a pack whose `package-json.hbs` calls the partial
// STANDALONE (alone on its line) gets Handlebars' standalone-partial
// whitespace stripping, which removes the newline the parent supplied.
// `stacks/ng1` already ended with a newline, which is the whole reason the
// three Angular packs were the clean ones.
//
// The gate is re-serialization: parse what the pack emits, print it back with
// `JSON.stringify(…, null, 2)`, and require the two to match.  That catches
// the missing newline, a stray comma line, a tab, or a double blank line —
// anything that would make a formatter rewrite the file — without pinning the
// dependency LIST, which every pack legitimately differs on.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPack } from "../../../src/generator/_packs/loader-fs.js";

const DESIGNS_DIR = path.resolve(__dirname, "..", "..", "..", "designs");

/** Every built-in pack that emits a `package-json` template. */
function packsWithPackageJson(): ReadonlyArray<{ label: string; dir: string }> {
  const found: Array<{ label: string; dir: string }> = [];
  for (const family of fs.readdirSync(DESIGNS_DIR).sort()) {
    const familyDir = path.join(DESIGNS_DIR, family);
    if (!fs.statSync(familyDir).isDirectory()) continue;
    for (const version of fs.readdirSync(familyDir).sort()) {
      const dir = path.join(familyDir, version);
      const manifestPath = path.join(dir, "pack.json");
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
        emits?: Record<string, string>;
      };
      if (manifest.emits?.["package-json"]) found.push({ label: `${family}@${version}`, dir });
    }
  }
  return found;
}

const PACKS = packsWithPackageJson();

describe("every pack emits a canonically formatted package.json", () => {
  it("finds the packs", () => {
    expect(PACKS.length).toBeGreaterThanOrEqual(13);
  });

  // Both flag combinations: `usesMoney` / `usesChart` splice extra dependency
  // lines in, and a whitespace bug can hide behind a branch that is off.
  for (const flags of [
    { usesMoney: false, usesChart: false, appName: "loom_app" },
    { usesMoney: true, usesChart: true, appName: "loom_app" },
  ]) {
    const suffix = flags.usesMoney ? " (money + chart)" : "";
    for (const { label, dir } of PACKS) {
      it(`${label}${suffix}`, () => {
        const text = loadPack(dir).render("package-json", flags);
        const parsed = JSON.parse(text) as unknown;
        expect(
          text.replace(/\n+$/, ""),
          `${label} package.json is not canonically formatted — a formatter or \`npm pkg set\` would rewrite the whole file`,
        ).toBe(JSON.stringify(parsed, null, 2));
      });
    }
  }
});
