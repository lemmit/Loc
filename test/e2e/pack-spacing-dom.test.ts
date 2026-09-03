// ---------------------------------------------------------------------------
// The DOM half of the cross-pack spacing contract — opt-in tier.
//
//   LOOM_PACK_SPACING_DOM=1 \
//   LOOM_PACK_SPACING_URLS='{"react-mantine":4200,"vue-vuetify":4300}' \
//   npm run test:pack-spacing-dom
//
// `test/generator/_packs/pack-spacing-contract.test.ts` proves each pack SAYS
// 16px in its own dialect.  This proves the browser then RENDERS 16px, which is
// a different claim: a Tailwind class the JIT never compiled, a theme override,
// a `min-width:auto` flex child that lets a wide table widen the document —
// none of those show up in the template.
//
// It is opt-in because it needs a booted generated stack per pack (a build, a
// backend and a database each), which is minutes per pack against seconds for
// the template gate.  Point it at whatever you already have running; the CI
// lane it belongs in is `generated-{react,vue,svelte,angular}-build` once those
// serve the built bundle rather than only type-checking it.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const enabled = process.env.LOOM_PACK_SPACING_DOM === "1";
const urls = process.env.LOOM_PACK_SPACING_URLS;

describe.skipIf(!enabled)("cross-pack spacing — measured in a real browser", () => {
  it("every running pack renders the contract's distances", () => {
    // A tier that silently passes with nothing to measure is worse than one
    // that is off: say what is missing.
    expect(
      urls,
      'LOOM_PACK_SPACING_DOM=1 needs LOOM_PACK_SPACING_URLS, e.g. \'{"react-mantine":4200}\' — a map of pack label to port or URL of an already-running generated app',
    ).toBeTruthy();
    const listPath = process.env.LOOM_PACK_SPACING_LIST ?? "/";
    const out = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts/measure-pack-spacing.mjs"), urls!, "--list", listPath],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(out).toContain("inside the");
  }, 300_000);
});
