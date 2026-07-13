import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Every IR diagnostic carries a stable `loom.*` code.
//
// The structured-diagnostics contract (docs/old/proposals/ai-diagnostics-contract.md
// design goal §2) requires every diagnostic to be matchable by a stable
// machine code, so the AI authoring loop's repair step keys on identity, not
// message prose.  The Langium-side validators are gated on codes by their own
// tests; this one gates the IR validator, where the codes were backfilled.
//
// A source scan (not a runtime trigger) so it catches an uncoded
// `diags.push({ … })` the moment it's added, without needing a model that
// reaches every branch.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
// The IR validator was split from one validate.ts into a thin orchestrator
// plus per-theme leaf modules under `checks/`; the diagnostics now live in
// the leaves, so scan the whole `validate/` tree, not just validate.ts.
const validateDir = path.resolve(here, "..", "..", "src", "ir", "validate");
const validateSources = [
  path.join(validateDir, "validate.ts"),
  ...fs
    .readdirSync(path.join(validateDir, "checks"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(validateDir, "checks", f)),
];

/** Slice each `diags.push({ … })` object literal by brace-matching from the
 *  opening `{`, returning the inner text of every block. */
function pushBlocks(src: string): string[] {
  const blocks: string[] = [];
  const marker = "diags.push(";
  let from = 0;
  for (;;) {
    const call = src.indexOf(marker, from);
    if (call === -1) break;
    const open = src.indexOf("{", call);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    blocks.push(src.slice(open, end + 1));
    from = end + 1;
  }
  return blocks;
}

describe("IR validator diagnostic codes", () => {
  const blocks = validateSources.flatMap((p) => pushBlocks(fs.readFileSync(p, "utf8")));

  it("scans a non-trivial number of diagnostics (guard against vacuous pass)", () => {
    expect(blocks.length).toBeGreaterThan(80);
  });

  it("every diags.push carries a stable loom.* code", () => {
    const uncoded = blocks.filter((b) => !/\bcode:\s*"loom\.[a-z0-9-]+"/.test(b));
    expect(
      uncoded.map((b) => b.replace(/\s+/g, " ").slice(0, 100)),
      "Each IR diagnostic must carry a stable `loom.*` code (contract §2). " +
        'Add `code: "loom.<kebab>"` to the offending diags.push.',
    ).toEqual([]);
  });
});
