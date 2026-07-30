import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ifParses } from "../../web/src/builder/edit-engine.js";
import { isParseOk, writeDecision } from "../../web/src/builder/pane-write.js";
import { parseDdd } from "../../web/src/builder/parse.js";

// ---------------------------------------------------------------------------
// The shared builder-pane harness (M-T8.13 phase 1).
//
// Four panes edit the `.ddd` text through a visual surface, and each used to
// carry its OWN copy of the same four safety rails (source-change ticks, the
// read gate on a recovered AST, the write gate, the refusal line).  The copies
// drifted: `SystemBuilderV2Pane` shipped with no read gate at all — audit
// defect #6, `docs/audits/playground-file-mgmt-review-2026-07.md` — so #2287
// had to fix the same class of bug twice.
//
// Two halves are pinned here:
//
//  * the PURE decision core (`pane-write.ts`), exercised against the real
//    parser + the real `ifParses` gate.  The hook that composes it
//    (`pane-harness.ts`) imports react, which the root vitest suite has no
//    `web/node_modules` for — same split as `live-source-tick.ts` /
//    `use-live-source-tick.ts`, and its composition is covered by the four
//    panes' Playwright specs.
//  * a COMPLETENESS pin, in the spirit of `walker-stdlib-completeness.test.ts`:
//    a pane that hand-rolls a rail instead of taking the harness fails CI.
//    That is what makes the drift class unrepeatable rather than merely fixed.
// ---------------------------------------------------------------------------

const OK_SRC = `system S {
  context C {
    aggregate A {
      total: int
    }
  }
}`;

/** Langium recovers rather than failing outright, so this yields an AST *and*
 *  parser errors — exactly the shape the read gate exists for. */
const RECOVERED_SRC = `system S {
  context C {
    aggregate A {
      status:
      operation go() {
        status :=
      }
    }
  }
}`;

describe("pane harness — read gate (parseOk)", () => {
  it("is true for a clean parse", () => {
    expect(isParseOk(parseDdd(OK_SRC))).toBe(true);
  });

  it("is FALSE on a recovered AST", () => {
    // The AST is non-null and walkable — which is precisely why the gate has to
    // be explicit.  A pane deriving its graph from this would address CST
    // ranges that no longer describe the user's source.
    const parsed = parseDdd(RECOVERED_SRC);
    expect(parsed.ast).toBeDefined();
    expect(parsed.parserErrors.length).toBeGreaterThan(0);
    expect(isParseOk(parsed)).toBe(false);
  });
});

describe("pane harness — write gate (writeDecision)", () => {
  it("commits a candidate that still parses", () => {
    expect(writeDecision(OK_SRC, ifParses)).toBe("commit");
  });

  it("REFUSES a candidate the parser rejects", () => {
    expect(writeDecision(`${OK_SRC}\naggregate {{{`, ifParses)).toBe("refuse");
  });

  it("refuses a null candidate by default — a silent no-op is its own bug", () => {
    // Every `edit-engine`-backed helper returns null for "nothing written".
    // The user clicked Rename / Delete / Apply; if nothing happens and nothing
    // is said, a refused write is indistinguishable from a lost click.
    expect(writeDecision(null, ifParses)).toBe("refuse");
  });

  it("skips a null candidate when the caller says null means 'nothing to do'", () => {
    // `BuilderPane`'s state-panel helpers return null when the page has no
    // block to edit — an ordinary outcome, not a refusal.
    expect(writeDecision(null, ifParses, "skip")).toBe("skip");
  });

  it("never consults the gate for a null candidate", () => {
    let calls = 0;
    const gate = (s: string): string | null => {
      calls++;
      return s;
    };
    writeDecision(null, gate);
    writeDecision(null, gate, "skip");
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const builderDir = path.join(repoRoot, "web", "src", "builder");

/** Every `*Pane.tsx` under `web/src/builder/` — discovered, not listed, so a
 *  NEW pane is covered the day it lands. */
function panes(): string[] {
  return fs
    .readdirSync(builderDir, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith("Pane.tsx"))
    .map((rel) => path.join(builderDir, rel))
    .sort();
}

describe("builder panes — the rails come from the harness, not a local copy", () => {
  it("finds the four panes", () => {
    expect(
      panes()
        .map((p) => path.basename(p))
        .sort(),
    ).toEqual([
      "BuilderPane.tsx",
      "RequirementsPane.tsx",
      "SystemBuilderPane.tsx",
      "SystemBuilderV2Pane.tsx",
    ]);
  });

  it.each(panes().map((p) => [path.basename(p), p]))("%s takes the harness", (_name, file) => {
    // `usePaneHarness(ctx…)` or `usePaneHarness<[…]>(ctx…)` — v1 parameterises
    // it with the extra `keepSelection` argument its preview staging carries.
    expect(fs.readFileSync(file, "utf8")).toMatch(/usePaneHarness\s*[<(]/);
  });

  // The four hand-rolled rails.  Each of these appearing in a pane means that
  // pane has its own copy again — which is how v2 lost the read gate.
  const FORBIDDEN: [string, string][] = [
    ["useLiveSourceTick(", "the debounced source tick is a harness rail"],
    ["useExternalSourceTick(", "the external-reseed tick is a harness rail"],
    ["useRefusal(", "the refusal state is a harness rail (render `RefusalLine` from it)"],
    ["parseDdd(getSource())", "the parse memo is a harness rail"],
    ["parseDdd(ctx.getSource())", "the parse memo is a harness rail"],
    ["parsed.parserErrors", "gate on the harness's `parseOk`, not on the raw parse result"],
  ];

  it.each(
    panes().map((p) => [path.basename(p), p]),
  )("%s hand-rolls none of the rails", (_name, file) => {
    const src = fs.readFileSync(file, "utf8");
    for (const [needle, why] of FORBIDDEN) {
      expect(src, `${path.basename(file)} — ${why}`).not.toContain(needle);
    }
  });
});
