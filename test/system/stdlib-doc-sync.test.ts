// Drift gate for the generated `docs/stdlib.md` — re-renders from the
// registries via the same pure `renderStdlibMarkdown()` the generator
// script uses and asserts the committed file matches byte-for-byte.  A
// change to an intrinsic / collection-op catalogue or the ambient prelude
// without re-running `npm run docs:stdlib` fails here (the doc's
// single-source-of-truth guard, mirroring langium-generated).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderStdlibMarkdown } from "../../src/system/stdlib-doc.js";

const DOC_PATH = fileURLToPath(new URL("../../docs/stdlib.md", import.meta.url));

describe("docs/stdlib.md", () => {
  it("is in sync with the stdlib registries (run `npm run docs:stdlib` to refresh)", () => {
    const committed = readFileSync(DOC_PATH, "utf8");
    expect(committed).toBe(renderStdlibMarkdown());
  });
});
